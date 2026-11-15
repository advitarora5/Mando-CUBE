import { loadSections, parseSectionCommand, sectionDatabaseTarget } from "../src/pipeline/sections.ts";

export function previewSections(argv, env) {
  const selection = parseSectionCommand(argv);
  const { manifest, sections } = loadSections();
  console.log(`Assignment: ${manifest.version} (frozen ${manifest.frozen_on})`);
  console.log(`Snapshot SHA-256: ${manifest.snapshot_sha256}`);
  console.log(`Database target: ${sectionDatabaseTarget(env)}`);
  console.log("Read-only preview: no database access, network requests, or pipeline execution.");
  console.log("Progress: unavailable in step 1; assignments include all issuers regardless of prior work.");
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
