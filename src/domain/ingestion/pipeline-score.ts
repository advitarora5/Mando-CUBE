import type { Category } from "../contracts/company.ts";
import { buildAssessment, type AssessmentResult, type CategoryInput } from "../scoring/assessment.ts";
import { daysSince, chicagoToday } from "../scoring/go-live.ts";
import { firstReleaseOnOrAfter } from "../scoring/releases.ts";
import { rubric, TEAM_RUBRIC_70 } from "../scoring/rubric.ts";
import { isSignalFresh, readyForContacts, type PipelineSettings } from "./settings.ts";
import { authorityBand, classifyTitle } from "./titles.ts";

// Pipeline scoring = the Mando team scoring rubric (provisional team revision, 2026-10-13; Qualified 70+, Maybe 55+),
// applied to what the pipeline collects: sourced signals and contacts. Weights and the evidence gate are the shared
// rubric's (src/domain/scoring). Rules the pipeline cannot evidence automatically (annual operating income, confirmed
// release dates, a willing introducer) earn nothing and say so: "Needs evidence", never an invented fact or URL.
// The rubric version decides the tier thresholds (src/domain/scoring/rubric.ts tierThresholdsFor).
export const PIPELINE_POLICY_VERSION = "pipeline-v2";
export const PIPELINE_RUBRIC_VERSION = `${TEAM_RUBRIC_70}:${PIPELINE_POLICY_VERSION}`;

export const signalTypes = ["go_live", "hiring", "release_planning", "known_customer", "budget_clue", "event"] as const;
export type SignalType = (typeof signalTypes)[number];
export const projectTypes = ["implementation", "release_testing", "integration", "support"] as const;
export type ProjectType = (typeof projectTypes)[number];

export type ScoringSignal = {
  type: SignalType;
  signal_date: string | null;
  source_url: string;
  quote: string;
  confidence: number;
  first_seen_at: string;
  last_seen_at: string;
  project_type?: ProjectType | null;
};

export type ScoringContact = {
  name: string;
  title: string | null;
  source: string | null;
  linkedin_url: string | null;
  // provided / confirmed = a person entered or checked the profile; unconfirmed = found by the people search.
  linkedin_status?: string | null;
  email: string | null;
  email_status: string | null;
  email_source?: string | null;
  phone: string | null;
  phone_status: string | null;
  phone_source?: string | null;
  mutual_connection: string | null;
  // Provenance written by enrichment; its presence marks a contact found automatically.
  contact_sources?: unknown;
  // Dated personal HR-tech/Workday initiative, case study or event: { source, reason, date }.
  conviction?: { source: string; reason: string; date?: string | null } | null;
};

// Company facts the rubric uses. Employee count earns the +3 Authority bonus only with a source link.
export type ScoringCompany = { employee_count: number | null; employee_source?: string | null };

export type CategoryResult = CategoryInput & { status: "met" | "partial" | "unknown" | "not_met"; detail: Record<string, number> };

const http = (value: string | null | undefined) => (value && /^https?:\/\//i.test(value) ? value : null);
const short = (quote: string, max = 90) => (quote.length > max ? `${quote.slice(0, max - 3)}...` : quote).replace(/\s+/g, " ");
// Category reasons stay at most 240 characters (team rubric, excluding the URL).
const clip = (reason: string) => (reason.length > 240 ? `${reason.slice(0, 237)}...` : reason);
const needs = (what: string, detail: Record<string, number> = {}): CategoryResult =>
  ({ score: 0, source: null, reason: `Needs evidence: ${what}`, status: "unknown", detail });
const withinMonths = (date: string | null | undefined, months: number, now: Date) => {
  const days = daysSince(date, now);
  return days !== null && days >= 0 && days <= Math.round(months * 30.44);
};

// A contact counts as "confirmed current" when a person entered or confirmed them; people-search results do not.
export function confirmedCurrent(contact: ScoringContact): boolean {
  if (contact.linkedin_status === "confirmed" || contact.linkedin_status === "provided") return true;
  const found = contact.contact_sources && typeof contact.contact_sources === "object" && "name_title_linkedin" in (contact.contact_sources as object);
  return !found && !!http(contact.source);
}

// ---------- Authority /25: one role base per contact + bonuses for confirmed current contacts; best contact wins ----------
export function authorityFromContacts(contacts: ScoringContact[], company: ScoringCompany = { employee_count: null }): CategoryResult {
  if (!contacts.length) return needs("no named relevant contact yet; contact lookup is pending.");
  const rated = contacts.map(contact => {
    const band = authorityBand(contact.title);
    const confirmed = confirmedCurrent(contact);
    // A relevant person whose current role is unconfirmed gets the 5-point band and no bonuses.
    const base = confirmed ? band.base : Math.min(band.base, 5);
    const eligible = confirmed && base > 0;
    const size = eligible && (company.employee_count ?? 0) >= 3000 && http(company.employee_source) ? 3 : 0;
    const workday = eligible && classifyTitle(contact.title).ownsWorkday === 4 ? 2 : 0;
    return { contact, band, confirmed, base, size, workday, score: Math.min(rubric.authority.weight, base + size + workday), source: http(contact.source) ?? http(contact.linkedin_url) };
  }).filter(r => r.source).sort((a, b) => b.score - a.score);
  if (!rated.length) return needs("contacts have no source link for their role.");
  const best = rated[0];
  if (!best.score) return { score: 0, source: best.source, status: "not_met", detail: { base: 0 }, reason: clip(`${best.contact.name}, ${best.contact.title ?? "title unknown"}: no relevant HR/IT systems role.`) };
  const missing = !best.confirmed ? " Current role not yet confirmed (found by people search)." : !best.size ? " 3,000+ employer size not sourced." : "";
  return {
    score: best.score, source: best.source, status: best.confirmed ? "met" : "partial",
    detail: { base: best.base, size: best.size, workday: best.workday },
    reason: clip(`${best.contact.name}, ${best.contact.title}: ${best.confirmed ? best.band.label : "role unconfirmed"} ${best.base} + size ${best.size} + Workday owner ${best.workday}.${missing}`),
  };
}

// ---------- Reachability /25: one route base per person + bonuses for confirmed current relevant contacts ----------
export function reachabilityFromContacts(contacts: ScoringContact[]): CategoryResult {
  if (!contacts.length) return needs("no named contact yet; contact lookup is pending.");
  const rated = contacts.map(contact => {
    // Published (sourced) or provider-verified work email; published direct phone. A live line alone is not ownership.
    const emailSource = contact.email ? (http(contact.email_source) ?? (contact.email_status === "valid" ? http(contact.source) ?? http(contact.linkedin_url) : null)) : null;
    const phoneSource = contact.phone ? http(contact.phone_source) : null;
    const linkedin = http(contact.linkedin_url) && (contact.linkedin_status === "confirmed" || contact.linkedin_status === "provided") ? http(contact.linkedin_url) : null;
    const base = emailSource && phoneSource ? 20 : emailSource || phoneSource ? 15 : linkedin ? 10 : 0;
    const route = emailSource && phoneSource ? "named work email and direct phone" : emailSource ? "named work email" : phoneSource ? "direct phone" : linkedin ? "confirmed LinkedIn only" : "no sourced route";
    const eligible = confirmedCurrent(contact) && classifyTitle(contact.title).functional > 0 && base > 0;
    const linkedinBonus = eligible && base >= 15 && linkedin ? 3 : 0;
    const initiative = eligible && contact.conviction && http(contact.conviction.source) && withinMonths(contact.conviction.date, 24, new Date()) ? 3 : 0;
    const intro = eligible && /willing|introduc/i.test(contact.mutual_connection ?? "") ? 5 : 0;
    return { contact, base, route, linkedinBonus, initiative, intro, score: Math.min(rubric.reachability.weight, base + linkedinBonus + initiative + intro), source: emailSource ?? phoneSource ?? linkedin };
  }).sort((a, b) => b.score - a.score);
  const best = rated[0];
  if (!best.score || !best.source) return needs(`no published or verified work email, direct phone or confirmed LinkedIn for ${contacts.length} contact(s).`);
  return {
    score: best.score, source: best.source, status: "met",
    detail: { base: best.base, linkedin: best.linkedinBonus, initiative: best.initiative, introduction: best.intro },
    reason: clip(`${best.contact.name}: ${best.route} ${best.base} + LinkedIn ${best.linkedinBonus} + dated initiative ${best.initiative} + willing introduction ${best.intro}. Not verified unless stated.`),
  };
}

// ---------- Budget /20: financial capacity + the single highest technology-investment band (proxies) ----------
export function budgetFromSignals(signals: ScoringSignal[], now: Date): CategoryResult {
  // Financial capacity needs matching-entity annual operating income, which the pipeline does not collect yet: 0 points.
  const options: { points: number; signal: ScoringSignal; label: string }[] = [];
  for (const s of signals) {
    if (s.type === "budget_clue" && withinMonths(s.signal_date, 24, now)) options.push({ points: 8, signal: s, label: "adjacent tool purchase/deployment within 24 months" });
    else if (s.type === "budget_clue") options.push({ points: 3, signal: s, label: "undated adjacent-tool adoption" });
    if (s.project_type === "implementation") options.push({ points: 6, signal: s, label: "active HR modernization (Workday implementation)" });
  }
  const best = options.sort((a, b) => b.points - a.points)[0];
  if (!best) return needs("no technology-investment signal; annual operating income not collected.");
  return { score: best.points, source: best.signal.source_url, status: "partial", detail: { capacity: 0, investment: best.points },
    reason: clip(`Capacity 0 (operating income not collected) + ${best.label} ${best.points}; proxy, not committed funds: "${short(best.signal.quote)}"`) };
}

// ---------- Release /15: confirmed current deployment, then the confirmed next release's distance ----------
export function releaseFromSignals(signals: ScoringSignal[], now: Date): CategoryResult {
  const deployed = signals.find(s => s.type === "known_customer")
    ?? signals.find(s => s.type === "release_planning")
    ?? signals.find(s => s.type === "go_live" && s.signal_date && (daysSince(s.signal_date, now) ?? -1) >= 0);
  if (!deployed) return needs("current Workday deployment not confirmed.");
  const today = chicagoToday(now);
  const next = firstReleaseOnOrAfter(today);
  const days = Math.round((Date.parse(next.date) - Date.parse(today)) / 86400000);
  const preparing = signals.find(s => s.type === "release_planning");
  let score = 8, band = "deployment affected by recurring releases";
  // Only public, documented preparation (a release_planning signal) lifts the score above the baseline.
  if (next.confirmed && preparing && days >= 42 && days <= 84) { score = 15; band = "42-84 days before confirmed release, with documented preparation"; }
  else if (next.confirmed && preparing && days >= 85 && days <= 126) { score = 10; band = "85-126 days before confirmed release, with documented preparation"; }
  const note = !next.confirmed ? " Next release date is estimated, so higher bands cannot apply." : !preparing ? " No public release preparation found, so higher bands cannot apply." : "";
  return { score, source: (score >= 15 && preparing ? preparing : deployed).source_url, status: "met", detail: { days },
    reason: clip(`${band} ${score}: ${next.name} ${next.confirmed ? "on" : "estimated for"} ${next.date}, ${days} days.${note}`) };
}

// ---------- Timing /15: the strongest single trigger; triggers do not stack ----------
export function timingFromSignals(signals: ScoringSignal[], now: Date): CategoryResult {
  const candidates: { points: number; signal: ScoringSignal; why: string }[] = [];
  for (const s of signals) {
    const days = daysSince(s.signal_date, now);
    if (s.type === "go_live" && days !== null) {
      if (days < 0 && days >= -183) candidates.push({ points: 15, signal: s, why: `go-live milestone in ${-days} days` });
      else if (days >= 0 && days <= 183) candidates.push({ points: 12, signal: s, why: `completed go-live ${days} days ago` });
      else if (days > 183 && days <= 365) candidates.push({ points: 10, signal: s, why: `dated rollout ${days} days ago` });
    } else if (s.type === "go_live") {
      candidates.push({ points: 5, signal: s, why: "go-live without a day-precise date: current operations baseline" });
    } else if (s.type === "hiring" && s.confidence >= 0.8 && withinMonths(s.signal_date ?? s.first_seen_at.slice(0, 10), 12, now)) {
      candidates.push({ points: 8, signal: s, why: "employer-posted Workday hiring within 12 months" });
    } else if (s.type === "known_customer" || s.type === "hiring") {
      candidates.push({ points: 5, signal: s, why: "current Workday operations, no recent dated trigger" });
    }
  }
  const best = candidates.sort((a, b) => b.points - a.points)[0];
  if (!best) return needs("no go-live, rollout, Workday hiring or current-operations signal in the last 14 days.");
  return { score: best.points, source: best.signal.source_url, status: "met", detail: { points: best.points },
    reason: clip(`${best.why} (${best.points}): "${short(best.signal.quote)}"`) };
}

export type PipelineAssessment = {
  result: AssessmentResult;
  categories: Record<Category, CategoryResult>;
  ready_for_contacts: boolean;
  fresh_signals: number;
};

// Builds an insert-ready score row through the shared buildAssessment and tier evaluator (Qualified 70 for this version).
export function scoreCompany(companyId: string, signals: ScoringSignal[], contacts: ScoringContact[], settings: PipelineSettings, now: Date = new Date(), company: ScoringCompany = { employee_count: null }): PipelineAssessment {
  const fresh = signals.filter(s => s.type === "go_live" || isSignalFresh(s, settings, now));
  const categories: Record<Category, CategoryResult> = {
    authority: authorityFromContacts(contacts, company),
    reachability: reachabilityFromContacts(contacts),
    budget: budgetFromSignals(fresh, now),
    release: releaseFromSignals(fresh, now),
    timing: timingFromSignals(fresh, now),
  };
  const inputs = Object.fromEntries(Object.entries(categories).map(([key, c]) =>
    [key, { score: c.score, source: c.source, reason: `Assessment status: ${c.status}. ${c.reason}` }])) as Record<Category, CategoryInput>;
  const result = buildAssessment(companyId, inputs, { rubricVersion: PIPELINE_RUBRIC_VERSION });
  if (result.ok) {
    // An unsourced zero keeps its "Needs evidence" text without a link; a URL is never invented.
    for (const [key, c] of Object.entries(categories)) {
      if (!c.source) result.row[`${key as Category}_evidence`] = inputs[key as Category].reason ?? "";
    }
  }
  const ready = result.ok && readyForContacts(result.row, settings);
  return { result, categories, ready_for_contacts: ready, fresh_signals: fresh.length };
}
