import { normalizeName } from "../domain/ingestion/normalize.ts";
import { chicagoToday, daysSince } from "../domain/scoring/go-live.ts";
import { linkedinProfile, type ContactReview } from "./contact-review.ts";

export const CONTACT_EVIDENCE_SEARCH = "tinyfish.web.search";
const WORKDAY_PUBLISHERS = new Set(["workday", "paradoxolivia"]);
const COMPANY_SUFFIX = "(?:inc|incorporated|corp|corporation|company|co|llc|limited|ltd|plc|group|holdings)";
const WORKDAY_RESPONSIBILITY = new RegExp(`^(?:${COMPANY_SUFFIX} )*where (?:she|he|they) (?:own|lead|oversee)s? (?:the )?workday (?:platform|roadmap|program|product)\\b`);
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const CLOSED_PERIOD = new RegExp(`^(?:${COMPANY_SUFFIX} )*${MONTH} (?:19|20)\\d\\d ${MONTH} (?:19|20)\\d\\d\\b`);
const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const contains = (text: string, words: string) => ` ${text} `.includes(` ${words} `);
const titleWords = (title: string) => normalize(title)
  .replace(/\bsvp\b/g, "senior vice president").replace(/\bevp\b/g, "executive vice president")
  .replace(/\bvp\b/g, "vice president").replace(/\bof\b\s*/g, "").trim();

export type EvidenceCandidate = { name: string; title: string; profile: string };
type IndexedResult = { url: string; title: string; snippet: string };
export type AutomatedContactReview = ContactReview & {
  method: "public_search_index";
  indexed_quote: string;
  profile_quote: string;
};

export function contactEvidenceQuery(candidate: EvidenceCandidate, companyName: string): string {
  const role = titleWords(candidate.title).replace(/^(?:(?:executive|senior) )?vice president\s+/, "");
  return [normalize(candidate.name), normalizeName(companyName), role].map(part => `"${part.slice(0, 110)}"`).join(" ");
}

function publisherPost(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.host !== "www.linkedin.com" || url.username || url.password) return null;
    const match = url.pathname.match(/^\/posts\/([\w-]+)_[^/]+-activity-(\d{19})-[\w-]+\/?$/);
    if (!match) return null;
    // LinkedIn activity IDs include an epoch timestamp in the upper bits.
    const published = new Date(Number(BigInt(match[2]) >> BigInt(22))).toISOString().slice(0, 10);
    return { publisher: match[1].toLowerCase(), published };
  } catch { return null; }
}

// The index is only accepted for an exact profile plus an independent, recent
// publisher attribution. Provider titles and third-party contact directories do not confer credit.
export function reviewIndexedContact(body: unknown, candidate: EvidenceCandidate, company: { name: string; domain: string }, now: Date): AutomatedContactReview | null {
  const raw = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(raw)) return null;
  const rows = (raw.slice(0, 10) as Partial<IndexedResult>[]).filter((row): row is IndexedResult =>
    typeof row?.url === "string" && typeof row.title === "string" && typeof row.snippet === "string")
    .map(row => ({ ...row, snippet: row.snippet.slice(0, 1000) }));
  const name = normalize(candidate.name), title = titleWords(candidate.title), employer = normalizeName(company.name);
  if (!name || !title || !employer) return null;
  const namesCandidate = (row: IndexedResult) => `${normalize(row.title)} `.startsWith(`${name} `);
  const profile = rows.find(row => linkedinProfile(row.url) === candidate.profile && namesCandidate(row));
  const review = { company_domain: company.domain, linkedin_url: candidate.profile, method: "public_search_index" as const };
  const attributed = rows.flatMap(row => {
    const post = publisherPost(row.url);
    const age = daysSince(post?.published, now);
    if (!post || age === null || age < 0 || age > 90) return [];
    const employerHandle = employer.replace(/ /g, "");
    if (!WORKDAY_PUBLISHERS.has(post.publisher) && post.publisher !== employerHandle) return [];
    // Require the publisher to name this person, title, and employer together.
    const text = titleWords(row.snippet);
    const start = text.indexOf(`${name} `);
    if (start < 0 || (start > 0 && text[start - 1] !== " ")) return [];
    const attribution = text.slice(start + name.length + 1).replace(/^(?:(?:cpa|mba|pmp|shrm|is|the) )+/, "");
    const role = `${title} at ${titleWords(employer)}`;
    if (!`${attribution} `.startsWith(`${role} `)) return [];
    const responsibility = attribution.slice(role.length).trim();
    const ownsWorkday = WORKDAY_RESPONSIBILITY.test(responsibility);
    return [{ row, published: post.published, ownsWorkday }];
  }).sort((a, b) => b.published.localeCompare(a.published))[0];
  if (profile && attributed && contains(titleWords(profile.snippet), title) && contains(normalize(profile.snippet), employer)) {
    return { ...review, status: "confirmed", title: candidate.title, source: attributed.row.url, reviewed_on: attributed.published,
      ...(attributed.ownsWorkday ? { workday_source: attributed.row.url } : {}),
      indexed_quote: attributed.row.snippet, profile_quote: profile.snippet };
  }

  // An old generated profile slug can resolve to a custom one. Require the
  // same full name and slug stem plus an explicit closed employment period.
  const slugStem = (url: string) => linkedinProfile(url)?.replace(/-[a-f0-9]{7,12}$/, "");
  const employment = rows.find(row => slugStem(row.url) === slugStem(candidate.profile) &&
    namesCandidate(row) && contains(normalize(row.snippet), employer));
  if (!employment) return null;
  const snippet = normalize(employment.snippet);
  const [lead, ...history] = snippet.split(` ${employer} `);
  const [, currentTitle, currentEmployer] = employment.snippet.split("·", 3);
  // The indexed profile must also show a current heading before its history.
  if (history.length !== 1 || !CLOSED_PERIOD.test(history[0]) || !lead || !currentTitle?.trim() || !currentEmployer?.trim() ||
      titleWords(currentTitle) === title || contains(snippet, "present")) return null;
  return { ...review, status: "different_employer", source: employment.url, reviewed_on: chicagoToday(now),
    indexed_quote: employment.snippet, profile_quote: employment.snippet };
}
