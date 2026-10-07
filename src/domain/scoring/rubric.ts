import type { Category, Tier } from "@/domain/contracts/company";

// Week 2 slide 7 rubric. Change weights, thresholds or bands here only, and bump the version.
export const RUBRIC_VERSION = "week2-100";

export const rubric: Record<Category, { label: string; weight: number; explanation: string }> = {
  authority: { label: "Functional Authority", weight: 25, explanation: "HRIS/IT leadership at a 3,000+ employee company." },
  reachability: { label: "Reachability & Conviction", weight: 25, explanation: "≤1 degree away; proven authority and conviction to act." },
  budget: { label: "Customer Budget", weight: 20, explanation: "Clear purchase timeline and financial stability." },
  release: { label: "Workday Release Alignment", weight: 15, explanation: "6-12 weeks prior to biannual release (e.g., Q1 2027)." },
  timing: { label: "Timing Trigger", weight: 15, explanation: "One-off events: go-live, audit, migration, new systems leader." },
};

// Inclusive minimum totals. Anything below Maybe is Disqualified.
export const tierThresholds = { Qualified: 80, Maybe: 55 } as const;

export function tierForTotal(total: number): Tier {
  return total >= tierThresholds.Qualified ? "Qualified" : total >= tierThresholds.Maybe ? "Maybe" : "Disqualified";
}

// Timing Trigger points by days since the Workday go-live (inclusive upper bound).
// Negative days mean the go-live is announced but still in the future.
export const goLiveBands = [
  { maxDays: -181, score: 6, label: "announced, more than 180 days out" },
  { maxDays: -1, score: 12, label: "announced, within 180 days" },
  { maxDays: 30, score: 10, label: "0-30 days post go-live" },
  { maxDays: 90, score: 15, label: "31-90 days post go-live" },
  { maxDays: 180, score: 13, label: "91-180 days post go-live" },
  { maxDays: 365, score: 6, label: "181-365 days post go-live" },
  { maxDays: Infinity, score: 0, label: "over 365 days post go-live" },
] as const;

// Release Alignment points by days until the next Workday feature release (inclusive upper bound).
// The rubric's peak is 6-12 weeks out: early enough to buy and set up before release testing starts.
export const releaseBands = [
  { maxDays: 13, score: 3, label: "under 2 weeks before release" },
  { maxDays: 41, score: 9, label: "2-6 weeks before release" },
  { maxDays: 84, score: 15, label: "6-12 weeks before release" },
  { maxDays: 126, score: 10, label: "12-18 weeks before release" },
  { maxDays: Infinity, score: 5, label: "more than 18 weeks before release" },
] as const;
