import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { applyTierRules } from "../src/domain/scoring/tier-rules.ts";
import {
  companyRanks,
  scoreOrder,
} from "../src/features/company-list/query.ts";

export function currentWeek(now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const get = (type) => parts.find((part) => part.type === type).value;
  const date = new Date(
    `${get("year")}-${get("month")}-${get("day")}T00:00:00Z`
  );

  // Use Monday as the start of each week.
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

async function readAll(db, table, columns, week = null) {
  const rows = [];
  const orderColumn = table === "company_insights" ? "company_id" : "id";

  // Read in batches so larger company lists are not cut off.
  for (let offset = 0; ; offset += 500) {
    let query = db.from(table).select(columns).order(orderColumn);
    if (week) query = query.eq("week_start", week);

    const { data, error } = await query.range(offset, offset + 499);
    if (error) throw new Error(`${table}: ${error.message}`);

    rows.push(...data);
    if (data.length < 500) return rows;
  }
}

export async function saveWeeklySnapshot(db, { apply = false, now = new Date() } = {}) {
  const week = currentWeek(now);

  const [companies, scores, insights, existing] = await Promise.all([
    readAll(db, "companies", "id,name"),
    readAll(db, "scores", "*"),
    readAll(db, "company_insights", "*"),
    readAll(db, "weekly_snapshots", "id,company_id,score_id,rank", week),
  ]);

  // Select the latest assessment available for each company.
  const latest = new Map();

  for (const score of scores) {
    const assessed = Date.parse(score.assessed_at);

    if (!Number.isFinite(assessed)) {
      throw new Error(`Invalid assessment date: ${score.id}`);
    }
    if (assessed > now.getTime()) continue;

    const previous = latest.get(score.company_id);

    if (
      !previous ||
      assessed > Date.parse(previous.assessed_at) ||
      (assessed === Date.parse(previous.assessed_at) &&
        score.id.localeCompare(previous.id) > 0)
    ) {
      latest.set(score.company_id, score);
    }
  }

  const scored = companies
    .filter((company) => latest.has(company.id))
    .map((company) => ({
      ...company,
      score: applyTierRules(latest.get(company.id)),
    }))
    .toSorted(scoreOrder);

  const ranks = companyRanks(scored);
  const insightMap = new Map(
    insights.map((item) => [item.company_id, item])
  );

  const plan = scored.map((company) => {
    const insight = insightMap.get(company.id);

    return {
      company: company.name,
      total: company.score.total,
      tier: company.score.tier,
      snapshot: {
        week_start: week,
        company_id: company.id,
        score_id: company.score.id,
        rank: ranks.get(company.id),
        persona: insight?.persona_override ?? insight?.persona_generated ?? null,
        level: insight?.level_override ?? insight?.level_generated ?? null,
        why_now: insight?.why_now_override ?? insight?.why_now_generated ?? null,
      },
    };
  });

  console.log(`Week starting ${week} (Monday, America/Chicago).`);

  console.table(
    plan.map((item) => ({
      company: item.company,
      rank: item.snapshot.rank,
      total: item.total,
      tier: item.tier,
    }))
  );

  console.log(
    `${plan.length} scored companies; ` +
    `${companies.length - plan.length} without an assessment as of now.`
  );

  if (existing.length) {
    console.log(
      `${existing.length} snapshots already exist for this week. ` +
      "Saving will skip the entire week to preserve them."
    );
  }

  const rankCounts = new Map();
  for (const item of plan) {
    const rank = item.snapshot.rank;
    rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1);
  }

  if ([...rankCounts.values()].some((count) => count > 1)) {
    console.log(
      "Tied ranks detected. The database must support shared ranks before saving."
    );
  }

  if (!apply) {
    console.log("PREVIEW ONLY: no database writes. Use --apply to save.");
    return { week, plan, status: "preview" };
  }
  if (existing.length) return { week, plan, status: "existing" };
  if (!plan.length) {
    console.log("No assessed companies; nothing saved.");
    return { week, plan, status: "empty" };
  }

  // One bulk INSERT is one database statement: every row succeeds or none do.
  // Do not chunk or upsert: conflicts must abort the complete batch.
  const { error } = await db.from("weekly_snapshots")
    .insert(plan.map((item) => item.snapshot));
  if (error) {
    throw new Error(`Weekly snapshot batch was not confirmed. Database rejections roll back the whole batch; after a connection failure, preview again before retrying: ${error.message}`);
  }
  console.log(`Saved ${plan.length} snapshots for ${week}.`);
  return { week, plan, status: "saved" };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--apply")) {
    throw new Error("Usage: node --env-file=.env.local scripts/save-weekly-snapshot.mjs [--apply]");
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY.");
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return saveWeeklySnapshot(db, { apply: args.includes("--apply") });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}