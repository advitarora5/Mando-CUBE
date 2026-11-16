import { contextFromEnv, databaseFromEnv } from "../src/pipeline/context.ts";
import { loadSections } from "../src/pipeline/sections.ts";
import { normalizeName } from "../src/domain/ingestion/normalize.ts";
import { workScoringQueue } from "../src/pipeline/scoring-queue.ts";

const uuid = value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value ?? "");
export function parseScoringCommand(argv) {
  const command = argv[0];
  if (command === "status" && argv.length === 1) return { command };
  if (command === "enqueue" && argv.length === 2 && uuid(argv[1])) return { command, companyId: argv[1] };
  if (command !== "work") throw Error("Usage: pipeline scoring status | enqueue <company-id> | work [--limit 25] [--company <id>] [--watch --poll-seconds 5]");
  const opts = { command, limit: 25, watch: false, pollSeconds: 5, companyId: undefined };
  const seen = new Set();
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw Error("Repeated scoring option.");
    seen.add(flag);
    if (flag === "--watch") opts.watch = true;
    else if (flag === "--company") {
      if (!uuid(argv[++i])) throw Error("Scoring company must be a valid company ID.");
      opts.companyId = argv[i];
    } else if (flag === "--limit" || flag === "--poll-seconds") {
      const value = argv[++i] ?? "";
      const max = flag === "--limit" ? 100 : 60;
      if (!/^[1-9]\d*$/.test(value) || Number(value) > max) throw Error(`Scoring ${flag} must be an integer from 1 to ${max}.`);
      if (flag === "--limit") opts.limit = Number(value); else opts.pollSeconds = Number(value);
    } else throw Error("Unrecognized scoring option.");
  }
  if (seen.has("--poll-seconds") && !opts.watch) throw Error("--poll-seconds requires --watch.");
  return opts;
}

export async function scoringCommand(argv, env) {
  const opts = parseScoringCommand(argv); // Validate before touching the database or initializing providers.
  const store = databaseFromEnv(env);
  if (opts.command === "status") { console.log(JSON.stringify(await store.scoringQueueStatus(), null, 2)); return; }
  if (opts.command === "enqueue") { await store.enqueueScoring(opts.companyId); console.log("Company queued for scoring."); return; }
  const ctx = await contextFromEnv({ ...env, PIPELINE_CONTACT_REVIEWS_FILE: undefined }, { dryRun: false, store, noLlm: true, noTreg: true, maxSpend: 0 });
  // Section discovery does not collect a live SEC list; use the same verified frozen list for filing lookup.
  const all = loadSections().sections.flatMap(s => s.issuers), ambiguous = new Set(), index = new Map();
  for (const issuer of all) {
    const name = normalizeName(issuer.name);
    if (index.has(name) && index.get(name) !== issuer.cik) ambiguous.add(name);
    index.set(name, issuer.cik);
  }
  for (const name of ambiguous) index.delete(name);
  ctx.financialsIndex = index;
  const controller = new AbortController();
  ctx.signal = controller.signal;
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    do {
      const report = await workScoringQueue(ctx, opts);
      if (report.attempted || !opts.watch) console.log(JSON.stringify(report, null, 2));
      if (report.retry && !opts.watch) process.exitCode = 1;
      if (!opts.watch || controller.signal.aborted) break;
      await new Promise(resolve => {
        const onAbort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { controller.signal.removeEventListener("abort", onAbort); resolve(); }, opts.pollSeconds * 1000);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
    } while (!controller.signal.aborted);
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}
