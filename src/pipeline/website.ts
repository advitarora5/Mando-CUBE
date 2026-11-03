// Free candidate lookup + independent company identity and Workday-source corroboration. No LLM or paid fallback.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { normalizeDomain, normalizeName } from "../domain/ingestion/normalize.ts";
import { htmlToText } from "../domain/ingestion/quote.ts";
import { parseRobots, robotsAllows } from "./http.ts";
import type { PipelineContext, WebsiteResolution, WorkdaySite, EmployerWebsiteLink } from "./types.ts";

export const WEBSITE_VERSION = 9;
export const WEBSITE_LIMIT = 50;
const GUESS_TLDS = ["com", "org", "edu", "net", "tv"];
const CAREERS_PATHS = ["/careers", "/jobs", "/about/careers", "/company/careers"];
const PARKED = /domain (name )?(is )?for sale|buy this domain|this domain may be for sale|domain is parked|parked free|sedoparking|hugedomains/i;
// Candidate hosts for a slug: the usual endings, plus health systems that add the word ("allina" -> allinahealth.org).
export const guessDomains = (tenant: string) => [...GUESS_TLDS.map(tld => `${tenant}.${tld}`), `${tenant}health.org`, `${tenant}health.com`];
const DAY = 86400000;
export const MAX_WEBSITE_BODY = 2 * 1024 * 1024;
const MAX_ROBOTS_BODY = 512 * 1024;

// Candidate URLs and every redirect are checked before fetching. IPs and private DNS answers are refused.
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0)) && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19));
  }
  // Only globally routed IPv6 unicast; reject embedded IPv4 and transition ranges too.
  return isIP(address) === 6 && /^[23][0-9a-f]{0,3}:/i.test(address) && !/^2002:/i.test(address) && !/^2001:(?:db8|0):/i.test(address) && !address.includes(".");
}
function safeUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !normalizeDomain(url.hostname) || isIP(url.hostname) || /\.(local|localhost|internal|home|arpa)$/i.test(url.hostname)) throw Error("unsafe website URL");
  return url;
}

export class WebsiteHttp {
  requests = 0;
  private robots = new Map<string, string>();
  private last = new Map<string, number>();
  private ctx: PipelineContext;
  private maxRequests: number;
  constructor(ctx: PipelineContext, maxRequests = 300) { this.ctx = ctx; this.maxRequests = maxRequests; }
  private async read(url: URL, maxBody = MAX_WEBSITE_BODY, jsonBody?: unknown, jsonMode = false): Promise<{ status: number; body: string; location: string | null; type: string }> {
    const addresses = await (this.ctx.lookupHost ?? (host => lookup(host, { all: true })))(url.hostname);
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw Error("website resolves to a non-public address");
    if (this.requests >= this.maxRequests) throw Error("website request cap reached");
    const wait = (this.last.get(url.hostname) ?? 0) + 1000 - this.ctx.now().getTime();
    if (wait > 0) await this.ctx.sleep(wait);
    this.requests++; this.last.set(url.hostname, this.ctx.now().getTime());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await this.ctx.fetch(url.href, { redirect: "manual", signal: controller.signal,
        ...(jsonBody === undefined ? {} : { method: "POST", body: JSON.stringify(jsonBody) }),
        headers: { "user-agent": `mando-cube-ingestion/1.0 (${this.ctx.contact || "contact unset"})`, accept: jsonMode ? "application/json" : "text/html,text/plain;q=0.9", ...(jsonBody === undefined ? {} : { "content-type": "application/json" }) } });
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      if (reader) try {
        while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > maxBody) throw Error("website response exceeds size limit"); chunks.push(value); }
      } finally { void reader.cancel().catch(() => {}); }
      return { status: res.status, body: Buffer.concat(chunks).toString("utf8"), location: res.headers.get("location"), type: res.headers.get("content-type") ?? "" };
    } finally { clearTimeout(timer); }
  }
  // Redirected robots rules govern the original origin. Fetching robots itself does not recurse
  // through robots checks; every redirect still goes through URL, DNS, size and request limits.
  private async readRobots(origin: string): Promise<string> {
    let url = safeUrl(new URL("/robots.txt", origin).href);
    const visited = new Set<string>();
    for (let hop = 0; hop <= 3; hop++) {
      if (visited.has(url.href)) throw Error("website robots redirect loop");
      visited.add(url.href);
      const res = await this.read(url, MAX_ROBOTS_BODY);
      if ([301, 302, 303, 307, 308].includes(res.status) && res.location) {
        url = safeUrl(new URL(res.location, url).href);
        continue;
      }
      if (res.status === 404 || res.status === 410) return "";
      if (res.status === 200 && !/<html|captcha|cf-chl-/i.test(res.body)) return res.body;
      throw Error(`website robots unavailable: HTTP ${res.status}`);
    }
    throw Error("website robots redirect limit reached");
  }
  async page(value: string): Promise<{ url: string; html: string }> {
    let url = safeUrl(value);
    for (let hop = 0; hop <= 3; hop++) {
      let robots = this.robots.get(url.origin);
      if (robots === undefined) {
        robots = await this.readRobots(url.origin);
        this.robots.set(url.origin, robots);
      }
      if (!robotsAllows(parseRobots(robots, "mando-cube-ingestion"), url.pathname + url.search)) throw Error("website disallowed by robots.txt");
      const res = await this.read(url);
      if (res.status >= 300 && res.status < 400 && res.location) { url = safeUrl(new URL(res.location, url).href); continue; }
      if (res.status !== 200) throw Error(`website HTTP ${res.status}`);
      const head = res.body.slice(0, 20000);
      // A normal careers page can load reCAPTCHA for an application form. That is not itself
      // an access challenge; actual challenge markup/messages still stop verification.
      const challenge = /cf-chl-|challenge-platform|verify you are human|<title[^>]*>\s*(captcha|just a moment|access denied)/i.test(head) || /^captcha\b/i.test(htmlToText(head));
      if (!/text\/html|application\/xhtml\+xml/i.test(res.type) || challenge) throw Error("website is not readable HTML");
      return { url: url.href, html: res.body };
    }
    throw Error("website redirect limit reached");
  }
  // Identity sampling uses the same DNS, robots, body, timeout and request limits as website checks.
  // JSON redirects are refused: a posting must come from the exact Workday API requested.
  async json(value: string, body?: unknown): Promise<{ url: string; raw: string; data: unknown }> {
    const url = safeUrl(value);
    let robots = this.robots.get(url.origin);
    if (robots === undefined) { robots = await this.readRobots(url.origin); this.robots.set(url.origin, robots); }
    if (!robotsAllows(parseRobots(robots, "mando-cube-ingestion"), url.pathname + url.search)) throw Error("website disallowed by robots.txt");
    const res = await this.read(url, MAX_WEBSITE_BODY, body, true);
    if (res.status !== 200) throw Error(`website JSON HTTP ${res.status}`);
    return { url: url.href, raw: res.body, data: JSON.parse(res.body) };
  }
}

const decode = (value: string) => value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&nbsp;/gi, " ");
const attr = (tag: string, key: string) => decode(tag.match(new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find(v => v !== undefined) ?? "");
export function links(html: string, base: string): { url: URL; label: string }[] {
  const out: { url: URL; label: string }[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(match[1], "href"); if (!href) continue;
    try { const url = new URL(href, base); if (url.protocol === "https:") out.push({ url, label: decode(match[2].replace(/<[^>]+>/g, " ")).trim() }); } catch { /* not a URL */ }
  }
  return out;
}
// Prefer the main careers landing page over account tools and saved jobs. Only explicitly linked
// pages on the verified company's hostname/subdomains can corroborate its Workday site.
export function careersLinks(html: string, base: string, companyHost: string): string[] {
  const host = normalizeDomain(companyHost)!;
  const scored = links(html, base).flatMap(({ url, label }) => {
    const other = normalizeDomain(url.hostname);
    if (!other || !(other === host || other.endsWith(`.${host}`)) || url.href === base || /saved.jobs|job.alerts|sign.?in|log.?in|register|privacy|cookies|accessibility/i.test(`${url.pathname} ${label}`)) return [];
    const careerPath = /careers?|jobs/i.test(`${url.hostname} ${url.pathname}`);
    const careerAction = /^(careers?|jobs|join (our|the) team|(?:find|search|view|see|explore|browse)(?: all| our| available| open)? (?:jobs|positions|opportunities)|open positions)$/i.test(label.trim());
    if (!careerPath && !careerAction) return [];
    const score = (/^(careers?|jobs|join (our|the) team)$/i.test(label.trim()) ? 100 : 0)
      + (/\/(careers?|jobs)(?:\.html)?\/?$/i.test(url.pathname) ? 50 : 0)
      + (/search|find.*job|open.*position|view.*job/i.test(`${label} ${url.pathname}`) ? 20 : 0)
      - url.pathname.split("/").filter(Boolean).length;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(icmp|cmp|ref)$/i.test(key)) url.searchParams.delete(key);
    return [{ href: url.href, score }];
  }).sort((a, b) => b.score - a.score);
  return [...new Set(scored.map(row => row.href))];
}
// loose: the page's name only has to start with the target (a tenant slug "nexstar" for "Nexstar Media Group").
// It is used for guessed domains only, which must also pass the reciprocal Workday-link proof.
const compact = (value: string) => normalizeName(value).replace(/ /g, "");
export function pageIdentity(html: string, name: string, loose = false): string | null {
  const target = normalizeName(name); if (!target) return null;
  const names: string[] = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) if (/^(og:site_name|application-name)$/i.test(attr(match[0], "property") || attr(match[0], "name"))) names.push(attr(match[0], "content"));
  for (const match of html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)) names.push(...decode(match[1]).split(/\s*[|–—]\s*|\s+-\s+/));
  // Corporate pages often use a short brand in metadata and the full legal owner in
  // their explicit copyright element. Require the whole owner, not a body mention.
  const visible = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  for (const match of visible.matchAll(/<([a-z][\w-]*)\b(?=[^>]*copyright)([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    if (!/copyright/i.test(attr(match[2], "class") + " " + attr(match[2], "id"))) continue;
    const text = htmlToText(match[3]).replace(/&copy;/gi, "©").trim();
    const owner = text.match(/^(?:©|copyright\s*©?)\s*(?:\d{4}(?:\s*[-–]\s*\d{4})?\s*)?(.+?)(?:\s*[.|]?\s*all rights reserved\.?)?$/i)?.[1];
    if (owner) names.push(owner.trim());
  }
  // Only structured Organization/Corporation identity, not arbitrary body mentions or name fragments.
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (v: unknown, depth = 0) => {
        if (depth > 8 || !v || typeof v !== "object") return;
        if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
        const row = v as Record<string, unknown>;
        if ([row["@type"]].flat().some(type => type === "Organization" || type === "Corporation")) {
          for (const key of ["name", "legalName"]) if (typeof row[key] === "string") names.push(row[key]);
        }
        if (row["@graph"]) walk(row["@graph"], depth + 1);
      };
      walk(JSON.parse(match[1]));
    } catch { /* broken structured data is not evidence */ }
  }
  return names.find(value => loose ? compact(value.replace(/<[^>]+>/g, " ")).startsWith(compact(name)) : normalizeName(value.replace(/<[^>]+>/g, " ")) === target) ?? null;
}
// tenantOnly (guessed slug domains): a link to any career site of the tenant proves the tenant is theirs. The company may link
// a different site than the one picked as primary (M&T Bank links /MTB while the primary pick was Wilmington Trust's site).
function workdayLink(html: string, base: string, sites: WorkdaySite[], tenantOnly = false): string | null {
  return links(html, base).find(({ url }) => sites.some(site => url.hostname === `${site.tenant}.${site.pod}.myworkdayjobs.com` && (tenantOnly || decodeURIComponent(url.pathname).split("/").includes(site.site))))?.url.href ?? null;
}
// A branded page on a shared social/document/ATS platform is not a corporate website.
function sharedPlatform(domain: string): boolean {
  return ["sharepoint.com", "myworkdayjobs.com", "myworkdaysite.com", "linkedin.com", "facebook.com", "instagram.com", "youtube.com"].some(host => domain === host || domain.endsWith(`.${host}`));
}

// Only stored JSON from the exact enabled Workday tenant/site can vouch for an employer link.
// Links to unrelated benefits providers are merely candidates: company identity must still match.
export async function loadEmployerLinks(ctx: PipelineContext, name: string, sites: WorkdaySite[]): Promise<EmployerWebsiteLink[]> {
  if (!sites.length) return [];
  const refs: EmployerWebsiteLink[] = [];
  for (const capture of await ctx.store.websiteEvidenceCaptures(normalizeName(name), 20)) {
    if (ctx.now().getTime() - Date.parse(capture.last_seen_at) > 14 * DAY || !Number.isFinite(Date.parse(capture.last_seen_at))) continue;
    let source: URL;
    try { source = new URL(capture.url); } catch { continue; }
    if (source.protocol !== "https:" || source.username || source.password || source.port) continue;
    const site = sites.find(s => s.enabled && s.normalized_name === normalizeName(name) && source.hostname === `${s.tenant}.${s.pod}.myworkdayjobs.com` && source.pathname.startsWith(`/wday/cxs/${s.tenant}/${s.site}/job/`));
    if (!site || capture.meta.kind !== "workday_job" || capture.meta.normalized_name !== normalizeName(name)) continue;
    let body: { jobPostingInfo?: { jobDescription?: string }; hiringOrganization?: { url?: string } };
    try { body = JSON.parse(capture.body); } catch { continue; }
    if (typeof body?.jobPostingInfo?.jobDescription !== "string") continue;
    const add = (value: string, field: EmployerWebsiteLink["field"]) => {
      try {
        const url = safeUrl(value), domain = normalizeDomain(url.hostname)!;
        if (sharedPlatform(domain)) return;
        url.search = ""; url.hash = ""; // do not copy tracking/account query data into verification evidence
        refs.push({ domain, url: url.href, source_url: capture.url, capture_id: capture.id, field });
      } catch { /* unsafe/non-website links are not evidence */ }
    };
    if (typeof body.hiringOrganization?.url === "string") add(body.hiringOrganization.url, "hiringOrganization.url");
    const description = body.jobPostingInfo.jobDescription.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
    for (const link of links(description, capture.url)) add(link.url.href, "jobPostingInfo.jobDescription");
  }
  return [...new Map(refs.map(ref => [`${ref.domain}|${ref.capture_id}|${ref.url}`, ref])).values()];
}
// The company's own name as its confirmed website writes it ("Nexstar Media Group"): used instead of a tenant slug.
export function confirmedName(resolution: WebsiteResolution): string | null {
  if (resolution.status !== "confirmed" || !resolution.domain) return null;
  const name = resolution.evidence.checks.find(check => check.identity && (check.workday_url || check.employer_link))?.identity?.replace(/\s+/g, " ").trim();
  return name && name.length <= 120 ? name : null;
}
export function websiteSignature(sites: WorkdaySite[], employerLinks: EmployerWebsiteLink[] = []): string {
  return createHash("sha256").update(JSON.stringify([WEBSITE_VERSION, sites.map(s => `${s.tenant}.${s.pod}/${s.site}`).sort(), employerLinks.map(ref => `${ref.capture_id}|${ref.url}`).sort()])).digest("hex");
}

export async function resolveWebsite(ctx: PipelineContext, name: string, sites: WorkdaySite[], http: WebsiteHttp, dryRun = false, employerLinks?: EmployerWebsiteLink[]): Promise<WebsiteResolution> {
  const refs = employerLinks ?? await loadEmployerLinks(ctx, name, sites);
  const normalized = normalizeName(name), signature = websiteSignature(sites, refs);
  const cached = await ctx.store.websiteResolution(normalized);
  if (cached?.input_signature === signature && Date.parse(cached.next_check_at) > ctx.now().getTime()) return cached;
  const checked = ctx.now();
  const base: WebsiteResolution = { normalized_name: normalized, company_name: name, domain: null, status: "unresolved", reason: "no matching Workday site available for reciprocal confirmation", input_signature: signature, checked_at: checked.toISOString(), next_check_at: new Date(+checked + 7 * DAY).toISOString(), evidence: { candidates: [], checks: [] } };
  if (!sites.length) { if (!dryRun) await ctx.store.saveWebsiteResolution(base); return base; }
  let guessed = false;
  try {
    const query = name.replace(/\s*\/[A-Z]{2}\/?\s*$/, "").trim();
    const fetchCandidates = async (company: string): Promise<{ domain: string; company_name: string }[]> => {
      const res = await ctx.treg!.call("hunter.x.domain-finder", { query: { company, limit: 3 }, headers: { "X-Treg-Route-Max-Cost": "0", "X-Treg-Route-Waterfall": "0" }, timeoutMs: 15000 });
      if (res.cost_usd > 0) await ctx.spend.record({ provider: "treg", endpoint: "hunter.x.domain-finder", step: "domain", subject: name, idempotency_key: "", worst_case_usd: 0, cost_usd: res.cost_usd, outcome: "unexpected charge on a free endpoint" });
      if (!Number.isFinite(res.cost_usd) || res.cost_usd !== 0) throw Error("domain lookup did not report a zero charge");
      if (!res.ok) throw Error(res.error);
      const data = (res.body as { data?: unknown })?.data;
      if (!Array.isArray(data) || data.some(row => !row || typeof row !== "object" || typeof row.domain !== "string" || typeof row.company_name !== "string")) throw Error("domain lookup returned malformed data");
      // Preserve only the public identity fields used for matching.
      const rows = data.slice(0, 3).map(row => ({ domain: row.domain as string, company_name: row.company_name as string }));
      (base.evidence.queries ??= []).push({ company, candidates: rows });
      return rows;
    };
    const candidates: { domain: string; company_name: string }[] = [];
    base.evidence.candidates = candidates;
    const backing = (domain: string) => refs.find(ref => ref.domain === domain || ref.domain.endsWith(`.${domain}`));
    base.evidence.employer_links = refs;
    const sourceDomains = [...new Set(refs.map(ref => ref.domain))];
    const sourceCandidates = sourceDomains.slice(0, 5).map(domain => ({ domain, company_name: name }));
    candidates.push(...sourceCandidates);
    const confirmed = new Set<string>(); let failures = 0, identityFailures = 0;
    const visitedDomains = new Set<string>();
    const checkCandidates = async (rows: typeof candidates, loose = false) => {
      for (const candidate of rows) {
        if (loose && confirmed.size) break;
        if (normalizeName(candidate.company_name) !== normalized) continue;
        const domain = normalizeDomain(candidate.domain); if (!domain || sharedPlatform(domain)) continue;
        if (visitedDomains.has(domain)) continue;
        visitedDomains.add(domain);
        let identityMatched = false;
        try {
          safeUrl(candidate.domain.includes("://") ? candidate.domain : `https://${candidate.domain}/`);
          const home = await http.page(`https://${domain}/`);
          // Guessed domains: a redirect to another domain, or a parked "for sale" page, is never evidence.
          if (loose && (normalizeDomain(new URL(home.url).hostname) !== domain || PARKED.test(home.html.slice(0, 30000)))) { base.evidence.checks.push({ domain, url: home.url, reason: "guessed domain redirects elsewhere or is parked" }); continue; }
          const identity = pageIdentity(home.html, name, loose);
          // Guessed slug domains without a name match (M&T Bank on mtb.com) may still pass on the exact Workday link below.
          const slugDomain = loose && sites.some(s => domain.split(".").slice(-2, -1)[0] === s.tenant);
          if (!identity && !slugDomain) { base.evidence.checks.push({ domain, url: home.url, reason: "no exact company identity in page metadata" }); continue; }
          identityMatched = !!identity;
          // A guessed domain may use the posting shortcut only when its name is the tenant slug itself and the tenant's
          // own posting links to it; otherwise (benefit vendors, acquired brands) it needs the reciprocal link.
          const employerLink = backing(domain);
          if (identity && employerLink && (!loose || sites.some(s => domain.split(".").slice(-2, -1)[0] === s.tenant))) {
            base.evidence.checks.push({ domain, url: home.url, identity, employer_link: employerLink, reason: "company identity and corporate link from its observed Workday posting" });
            confirmed.add(normalizeDomain(new URL(home.url).hostname)!);
            continue;
          }
          let proof = workdayLink(home.html, home.url, sites, loose); let proofUrl = home.url;
          const homeHost = normalizeDomain(new URL(home.url).hostname)!;
          const queue = careersLinks(home.html, home.url, homeHost);
          const visited = new Set([home.url]);
          // Up to three explicitly linked careers pages, including a job-search page linked from
          // the landing page. No general crawler, search engine, rendering or arbitrary URL guessing.
          for (let followed = 0; !proof && queue.length && followed < 3; followed++) {
            const next = queue.shift()!;
            if (visited.has(next)) { followed--; continue; }
            visited.add(next);
            const page = await http.page(next);
            visited.add(page.url);
            const pageHost = normalizeDomain(new URL(page.url).hostname)!;
            if (pageHost !== homeHost && !pageHost.endsWith(`.${homeHost}`)) continue;
            proof = workdayLink(page.html, page.url, sites, loose); proofUrl = page.url;
            queue.unshift(...careersLinks(page.html, page.url, homeHost).filter(url => !visited.has(url)));
          }
          // Guessed domains also try the usual careers paths directly: many homepages build the careers link in a script or sit behind a bot wall.
          for (const path of loose ? CAREERS_PATHS : []) {
            if (proof) break;
            const target = new URL(path, home.url).href;
            if (visited.has(target)) continue;
            visited.add(target);
            try {
              const page = await http.page(target);
              visited.add(page.url);
              const pageHost = normalizeDomain(new URL(page.url).hostname)!;
              if (pageHost !== homeHost && !pageHost.endsWith(`.${homeHost}`)) continue;
              proof = workdayLink(page.html, page.url, sites, loose); proofUrl = page.url;
            } catch { /* a missing or blocked path is a miss */ }
          }
          base.evidence.checks.push({ domain, url: proofUrl, identity: identity ?? undefined, workday_url: proof, reason: proof ? (identity ? "company identity and reciprocal Workday career link" : "reciprocal Workday career link on the slug domain, no name match: check the name") : "no reciprocal link to observed Workday career site" });
          if (proof) confirmed.add(normalizeDomain(new URL(home.url).hostname)!);
        } catch (error) {
          failures++;
          if (identityMatched) identityFailures++;
          base.evidence.checks.push({ domain, reason: (error as Error).message });
        }
      }
    };
    // Posting links are candidates in their own right, even when Hunter omits them.
    // Inspect every bounded source candidate before deciding whether one is unique.
    await checkCandidates(sourceCandidates);
    // A slug-derived name (Common Crawl tenant) has nothing to search for. Guess {tenant}.com/.org/.edu/.net; a wrong
    // guess simply fails identity or the Workday-link proof, and unreachable guesses are misses, not errors.
    if (!confirmed.size && sites.some(s => s.match_kind === "first_word")) {
      guessed = true;
      const [failed, identityFailed] = [failures, identityFailures];
      await checkCandidates([...new Set(sites.filter(s => s.match_kind === "first_word").map(s => s.tenant))].flatMap(tenant => guessDomains(tenant).map(domain => ({ domain, company_name: name }))), true);
      failures = failed + (identityFailures - identityFailed);
    }
    if (!confirmed.size && ctx.treg) {
      const hunter = await fetchCandidates(query);
      // Retry the complete normalized identity, never an arbitrary first-word alias.
      if (!hunter.some(row => normalizeName(row.company_name) === normalized && normalizeDomain(row.domain) && !sharedPlatform(normalizeDomain(row.domain)!)) && normalized.length >= 3 && normalized !== query.toLowerCase()) {
        hunter.push(...await fetchCandidates(normalized));
      }
      candidates.push(...hunter);
      await checkCandidates(hunter);
    }
    // A plausible provider label is not a successful lookup. Search is discovery only:
    // titles/snippets never replace page identity or exact Workday corroboration.
    if (!confirmed.size && ctx.treg) {
      const searchQuery = `${query} official corporate website careers`;
      const res = await ctx.treg.call("tinyfish.web.search", { query: { query: searchQuery, domain_type: "web" }, headers: { "X-Treg-Route-Max-Cost": "0", "X-Treg-Route-Waterfall": "0" }, timeoutMs: 15000 });
      if (res.cost_usd > 0) await ctx.spend.record({ provider: "treg", endpoint: "tinyfish.web.search", step: "domain", subject: name, idempotency_key: "", worst_case_usd: 0, cost_usd: res.cost_usd, outcome: "unexpected charge on a free endpoint" });
      if (!Number.isFinite(res.cost_usd) || res.cost_usd !== 0) throw Error("website search did not report a zero charge");
      if (!res.ok) throw Error(res.error);
      const results = (res.body as { results?: unknown })?.results;
      if (!Array.isArray(results) || results.some(row => !row || typeof row !== "object" || typeof row.url !== "string" || typeof row.title !== "string")) throw Error("website search returned malformed data");
      const searchRows: { url: string; title: string; domain: string }[] = [];
      for (const row of results.slice(0, 10)) {
        try {
          const url = safeUrl(row.url), domain = normalizeDomain(url.hostname)!;
          if (sharedPlatform(domain) || searchRows.some(r => r.domain === domain)) continue;
          url.search = ""; url.hash = "";
          searchRows.push({ url: url.href, title: row.title.slice(0, 300), domain });
        } catch { /* unsafe search results are not fetched */ }
      }
      // Prefer a parent hostname only when it also appears explicitly in the results.
      // Never guess registrable domains by stripping subdomains or country suffixes.
      const selected = searchRows.filter(row => !searchRows.some(other => row.domain.endsWith(`.${other.domain}`))).slice(0, 3);
      base.evidence.search = { provider: "tinyfish.web.search", query: searchQuery, results: selected };
      const extra = selected.map(row => ({ domain: row.domain, company_name: name }));
      base.evidence.candidates.push(...extra);
      await checkCandidates(extra);
    }
    // Unrelated failures do not veto a complete proof. A second verified domain or an
    // identity-matched candidate whose proof could not finish still prevents admission.
    if (sourceDomains.length > sourceCandidates.length) base.reason = "employer website candidate cap reached; human review required";
    else if (confirmed.size > 1) base.reason = "multiple websites corroborate this company; human review required";
    else if (confirmed.size === 1 && identityFailures === 0) { base.domain = [...confirmed][0]; base.status = "confirmed"; base.reason = base.evidence.checks.some(check => check.employer_link) ? "independent company identity and corporate link from observed Workday posting" : "independent company identity and reciprocal Workday career link"; base.next_check_at = new Date(+checked + 30 * DAY).toISOString(); }
    else if (failures) { base.status = "error"; base.reason = "one or more website checks failed; retry required"; }
    else base.reason = "no uniquely corroborated website";
  } catch (error) { base.status = "error"; base.reason = (error as Error).message; }
  if (base.status === "error") base.next_check_at = new Date(+checked + DAY).toISOString();
  if (!ctx.treg && !guessed && base.status !== "confirmed") return { ...base, reason: base.status === "error" ? base.reason : "Treg is not configured" }; // do not cache disabled fallback configuration
  if (!dryRun) await ctx.store.saveWebsiteResolution(base);
  return base;
}
