import { createClient } from "@supabase/supabase-js";

// Fictional fixture, with stable IDs so repeat runs don't duplicate records.
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error("Configure SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local first.");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const companyId = "d0000000-0000-4000-8000-000000000001";
const scoreId = "d0000000-0000-4000-8000-000000000002";
const contactId = "d0000000-0000-4000-8000-000000000003";
const source = "https://google.com";
const whyNow = "Fictional demo: recent Workday go-live, active HRIS hiring, and a reachable buyer with an approved evaluation budget.";

async function save(table, row) {
  const { error } = await db.from(table).upsert(row);
  if (error) throw new Error(`${table}: ${error.message}`);
}

await save("companies", {
  id: companyId, name: "Demo Company — Fictional", domain: "mando-demo.example",
  industry: "Manufacturing", headquarters: "Chicago, IL", employee_count: 5200,
  workday_signal_date: "2026-08-01", source,
});
await save("contacts", {
  id: contactId, company_id: companyId, name: "John Smith", title: "Director of HRIS",
  linkedin_url: source, source, mutual_connection: "Fictional one-degree connection",
});
await save("scores", {
  id: scoreId, company_id: companyId, assessed_at: "2026-10-02T15:00:00Z",
  rubric_version: "demo-v1-placeholder-not-approved-rubric",
  authority_score: 23, authority_evidence: `${source} | Fictional HRIS director with purchasing influence at a 5,200-person company.`,
  reachability_score: 22, reachability_evidence: `${source} | Fictional one-degree introduction and stated willingness to evaluate Mando.`,
  budget_score: 18, budget_evidence: `${source} | Fictional approved evaluation budget and near-term purchase timeline.`,
  release_score: 12, release_evidence: `${source} | Fictional upcoming release preparation creates a testing need.`,
  timing_score: 8, timing_evidence: `${source} | Fictional recent go-live and two open HRIS roles create a timely opportunity.`,
  tier: "Qualified",
});
await save("company_insights", {
  company_id: companyId, persona_generated: "HRIS systems buyer (fictional)",
  level_generated: "Director", why_now_generated: whyNow, generated_at: "2026-10-02T15:00:00Z",
});

const { data, error } = await db.from("companies")
  .select("name, contacts(name), scores(total, tier, authority_score, reachability_score, budget_score, release_score, timing_score)")
  .eq("id", companyId).single();
if (error) throw new Error(error.message);
console.log("Fictional demo record saved and read back:", JSON.stringify(data, null, 2));
