export type Tier = "Qualified" | "Maybe" | "Disqualified";

export const categories = ["authority", "reachability", "budget", "release", "timing"] as const;
export type Category = (typeof categories)[number];

export interface Company {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  headquarters: string | null;
  employee_count: number | null;
  workday_signal_date: string | null;
  source: string | null;
}

export interface Score {
  id: string;
  company_id: string;
  assessed_at: string;
  rubric_version: string;
  authority_score: number;
  authority_evidence: string;
  reachability_score: number;
  reachability_evidence: string;
  budget_score: number;
  budget_evidence: string;
  release_score: number;
  release_evidence: string;
  timing_score: number;
  timing_evidence: string;
  total: number;
  tier: Tier;
  tier_reason?: string;
}

export interface CompanyListItem extends Company {
  score: Score | null;
  why_now: string | null;
  contacts: { id: string; name: string; title: string | null; linkedin_url: string | null }[];
}
