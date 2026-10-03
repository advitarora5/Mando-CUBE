import type { Company, Score } from "./company";

export interface Contact {
  id: string;
  company_id: string;
  name: string;
  title: string | null;
  linkedin_url: string | null;
  source: string | null;
  mutual_connection: string | null;
}

export interface Insights {
  company_id: string;
  persona_generated: string | null;
  persona_override: string | null;
  level_generated: string | null;
  level_override: string | null;
  why_now_generated: string | null;
  why_now_override: string | null;
  updated_at: string;
}

export interface CompanyDetail extends Company {
  updated_at: string;
  days_since_signal: number | null;
  contacts: Contact[];
  score: Score | null;
  insights: Insights | null;
}

export function safeUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
