import { createClient } from "@supabase/supabase-js";
import { isSimilarName } from "../src/domain/ingestion/normalize.ts";

// Merges a duplicate company into the company being kept, using the merge_companies database function
// (supabase/migrations/202610270001_merge_companies.sql). Preview by default: the merge runs in full and is
// rolled back, so any problem shows up before anything changes. --apply commits it.
//   npm run companies:merge -- --keep <company id> --drop <company id> [--apply]
const args = process.argv.slice(2);
const value = flag => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
const keep = value("--keep"), drop = value("--drop"), apply = args.includes("--apply");
const known = new Set(["--keep", "--drop", "--apply", keep, drop]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!uuid.test(keep ?? "") || !uuid.test(drop ?? "") || args.some(arg => !known.has(arg))) {
  throw new Error("Usage: npm run companies:merge -- --keep <company id> --drop <company id> [--apply]");
}
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error("Configure database credentials in .env.local first.");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: rows, error: readError } = await db.from("companies").select("id,name,domain").in("id", [keep, drop]);
if (readError) throw new Error(readError.message);
const kept = rows.find(c => c.id === keep), merged = rows.find(c => c.id === drop);
if (!kept || !merged) throw new Error(`${!kept ? "--keep" : "--drop"} is not a company in the database.`);
console.log(`Keep:  ${kept.name}${kept.domain ? ` (${kept.domain})` : ""} [${kept.id}]`);
console.log(`Merge: ${merged.name}${merged.domain ? ` (${merged.domain})` : ""} [${merged.id}]`);

const { data, error } = await db.rpc("merge_companies", { p_keep: keep, p_drop: drop, p_apply: apply });
const preview = error?.message.startsWith("MERGE PREVIEW ") ? JSON.parse(error.message.slice("MERGE PREVIEW ".length)) : null;
if (error && !preview) {
  if (error.code === "PGRST202") throw new Error("The merge function is not in this database yet. Apply supabase/migrations/202610270001_merge_companies.sql first.");
  throw new Error(`Merge stopped, nothing changed: ${error.message}`);
}
const report = preview ?? data;
const moved = Object.entries(report.moved);
if (moved.length) console.table(Object.fromEntries(moved.map(([table, n]) => [table, { rows: n }])));
else console.log("The duplicate has no contacts, scores or other records to move.");

if (preview) {
  console.log("PREVIEW ONLY: nothing changed. Check the list above, then add --apply to merge.");
} else {
  console.log(`Merged ${merged.name} into ${kept.name}. The duplicate record is deleted; its records now belong to ${kept.name}.`);
  if (!isSimilarName(kept.name, merged.name)) {
    console.log(`So this name is never added again, add ${JSON.stringify(merged.name)} to ${kept.name}'s aliases in src/data/company-aliases.ts`);
    console.log(`(or add a new entry if it has none) and commit:`);
    console.log(`  { company_id: "${kept.id}", name: ${JSON.stringify(kept.name)}, aliases: [${JSON.stringify(merged.name)}] },`);
  }
}
