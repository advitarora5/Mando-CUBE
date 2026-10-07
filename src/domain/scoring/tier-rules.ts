import type { Score, Tier } from "@/domain/contracts/company";
import { categories } from "../contracts/company.ts";
import { hasEvidence } from "./evidence.ts";
import { rubric, tierForTotal, tierThresholds } from "./rubric.ts";

export { hasEvidence };
export type TierResult = { total: number; tier: Tier; tier_reason: string };

export function evaluateTier(score: Pick<Score,
  "authority_score" | "reachability_score" | "budget_score" | "release_score" | "timing_score" | "authority_evidence" | "reachability_evidence"
>): TierResult {
  const values = [score.authority_score, score.reachability_score, score.budget_score, score.release_score, score.timing_score];
  const maxima = categories.map(category => rubric[category].weight);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.some((value, i) => !Number.isFinite(value) || value < 0 || value > maxima[i])) {
    return { total, tier: "Disqualified", tier_reason: "Category scores must be within the rubric limits." };
  }
  const missing = [!hasEvidence(score.authority_evidence) && "Authority", !hasEvidence(score.reachability_evidence) && "Reachability"].filter(Boolean);
  if (missing.length) return { total, tier: "Disqualified", tier_reason: `${missing.join(" and ")} evidence requires a source link and a reason.` };
  if (score.authority_score + score.reachability_score + score.budget_score === 0) {
    return { total, tier: "Disqualified", tier_reason: "Timing signals alone cannot qualify a company." };
  }
  const tier = tierForTotal(total);
  if (tier === "Disqualified") return { total, tier, tier_reason: `Score is below ${tierThresholds.Maybe}.` };
  return { total, tier, tier_reason: `Score is at least ${tierThresholds[tier]}, with Authority and Reachability evidence present.` };
}

// Never trust a stored tier without checking its scores and evidence.
export function applyTierRules(score: Score): Score {
  return { ...score, ...evaluateTier(score) };
}
