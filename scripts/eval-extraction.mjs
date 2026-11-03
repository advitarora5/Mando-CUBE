// Extraction evaluation on the golden set (tests/fixtures/ingestion/golden). Uses the pipeline's own model call,
// gating and grounding, so the numbers describe what the pipeline would keep.
//
//   npm run pipeline:eval -- [--model qwen2.5:7b] [--runs 5] [--set all|tune|holdout] [--prompt extract-v1] [--out file.json]
//   Paid models: --provider openai|gemini (needs PIPELINE_ALLOW_PAID_LLM=1 and a key; prints the cost). Off by default.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { OllamaProvider, llmFromEnv } from "../src/pipeline/llm.ts";
import { readWithModel, loadPrompt, needsModelText } from "../src/pipeline/extract.ts";
import { normalizeName, isSimilarName } from "../src/domain/ingestion/normalize.ts";
import { verifyQuote } from "../src/domain/ingestion/quote.ts";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]]] : acc), []));
const G = new URL("../tests/fixtures/ingestion/golden/", import.meta.url);
const items = JSON.parse(readFileSync(new URL("items.json", G), "utf8"));
const labels = JSON.parse(readFileSync(new URL("labels.json", G), "utf8"));
const holdout = new Set(labels.holdout);
const set = args.set ?? "all";
const chosen = items.filter(i => set === "all" || (set === "holdout") === holdout.has(i.id));
const runs = Number(args.runs ?? 5);
const promptVersion = args.prompt ?? "extract-v1";
const prompt = loadPrompt(promptVersion);
const llm = args.provider ? llmFromEnv({ ...process.env, PIPELINE_LLM: args.provider }) : new OllamaProvider({ host: process.env.OLLAMA_HOST, model: args.model ?? process.env.OLLAMA_MODEL ?? "qwen2.5:7b" });

const mode = values => { const counts = new Map(); for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1); return Math.max(...counts.values()) / values.length; };
const norm = v => (v ? normalizeName(v) : "");
const results = [];
let cost = 0;
const started = Date.now();
for (const item of chosen) {
  const label = labels.items[item.id];
  const perRun = [];
  for (let r = 0; r < runs; r++) {
    if (!needsModelText(item.kind, item.title, item.text)) { perRun.push({ skipped: true, ok: true, attempts: 0, company: null, types: [], quotes: [], project: null, rawQuotes: 0, rawVerbatim: 0, filled: 0, dropped: 0, ms: 0, firstValid: true }); continue; }
    const reading = await readWithModel(llm, item.kind, item.title, item.text, prompt, promptVersion);
    cost += reading.cost_usd;
    if (!reading.ok) { perRun.push({ ok: false, error: reading.error, attempts: reading.attempts, ms: reading.ms, firstValid: false, company: null, types: [], quotes: [], project: null, rawQuotes: 0, rawVerbatim: 0, filled: 0, dropped: 0 }); continue; }
    const { checked } = reading;
    const fullText = `${item.title ?? ""}\n${item.text}`;
    const rawSignals = checked.signals.length + checked.dropped.filter(d => d.field.endsWith(".quote")).length;
    const quoteDrops = checked.dropped.filter(d => d.field.endsWith(".quote"));
    const nonQuoteDrops = checked.dropped.filter(d => !d.field.endsWith(".quote"));
    const o = checked.output;
    const filled = (o.company_name ? 1 : 0) + o.workday_products.length + o.timing_words.length + (o.project_type ? 1 : 0) + checked.signals.filter(s => s.date_text).length + nonQuoteDrops.length;
    perRun.push({
      ok: true, attempts: reading.attempts, firstValid: reading.attempts === 1, ms: reading.ms,
      company: o.company_name, types: [...new Set(checked.signals.map(s => s.type))].sort(), quotes: checked.signals.map(s => s.quote).sort(), project: o.project_type,
      rawQuotes: rawSignals, rawVerbatim: rawSignals - quoteDrops.length, filled, dropped: nonQuoteDrops.length,
      dropped_detail: checked.dropped, verbatimCheck: checked.signals.every(s => verifyQuote(s.quote, fullText).ok),
    });
  }
  const first = perRun[0];
  const types = new Set(first.types);
  // What the pipeline keeps: the model's signals plus the structured hiring signal every Workday job posting gets.
  const pipelineTypes = new Set([...first.types, ...(/job posting/i.test(item.kind) && needsModelText(item.kind, item.title, item.text) ? ["hiring"] : [])]);
  const required = label.required ?? [], allowed = new Set([...(label.required ?? []), ...(label.allowed ?? [])]);
  const companyOk = label.company === null ? (!first.company || (label.company_ok ?? []).some(c => isSimilarName(c, first.company))) : !!first.company && [label.company, ...(label.company_ok ?? [])].some(c => isSimilarName(c, first.company));
  const projectOk = [label.project, ...(label.project_ok ?? [])].includes(first.project ?? null);
  results.push({
    id: item.id, holdout: holdout.has(item.id), kind: item.kind, title: item.title, label, runs: perRun,
    company_ok: companyOk, project_ok: projectOk,
    required_found: required.filter(t => types.has(t)).length, required_total: required.length,
    false_types: [...types].filter(t => !allowed.has(t)),
    pipeline_required_found: required.filter(t => pipelineTypes.has(t)).length,
    pipeline_false_types: [...pipelineTypes].filter(t => !allowed.has(t)), pipeline_predicted: pipelineTypes.size,
    consistency: { company: mode(perRun.map(p => norm(p.company))), types: mode(perRun.map(p => p.types.join(","))), quotes: mode(perRun.map(p => p.quotes.join("|"))) },
  });
  process.stdout.write(`${item.id} ${first.ok ? "" : "INVALID "}types=[${first.types}] company=${first.company ?? "-"} project=${first.project ?? "-"} ${companyOk ? "" : "COMPANY-MISS "}${results.at(-1).false_types.length ? `FALSE=${results.at(-1).false_types} ` : ""}${results.at(-1).required_found < required.length ? `MISSED=${required.filter(t => !types.has(t))} ` : ""}\n`);
}

function summarize(rs) {
  const all = rs.flatMap(r => r.runs.filter(p => !p.skipped));
  const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
  const firsts = rs.map(r => r.runs[0]);
  const req = sum(rs, r => r.required_total), found = sum(rs, r => r.required_found);
  const predicted = sum(firsts, p => p.types.length), falseTypes = sum(rs, r => r.false_types.length);
  const avg = (xs, f) => (xs.length ? sum(xs, f) / xs.length : 1);
  return {
    items: rs.length, model_calls: all.length,
    schema_valid_first_try: avg(all, p => (p.firstValid ? 1 : 0)),
    schema_valid_after_retry: avg(all, p => (p.ok ? 1 : 0)),
    raw_quote_verbatim_rate: sum(all, p => p.rawQuotes) ? sum(all, p => p.rawVerbatim) / sum(all, p => p.rawQuotes) : 1,
    kept_quote_verbatim_rate: avg(all.filter(p => p.ok), p => (p.verbatimCheck === false ? 0 : 1)),
    hallucination_rate: sum(all, p => p.filled) ? sum(all, p => p.dropped) / sum(all, p => p.filled) : 0,
    company_accuracy: avg(rs, r => (r.company_ok ? 1 : 0)),
    project_accuracy: avg(rs, r => (r.project_ok ? 1 : 0)),
    signal_recall: req ? found / req : 1,
    signal_precision: predicted ? (predicted - falseTypes) / predicted : 1,
    pipeline_signal_recall: req ? sum(rs, r => r.pipeline_required_found) / req : 1,
    pipeline_signal_precision: sum(rs, r => r.pipeline_predicted) ? (sum(rs, r => r.pipeline_predicted) - sum(rs, r => r.pipeline_false_types.length)) / sum(rs, r => r.pipeline_predicted) : 1,
    false_type_items: rs.filter(r => r.false_types.length).map(r => `${r.id}:${r.false_types}`),
    consistency_company: avg(rs, r => r.consistency.company),
    consistency_types: avg(rs, r => r.consistency.types),
    consistency_quotes: avg(rs, r => r.consistency.quotes),
    mean_ms_per_call: avg(all, p => p.ms),
  };
}

const report = {
  model: `${llm.name}:${llm.model}`, prompt: promptVersion, runs, set, at: new Date().toISOString(), minutes: (Date.now() - started) / 60000, cost_usd: cost,
  label_source: labels.label_source,
  overall: summarize(results), tune: summarize(results.filter(r => !r.holdout)), holdout: summarize(results.filter(r => r.holdout)),
  results,
};
const out = args.out ?? `var/eval/extraction-${promptVersion}-${llm.model.replace(/[:/]/g, "_")}.json`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ model: report.model, prompt: report.prompt, minutes: report.minutes.toFixed(1), cost_usd: cost, overall: report.overall, holdout: report.holdout }, null, 1));
console.log(`full report: ${out}`);
