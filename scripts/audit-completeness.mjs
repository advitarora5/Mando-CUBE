// Read-only: counts how complete the real companies on the dashboard are, and lists what is missing.
// Usage: node --env-file=.env.local scripts/audit-completeness.mjs [--list] [--json out.json]
import { writeFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { categories } from "../src/domain/contracts/company.ts";
import { evaluateTier, hasEvidence } from "../src/domain/scoring/tier-rules.ts";

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
async function all(table, order = "id") {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db.from(table).select("*").order(order).range(offset, offset + 499);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}
const [companies, contacts, scores, insights] = await Promise.all([all("companies"), all("contacts"), all("scores"), all("company_insights", "company_id")]);

const demoId = /^d0000000-/;
const real = companies.filter(c => !demoId.test(c.id) && !/^demo company/i.test(c.name));
const latest = new Map();
for (const s of [...scores].sort((a, b) => (a.assessed_at < b.assessed_at ? -1 : 1))) latest.set(s.company_id, s);
const insight = new Map(insights.map(i => [i.company_id, i]));
const byCompany = Map.groupBy(contacts, c => c.company_id);

const rows = real.map(c => {
  const score = latest.get(c.id);
  const people = byCompany.get(c.id) ?? [];
  const tier = score ? evaluateTier(score) : null;
  const why = insight.get(c.id);
  const gaps = [];
  if (demoId.test(c.id)) gaps.push("demo");
  for (const f of ["employee_count", "industry", "domain", "workday_signal_date"]) if (c[f] == null || c[f] === "") gaps.push(f);
  if (!score) gaps.push("unscored");
  else for (const cat of categories) if (!hasEvidence(score[`${cat}_evidence`])) gaps.push(`${cat}_evidence`);
  if (!(why?.why_now_override || why?.why_now_generated)) gaps.push("why_now");
  if (!people.length) gaps.push("contacts");
  else if (people.length > 3) gaps.push("more_than_3_contacts");
  const reachable = people.some(p => p.email || p.phone || p.linkedin_url);
  if (people.length && !people.some(p => p.email || p.phone)) gaps.push("no_email_or_phone");
  return { id: c.id, name: c.name, tier: tier?.tier ?? "Unscored", total: tier?.total ?? null, tier_reason: tier?.tier_reason ?? "", contacts: people.length, reachable, gaps };
});

const count = f => rows.filter(f).length;
const pct = n => `${n}/${rows.length}`;
console.log(`Real companies: ${rows.length}   Demo rows still present: ${companies.length - real.length}`);
console.log(`Fully complete (no gaps): ${pct(count(r => !r.gaps.length))}`);
const tally = {};
for (const r of rows) for (const g of r.gaps) tally[g] = (tally[g] ?? 0) + 1;
console.table(Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([gap, n]) => ({ gap, companies: n })));
console.log(`Tiers: ${JSON.stringify(Object.fromEntries(Map.groupBy(rows, r => r.tier).entries().map(([t, g]) => [t, g.length])))}`);
console.log(`Maybe-or-higher with a reachable contact (email, phone or LinkedIn): ${count(r => r.tier !== "Disqualified" && r.tier !== "Unscored" && r.reachable)}  (goal 15)`);
console.log(`Contacts: ${contacts.length}; with email ${contacts.filter(c => c.email).length} (verified ${contacts.filter(c => c.email_verified).length}); phone ${contacts.filter(c => c.phone).length}; LinkedIn ${contacts.filter(c => c.linkedin_url).length}`);
console.log(`Disqualified only for missing Authority/Reachability evidence: ${count(r => /evidence requires/.test(r.tier_reason))}`);

const args = process.argv.slice(2);
if (args.includes("--list")) console.table(rows.filter(r => r.gaps.length).map(r => ({ company: r.name, tier: r.tier, contacts: r.contacts, gaps: r.gaps.join(", ") })));
if (args.includes("--json")) await writeFile(args[args.indexOf("--json") + 1], JSON.stringify(rows, null, 2));
