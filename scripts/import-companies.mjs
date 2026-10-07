import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";
import { evaluateTier, hasEvidence } from "../src/domain/scoring/tier-rules.ts";

const RUBRIC = "week2-100-csv-unreviewed-v1";

const normalize = (value) =>
  String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();

function stableId(value) {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function readCompanies(filename) {
  const rows = Papa.parse(
    fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""),
    { skipEmptyLines: "greedy" }
  ).data;

  const start = rows.findIndex((row) =>
    row.map(normalize).includes("company")
  );
  const headers = rows[start].map(normalize);

  return rows.slice(start + 1).flatMap((row) => {
    const get = (name) =>
      String(row[headers.indexOf(name)] ?? "").trim();

    const name = get("company");
    if (!name || name === "Blue = manual input / judgment call.") return [];

    const rawDate = get("trigger event date");
    const date = rawDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const employees = get("est. employees").replace(/,/g, "");
    const count = /^\d+$/.test(employees) ? Number(employees) : null;

    if (
      count !== null &&
      (!Number.isSafeInteger(count) || count > 2147483647)
    ) {
      throw new Error(`${name}: employee count too large.`);
    }

    const evidence = get("evidence / source");
    const source = evidence.match(/https?:\/\/[^\s]+/)?.[0] ?? null;

    const company = {
      name,
      industry: get("industry") || null,
      headquarters: get("hq") || null,
      employee_count: count,
      workday_signal_date: date
        ? `${date[3]}-${date[1].padStart(2, "0")}-${date[2].padStart(2, "0")}`
        : null,
      source,
    };

    const score = {
      rubric_version: RUBRIC,
      authority_score: Number(get("functional authority /25")),
      reachability_score: Number(get("reachability & conviction /25")),
      budget_score: Number(get("customer budget /20")),
      release_score: Number(get("workday release alignment /15")),
      timing_score: Number(get("timing trigger /15")),
      authority_evidence:
        "Unmapped spreadsheet research; category evidence needs review.\n" +
        JSON.stringify({
          evidence,
          contact_targets: get("linkedin contact / target"),
          estimated_employees: get("est. employees"),
          trigger_event_date: rawDate,
          spreadsheet_tier: get("tier"),
          why_now: get("why now"),
        }),
      reachability_evidence: "",
      budget_evidence: "",
      release_evidence: "",
      timing_evidence: "",
    };
const authorityEvidence = get("authority evidence");
for (const category of [
  "authority", "reachability", "budget", "release", "timing",
]) {
  const value = get(`${category} evidence`);

  if (value && (!value.includes(" | ") || !hasEvidence(value))) {
    throw new Error(
      `${name}: ${category} evidence needs https://source | explanation.`
    );
  }
}
if (authorityEvidence) {
  score.authority_evidence =
    authorityEvidence + "\n\n" + score.authority_evidence;
}

score.reachability_evidence = get("reachability evidence");
score.budget_evidence = get("budget evidence");
score.release_evidence = get("release evidence");
score.timing_evidence = get("timing evidence");
    score.tier = evaluateTier(score).tier;

    return [{ company, score, whyNow: get("why now") || null }];
  });
}

async function result(query) {
  const response = await query;
  if (response.error) throw new Error(response.error.message);
  return response.data;
}

async function allCompanies(db) {
  const rows = [];

  for (let offset = 0; ; offset += 500) {
    const page = await result(
      db.from("companies")
        .select("id,name")
        .order("id")
        .range(offset, offset + 499)
    );

    rows.push(...page);
    if (page.length < 500) return rows;
  }
}

export async function importCompanies(db, records, apply = false) {
  const existing = await allCompanies(db);
  const plan = [];

  for (const record of records) {
    const matches = existing.filter(
      (row) => normalize(row.name) === normalize(record.company.name)
    );

    if (matches.length > 1) {
      throw new Error(
        `Multiple database matches for ${record.company.name}; resolve before importing.`
      );
    }

    const companyId =
      matches[0]?.id ??
      stableId(`mando-csv-company:${normalize(record.company.name)}`);

    const scoreId = stableId(
      `mando-csv-score:${companyId}:${JSON.stringify(record.score)}`
    );

    const scores = await result(
      db.from("scores")
        .select("id,rubric_version,assessed_at")
        .eq("company_id", companyId)
        .order("assessed_at", { ascending: false })
    );

    const alreadySaved = scores.some((score) => score.id === scoreId);
    const preserveAssessment =
      scores.length > 0 && scores[0].rubric_version !== RUBRIC;

    const insights = await result(
      db.from("company_insights")
        .select("company_id")
        .eq("company_id", companyId)
    );

    plan.push({
      ...record,
      companyId,
      scoreId,
      newCompany: !matches.length,
      newScore: !alreadySaved && !preserveAssessment,
      newInsights: !insights.length,
      scoreAction: alreadySaved
        ? "Already imported"
        : preserveAssessment
          ? "Preserve team assessment"
          : "Add unreviewed assessment",
    });
  }

  console.table(
    plan.map((item) => ({
      company: item.company.name,
      company_action: item.newCompany ? "Add" : "Keep existing fields",
      score_action: item.scoreAction,
      imported_total: evaluateTier(item.score).total,
      imported_tier: item.score.tier,
    }))
  );

  if (!apply) {
    console.log(
      "PREVIEW ONLY: no database writes. Add --apply to save this import."
    );
    return plan;
  }

  // If an insert fails, stable IDs let a rerun resume without duplicates.
  for (const item of plan) {
    try {
      if (item.newCompany) {
        await result(
          db.from("companies").upsert(
            { id: item.companyId, ...item.company },
            { onConflict: "id", ignoreDuplicates: true }
          )
        );
      }

      if (item.newInsights) {
        await result(
          db.from("company_insights").upsert(
            {
              company_id: item.companyId,
              why_now_generated: item.whyNow,
              generated_at: new Date().toISOString(),
            },
            { onConflict: "company_id", ignoreDuplicates: true }
          )
        );
      }

      if (item.newScore) {
        await result(
          db.from("scores").upsert(
            {
              id: item.scoreId,
              company_id: item.companyId,
              ...item.score,
            },
            { onConflict: "id", ignoreDuplicates: true }
          )
        );
      }

      console.log(`Saved/checked: ${item.company.name}`);
    } catch (error) {
      throw new Error(
        `${item.company.name}: ${error.message}. Import stopped; earlier records may be saved. Rerun to resume.`
      );
    }
  }

  console.log(
    "Import complete. Existing company fields, contacts, and insight overrides were preserved."
  );
}

async function main() {
  const args = process.argv.slice(2);
  const filename = args.find((arg) => !arg.startsWith("--"));

  if (
    !filename ||
    args.some((arg) => arg.startsWith("--") && arg !== "--apply") ||
    args.filter((arg) => !arg.startsWith("--")).length !== 1
  ) {
    throw new Error(
      'Usage: node --env-file=.env.local scripts/import-companies.mjs "path/to/companies.csv" [--apply]'
    );
  }

  const preview = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./preview-import.mjs", import.meta.url)),
      filename,
    ],
    { stdio: "inherit" }
  );

  if (preview.error || preview.status !== 0) {
    throw new Error("CSV validation failed; nothing imported.");
  }

  const records = readCompanies(filename);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error(
      "Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local."
    );
  }

  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  await importCompanies(db, records, args.includes("--apply"));
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(new URL(`file://${process.argv[1]}`))
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}