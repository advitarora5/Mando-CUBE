// Assignments are derived only from the pinned repository snapshot, never live SEC data or run progress.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const SECTION_COUNT = 10;
export type SectionIssuer = { cik: number; name: string };
export type Section = { number: number; start: number; end: number; issuers: SectionIssuer[] };
export type SectionManifest = {
  version: string;
  frozen_on: string;
  source: string;
  snapshot: string;
  snapshot_sha256: string;
  section_count: number;
  issuer_count: number;
};

// Keep the first SEC occurrence for each CIK, preserving the snapshot's order.
// Do not exclude existing companies or unsuccessful candidates before assigning sections.
export function uniqueIssuers(raw: unknown): SectionIssuer[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Invalid SEC snapshot.");
  const issuers: SectionIssuer[] = [];
  const seen = new Set<number>();
  for (const row of Object.values(raw)) {
    if (!row || typeof row !== "object") throw Error("Invalid SEC issuer row.");
    const { cik_str: cik, title } = row as { cik_str?: unknown; title?: unknown };
    if (typeof cik !== "number" || !Number.isSafeInteger(cik) || cik <= 0 || typeof title !== "string" || !title.trim()) {
      throw Error("SEC issuer rows require a positive CIK and a company name.");
    }
    if (seen.has(cik)) continue;
    seen.add(cik);
    issuers.push({ cik, name: title.trim() });
  }
  if (issuers.length < SECTION_COUNT) throw Error("SEC snapshot needs at least 10 unique issuers.");
  return issuers;
}

export function splitSections(issuers: SectionIssuer[]): Section[] {
  if (issuers.length < SECTION_COUNT || new Set(issuers.map(i => i.cik)).size !== issuers.length) {
    throw Error("Sections require at least 10 issuers with unique CIKs.");
  }
  const base = Math.floor(issuers.length / SECTION_COUNT);
  const extra = issuers.length % SECTION_COUNT;
  let offset = 0;
  return Array.from({ length: SECTION_COUNT }, (_, index) => {
    const size = base + Number(index < extra);
    const section = { number: index + 1, start: offset + 1, end: offset + size, issuers: issuers.slice(offset, offset + size) };
    offset += size;
    return section;
  });
}

export function loadSections(manifestUrl = new URL("../data/sec-sections-v1.json", import.meta.url)) {
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as SectionManifest;
  if (manifest.version !== "sec-sections-v1" || manifest.section_count !== SECTION_COUNT || !Number.isSafeInteger(manifest.issuer_count)) {
    throw Error("Unsupported SEC assignment manifest.");
  }
  const snapshot = readFileSync(new URL(manifest.snapshot, manifestUrl));
  if (createHash("sha256").update(snapshot).digest("hex") !== manifest.snapshot_sha256) {
    throw Error("SEC snapshot differs from the frozen assignment manifest. Restore it or coordinate a new assignment version.");
  }
  const issuers = uniqueIssuers(JSON.parse(snapshot.toString("utf8")));
  if (issuers.length !== manifest.issuer_count) throw Error("SEC manifest issuer count does not match the snapshot.");
  return { manifest, sections: splitSections(issuers) };
}

export type SectionCommand = { section: number | null; preview: boolean; limit: number; noLlm: boolean; noTreg: boolean; maxSpend?: number };
export function parseSectionCommand(argv: string[]): SectionCommand {
  const defaults = { preview: true, limit: 25, noLlm: false, noTreg: false };
  if (argv[0] === "sections" && argv.length === 1) return { section: null, ...defaults };
  if (argv[0] !== "section") throw Error("Usage: pipeline sections | section <1-10> --preview");
  if (!/^(?:[1-9]|10)$/.test(argv[1] ?? "")) throw Error("Choose an explicit section number from 1 to 10.");
  const command: SectionCommand = { section: Number(argv[1]), ...defaults, preview: false };
  const seen = new Set<string>();
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw Error("Repeated section option.");
    seen.add(flag);
    if (flag === "--preview") command.preview = true;
    else if (flag === "--no-llm") command.noLlm = true;
    else if (flag === "--no-treg") command.noTreg = true;
    else if (flag === "--limit") {
      const value = argv[++i] ?? "";
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 100) throw Error("Section limit must be an integer from 1 to 100.");
      command.limit = Number(value);
    } else if (flag === "--max-spend") {
      const value = argv[++i] ?? "";
      if (!/^(?:\d+\.?\d*|\.\d+)$/.test(value) || !Number.isFinite(Number(value))) throw Error("Section spend limit must be a nonnegative number.");
      command.maxSpend = Number(value);
    } else throw Error("Unrecognized section option. Use --preview, --limit, --no-llm, --no-treg, or --max-spend.");
  }
  if (command.preview && seen.size !== 1) throw Error("Preview cannot be combined with execution options.");
  return command;
}

// Report only a hostname, never URL credentials, paths, query strings, or key values.
export function sectionDatabaseTarget(env: NodeJS.ProcessEnv, preview = true): string {
  const suffix = preview ? " (preview does not connect)" : "";
  if (!env.PIPELINE_SUPABASE_URL) return `not configured${suffix}`;
  let url: URL;
  try { url = new URL(env.PIPELINE_SUPABASE_URL); } catch { throw Error("Invalid pipeline database target URL."); }
  if (!["http:", "https:"].includes(url.protocol)) throw Error("Invalid pipeline database target URL.");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return `${local ? "local" : "remote"}: ${url.hostname}${suffix}`;
}
