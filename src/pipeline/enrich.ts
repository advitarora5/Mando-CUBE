// Contact discovery and completion are evidence-gated, independent of qualification scores.
import { randomUUID } from "node:crypto";
import { completeContact, contactNeedsCompletion } from "../../scripts/contact-completion.mjs";
import { completionClient, ContactBudgetReached } from "./contact-completion.ts";
import { paidCallKey } from "../domain/ingestion/fingerprint.ts";
import { mayScore } from "../domain/ingestion/settings.ts";
import { parseEvidence } from "../domain/scoring/evidence.ts";
import { authorityFromContacts, confirmedCurrent, differentEmployer, reachabilityFromContacts, type ScoringSignal } from "../domain/ingestion/pipeline-score.ts";
import type { PipelineSettings } from "../domain/ingestion/settings.ts";
import { authorityBand, classifyTitle } from "../domain/ingestion/titles.ts";
import { daysSince } from "../domain/scoring/go-live.ts";
import { currentContactReviews, linkedinProfile, type ContactReview } from "./contact-review.ts";
import { CONTACT_EVIDENCE_SEARCH, contactEvidenceQuery, reviewIndexedContact, type AutomatedContactReview, type EvidenceCandidate } from "./contact-verification.ts";
import { scoreStage, type StageResult } from "./stages.ts";
import type { ContactRow, PipelineContext } from "./types.ts";

export const PEOPLE_SEARCH = "quickenrich.people.search"; // free on treg; returns names, titles and LinkedIn URLs, never emails
export const EMAIL_FIND = "treg.people.email.find";
export const TITLE_PHRASES = ["Human Resources", "HRIS", "People", "Workday", "Enterprise Applications", "Information Technology", "IT Operations", "Information Systems"];
export const FOCUSED_TITLE_PHRASES = ["Workday", "HRIS", "HR Technology", "HR Service Delivery", "People Systems", "HCM"];
export const MAX_CONTACTS_PER_COMPANY = 3;
export const MAX_EMAIL_LOOKUPS_PER_COMPANY = 2;

type FoundPerson = { first_name?: string; last_name?: string; title?: string; employee_linkedin?: string; company_name?: string; employee_count?: string };
const MAX_EVIDENCE_SEARCHES = 10;
const DAY_MS = 86400000;

function storedContactProvenance(contact: ContactRow) {
  return (contact.contact_sources ?? {}) as Record<string, unknown> & {
    name_title_linkedin?: { fetched_at?: string };
    role_review?: ContactReview | AutomatedContactReview;
    role_verification_attempt?: string;
  };
}

function contactRefreshDue(contact: ContactRow, now: Date) {
  const provenance = storedContactProvenance(contact);
  if (!provenance.name_title_linkedin || differentEmployer(contact)) return false;
  const review = provenance.role_review;
  if (review && (typeof review !== "object" || !("method" in review) || (daysSince(review.reviewed_on, now) ?? 0) < 76)) return false;
  if (!review && contact.linkedin_status !== "unconfirmed") return false;
  const last = Date.parse(provenance.role_verification_attempt ?? provenance.name_title_linkedin.fetched_at ?? "");
  return !Number.isFinite(last) || now.getTime() - last >= 7 * DAY_MS;
}

function contactCandidates(people: FoundPerson[], reviews: Map<string, ContactReview>) {
  const seen = new Set<string>();
  return people.flatMap(person => {
    const profile = linkedinProfile(person?.employee_linkedin);
    if (!profile || seen.has(profile) || typeof person.first_name !== "string" || typeof person.last_name !== "string" ||
        typeof person.title !== "string" || !person.first_name.trim() || !person.last_name.trim()) return [];
    const review = reviews.get(profile);
    if (review?.status === "different_employer") return [];
    const title = review?.title ?? person.title;
    const potential = authorityBand(title).base;
    if (!potential && !review?.workday_source) return [];
    seen.add(profile);
    return [{ person, profile, review, name: `${person.first_name.trim()} ${person.last_name.trim()}`, title, potential }];
  });
}

type Candidate = ReturnType<typeof contactCandidates>[number];
function candidateContact({ name, title, profile, review }: Candidate, now: Date) {
  return {
    name, title, linkedin_url: profile, source: review?.source ?? profile,
    email: null, email_status: null, phone: null, phone_status: null, mutual_connection: null,
    linkedin_status: review ? "confirmed" : "unconfirmed", enriched_at: now.toISOString(),
    contact_sources: {
      name_title_linkedin: { provider: "quickenrich via treg", endpoint: PEOPLE_SEARCH, fetched_at: now.toISOString(), cost_usd: 0 },
      ...(review ? { role_review: review } : {}),
    },
  };
}

export function pickContacts(people: FoundPerson[], max = MAX_CONTACTS_PER_COMPANY, reviews = new Map<string, ContactReview>(), now = new Date()) {
  return contactCandidates(people, reviews).map(candidate => {
    const contact = candidateContact(candidate, now);
    return { ...candidate, contact, authority: authorityFromContacts([contact], undefined, now).score,
      reachability: reachabilityFromContacts([contact], now).score, seniority: classifyTitle(candidate.title).seniority };
  }).sort((a, b) => b.authority - a.authority || b.reachability - a.reachability ||
    b.potential - a.potential || b.seniority - a.seniority || a.profile.localeCompare(b.profile)).slice(0, max);
}

type EmailOutcome = { email: string | null; status: "valid" | "risky" | "invalid" | "not_found"; served_by: string | null };

// Reads treg's routed email-find answer: {output: {email}, _treg: {verification: {verdict}}}.
export function readEmailAnswer(body: unknown): EmailOutcome {
  const b = (body ?? {}) as { output?: { email?: string | null }; _treg?: { served_by?: string; verification?: { verdict?: string; checked?: boolean } } };
  const email = typeof b.output?.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.output.email) ? b.output.email.toLowerCase() : null;
  const verdict = b._treg?.verification?.checked === false ? "unknown" : (b._treg?.verification?.verdict ?? "unknown");
  if (!email) return { email: null, status: "not_found", served_by: b._treg?.served_by ?? null };
  if (verdict === "valid") return { email, status: "valid", served_by: b._treg?.served_by ?? null };
  if (verdict === "invalid") return { email: null, status: "invalid", served_by: b._treg?.served_by ?? null };
  return { email, status: "risky", served_by: b._treg?.served_by ?? null };
}

// Free research is evidence collection, not qualification. Fresh, sourced Workday customer/hiring evidence
// unlocks it for an admitted company at any stored confidence; a generic event or an invented future timestamp cannot.
export function eligibleForFreeResearch(signals: ScoringSignal[], settings: PipelineSettings, now: Date): boolean {
  return signals.some(signal => {
    const age = now.getTime() - Date.parse(signal.last_seen_at);
    return (signal.type === "known_customer" || signal.type === "hiring") &&
      signal.confidence >= 0 && signal.confidence <= 1 &&
      Number.isFinite(age) && age >= 0 && age <= settings.signal_fresh_days * 86400000 &&
      !!parseEvidence(`${signal.source_url} | ${signal.quote.trim()}`);
  });
}

export async function enrichStage(ctx: PipelineContext, opts: { maxCompanies: number; emailWorstCaseUsd?: number; dryRun?: boolean; freeOnly?: boolean }): Promise<StageResult> {
  const r: StageResult = { counts: {}, errors: [], blocked: null, requests: 0, llm_spend_usd: 0, treg_spend_usd: 0 };
  const bump = (key: string, n = 1) => { r.counts[key] = (r.counts[key] ?? 0) + n; };
  const settings = await ctx.store.settings();
  const worst = opts.emailWorstCaseUsd ?? 0.02;
  if (!Number.isFinite(worst) || worst <= 0) throw new Error("Invalid email call ceiling");
  if (opts.dryRun) return r; // Preview never dispatches or mutates contact state.
  const call = completionClient(ctx, worst, r);
  const processed = new Set<string>(), touched = new Set<string>();
  let evidenceSearchAvailable = true;
  async function verify(candidate: EvidenceCandidate, company: { name: string; domain: string }, now: Date) {
    if (!ctx.treg || !evidenceSearchAvailable) return undefined;
    r.requests++;
    const result = await ctx.treg.call(CONTACT_EVIDENCE_SEARCH, {
      query: { query: contactEvidenceQuery(candidate, company.name), domain_type: "web" },
      headers: { "X-Treg-Route-Max-Cost": "0", "X-Treg-Route-Waterfall": "0" }, timeoutMs: 8000,
    });
    if (!Number.isFinite(result.cost_usd) || result.cost_usd !== 0) {
      if (result.cost_usd > 0) {
        r.treg_spend_usd += result.cost_usd;
        await ctx.spend.record({ provider: "treg", endpoint: CONTACT_EVIDENCE_SEARCH, step: "contact_evidence", subject: company.domain, idempotency_key: "", worst_case_usd: 0, cost_usd: result.cost_usd, outcome: "unexpected charge on a free endpoint" });
      }
      r.blocked = "Public contact evidence search did not report zero cost.";
      return undefined;
    }
    if (!result.ok) {
      bump("contact_evidence_unavailable");
      if (result.status >= 200 && result.status < 300) r.blocked = "Public contact evidence search could not confirm a zero charge.";
      if ([401, 402, 403, 404, 429].includes(result.status)) evidenceSearchAvailable = false;
      return undefined;
    }
    const review = reviewIndexedContact(result.body, candidate, company, now);
    if (review) bump(review.status === "confirmed" ? "contacts_auto_verified" : "contacts_employer_mismatch");
    else bump("contact_evidence_inconclusive");
    return review;
  }
  const companies = (await ctx.store.companies()).filter(c => mayScore(settings, c.pipeline));
  for (const company of companies) {
    if (processed.size >= opts.maxCompanies) break;
    const owner = randomUUID();
    if (!(await ctx.store.claimContactResearch(company.id, owner))) { bump("contact_research_busy"); continue; }
    try {
      const status = await ctx.store.enrichmentStatus(company.id);
      const reviews = company.domain ? currentContactReviews(ctx.contactReviews ?? [], company.domain, ctx.now()) : new Map<string, ContactReview>();
      const canResearch = !status || status === "pending" || status === "skipped_budget";
      if (!canResearch && !reviews.size && (opts.freeOnly || !ctx.treg || !evidenceSearchAvailable)) continue;
      if (!company.domain) { await ctx.store.setEnrichment(company.id, "pending", "No website yet, so no contact search."); bump("no_website"); continue; }
      let storedContacts = await ctx.store.contactsForCompany(company.id);
      for (const contact of storedContacts) {
        const review = reviews.get(linkedinProfile(contact.linkedin_url) ?? "");
        if (!review || opts.dryRun) continue;
        const provenance = (contact.contact_sources ?? {}) as Record<string, unknown>;
        const previous = provenance.role_review as ContactReview | undefined;
        if (previous && (previous.reviewed_on > review.reviewed_on ||
          Object.entries(review).every(([key, value]) => previous[key as keyof ContactReview] === value))) continue;
        const patch = {
          contact_sources: { ...provenance, role_review: review },
          ...(review.status === "confirmed" ? { title: review.title, source: review.source, linkedin_status: "confirmed" } : {}),
        };
        await ctx.store.updateContact(contact.id, patch);
        touched.add(company.id);
        processed.add(company.id);
        bump(review.status === "confirmed" ? "contacts_confirmed" : "contacts_employer_mismatch");
      }
      if (touched.has(company.id)) storedContacts = await ctx.store.contactsForCompany(company.id);
      if (!opts.freeOnly && !opts.dryRun && ctx.treg && evidenceSearchAvailable) {
        const now = ctx.now();
        const due = storedContacts.filter(contact => contactRefreshDue(contact, now)).slice(0, MAX_EVIDENCE_SEARCHES);
        for (const contact of due) {
          const profile = linkedinProfile(contact.linkedin_url);
          if (!profile || !contact.title || reviews.has(profile) || !evidenceSearchAvailable) continue;
          processed.add(company.id);
          bump("contact_refresh_checked");
          const review = await verify({ name: contact.name, title: contact.title, profile }, { name: company.name, domain: company.domain }, now);
          if (r.blocked) break;
          if (review === undefined) continue;
          const previous = storedContactProvenance(contact);
          const olderConfirmation = review?.status === "confirmed" && previous.role_review?.status === "confirmed" &&
            review.reviewed_on < previous.role_review.reviewed_on;
          const changed = !!review && !olderConfirmation && (review.status !== previous.role_review?.status || review.source !== previous.role_review?.source ||
            review.reviewed_on !== previous.role_review?.reviewed_on || (review.status === "confirmed" &&
              (previous.role_review?.status !== "confirmed" || review.title !== previous.role_review.title || review.workday_source !== previous.role_review.workday_source)));
          await ctx.store.updateContact(contact.id, {
            contact_sources: { ...previous, role_verification_attempt: now.toISOString(), ...(changed ? { role_review: review } : {}) },
            ...(changed && review.status === "confirmed" ? { title: review.title, source: review.source, linkedin_status: "confirmed" } : {}),
          });
          if (changed) {
            bump("contact_refresh_changed");
            touched.add(company.id);
          }
        }
      }
      if (r.blocked) break;

      if (touched.has(company.id)) storedContacts = await ctx.store.contactsForCompany(company.id);
      let contacts = storedContacts.filter(contact => !differentEmployer(contact));
      if (opts.freeOnly && contacts.length) { bump("contacts_already_present"); continue; }
      if (!contacts.length && !canResearch) continue;
      if (!eligibleForFreeResearch(await ctx.store.signalsForCompany(company.id), settings, ctx.now())) {
        bump("research_evidence_missing"); continue;
      }
      if (!ctx.treg) { await ctx.store.setEnrichment(company.id, "pending", "treg is not configured; eligible contact research pending."); bump("no_treg"); continue; }
      // 1. Free search for likely decision makers.
      if (!contacts.length) {
        processed.add(company.id);
        bump("companies_researched");
        const searchPeople = async (titles: string[]) => {
          r.requests++;
          return ctx.treg!.call(PEOPLE_SEARCH, { body: { company_url: { include: [company.domain], exclude: [] }, title: { include: titles, exclude: [] }, per_page: 50 }, headers: { "X-Treg-Route-Max-Cost": "0", "X-Treg-Route-Waterfall": "0" }, timeoutMs: 12000 });
        };
        const readPeople = (body: unknown) => {
          const people = (body as { data?: unknown } | null)?.data;
          if (!Array.isArray(people)) return null;
          const existingProfiles = new Set(storedContacts.map(contact => linkedinProfile(contact.linkedin_url)));
          const newPeople = people.slice(0, 50).filter(person => !existingProfiles.has(linkedinProfile(person?.employee_linkedin)));
          return contactCandidates(newPeople, reviews);
        };
        let search = await searchPeople(FOCUSED_TITLE_PHRASES);
        let pool = search.ok && search.cost_usd === 0 ? readPeople(search.body) : null;
        if (pool?.length === 0) {
          bump("broad_people_search");
          search = await searchPeople(TITLE_PHRASES);
          pool = search.ok && search.cost_usd === 0 ? readPeople(search.body) : null;
        }
        if (search.cost_usd > 0) r.treg_spend_usd += search.cost_usd;
        if (search.cost_usd > 0) await ctx.spend.record({ provider: "treg", endpoint: PEOPLE_SEARCH, step: "people_search", subject: company.domain, idempotency_key: "", worst_case_usd: 0, cost_usd: search.cost_usd, outcome: "unexpected charge on a free endpoint" });
        if (!pool) {
          bump("error_people_search");
          const reason = !search.ok ? search.error : search.cost_usd !== 0 ? "free research did not report zero cost" : "malformed people results";
          r.errors.push(`people search ${company.name}: ${reason}`);
          await ctx.store.setEnrichment(company.id, "pending", "Free people search failed; retry on a later run.");
          // An authentication/rate/billing error must not be repeated across every company.
          if ((!search.ok && ([401, 402, 403, 429].includes(search.status) || (search.status >= 200 && search.status < 300))) ||
              search.cost_usd !== 0) { r.blocked = "Free people search unavailable or zero cost not confirmed."; break; }
          continue;
        }
        bump("people_candidates", pool.length);
        const now = ctx.now();
        // Spend the bounded research budget on plausible decision makers, keeping every
        // other eligible result in the pool as a provisional candidate for the final rank.
        const toVerify = pool.filter(candidate => !candidate.review)
          .sort((a, b) => b.potential - a.potential).slice(0, MAX_EVIDENCE_SEARCHES);
        for (const candidate of toVerify) {
          if (!evidenceSearchAvailable) break;
          const verified = await verify(candidate, { name: company.name, domain: company.domain }, now);
          if (r.blocked) break;
          if (!verified) continue;
          reviews.set(candidate.profile, verified);
        }
        if (r.blocked) break;
        const picked = pickContacts(pool.map(candidate => candidate.person), MAX_CONTACTS_PER_COMPANY, reviews, now);
        bump("people_found", picked.length);
        if (!picked.length) { await ctx.store.setEnrichment(company.id, "no_contacts_found", "Free people search found no HR/IT systems contacts."); continue; }
        if (opts.dryRun) continue;
        if (opts.freeOnly && !status) {
          await ctx.store.setEnrichment(company.id, "pending", "Contact research started; paid email completion requires budget.");
        }
        for (const { contact, review } of picked) {
          await ctx.store.insertContact({ company_id: company.id, ...contact });
          touched.add(company.id);
          bump("contacts_added");
          if (review) bump("contacts_confirmed");
        }
        if (picked.some(candidate => candidate.review)) bump("companies_verified");
        contacts = (await ctx.store.contactsForCompany(company.id)).filter(contact => !differentEmployer(contact));
      }
      if (opts.freeOnly) continue;
      // 2. Paid work email with verification, best contacts first, within budget.
      let budgetSkipped = false;
      const now = ctx.now();
      const ranked = [...contacts].sort((a, b) => {
        const x = classifyTitle(a.title), y = classifyTitle(b.title);
        return Number(confirmedCurrent(b, now)) - Number(confirmedCurrent(a, now)) ||
          (y.functional + y.seniority) - (x.functional + x.seniority);
      });
      for (const original of ranked.filter(contactNeedsCompletion)) {
        const contact = structuredClone(original);
        // Historical pipeline lookups cannot be purchased again, even if their result was not applied.
        if (!contact.email && await ctx.store.paidCall(paidCallKey("treg", "email", contact.id))) {
          bump("email_already_looked_up"); continue;
        }
        const requestsBefore = r.requests;
        try {
          const patch = await completeContact({ company, contact, call });
          if (patch || r.requests > requestsBefore) processed.add(company.id);
          if (patch && await ctx.store.completeContact(contact, patch)) {
            touched.add(company.id);
            bump(`email_${patch.email_status}`);
          }
        } catch (error) {
          if (error instanceof ContactBudgetReached) { budgetSkipped = true; break; }
          throw error;
        }
      }
      await ctx.store.setEnrichment(company.id, budgetSkipped ? "skipped_budget" : "done", budgetSkipped ? "Contacts found; email lookup waits for budget." : "Contacts found and looked up within budget.");
      if (budgetSkipped) bump("budget_skipped");
    } catch (error) {
      bump("error_enrich");
      r.errors.push(`enrich ${company.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await ctx.store.releaseContactResearch(company.id, owner);
    }
  }
  // New contacts change Authority and Reachability: rescore what was touched.
  if (touched.size && !opts.dryRun) {
    const rescored = await scoreStage(ctx, { companyIds: [...touched], trigger: "new_contacts" });
    for (const [k, v] of Object.entries(rescored.counts)) bump(`rescore_${k}`, v);
    r.errors.push(...rescored.errors);
    if (rescored.blocked) r.blocked = rescored.blocked;
  }
  return r;
}
