// Bounded recovery of corporate identity evidence when the company's own page is unreadable.
// It only changes which first-party page is collected; it never changes the identity decision.
//
// A host is tried only with provenance:
// - "corporate_link": an investor/about link on the company's own corporate page (the page was fetched but its
//   text was too thin, e.g. a script-rendered page);
// - "sec_filing": a host named in one of the company's own recent SEC filings, where the same filing also names
//   the corporate domain. The domain check stops a name-based CIK lookup from attaching another issuer's hosts.
// A search result, a logo or a name alone never makes a host trusted.
// Every request goes through WebsiteHttp, so robots.txt, DNS, size and request limits apply. Blocks, challenges
// and paywalls are recorded as errors, never bypassed. Every attempted URL and its error are returned.
import { htmlToText } from "../domain/ingestion/quote.ts";
import { normalizeDomain, normalizeName } from "../domain/ingestion/normalize.ts";
import { links, WebsiteHttp } from "./website.ts";
import type { PipelineContext } from "./types.ts";

export const MIN_CORPORATE_TEXT = 200;      // shorter corporate text counts as unreadable
export const FALLBACK_MAX_PAGES = 3;        // fallback pages fetched per company
export const FALLBACK_MAX_FILINGS = 2;      // SEC filing documents read per company
export const FALLBACK_MAX_REQUESTS = 12;    // all fallback HTTP requests per company, robots.txt fetches included
export const MAX_FILING_BODY = 12 * 1024 * 1024; // annual reports are often larger than the 2 MB web-page limit

export type FallbackCandidate = { url: string; provenance: "corporate_link" | "sec_filing"; via: string };
export type FallbackAttempt = { url: string; provenance: "corporate_link" | "sec_filing" | "sec_issuer_record"; via: string; error: string | null };
export type FallbackInput = {
  targetName: string;
  corporateUrl: string;
  corporatePage: { url: string; html: string } | null;
  secRows: unknown;
  readable: (html: string) => boolean;
};

// Investor and about links on the company's own fetched page. Investor pages are tried first.
export function linkedFallbackCandidates(html: string, pageUrl: string): FallbackCandidate[] {
  const investor: FallbackCandidate[] = [];
  const about: FallbackCandidate[] = [];
  for (const link of links(html, pageUrl)) {
    const url = link.url;
    if (url.username || url.password || url.port) continue;
    url.hash = "";
    const text = `${link.label} ${url.hostname} ${url.pathname}`;
    let list: FallbackCandidate[] | null = null;
    if (/investor/i.test(text)) list = investor;
    else if (/about/i.test(text)) list = about;
    if (!list) continue;
    const href = url.href;
    if (href === pageUrl) continue;
    if (investor.some(c => c.url === href) || about.some(c => c.url === href)) continue;
    list.push({ url: href, provenance: "corporate_link", via: pageUrl });
  }
  return [...investor, ...about];
}

// Exactly one SEC issuer whose title normalizes to the target name; otherwise none.
export function secCik(rows: unknown, targetName: string): string | null {
  if (!rows || typeof rows !== "object") return null;
  const wanted = normalizeName(targetName);
  const ciks = new Set<number>();
  for (const row of Object.values(rows as Record<string, unknown>)) {
    if (!row || typeof row !== "object") continue;
    const title = (row as { title?: unknown }).title;
    const cik = Number((row as { cik_str?: unknown }).cik_str);
    if (typeof title !== "string" || !Number.isInteger(cik) || cik <= 0) continue;
    if (normalizeName(title) === wanted) ciks.add(cik);
  }
  if (ciks.size !== 1) return null;
  return String([...ciks][0]).padStart(10, "0");
}

const FILE_ENDINGS = /\.(htm|html|pdf|xml|xsd|txt|jpg|jpeg|png|gif|css|js|json|zip)$/;
const IGNORED_HOSTS = /(^|\.)(sec\.gov|xbrl\.org|fasb\.org|w3\.org)$/;

// Hosts named in an issuer's own filing text. The filing must also name the corporate domain. A host counts if it
// is a subdomain of the corporate domain (investor.example.com) or appears near the word "investor".
export function filingHostCandidates(text: string, corporateDomain: string, via: string): FallbackCandidate[] {
  const domain = normalizeDomain(corporateDomain);
  if (!domain) return [];
  const lower = text.toLowerCase();
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`(^|[^a-z0-9-])${escaped}($|[^a-z0-9-])`).test(lower)) return [];
  const out: FallbackCandidate[] = [];
  for (const match of lower.matchAll(/(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})/g)) {
    const host = match[1];
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (lower[start - 1] === "@" || lower[end] === "@") continue; // e-mail address, not a website
    if (FILE_ENDINGS.test(host) || IGNORED_HOSTS.test(host)) continue;
    const normalized = normalizeDomain(host);
    if (!normalized || normalized === domain) continue; // the corporate host itself already failed
    const subdomain = normalized.endsWith(`.${domain}`);
    // "Near" means in the same sentence: up to 80 characters before the host or 40 after it.
    let before = lower.slice(Math.max(0, start - 80), start);
    const sentenceStart = before.lastIndexOf(". ");
    if (sentenceStart >= 0) before = before.slice(sentenceStart + 2);
    let after = lower.slice(end, end + 40);
    const sentenceEnd = after.indexOf(". ");
    if (sentenceEnd >= 0) after = after.slice(0, sentenceEnd);
    const nearInvestor = /investor/.test(before) || /investor/.test(after);
    if (!subdomain && !nearInvestor) continue;
    const url = `https://${host}/`;
    if (!out.some(c => c.url === url)) out.push({ url, provenance: "sec_filing", via });
  }
  return out;
}

// Up to FALLBACK_MAX_FILINGS recent 10-K, 10-Q or 8-K primary documents from the issuer's own submissions record.
async function secFilingCandidates(http: WebsiteHttp, cik: string, corporateDomain: string, attempts: FallbackAttempt[]): Promise<FallbackCandidate[]> {
  const recordUrl = `https://data.sec.gov/submissions/CIK${cik}.json`;
  let recent: { form?: unknown[]; accessionNumber?: unknown[]; primaryDocument?: unknown[] } | undefined;
  try {
    const record = await http.json(recordUrl);
    recent = (record.data as { filings?: { recent?: typeof recent } })?.filings?.recent;
    attempts.push({ url: recordUrl, provenance: "sec_issuer_record", via: `CIK ${cik}`, error: null });
  } catch (error) {
    attempts.push({ url: recordUrl, provenance: "sec_issuer_record", via: `CIK ${cik}`, error: (error as Error).message });
    return [];
  }
  const forms = Array.isArray(recent?.form) ? recent.form : [];
  // The most recent periodic report (its "available information" section usually names the investor site),
  // then the most recent 8-K.
  const documents: string[] = [];
  for (const wanted of [["10-K", "10-Q"], ["8-K"]]) {
    for (let i = 0; i < forms.length; i++) {
      if (!wanted.includes(String(forms[i]))) continue;
      const accession = String(recent?.accessionNumber?.[i] ?? "").replace(/-/g, "");
      const document = String(recent?.primaryDocument?.[i] ?? "");
      if (!/^\d{18}$/.test(accession) || !/^[A-Za-z0-9._-]+$/.test(document)) continue;
      documents.push(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}/${document}`);
      break;
    }
  }
  const candidates: FallbackCandidate[] = [];
  for (const url of documents.slice(0, FALLBACK_MAX_FILINGS)) {
    try {
      const page = await http.page(url, MAX_FILING_BODY);
      attempts.push({ url, provenance: "sec_filing", via: `CIK ${cik}`, error: null });
      for (const candidate of filingHostCandidates(htmlToText(page.html), corporateDomain, url)) {
        if (!candidates.some(c => c.url === candidate.url)) candidates.push(candidate);
      }
    } catch (error) {
      attempts.push({ url, provenance: "sec_filing", via: `CIK ${cik}`, error: (error as Error).message });
    }
  }
  return candidates;
}

export async function corporateFallback(ctx: PipelineContext, input: FallbackInput): Promise<{ page: { url: string; html: string; candidate: FallbackCandidate } | null; attempts: FallbackAttempt[] }> {
  const http = new WebsiteHttp(ctx, FALLBACK_MAX_REQUESTS);
  const attempts: FallbackAttempt[] = [];
  let pagesTried = 0;

  const tryCandidates = async (candidates: FallbackCandidate[]) => {
    for (const candidate of candidates) {
      if (pagesTried >= FALLBACK_MAX_PAGES) return null;
      pagesTried++;
      try {
        const page = await http.page(candidate.url);
        if (!input.readable(page.html)) {
          attempts.push({ url: candidate.url, provenance: candidate.provenance, via: candidate.via, error: "too little readable text" });
          continue;
        }
        attempts.push({ url: candidate.url, provenance: candidate.provenance, via: candidate.via, error: null });
        return { url: page.url, html: page.html, candidate };
      } catch (error) {
        attempts.push({ url: candidate.url, provenance: candidate.provenance, via: candidate.via, error: (error as Error).message });
      }
    }
    return null;
  };

  if (input.corporatePage) {
    const found = await tryCandidates(linkedFallbackCandidates(input.corporatePage.html, input.corporatePage.url));
    if (found) return { page: found, attempts };
  }
  const cik = secCik(input.secRows, input.targetName);
  const domain = normalizeDomain(input.corporateUrl);
  if (cik && domain && pagesTried < FALLBACK_MAX_PAGES) {
    const candidates = await secFilingCandidates(http, cik, domain, attempts);
    const found = await tryCandidates(candidates);
    if (found) return { page: found, attempts };
  }
  return { page: null, attempts };
}
