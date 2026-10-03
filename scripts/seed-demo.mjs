import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error("Configure database credentials in .env.local first.");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const source = "https://google.com";
const categories = ["authority", "reachability", "budget", "release", "timing"];
const fixtures = [
  [23, 22, 18, 12, 8], [25, 25, 20, 15, 10], [24, 23, 19, 13, 10],
  [22, 21, 17, 11, 9], [20, 19, 16, 10, 7], [18, 17, 14, 8, 6],
  [16, 15, 12, 7, 5], [14, 13, 11, 6, 5], [10, 10, 8, 5, 5],
];
const industries = ["Manufacturing", "Healthcare", "Professional services", "Retail", "Technology", "Construction", "Education", "Financial services", "Energy"];
const reasons = ["Fictional HRIS leadership with purchasing influence.", "Fictional introduction and willingness to evaluate.", "Fictional purchase timeline and available budget.", "Fictional release preparation and testing needs.", "Fictional go-live and hiring signals."];
function id(suffix) { return `d0000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`; }
async function save(table, row) {
  const { error } = await db.from(table).upsert(row);
  if (error) throw new Error(`${table}: ${error.message}`);
}
for (let index = 0; index < fixtures.length; index++) {
  const n = index + 1;
  // Reuse the original fictional record as Demo Company 1, avoiding a tenth demo.
  const companyId = id(n === 1 ? 1 : n * 10);
  const scoreId = id(n === 1 ? 2 : n * 10 + 1);
  const contactId = id(n === 1 ? 3 : n * 10 + 2);
  const total = fixtures[index].reduce((a, b) => a + b, 0);
  const tier = total >= 80 ? "Qualified" : total >= 55 ? "Maybe" : "Disqualified";
  await save("companies", {
    id: companyId, name: `Demo Company ${n}`, domain: n === 1 ? "mando-demo.example" : `demo-company-${n}.example`,
    industry: industries[index], headquarters: n % 2 ? "Chicago, IL" : "New York, NY",
    employee_count: n === 1 ? 5200 : 3000 + n * 550, workday_signal_date: `2026-08-${String(n).padStart(2, "0")}`, source,
  });
  await save("contacts", { id: contactId, company_id: companyId, name: "John Smith", title: n % 2 ? "Director of HRIS" : "IT Operations Manager", linkedin_url: source, source, mutual_connection: "Fictional one-degree connection" });
  // Do not rewrite existing assessments: history may reference them.
  const existing = await db.from("scores").select("id").eq("id", scoreId).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (!existing.data) {
    const score = { id: scoreId, company_id: companyId, assessed_at: "2026-10-03T15:00:00Z", rubric_version: "week2-100-demo-fixture", tier };
    categories.forEach((category, i) => {
      score[`${category}_score`] = fixtures[index][i];
      score[`${category}_evidence`] = `${source} | Demo Company ${n}: ${reasons[i]}`;
    });
    const { error } = await db.from("scores").insert(score);
    if (error) throw new Error(error.message);
  }
  await save("company_insights", { company_id: companyId, persona_generated: "HRIS systems buyer (fictional)", level_generated: "Director", why_now_generated: `Fictional demo ${n}: sample Workday signals and buyer readiness for dashboard testing.`, generated_at: "2026-10-03T15:00:00Z" });
}
const ids = fixtures.map((_, i) => id(i === 0 ? 1 : (i + 1) * 10));
const { data, error } = await db.from("companies").select("name, scores(total, tier)").in("id", ids).order("name");
if (error) throw new Error(error.message);
console.log("Saved nine fictional demo companies:", JSON.stringify(data, null, 2));
