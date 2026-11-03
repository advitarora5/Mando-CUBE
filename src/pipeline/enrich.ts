// Contact enrichment for companies over the ready-for-contacts threshold. Budget-gated and never blocking:
// free people search first, then (budget allowing) one verified work-email lookup per contact through treg.
// Rules: a LinkedIn URL that already exists is never paid for; only a "valid" verdict is verified; risky
// addresses are stored unverified; invalid ones are not stored; no address is ever guessed; a paid call
// for the same contact and step is never repeated (idempotency key in paid_calls and on the treg call).
import { paidCallKey } from "../domain/ingestion/fingerprint.ts";
import { mayScore } from "../domain/ingestion/settings.ts";
import { classifyTitle } from "../domain/ingestion/titles.ts";
import { scoreStage, type StageResult } from "./stages.ts";
import type { ContactRow, PipelineContext } from "./types.ts";

export const PEOPLE_SEARCH = "quickenrich.people.search"; // free on treg; returns names, titles and LinkedIn URLs, never emails
export const EMAIL_FIND = "treg.people.email.find";
export const TITLE_PHRASES = ["Human Resources", "HRIS", "People", "Workday", "Enterprise Applications", "Information Technology", "IT Operations", "Information Systems"];
export const MAX_CONTACTS_PER_COMPANY = 3;
export const MAX_EMAIL_LOOKUPS_PER_COMPANY = 2;

type FoundPerson = { first_name?: string; last_name?: string; title?: string; employee_linkedin?: string; company_name?: string; employee_count?: string };

export function pickContacts(people: FoundPerson[], max = MAX_CONTACTS_PER_COMPANY) {
  return people
    .filter(p => p.first_name && p.last_name && p.title && /^https:\/\/(www\.)?linkedin\.com\/in\//i.test(p.employee_linkedin ?? ""))
    .map(p => ({ person: p, cls: classifyTitle(p.title) }))
    .filter(x => x.cls.functional > 0)
    .sort((a, b) => (b.cls.functional + b.cls.seniority + b.cls.ownsWorkday) - (a.cls.functional + a.cls.seniority + a.cls.ownsWorkday))
    .slice(0, max);
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

export async function enrichStage(ctx: PipelineContext, opts: { maxCompanies: number; emailWorstCaseUsd?: number; dryRun?: boolean }): Promise<StageResult> {
  const r: StageResult = { counts: {}, errors: [], blocked: null, requests: 0, llm_spend_usd: 0, treg_spend_usd: 0 };
  const bump = (key: string, n = 1) => { r.counts[key] = (r.counts[key] ?? 0) + n; };
  const settings = await ctx.store.settings();
  const worst = opts.emailWorstCaseUsd ?? 0.02;
  const touched: string[] = [];
  const companies = (await ctx.store.companies()).filter(c => mayScore(settings, c.pipeline));
  for (const company of companies) {
    if (touched.length >= opts.maxCompanies) break;
    const status = await ctx.store.enrichmentStatus(company.id);
    if (status !== "pending" && status !== "skipped_budget") continue;
    try {
      if (!company.domain) { await ctx.store.setEnrichment(company.id, "pending", "No website yet, so no contact search."); bump("no_website"); continue; }
      if (!ctx.treg) { await ctx.store.setEnrichment(company.id, "pending", "treg is not configured; contacts pending."); bump("no_treg"); continue; }
      touched.push(company.id);
      let contacts: ContactRow[] = await ctx.store.contactsForCompany(company.id);
      // 1. Free search for likely decision makers.
      if (!contacts.length) {
        const search = await ctx.treg.call(PEOPLE_SEARCH, { body: { company_url: { include: [company.domain], exclude: [] }, title: { include: TITLE_PHRASES, exclude: [] }, per_page: 50 }, headers: { "X-Treg-Route-Max-Cost": "0" } });
        r.requests++;
        if (search.cost_usd > 0) await ctx.spend.record({ provider: "treg", endpoint: PEOPLE_SEARCH, step: "people_search", subject: company.domain, idempotency_key: "", worst_case_usd: 0, cost_usd: search.cost_usd, outcome: "unexpected charge on a free endpoint" });
        const people = search.ok ? (((search.body as { data?: FoundPerson[] })?.data) ?? []) : [];
        const picked = pickContacts(people);
        bump("people_found", picked.length);
        if (!picked.length) { await ctx.store.setEnrichment(company.id, "no_contacts_found", search.ok ? "Free people search found no HR/IT systems contacts." : `People search failed: ${search.error}`); continue; }
        if (opts.dryRun) continue;
        for (const { person } of picked) {
          const contact = {
            company_id: company.id, name: `${person.first_name} ${person.last_name}`, title: person.title ?? null,
            linkedin_url: person.employee_linkedin ?? null, source: person.employee_linkedin ?? null,
            email: null, email_status: null, phone: null, phone_status: null, mutual_connection: null,
            linkedin_status: "unconfirmed", enriched_at: ctx.now().toISOString(),
            contact_sources: { name_title_linkedin: { provider: "quickenrich via treg", endpoint: PEOPLE_SEARCH, fetched_at: ctx.now().toISOString(), cost_usd: 0 } },
          };
          await ctx.store.insertContact(contact as unknown as Omit<ContactRow, "id">);
          bump("contacts_added");
        }
        contacts = await ctx.store.contactsForCompany(company.id);
      }
      // 2. Paid work email with verification, best contacts first, within budget.
      let budgetSkipped = false;
      const ranked = [...contacts].sort((a, b) => { const x = classifyTitle(a.title), y = classifyTitle(b.title); return (y.functional + y.seniority) - (x.functional + x.seniority); });
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
  }
  return r;
}
