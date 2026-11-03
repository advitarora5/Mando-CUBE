// LOCAL TEST DATABASE ONLY. Copies the team's researched companies (committed in src/data/research) into the local
// pipeline database as existing, non-pipeline companies, so matching is tested against the real existing set:
// a discovered company already researched by the team must be matched (signals only), never created again.
//   node --env-file-if-exists=.env.pipeline.local scripts/seed-local-existing.mjs
import { readFileSync, readdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { assertAllowedTarget } from "../src/pipeline/store/supabase.ts";

const url = process.env.PIPELINE_SUPABASE_URL;
assertAllowedTarget(url, undefined); // loopback only, regardless of PIPELINE_ALLOW_REMOTE
const db = createClient(url, process.env.PIPELINE_SUPABASE_KEY, { auth: { persistSession: false } });

const main = JSON.parse(readFileSync("src/data/research/workday-companies.json", "utf8")).companies;
const extra = readdirSync("src/data/research/companies105-127").filter(f => /^\d+\.json$/.test(f))
  .map(f => JSON.parse(readFileSync(`src/data/research/companies105-127/${f}`, "utf8")))
  .map(c => ({ id: c.company_id, name: c.name, domain: c.domain, industry: c.industry, headquarters: c.headquarters, employee_count: c.employee_count }));
const rows = [...main, ...extra].map(c => ({ id: c.id, name: c.name, domain: c.domain || null, industry: c.industry ?? null, headquarters: c.headquarters ?? null, employee_count: Number.isInteger(c.employee_count) ? c.employee_count : null }));
const seen = new Set();
const unique = rows.filter(r => r.id && !seen.has(r.id) && seen.add(r.id));
// Domains are unique: skip a seed row whose domain a different local company already holds.
const { data: existing } = await db.from("companies").select("id, domain");
const taken = new Map((existing ?? []).filter(c => c.domain).map(c => [c.domain, c.id]));
const insertable = unique.filter(r => !r.domain || !taken.has(r.domain) || taken.get(r.domain) === r.id);
const { error } = await db.from("companies").upsert(insertable, { onConflict: "id" });
if (error) throw new Error(error.message);
console.log(`seeded ${insertable.length} existing companies (${unique.length - insertable.length} skipped: domain already used locally)`);
