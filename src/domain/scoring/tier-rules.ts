import type { Score, Tier } from "@/domain/contracts/company";

export type TierResult = { total: number; tier: Tier; tier_reason: string };

// Format validation establishes presence, not factual credibility of the source.
export function hasEvidence(value: string | null | undefined): boolean {
  if (!value) return false;
  const split = value.indexOf("|");
  if (split < 0 || !value.slice(split + 1).trim()) return false;
  try {
    const url = new URL(value.slice(0, split).trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch { return false; }
}

export function evaluateTier(score: Pick<Score,
  "authority_score" | "reachability_score" | "budget_score" | "release_score" | "timing_score" | "authority_evidence" | "reachability_evidence"
>): TierResult {
  const values = [score.authority_score, score.reachability_score, score.budget_score, score.release_score, score.timing_score];
  const maxima = [25, 25, 20, 15, 15];
  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.some((value, i) => !Number.isFinite(value) || value < 0 || value > maxima[i])) {
    return { total, tier: "Disqualified", tier_reason: "Category scores must be within the rubric limits." };
  }
  const missing = [!hasEvidence(score.authority_evidence) && "Authority", !hasEvidence(score.reachability_evidence) && "Reachability"].filter(Boolean);
  if (missing.length) return { total, tier: "Disqualified", tier_reason: `${missing.join(" and ")} evidence requires a source link and a reason.` };
  if (score.authority_score + score.reachability_score + score.budget_score === 0) {
    return { total, tier: "Disqualified", tier_reason: "Timing signals alone cannot qualify a company." };
  }
  if (total >= 80) return { total, tier: "Qualified", tier_reason: "Score is at least 80, with Authority and Reachability evidence present." };
  if (total >= 55) return { total, tier: "Maybe", tier_reason: "Score is at least 55, with Authority and Reachability evidence present." };
  return { total, tier: "Disqualified", tier_reason: "Score is below 55." };
}

// Never trust a stored tier without checking its scores and evidence.
export function applyTierRules(score: Score): Score {
  return { ...score, ...evaluateTier(score) };
}
