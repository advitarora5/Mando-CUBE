// Free contact research for eligible companies; paid email lookup keeps the readiness threshold and budget gate:
// free people search first, then (budget allowing) one verified work-email lookup per contact through treg.
// Rules: a LinkedIn URL that already exists is never paid for; only a "valid" verdict is verified; risky
// addresses are stored unverified; invalid ones are not stored; no address is ever guessed; a paid call
// for the same contact and step is never repeated (idempotency key in paid_calls and on the treg call).
import { paidCallKey } from "../domain/ingestion/fingerprint.ts";
import { mayScore, readyForContacts } from "../domain/ingestion/settings.ts";
import { parseEvidence } from "../domain/scoring/evidence.ts";
import { confirmedCurrent, differentEmployer, type ScoringSignal } from "../domain/ingestion/pipeline-score.ts";
import type { PipelineSettings } from "../domain/ingestion/settings.ts";
import { classifyTitle } from "../domain/ingestion/titles.ts";
import { currentContactReviews, linkedinProfile, type ContactReview } from "./contact-review.ts";
import { scoreStage, type StageResult } from "./stages.ts";
import type { ContactRow, PipelineContext } from "./types.ts";

export const PEOPLE_SEARCH = "quickenrich.people.search"; // free on treg; returns names, titles and LinkedIn URLs, never emails
export const EMAIL_FIND = "treg.people.email.find";
export const TITLE_PHRASES = ["Human Resources", "HRIS", "People", "Workday", "Enterprise Applications", "Information Technology", "IT Operations", "Information Systems"];
export const FOCUSED_TITLE_PHRASES = ["Workday", "HRIS", "HR Technology", "HR Service Delivery", "People Systems", "HCM"];
export const MAX_CONTACTS_PER_COMPANY = 3;
export const MAX_EMAIL_LOOKUPS_PER_COMPANY = 2;

type FoundPerson = { first_name?: string; last_name?: string; title?: string; employee_linkedin?: string; company_name?: string; employee_count?: string };

export function pickContacts(people: FoundPerson[], max = MAX_CONTACTS_PER_COMPANY, reviews = new Map<string, ContactReview>()) {
  const candidates = people.flatMap(person => {
    const profile = linkedinProfile(person?.employee_linkedin);
    if (!profile || !person.first_name || !person.last_name || !person.title) return [];
    const review = reviews.get(profile);
    if (review?.status === "different_employer") return [];
    const cls = classifyTitle(review?.title ?? person.title);
    if (cls.functional === 0 && !review?.workday_source) return [];
    const rank = cls.functional + cls.seniority + (review?.workday_source ? 4 : cls.ownsWorkday);
    return [{ person, profile, review, rank }];
  });
  candidates.sort((a, b) => Number(!!b.review) - Number(!!a.review) || b.rank - a.rank || a.profile.localeCompare(b.profile));
  const seen = new Set<string>();
  return candidates.filter(({ profile }) => {
    if (seen.has(profile)) return false;
    seen.add(profile);
    return true;
  }).slice(0, max);
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

export async function enrichStage(ctx: PipelineContext, opts: { maxCompanies: number; emailWorstCaseUsd?: number; dryRun?: boolean }): Promise<StageResult> {
  const r: StageResult = { counts: {}, errors: [], blocked: null, requests: 0, llm_spend_usd: 0, treg_spend_usd: 0 };
  const bump = (key: string, n = 1) => { r.counts[key] = (r.counts[key] ?? 0) + n; };
  const settings = await ctx.store.settings();
  const worst = opts.emailWorstCaseUsd ?? 0.02;
  const touched: string[] = [];
  const companies = (await ctx.store.companies()).filter(c => mayScore(settings, c.pipeline));
  for (const company of companies) {
    if (touched.length >= opts.maxCompanies) break;
    try {
      const status = await ctx.store.enrichmentStatus(company.id);
      const reviews = company.domain ? currentContactReviews(ctx.contactReviews ?? [], company.domain, ctx.now()) : new Map<string, ContactReview>();
      const canResearch = !status || status === "pending" || status === "skipped_budget";
      if (!canResearch && !reviews.size) continue;
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
        if (!touched.includes(company.id)) touched.push(company.id);
        bump(review.status === "confirmed" ? "contacts_confirmed" : "contacts_employer_mismatch");
      }
      if (!canResearch) continue;
      if (touched.includes(company.id)) storedContacts = await ctx.store.contactsForCompany(company.id);
      let contacts = storedContacts.filter(contact => !differentEmployer(contact));
      if (!status && contacts.length) continue; // Do not opt existing contacts into paid lookup implicitly.
      const latest = await ctx.store.latestScore(company.id);
      const paidReady = !!latest && readyForContacts(latest, settings);
      // Existing researched companies below the paid threshold do not consume the batch's research slots.
      if (contacts.length && !paidReady) { bump("paid_readiness_deferred"); continue; }
      if (!contacts.length && !paidReady && !eligibleForFreeResearch(await ctx.store.signalsForCompany(company.id), settings, ctx.now())) {
        bump("research_evidence_missing"); continue;
      }
      if (!ctx.treg) { await ctx.store.setEnrichment(company.id, "pending", "treg is not configured; eligible contact research pending."); bump("no_treg"); continue; }
      if (!touched.includes(company.id)) touched.push(company.id);
      // 1. Free search for likely decision makers.
      if (!contacts.length) {
        const searchPeople = async (titles: string[]) => {
          r.requests++;
          return ctx.treg!.call(PEOPLE_SEARCH, { body: { company_url: { include: [company.domain], exclude: [] }, title: { include: titles, exclude: [] }, per_page: 50 }, headers: { "X-Treg-Route-Max-Cost": "0", "X-Treg-Route-Waterfall": "0" } });
        };
        const selectPeople = (body: unknown) => {
          const people = (body as { data?: unknown } | null)?.data;
          if (!Array.isArray(people)) return null;
          const existingProfiles = new Set(storedContacts.map(contact => linkedinProfile(contact.linkedin_url)));
          const newPeople = people.slice(0, 50).filter(person => !existingProfiles.has(linkedinProfile(person?.employee_linkedin)));
          return pickContacts(newPeople, MAX_CONTACTS_PER_COMPANY, reviews);
        };
        let search = await searchPeople(FOCUSED_TITLE_PHRASES);
        let picked = search.ok && search.cost_usd === 0 ? selectPeople(search.body) : null;
        if (picked?.length === 0) {
          bump("broad_people_search");
          search = await searchPeople(TITLE_PHRASES);
          picked = search.ok && search.cost_usd === 0 ? selectPeople(search.body) : null;
        }
        if (search.cost_usd > 0) r.treg_spend_usd += search.cost_usd;
        if (search.cost_usd > 0) await ctx.spend.record({ provider: "treg", endpoint: PEOPLE_SEARCH, step: "people_search", subject: company.domain, idempotency_key: "", worst_case_usd: 0, cost_usd: search.cost_usd, outcome: "unexpected charge on a free endpoint" });
        if (!picked) {
          bump("error_people_search");
          const reason = !search.ok ? search.error : search.cost_usd !== 0 ? "free research did not report zero cost" : "malformed people results";
          r.errors.push(`people search ${company.name}: ${reason}`);
          await ctx.store.setEnrichment(company.id, "pending", "Free people search failed; retry on a later run.");
          // An authentication/rate/billing error must not be repeated across every company.
          if ((!search.ok && [401, 402, 403, 429].includes(search.status)) || search.cost_usd !== 0) { r.blocked = "Free people search unavailable or zero cost not confirmed."; break; }
          continue;
        }
        bump("people_found", picked.length);
        if (!picked.length) { await ctx.store.setEnrichment(company.id, "no_contacts_found", "Free people search found no HR/IT systems contacts."); continue; }
        if (opts.dryRun) continue;
        for (const { person, profile, review } of picked) {
          const contact = {
            company_id: company.id, name: `${person.first_name} ${person.last_name}`, title: review?.title ?? person.title ?? null,
            linkedin_url: profile, source: review?.source ?? profile,
            email: null, email_status: null, phone: null, phone_status: null, mutual_connection: null,
            linkedin_status: review ? "confirmed" : "unconfirmed", enriched_at: ctx.now().toISOString(),
            contact_sources: {
              name_title_linkedin: { provider: "quickenrich via treg", endpoint: PEOPLE_SEARCH, fetched_at: ctx.now().toISOString(), cost_usd: 0 },
              ...(review ? { role_review: review } : {}),
            },
          };
          await ctx.store.insertContact(contact as unknown as Omit<ContactRow, "id">);
          bump("contacts_added");
          if (review) bump("contacts_confirmed");
        }
        contacts = (await ctx.store.contactsForCompany(company.id)).filter(contact => !differentEmployer(contact));
      }
      // Free research does not authorize a paid email lookup or inflate a qualification score.
      if (!paidReady) {
        await ctx.store.setEnrichment(company.id, "pending", "Free contact research complete; paid email lookup waits for the readiness threshold.");
        bump("paid_readiness_deferred");
        continue;
      }
      // 2. Paid work email with verification, best contacts first, within budget.
      let budgetSkipped = false;
      const now = ctx.now();
      const ranked = [...contacts].sort((a, b) => {
        const x = classifyTitle(a.title), y = classifyTitle(b.title);
        return Number(confirmedCurrent(b, now)) - Number(confirmedCurrent(a, now)) ||
          (y.functional + y.seniority) - (x.functional + x.seniority);
      });
      for (const contact of ranked.filter(c => !c.email).slice(0, MAX_EMAIL_LOOKUPS_PER_COMPANY)) {
        const key = paidCallKey("treg", "email", `${contact.id}`);
        if (await ctx.store.paidCall(key)) { bump("email_already_looked_up"); continue; }
        if (!(await ctx.spend.allow("treg", worst, `email ${contact.name}`))) { budgetSkipped = true; break; }
        if (opts.dryRun) { await ctx.spend.record({ provider: "treg", endpoint: EMAIL_FIND, step: "email(dry-run)", subject: contact.id, idempotency_key: key, worst_case_usd: worst, cost_usd: 0, outcome: "dry-run" }); continue; }
        const res = await ctx.treg.call(EMAIL_FIND, {
          body: { full_name: contact.name, domain: company.domain, ...(contact.linkedin_url ? { linkedin_url: contact.linkedin_url } : {}) },
          headers: { "X-Treg-Route-Verify": "true", "X-Treg-Route-Max-Cost": worst.toFixed(4) }, idempotencyKey: key,
        });
        r.requests++; r.treg_spend_usd += res.cost_usd;
        await ctx.spend.record({ provider: "treg", endpoint: EMAIL_FIND, step: "email", subject: contact.id, idempotency_key: key, worst_case_usd: worst, cost_usd: res.cost_usd, outcome: res.ok ? "ok" : res.error });
        if (!res.ok) {
          if (res.status === 402) { (ctx.spend as { stop?: (p: string, r: string) => void }).stop?.("treg", "treg returned 402"); budgetSkipped = true; break; }
          bump("email_errors"); r.errors.push(`email ${contact.name}: ${res.error}`);
          continue; // a failed call was not billed and may be retried next run
        }
        const outcome = readEmailAnswer(res.body);
        await ctx.store.recordPaidCall({ idempotency_key: key, provider: "treg", endpoint: EMAIL_FIND, subject: contact.id, step: "email", run_id: ctx.runId, cost_usd: res.cost_usd, outcome: outcome.status, response: { served_by: outcome.served_by, status: outcome.status } });
        await ctx.store.updateContact(contact.id, {
          email: outcome.email, email_status: outcome.status, email_verified: outcome.status === "valid", enriched_at: ctx.now().toISOString(),
          contact_sources: { ...((contact as { contact_sources?: Record<string, unknown> }).contact_sources ?? {}), email: { provider: outcome.served_by ?? "treg", endpoint: EMAIL_FIND, verdict: outcome.status, call_id: res.call_id, fetched_at: ctx.now().toISOString(), cost_usd: res.cost_usd } },
        } as Partial<ContactRow>);
        bump(`email_${outcome.status}`);
      }
      await ctx.store.setEnrichment(company.id, budgetSkipped ? "skipped_budget" : "done", budgetSkipped ? "Contacts found; email lookup waits for budget." : "Contacts found and looked up within budget.");
      if (budgetSkipped) bump("budget_skipped");
    } catch (error) {
      bump("error_enrich");
      r.errors.push(`enrich ${company.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // New contacts change Authority and Reachability: rescore what was touched.
  if (touched.length && !opts.dryRun) {
    const rescored = await scoreStage(ctx, { companyIds: touched, trigger: "new_contacts" });
    for (const [k, v] of Object.entries(rescored.counts)) bump(`rescore_${k}`, v);
    r.errors.push(...rescored.errors);
    if (rescored.blocked) r.blocked = rescored.blocked;
  }
  return r;
}
