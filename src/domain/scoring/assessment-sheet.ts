import type { Category, Company, Tier } from "@/domain/contracts/company";
import type { CategoryInput, ScoreRow } from "./assessment.ts";
import { categories } from "../contracts/company.ts";
import { buildAssessment, goLiveTiming, releaseAlignment } from "./assessment.ts";

// One spreadsheet row per company, keyed by lowercase header: company_id or company,
// then <category>_score, <category>_source and <category>_reason for each rubric category.
export type SheetRow = Record<string, string | undefined>;
export type SheetCompany = Pick<Company, "id" | "name" | "workday_signal_date">;
export type SheetResult = { line: number; company: string; errors: string[]; row?: ScoreRow; total?: number; tier?: Tier };

const clean = (value: string | undefined) => (value ?? "").trim();
const normalize = (value: string | undefined) => clean(value).replace(/\s+/g, " ").toLowerCase();

// Turns sheet rows into insert-ready score rows. Nothing is guessed: an unmatched company or
// an unscored row, or points without evidence come back as errors. Timing and Release are calculated when their
// score is blank and a source link is given; any other blank score is 0.
export function assessSheet(rows: SheetRow[], companies: SheetCompany[], now: Date = new Date()): SheetResult[] {
  const seen = new Set<string>();
  return rows.map((sheet, index) => {
    const line = index + 2; // line 1 is the header
    const id = normalize(sheet.company_id);
    const name = normalize(sheet.company);
    const label = clean(sheet.company) || clean(sheet.company_id) || "(no company)";
    const matches = id ? companies.filter(c => c.id.toLowerCase() === id) : name ? companies.filter(c => normalize(c.name) === name) : [];
    if (matches.length !== 1) {
      const problem = !id && !name ? "Row needs a company_id or company name." : matches.length ? "More than one company matches; use company_id." : "No matching company in the database.";
      return { line, company: label, errors: [problem] };
    }
    const company = matches[0];
    if (seen.has(company.id)) return { line, company: company.name, errors: ["Company appears more than once in the sheet."] };
    seen.add(company.id);
    const input: Partial<Record<Category, CategoryInput>> = {};
    for (const category of categories) {
      const score = clean(sheet[`${category}_score`]);
      const source = clean(sheet[`${category}_source`]) || null;
      if (score) input[category] = { score: Number(score), source, reason: clean(sheet[`${category}_reason`]) || null };
      else if (category === "timing" && source) input.timing = goLiveTiming(company.workday_signal_date, source, now);
      else if (category === "release" && source) input.release = releaseAlignment(source, now);
    }
    if (!Object.keys(input).length) return { line, company: company.name, errors: ["Row has no scores; remove it or fill it in."] };
    const result = buildAssessment(company.id, input);
    if (!result.ok) return { line, company: company.name, errors: result.errors };
    return { line, company: company.name, errors: [], row: result.row, total: result.total, tier: result.tier };
  });
}
