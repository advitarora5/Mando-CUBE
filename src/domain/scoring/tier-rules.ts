import type { Score, Tier } from "@/domain/contracts/company";
import { categories } from "../contracts/company.ts";
import { hasEvidence } from "./evidence.ts";
import { rubric, tierForTotal, tierThresholdsFor } from "./rubric.ts";
import { incompleteCategories } from "./display.ts";

export { hasEvidence };
export type TierResult = { total: number; tier: Tier; tier_reason: string };

export function evaluateTier(score: Pick<Score,
  "authority_score" | "reachability_score" | "budget_score" | "release_score" | "timing_score" | "authority_evidence" | "reachability_evidence"
> & { rubric_version?: string | null }): TierResult {
  const tierThresholds = tierThresholdsFor(score.rubric_version);
  const values = [score.authority_score, score.reachability_score, score.budget_score, score.release_score, score.timing_score];
  const maxima = categories.map(category => rubric[category].weight);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.some((value, i) => !Number.isFinite(value) || value < 0 || value > maxima[i])) {
    return { total, tier: "Disqualified", tier_reason: "Category scores must be within the rubric limits." };
  }
  const unresolved = incompleteCategories({ ...score, tier: "Disqualified" });
  const missing = [unresolved.includes("authority") && "Authority", unresolved.includes("reachability") && "Reachability"].filter(Boolean);
  if (missing.length) return { total, tier: "Disqualified", tier_reason: `${missing.join(" and ")} evidence requires a source link and a reason.` };
  if (score.authority_score + score.reachability_score + score.budget_score === 0) {
    return { total, tier: "Disqualified", tier_reason: "Timing signals alone cannot qualify a company." };
  }
  const tier = tierForTotal(total, score.rubric_version);
  if (tier === "Disqualified") return { total, tier, tier_reason: `Score is below ${tierThresholds.Maybe}.` };
  return { total, tier, tier_reason: `Score is at least ${tierThresholds[tier]}, with Authority and Reachability evidence present.` };
}

// Never trust a stored tier without checking its scores and evidence.
export function applyTierRules(score: Score): Score {
  const result = evaluateTier(score);
  const missing = incompleteCategories({ ...score, tier: result.tier });
  if (result.tier === "Disqualified" && missing.length) {
    result.tier_reason = `Not Enough Evidence: ${missing.map(category => rubric[category].label).join(", ")} still need verification. Total ${result.total}/100 is provisional; missing evidence is not a rejection.`;
  }
  return { ...score, ...result };
}
