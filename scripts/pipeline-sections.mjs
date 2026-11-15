import { loadSections, parseSectionCommand, sectionDatabaseTarget } from "../src/pipeline/sections.ts";
import { loadSectionScope } from "../src/pipeline/section-scope.ts";
import { contextFromEnv } from "../src/pipeline/context.ts";
import { runPipeline } from "../src/pipeline/runner.ts";

export async function sectionCommand(argv, env) {
  const selection = parseSectionCommand(argv);
  if (selection.preview) return previewSections(argv, env);
  const scope = loadSectionScope(selection.section);
  console.log(`Assignment: ${scope.version}; section ${scope.section} of 10`);
  console.log(`Database target: ${sectionDatabaseTarget(env, false)}`);
  const ctx = await contextFromEnv(env, { dryRun: false, noLlm: selection.noLlm, noTreg: selection.noTreg, maxSpend: selection.maxSpend });
  ctx.sectionScope = scope;
  const report = await runPipeline(ctx, { plan: "section", limit: selection.limit, dryRun: false, trigger: "manual" });
  const failed = report.jobs.some(j => j.status !== "succeeded");
  console.log(JSON.stringify({ ...report, status: failed ? "failed" : "succeeded" }, null, 2));
  if (failed) process.exitCode = 1;
}

export function previewSections(argv, env) {
  const selection = parseSectionCommand(argv);
  const { manifest, sections } = loadSections();
  console.log(`Assignment: ${manifest.version} (frozen ${manifest.frozen_on})`);
  console.log(`Snapshot SHA-256: ${manifest.snapshot_sha256}`);
  console.log(`Database target: ${sectionDatabaseTarget(env)}`);
  console.log("Read-only preview: no database access, network requests, or pipeline execution.");
  console.log("Progress: not queried by preview; assignments include all issuers regardless of prior work.");
  if (selection.section === null) {
    console.table(sections.map(s => ({ section: s.number, start: s.start, end: s.end, issuers: s.issuers.length })));
    console.log(`Total: ${manifest.issuer_count} unique issuers across ${manifest.section_count} sections.`);
    console.log("Preview an assignment: npm run pipeline -- section <1-10> --preview");
    return;
  }
  const section = sections[selection.section - 1];
  console.log(`Section: ${section.number} of ${manifest.section_count}; issuer positions ${section.start}-${section.end} inclusive; ${section.issuers.length} issuers.`);
  console.log("Position\tCIK\tCompany");
  section.issuers.forEach((issuer, index) => console.log(`${section.start + index}\t${issuer.cik}\t${issuer.name}`));
}
