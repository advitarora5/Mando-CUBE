// Start to end in one command: collect -> extract -> match -> website lookup -> approve -> score -> enrich.
// The pipeline never guesses a company website, so unmatched companies wait for review. Here the model proposes a
// domain and it is only accepted when the site itself names the company; anything else stays in the review queue.
//   npm run pipeline:full -- [--limit N] [--no-treg]
import { contextFromEnv } from "../src/pipeline/context.ts";
import { runPipeline } from "../src/pipeline/runner.ts";
import { normalizeDomain, normalizeName } from "../src/domain/ingestion/normalize.ts";

const args = process.argv.slice(2);
const limit = Number(args[args.indexOf("--limit") + 1] || 10);
const ctx = await contextFromEnv(process.env, { dryRun: false, noTreg: args.includes("--no-treg") });
const run = plan => runPipeline(ctx, { plan, limit, dryRun: false, trigger: "manual" });

const report = await run("all");

// The homepage must mention the company's first distinctive word, so a wrong or invented domain is rejected.
async function siteNames(domain, name) {
  const word = normalizeName(name).split(" ")[0];
  if (word.length < 3) return false;
  try {
    const res = await fetch(`https://${domain}`, { signal: AbortSignal.timeout(10000), headers: { "user-agent": `MandoCUBE-pipeline ${ctx.contact}`.trim() } });
    return res.ok && (await res.text()).toLowerCase().includes(word);
  } catch { return false; }
}

const budget = Number(process.env.PIPELINE_LLM_BUDGET_USD ?? 0);
let spent = 0;
const outcome = { approved: [], left_for_review: [] };
if (ctx.llm) for (const item of await ctx.store.reviewItems("pending")) {
  if (item.reason !== "no_website") continue;
  let domain = null;
  if (spent + ctx.llm.worstCaseUsd <= budget) {
    const reply = await ctx.llm.complete({
      system: 'Give the primary public website domain of the named company, like "example.com". Use null if you are not sure.',
      user: item.candidate_name,
      schema: { type: "object", properties: { domain: { type: ["string", "null"] } }, required: ["domain"] },
    });
    spent += reply.cost_usd;
    if (reply.ok) domain = normalizeDomain(reply.json?.domain);
  }
  if (domain && await siteNames(domain, item.candidate_name)) {
    await ctx.store.resolveReview(item.id, { action: "approve", domain }, `auto-approved: ${domain} names the company`, null);
    outcome.approved.push(`${item.candidate_name} -> ${domain}`);
  } else outcome.left_for_review.push(item.candidate_name);
}
await run("score");

console.log(JSON.stringify({ collected: report.jobs.filter(j => j.job === "collect").map(j => ({ source: j.source_id, status: j.status, ...j.counts })), website_lookup: outcome, model_spend_usd: Number((report.llm_spend_usd + spent).toFixed(4)), alerts: report.alerts }, null, 2));
