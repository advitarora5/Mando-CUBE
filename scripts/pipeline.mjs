// Ingestion pipeline CLI. Any teammate can run one stage or the whole thing.
//
//   npm run pipeline -- run [--plan daily|weekly|all|collect|extract|match|score|rescore|enrich] [--source <id>]
//                            [--limit N] [--dry-run] [--max-spend USD] [--no-llm] [--no-treg] [--trigger manual|schedule|import_button]
//   npm run pipeline -- import <file.csv> [--dry-run]
//   npm run pipeline -- health
//   npm run pipeline -- review list | approve <id> [--domain example.com] | merge <id> <company_id> | reject <id> [--note text]
//
// Database: PIPELINE_SUPABASE_URL / PIPELINE_SUPABASE_KEY (local or test only; see docs/ingestion-runbook.md).
import { readFileSync } from "node:fs";
import { contextFromEnv } from "../src/pipeline/context.ts";
import { importCsv } from "../src/pipeline/import-csv.ts";
import { runPipeline } from "../src/pipeline/runner.ts";

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { out._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = flags(process.argv.slice(2));
const [command, ...rest] = args._;
const dryRun = !!args["dry-run"];
const maxSpend = args["max-spend"] != null ? Number(args["max-spend"]) : undefined;

try {
  if (command === "run") {
    const ctx = await contextFromEnv(process.env, { dryRun, maxSpend, noLlm: !!args["no-llm"], noTreg: !!args["no-treg"] });
    const report = await runPipeline(ctx, {
      plan: args.plan ?? (args.stage ?? "daily"), source: args.source, limit: Number(args.limit ?? 20), dryRun,
      trigger: args.trigger ?? "manual", enrichCompanies: args["enrich-companies"] ? Number(args["enrich-companies"]) : undefined,
    });
    const unsuccessful = report.jobs.filter(j => j.status !== "succeeded");
    const status = unsuccessful.length ? "failed" : "succeeded";
    console.log(JSON.stringify({ status, ms: report.ms, treg_spend_usd: report.treg_spend_usd, llm_spend_usd: report.llm_spend_usd, alerts: report.alerts, jobs: report.jobs.map(j => ({ job: j.job, source: j.source_id, status: j.status, ms: j.ms, counts: j.counts, blocked: j.blocked, errors: j.errors })) }, null, 2));
    if (unsuccessful.length) {
      console.error(`Pipeline failed: ${unsuccessful.map(j => `${j.job}${j.source_id ? ` [${j.source_id}]` : ""}: ${j.status}`).join("; ")}`);
      process.exitCode = 1;
    }
    if (dryRun) console.log("Dry run: nothing was written to the database or the spend ledger.");
  } else if (command === "import") {
    if (!rest[0]) throw new Error("usage: pipeline import <file.csv>");
    const ctx = await contextFromEnv(process.env, { dryRun, maxSpend, noLlm: true });
    const runId = dryRun ? null : await ctx.store.startRun({ job: "import", source_id: "csv-import", trigger: args.trigger ?? "import_button" });
    ctx.runId = runId;
    const result = await importCsv(ctx, readFileSync(rest[0], "utf8"), { dryRun });
    if (runId) await ctx.store.finishRun(runId, { status: result.errors.length ? "partial" : "succeeded", counts: { items: result.rows.length, ...result.counts }, requests: 0, llm_spend_usd: 0, treg_spend_usd: 0, error: result.errors.slice(0, 3).join(" | ") || null });
    console.log(JSON.stringify({ counts: result.counts, errors: result.errors }, null, 2));
  } else if (command === "health") {
    const ctx = await contextFromEnv(process.env, { dryRun: false, noLlm: true, noTreg: true });
    console.log(JSON.stringify({ health: await ctx.store.health(), alerts: await ctx.store.sourceAlerts() }, null, 2));
  } else if (command === "review") {
    const ctx = await contextFromEnv(process.env, { dryRun: false, noLlm: true, noTreg: true });
    const [action, id, company] = rest;
    if (action === "list" || !action) {
      for (const item of await ctx.store.reviewItems("pending")) console.log(`${item.id}  ${item.reason.padEnd(16)} ${item.candidate_name}${item.candidate_domain ? ` (${item.candidate_domain})` : ""}${item.suggested_company_id ? ` ~ ${item.suggested_company_id}` : ""}`);
    } else if (action === "approve") console.log(await ctx.store.resolveReview(id, { action: "approve", domain: args.domain ?? null }, args.note ?? "approved via CLI", null));
    else if (action === "merge") console.log(await ctx.store.resolveReview(id, { action: "merge", company_id: company }, args.note ?? "merged via CLI", null));
    else if (action === "reject") await ctx.store.resolveReview(id, { action: "reject" }, args.note ?? "rejected via CLI", null);
    else throw new Error(`unknown review action ${action}`);
  } else {
    console.log("usage: pipeline run|import|health|review  (see the header of scripts/pipeline.mjs)");
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(`x ${error.message}`);
  process.exitCode = 1;
}
