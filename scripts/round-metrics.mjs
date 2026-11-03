// Round metrics for docs/ingestion-eval: what one end-to-end run (or several) produced, read back from the database.
//   node --env-file-if-exists=.env.pipeline.local scripts/round-metrics.mjs --since 2026-10-13T06:00:00Z [--ledger var/spend-ledger.jsonl]
// Rows created by test fixtures (".example" domains) are excluded.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { assertAllowedTarget } from "../src/pipeline/store/supabase.ts";
import { normalizeName } from "../src/domain/ingestion/normalize.ts";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const since = args.since ?? new Date(Date.now() - 86400000).toISOString();
const url = process.env.PIPELINE_SUPABASE_URL;
assertAllowedTarget(url, process.env.PIPELINE_ALLOW_REMOTE);
const db = createClient(url, process.env.PIPELINE_SUPABASE_KEY, { auth: { persistSession: false } });
const q = async (p, what) => { const { data, error } = await p; if (error) throw new Error(`${what}: ${error.message}`); return data; };
// Read every row: the API returns at most 1,000 per request.
const all = async (make, what) => { const out = []; for (let from = 0; ; from += 1000) { const page = await q(make().range(from, from + 999), what); out.push(...page); if (page.length < 1000) return out; } };
const real = c => !/\.example$/.test(c.domain ?? "") && !/^Boundary |^Review /.test(c.name);

const runs = await q(db.from("pipeline_runs").select("*").gte("started_at", since).order("started_at"), "runs");
const created = (await all(() => db.from("companies").select("id, name, domain, employee_count, source, company_origins!inner(created_at)").gte("company_origins.created_at", since).order("id"), "companies")).filter(real);
const createdIds = created.map(c => c.id);
const signals = createdIds.length ? await q(db.from("signals").select("id, company_id, type, source_url, quote, method, confidence").in("company_id", createdIds), "signals") : [];
const reviews = (await q(db.from("review_queue").select("*").gte("created_at", since), "reviews")).filter(r => !/\.example$/.test(r.candidate_domain ?? "") && !/^Review /.test(r.candidate_name));
const scores = createdIds.length ? await q(db.from("scores").select("company_id, assessed_at, authority_score, reachability_score, budget_score, release_score, timing_score, total, tier").in("company_id", createdIds), "scores") : [];
const latest = Object.values(scores.reduce((m, s) => ((!m[s.company_id] || m[s.company_id].assessed_at < s.assessed_at) ? { ...m, [s.company_id]: s } : m), {}));
const allCompanies = await all(() => db.from("companies").select("id, name, domain").order("id"), "all companies");
const dupNames = Object.entries(allCompanies.filter(real).reduce((m, c) => ({ ...m, [normalizeName(c.name)]: (m[normalizeName(c.name)] ?? 0) + 1 }), {})).filter(([, n]) => n > 1);
const dupDomains = Object.entries(allCompanies.filter(c => c.domain && real(c)).reduce((m, c) => ({ ...m, [c.domain]: (m[c.domain] ?? 0) + 1 }), {})).filter(([, n]) => n > 1);
const sigDupes = (await all(() => db.from("signals").select("type, source_url, quote").order("id"), "all signals")).reduce((m, s) => { const k = `${s.type}|${s.source_url}|${s.quote}`; m.set(k, (m.get(k) ?? 0) + 1); return m; }, new Map());
const capDupes = (await all(() => db.from("raw_captures").select("url, content_hash").gte("fetched_at", since).order("id"), "captures")).reduce((m, c) => { const k = `${c.url}|${c.content_hash}`; m.set(k, (m.get(k) ?? 0) + 1); return m; }, new Map());
const extractions = await all(() => db.from("extractions").select("status, method, error").gte("created_at", since).order("id"), "extractions");

const ledger = existsSync(args.ledger ?? "var/spend-ledger.jsonl") ? readFileSync(args.ledger ?? "var/spend-ledger.jsonl", "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(e => e.at >= since) : [];
const tregSpend = ledger.filter(e => e.provider === "treg").reduce((n, e) => n + e.cost_usd, 0);
const errors = {};
for (const r of runs) for (const [k, v] of Object.entries(r.counts ?? {})) if (k.startsWith("error_")) errors[k] = (errors[k] ?? 0) + v;
for (const r of runs) if (r.status === "blocked") errors[`blocked:${r.source_id}`] = (errors[`blocked:${r.source_id}`] ?? 0) + 1;
const totals = latest.map(s => Number(s.total));
const dist = totals.reduce((m, t) => ({ ...m, [t]: (m[t] ?? 0) + 1 }), {});
const withEvidence = created.filter(c => c.domain && signals.some(s => s.company_id === c.id && /^https?:/.test(s.source_url) && s.quote));
const minutes = runs.length ? (Date.parse(runs.at(-1).finished_at ?? runs.at(-1).started_at) - Date.parse(runs[0].started_at)) / 60000 : 0;
const bySource = {};
for (const c of created) { const key = /myworkdayjobs/.test(c.source ?? "") ? "workday-site-resolver (SEC names)" : c.source === "csv-import" ? "csv-import" : (c.source ?? "unknown"); bySource[key] = (bySource[key] ?? 0) + 1; }

const report = {
  since, runs: runs.length, run_minutes: Number(minutes.toFixed(1)),
  runs_by_status: runs.reduce((m, r) => ({ ...m, [`${r.job}${r.source_id ? `:${r.source_id}` : ""}:${r.status}`]: (m[`${r.job}${r.source_id ? `:${r.source_id}` : ""}:${r.status}`] ?? 0) + 1 }), {}),
  new_companies: created.length, new_companies_by_source: bySource,
  treg_spend_usd: Number(tregSpend.toFixed(6)), cost_per_new_company_usd: created.length ? Number((tregSpend / created.length).toFixed(6)) : null,
  pct_with_website_and_sourced_signal: created.length ? withEvidence.length / created.length : null,
  auto_added: created.length, sent_to_review: reviews.length, pct_auto_added: created.length + reviews.length ? created.length / (created.length + reviews.length) : null,
  review_reasons: reviews.reduce((m, r) => ({ ...m, [r.reason]: (m[r.reason] ?? 0) + 1 }), {}),
  duplicates: { company_names: dupNames, company_domains: dupDomains, signals: [...sigDupes.values()].filter(n => n > 1).length, raw_captures_in_window: [...capDupes.values()].filter(n => n > 1).length },
  signals_on_new_companies: signals.length, signal_types: signals.reduce((m, s) => ({ ...m, [`${s.type}/${s.method}`]: (m[`${s.type}/${s.method}`] ?? 0) + 1 }), {}),
  extraction: extractions.reduce((m, e) => ({ ...m, [`${e.method}:${e.status}`]: (m[`${e.method}:${e.status}`] ?? 0) + 1 }), {}),
  score_distribution: dist, distinct_totals: Object.keys(dist).length, all_same_total: totals.length > 1 && new Set(totals).size === 1,
  tiers: latest.reduce((m, s) => ({ ...m, [s.tier]: (m[s.tier] ?? 0) + 1 }), {}),
  ready_for_contacts: latest.filter(s => Number(s.budget_score) + Number(s.release_score) + Number(s.timing_score) >= 25).length,
  errors_by_type: errors,
  companies: created.map(c => ({ name: c.name, domain: c.domain, signals: signals.filter(s => s.company_id === c.id).map(s => s.type), total: latest.find(s => s.company_id === c.id)?.total ?? null })),
};
console.log(JSON.stringify(report, null, 1));
