import fs from "node:fs";
import { createHash } from "node:crypto";
import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";
import { assessSheet } from "../src/domain/scoring/assessment-sheet.ts";

// Saves reviewed category scores and evidence as new rows in the scores table.
// Preview by default; --apply writes. Sheet format: see "Saving assessments" in README.md.
const args = process.argv.slice(2);
const files = args.filter(arg => !arg.startsWith("--"));
const apply = args.includes("--apply");
if (files.length !== 1 || args.some(arg => arg.startsWith("--") && arg !== "--apply")) {
  throw new Error('Usage: node --env-file=.env.local scripts/save-assessments.mjs "path/to/assessments.csv" [--apply]');
}
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error("Configure database credentials in .env.local first.");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const parsed = Papa.parse(fs.readFileSync(files[0], "utf8").replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: header => header.trim().toLowerCase() });
if (parsed.errors.length) throw new Error(`Could not read the CSV: ${parsed.errors.map(e => `line ${e.row + 2}: ${e.message}`).join("; ")}`);

const companies = [];
for (let offset = 0; ; offset += 500) {
  const { data, error } = await db.from("companies").select("id,name,workday_signal_date").order("id").range(offset, offset + 499);
  if (error) throw new Error(error.message);
  companies.push(...data);
  if (data.length < 500) break;
}

const results = assessSheet(parsed.data, companies);
console.table(results.map(r => ({ line: r.line, company: r.company, total: r.total ?? "", tier: r.tier ?? "", problem: r.errors.join(" ") })));
const failed = results.filter(r => r.errors.length);
if (failed.length) {
  console.error(`${failed.length} of ${results.length} rows have problems. Nothing was saved; fix the sheet and run again.`);
  process.exit(1);
}
if (!apply) {
  console.log(`PREVIEW ONLY: ${results.length} assessments are valid. No database writes. Add --apply to save them.`);
  process.exit(0);
}

// Assessments are appended, never rewritten. The ID comes from the row's content, so running
// the same sheet twice does not add duplicates.
function stableId(value) {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const rows = results.map(r => ({ id: stableId(`mando-assessment:${JSON.stringify(r.row)}`), ...r.row }));
const { data, error } = await db.from("scores").upsert(rows, { onConflict: "id", ignoreDuplicates: true }).select("id");
if (error) throw new Error(`scores: ${error.message}`);
console.log(`Saved ${data.length} new assessments; ${rows.length - data.length} were already saved.`);
