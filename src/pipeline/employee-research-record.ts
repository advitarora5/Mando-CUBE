import type { WebEmployeeEvidence } from "./employee-document-evidence.ts";
export type EmployeeResearchStatus = "found" | "needs_review" | "unavailable";
export type EmployeeResearchRecord = {
  company_id: string; company_domain: string; company_name: string;
  status: EmployeeResearchStatus | "running";
  evidence: WebEmployeeEvidence | null;
  checked_at: string | null; next_check_at: string;
  lease_token: string | null; lease_until: string | null; reason: string;
};
