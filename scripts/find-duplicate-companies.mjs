import fs from "node:fs";
import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";
import { findDuplicatePairs, matchExistingCompany } from "../src/domain/ingestion/duplicates.ts";
import { companyAliases, distinctCompanies } from "../src/data/company-aliases.ts";

// Read-only: never writes to the database.
//   npm run companies:duplicates                          companies on the dashboard that may be the same company
//   npm run companies:duplicates -- --check <file>        whether companies you are about to add are already there
// A --check file is a CSV with a company (or name) column and an optional domain (or website) column,
// or a JSON array (or { companies: [...] }) of objects with those fields.
const args = process.argv.slice(2);
const check = args[0] === "--check" ? args[1] : null;
if (args.length && !(args.length === 2 && check)) {
  throw new Error("Usage: npm run companies:duplicates [-- --check path/to/companies.csv]");
}
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error("Configure database credentials in .env.local first.");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const companies = [];
for (let offset = 0; ; offset += 1000) {
  const { data, error } = await db.from("companies").select("id,name,domain,created_at,scores(count),contacts(count)").order("id").range(offset, offset + 999);
  if (error) throw new Error(error.message);
  companies.push(...data.map(c => ({ ...c, scores: c.scores[0]?.count ?? 0, contacts: c.contacts[0]?.count ?? 0 })));
  if (data.length < 1000) break;
}
const short = id => id.slice(0, 8);

if (check) {
  const text = fs.readFileSync(check, "utf8").replace(/^﻿/, "");
  const json = check.endsWith(".json") ? JSON.parse(text) : null;
  const rows = json ? (Array.isArray(json) ? json : json.companies ?? []) : Papa.parse(text, { header: true, skipEmptyLines: "greedy", transformHeader: h => h.trim().toLowerCase() }).data;
  const results = rows.map(row => {
    const candidate = { name: String(row.company ?? row.name ?? "").trim(), domain: row.domain ?? row.website ?? null };
    const match = matchExistingCompany(candidate, companies, companyAliases);
    const found = match.kind === "existing" || match.kind === "review" ? [match.company] : match.kind === "ambiguous" ? match.companies : [];
    const verdict = { existing: "Already on the dashboard", review: "Similar name: a person decides", ambiguous: "Matches more than one company", new: "New" }[match.kind];
    return { company: candidate.name || "(no name)", verdict, reason: match.kind === "new" ? "" : match.reason, existing: found.map(c => `${c.name} [${short(c.id)}]`).join("; ") };
  });
  console.table(results);
  const counts = results.reduce((all, r) => ({ ...all, [r.verdict]: (all[r.verdict] ?? 0) + 1 }), {});
  console.log(Object.entries(counts).map(([verdict, n]) => `${verdict}: ${n}`).join(" | "));
  console.log("Add only the rows marked New. For a similar name, check the source and either add the name to src/data/company-aliases.ts or add the company.");
} else {
  const pairs = findDuplicatePairs(companies, companyAliases, distinctCompanies);
  if (!pairs.length) {
    console.log(`No likely duplicates among ${companies.length} companies (same website, same name, known alias or similar name).`);
  } else {
    // Suggest keeping the record with more history (scores, contacts), then the older one.
    const weight = c => c.scores + c.contacts;
    const suggested = pairs.map(({ a, b, reasons }) => {
      const aFirst = weight(a) !== weight(b) ? weight(a) > weight(b) : a.created_at <= b.created_at;
      return { reasons, keep: aFirst ? a : b, drop: aFirst ? b : a };
    });
    const label = c => `${c.name} [${short(c.id)}] ${c.scores}s ${c.contacts}c`;
    console.table(suggested.map(({ reasons, keep, drop }) => ({ why: reasons.join(", "), keep: label(keep), merge: label(drop) })));
    console.log(`${pairs.length} possible duplicates among ${companies.length} companies (s = scores, c = contacts).`);
    console.log("Check each pair against its sources. To merge one, preview first:");
    for (const { keep, drop } of suggested) console.log(`  npm run companies:merge -- --keep ${keep.id} --drop ${drop.id}`);
    console.log("If a pair is two different companies, add it to distinctCompanies in src/data/company-aliases.ts.");
  }
}
