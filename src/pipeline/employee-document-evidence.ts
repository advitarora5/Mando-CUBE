import { z } from "zod";
import { pageIdentity } from "./website.ts";
import { normalizeName } from "../domain/ingestion/normalize.ts";
import { chicagoToday, daysSince } from "../domain/scoring/go-live.ts";
import { htmlToText } from "../domain/ingestion/quote.ts";
import { employeeTableEvidence } from "./employee-table-evidence.ts";

export const webEmployeeEvidenceSchema = z.strictObject({
  employee_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  as_of: z.iso.date(), source: z.url({ protocol: /^https$/ }),
  quote: z.string().min(1).max(1000),
  basis: z.enum(["exact", "lower_bound", "approximate"]),
  published_on: z.iso.date().optional(), observed_on: z.iso.date().optional(),
  date_basis: z.enum(["effective", "publication", "observed"]).default("effective"),
});
export type WebEmployeeEvidence = z.infer<typeof webEmployeeEvidenceSchema>;
export type EmployeeDocumentResult = { evidence: WebEmployeeEvidence | null; reason: string };
const isoDate = z.iso.date();
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const number = "(?:\\d{1,3}(?:[, \\u00a0]\\d{3})+|\\d+(?:\\.\\d+)?)";
const countPattern = new RegExp(`((?:more than|over|at least|approximately|about|around|roughly|some)\\s+)?(${number})\\s*(thousand|million|k)?\\s*(?:\\+|-plus)?\\s*(?:(?:talented|dedicated|passionate|skilled|global)\\s+)?(?:full[ -]time\\s+|permanent\\s+)?(employees?|people|colleagues|team members|staff|associates)\\b`, "gi");
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function documentDates(text: string): string[] {
  const dates: string[] = [];
  for (const match of text.matchAll(/(?<!\d)(20\d{2}-\d{2}-\d{2})(?!\d)/g)) dates.push(match[1]);
  const months = MONTHS.join("|");
  for (const match of text.matchAll(new RegExp(`\\b(${months})\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(20\\d{2})\\b`, "gi"))) {
    dates.push(`${match[3]}-${String(MONTHS.indexOf(match[1].toLowerCase()) + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}`);
  }
  for (const match of text.matchAll(new RegExp(`\\b(\\d{1,2})\\s+(${months})\\s+(20\\d{2})\\b`, "gi"))) {
    dates.push(`${match[3]}-${String(MONTHS.indexOf(match[2].toLowerCase()) + 1).padStart(2, "0")}-${match[1].padStart(2, "0")}`);
  }
  return [...new Set(dates.filter(value => isoDate.safeParse(value).success))];
}

// Publication dates are used only for present-tense workforce statements in dated articles.
// A page's modification time or copyright year is not a headcount effective date.
export function publishedDate(html: string): string | null {
  const values: string[] = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/(?:property|name)=["'](?:article:published_time|date|datePublished|pubdate)["']/i.test(match[0])) continue;
    const content = match[0].match(/content=["']([^"']+)["']/i)?.[1];
    if (content) values.push(...documentDates(content));
  }
  const primary = [...new Set(values)];
  if (primary.length) return primary.length === 1 ? primary[0] : null;
  for (const match of html.matchAll(/["']datePublished["']\s*:\s*["']([^"']+)["']/gi)) values.push(...documentDates(match[1]));
  const dates = [...new Set(values)];
  if (dates.length) return dates.length === 1 ? dates[0] : null;
  const afterHeading = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>([\s\S]{0,12000})/i)?.[1];
  const visibleDates = afterHeading ? documentDates(htmlToText(afterHeading).slice(0, 1200)) : [];
  return visibleDates.length === 1 ? visibleDates[0] : null;
}

export function employeeEvidenceFromDocument(input: { text: string; companyName: string; source: string; published?: string | null; allowObserved?: boolean }, now: Date): EmployeeDocumentResult {
  if (input.published && (daysSince(input.published, now) ?? -1) < 0) return { evidence: null, reason: "Publication date is in the future or invalid." };
  const company = normalizeName(input.companyName);
  if (!company) return { evidence: null, reason: "Company identity is missing." };
  // Permit a brand shorthand only for a non-entity-changing industry descriptor.
  const brand = company.replace(/ pharmaceuticals$/, "");
  const subject = new RegExp(`\\b(?:${escape(company)}|${escape(brand)}|we|our company|our group|our|the company|the group)\\b`, "i");
  if (/\/(?:customers?|case-studies|testimonials?|partners?|community|forums?)(?:[-/]|$)/i.test(new URL(input.source).pathname)) {
    return { evidence: null, reason: "Customer, partner and community pages cannot establish the publisher's own workforce." };
  }
  const text = input.text.replace(/\u00ad/g, "").replace(/\s+/g, " ");
  const candidates: WebEmployeeEvidence[] = employeeTableEvidence(input.text, input.companyName, input.source, now);
  for (const match of text.matchAll(countPattern)) {
    // Do not accept the tail of a range, malformed grouping, or decimal without units.
    if (/[\d,.–—-]$/.test(text.slice(0, match.index).trimEnd()) ||
      (match[2].includes(".") && !match[3])) continue;
    const start = Math.max(0, match.index! - 400);
    const prefix = text.slice(start, match.index);
    const sentenceStart = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('! '), prefix.lastIndexOf('? '));
    const lead = prefix.slice(sentenceStart < 0 ? 0 : sentenceStart + 2);
    // Workday descriptions can carry a local employer-profile heading directly
    // before the count after HTML is flattened: “Shell in the US With ...”.
    if (new RegExp(`\\b${escape(brand)}\\s+(?:in|across|within)\\b[^.!?]{0,100}\\bwith\\s*$`, "i").test(lead)) continue;
    // “People” can be customers or beneficiaries. A distant “we have” is
    // insufficient (for example, “we have helped 700,000 people to hear”).
    // Require a workforce predicate immediately before the number/qualifier.
    if (/^people$/i.test(match[4]) && !/\b(?:employs?|employed|employing|(?:team|workforce)(?:\s+of)?|has|have|had|are|we['’]re|we['’]ve|with)\s*$/i.test(lead)) continue;
    const tail = text.slice(match.index! + match[0].length, match.index! + match[0].length + 200)
      // A separately numbered customer population is not a qualifier of employees.
      .replace(/^\s+and\s+[\d,.]+\s+customers?\b[\s\S]*/i, "");
    const full = `${lead}${match[0]}${tail.split(/\.\s/)[0]}`;
    const namedGroup = full.match(/\b([A-Z][A-Za-z0-9&-]+)\s+Group\b/)?.[1];
    if (namedGroup && normalizeName(namedGroup) !== brand) continue;
    if (/\bgroup\b/i.test(full) && !/\bgroup\b/i.test(input.companyName)) continue;
    const namedAfterCount = new RegExp(`^\\s*,?\\s*${escape(brand)}\\b`, "i").test(tail);
    if (!subject.test(lead) || !(/\b(has|have|had|are|we['’]re|we['’]ve|employs?|employed|employing|workforce|team|delivery model)\b/i.test(lead) || /\b(?:with|our(?: global)?)\s*$/i.test(lead) || (namedAfterCount && /\bwith\b.*\bour\b/i.test(lead)))) continue;
    if (/\b(subsidiar\w*|acquir\w*|dealers?|customers?|clients?|suppliers?|contractors?|graduates?|hired|hiring|recruit|between|up to|fewer than|less than|previously)\b/i.test(lead)) continue;
    if (/^(?:\s+(?:based |working )?in\s+)(?!more than|over|approximately|\d|countries|locations|offices)/i.test(tail)) continue;
    // Scope and modality apply to the entire claim, including qualifiers after the count.
    if (/\b(will|would|could|may|might|plans?|planned|planning|aims?|targets?|expects?|expected|forecast|projected|ambition|not|never|no longer|is not|has not|have not|doesn['’]t|don['’]t|isn['’]t|aren['’]t|won['’]t|cannot|can['’]t|nearly|almost|up to|fewer than|less than|between|ranging|subsidiar\w*|acquir\w*|customers?|clients?|dealers?|suppliers?|contractors?|independent|member firms?|network of|partners?|which|who|part[ -]time|full[ -]time equivalents?|FTEs?)\b/i.test(full)) continue;
    if (/\d\s*(?:-|–|—|to)\s*$/.test(lead) || /^\s*(?:-|–|—|to)\s*\d/.test(tail)) continue;
    // A location or business-unit qualifier cannot establish an employer-wide total.
    if (/^\s+(?:(?:based|working|located)\s+)?(?:in|at|across|within|for)\s+(?!more than|over|approximately|\d|countries\b|locations\b|offices\b|the world\b)/i.test(tail)) continue;
    const nearbyDates = documentDates(full);
    if (nearbyDates.length > 1) continue;
    // A date elsewhere in the sentence is not automatically an effective date.
    if (nearbyDates.length && !/\b(as of|as at|on|at (?:the )?end of|at)\s+(?:[A-Za-z]+\s+)?(?:\d|[A-Za-z]+\s+\d)/i.test(full)) continue;
    const historicalYear = /\b(?:in|during|as of|as at)\s+20\d{2}\b/i.test(full);
    const currentStatement = nearbyDates.length === 0 && !historicalYear && !/\b(had|employed)\b/i.test(lead);
    const date_basis = nearbyDates.length === 1 ? "effective" : input.published ? "publication" : "observed";
    const as_of = nearbyDates.length === 1 ? nearbyDates[0] : currentStatement
      ? input.published ?? (input.allowObserved ? chicagoToday(now) : null) : null;
    const age = daysSince(as_of, now);
    if (!as_of || age === null || age < 0 || age > 548) continue;
    const multiplier = /million/i.test(match[3] ?? "") ? 1e6 : match[3] ? 1000 : 1;
    const employee_count = Number(match[2].replace(/[, \u00a0]/g, "")) * multiplier;
    const evidence = webEmployeeEvidenceSchema.safeParse({ employee_count, as_of, date_basis, observed_on: chicagoToday(now), ...(input.published ? { published_on: input.published } : {}), source: input.source,
      quote: full.trim().slice(0, 1000), basis: /[~≈]\s*$/.test(lead) ? "approximate"
        : /more than|over|at least/i.test(match[1] ?? "") || /\+|-plus/i.test(match[0]) ? "lower_bound"
        : match[1] ? "approximate" : "exact" });
    if (evidence.success) candidates.push(evidence.data);
  }
  candidates.sort((a, b) => b.as_of.localeCompare(a.as_of));
  const latest = candidates[0];
  if (!latest) return { evidence: null, reason: "No current, dated statement about the employer's workforce was established." };
  if (candidates.some(row => row.as_of === latest.as_of && row.employee_count !== latest.employee_count)) {
    return { evidence: null, reason: "Conflicting workforce counts for the same date require review." };
  }
  return { evidence: latest, reason: "Dated employer workforce statement found." };
}

export function employeeEvidenceFromHtml(html: string, companyName: string, source: string, now: Date) {
  const path = new URL(source).pathname;
  const allowObserved = (path === "/" || /\/(about|company|our-company|who-we-are|careers|corporate|facts)(?:[-/]|$)/i.test(path))
    && !/reports?|annual|press|news|\b20\d{2}\b/i.test(path);
  const published = publishedDate(html);
  const prose = employeeEvidenceFromDocument({ text: htmlToText(html), companyName, source, published, allowObserved }, now);
  if (/Conflicting|Customer, partner|Publication date/.test(prose.reason)) return prose;
  // Organization JSON-LD is useful for corporate fact cards. Do not recurse into
  // customers, subsidiaries, departments, or job-posting hiringOrganization nodes.
  const structured: WebEmployeeEvidence[] = [];
  for (const script of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const root = JSON.parse(script[1]);
      const nodes = Array.isArray(root) ? root : [root, ...(Array.isArray(root?.["@graph"]) ? root["@graph"] : [])];
      for (const node of nodes.slice(0, 100)) {
        if (!node || ![node["@type"]].flat().some(t => t === "Organization" || t === "Corporation") ||
          normalizeName(node.legalName ?? node.name) !== normalizeName(companyName) ||
          /\bgroup\b/i.test(node.legalName ?? node.name) !== /\bgroup\b/i.test(companyName)) continue;
        const count = node.numberOfEmployees;
        const value = typeof count === "number" ? count : count?.value;
        if (typeof value !== "number" || (typeof count === "object" &&
          (count.minValue !== undefined || count.maxValue !== undefined ||
           (count.unitText && !/^employees?$/i.test(count.unitText)) || count.unitCode))) continue;
        const as_of = published ?? (allowObserved ? chicagoToday(now) : null);
        const age = daysSince(as_of, now);
        if (!as_of || age === null || age < 0 || age > 548) continue;
        const parsed = webEmployeeEvidenceSchema.safeParse({ employee_count: value, as_of, source, observed_on: chicagoToday(now), ...(published ? { published_on: published } : {}),
          quote: JSON.stringify({ name: node.legalName ?? node.name, numberOfEmployees: count }),
          basis: "exact", date_basis: published ? "publication" : "observed" });
        if (parsed.success) structured.push(parsed.data);
      }
    } catch { /* malformed structured data never establishes headcount */ }
  }
  // Short corporate fact cards are employer statements even without a sentence.
  // Require publisher identity, an eligible corporate profile page, and an entire
  // card containing only an employee total. Customer cards and prose cannot match.
  const profile = allowObserved || /\/(?:company-news|newsroom)\/?$/i.test(path);
  const identity = pageIdentity(html, companyName) || pageIdentity(html, `${normalizeName(companyName)} newsroom`);
  if (profile && identity) for (const card of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const quote = htmlToText(card[1]).replace(/\s+/g, " ").trim();
    const count = quote.match(/^(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|thousand|million)?\s*(\+)?\s+(?:global |worldwide )?employees(?: worldwide| globally)?$/i);
    if (!count) continue;
    const value = Number(count[1].replaceAll(",", "")) * (/million/i.test(count[2] ?? "") ? 1e6 : count[2] ? 1000 : 1);
    const as_of = published ?? chicagoToday(now);
    const age = daysSince(as_of, now);
    if (age === null || age < 0 || age > (published ? 548 : 30)) continue;
    const parsed = webEmployeeEvidenceSchema.safeParse({ employee_count: value, as_of, source, quote,
      basis: count[3] ? "lower_bound" : "exact", date_basis: published ? "publication" : "observed",
      ...(published ? { published_on: published } : {}), observed_on: chicagoToday(now) });
    if (parsed.success) structured.push(parsed.data);
  }
  const candidates = [...(prose.evidence ? [prose.evidence] : []), ...structured].sort((a, b) => b.as_of.localeCompare(a.as_of));
  const latest = candidates[0];
  if (latest && candidates.some(row => row.as_of === latest.as_of && row.employee_count !== latest.employee_count)) {
    return { evidence: null, reason: "Conflicting workforce counts for the same date require review." };
  }
  return latest ? { evidence: latest, reason: "Official employer workforce statement found with its date basis recorded." } : prose;
}
