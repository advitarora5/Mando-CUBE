// Contact title classification for pipeline Authority scoring. Reads the title text only; never infers.

// Functional relevance 0-10: how close the role is to owning Workday or HR systems.
const FUNCTION_RULES: [RegExp, number, string][] = [
  [/\bworkday\b|\bhris\b|\bhcm\b|hr (technology|tech|systems|information)|people (systems|technology|tech)|human resources information/i, 10, "HR systems / Workday"],
  [/enterprise (applications|apps|systems)|business (applications|systems)|erp\b/i, 9, "Enterprise applications"],
  [/hr operations|people operations|total rewards|payroll|talent systems/i, 7, "HR operations"],
  [/\bit\b.*(operations|ops)|it operations|infrastructure and operations|technology operations|information systems/i, 6, "IT operations"],
  [/\bchro\b|chief (people|human resources|hr)|human resources|\bhr\b|people\b|talent/i, 5, "HR leadership"],
  [/\bcio\b|chief (information|technology|digital)|information technology|\bit\b|technology/i, 5, "IT leadership"],
];

// Seniority 0-8 from the title's level words.
const SENIORITY_RULES: [RegExp, number, string][] = [
  [/\bchief\b|\bc[a-z]o\b|\bchro\b|\bcio\b|\bcto\b|\bpresident\b/i, 8, "C-level"],
  [/\b(evp|svp)\b|executive vice president|senior vice president/i, 7, "SVP/EVP"],
  [/\bvp\b|vice president|\bhead of\b|\bhead\b/i, 6, "VP/Head"],
  [/\bdirector\b/i, 5, "Director"],
  [/senior manager|sr\.? manager/i, 4, "Senior manager"],
  [/\bmanager\b|\blead\b|\bprincipal\b/i, 3, "Manager/Lead"],
  [/senior|sr\.?\b|specialist|engineer|architect|consultant/i, 2, "Senior IC"],
  [/analyst|associate|coordinator|administrator|partner/i, 1, "IC"],
];

export type TitleClass = { functional: number; functionLabel: string; seniority: number; seniorityLabel: string; ownsWorkday: number };

export function classifyTitle(title: string | null | undefined): TitleClass {
  // "Office of the CIO" names the org, not the person's level; "Executive Director" is a director.
  const text = (title ?? "").trim().replace(/\boffice of the \w+/gi, "").replace(/\bexecutive director\b/gi, "Director");
  const fn = FUNCTION_RULES.find(([re]) => re.test(text));
  const level = SENIORITY_RULES.find(([re]) => re.test(text));
  // Owns Workday 0-4: the title names Workday (4) or HRIS/HCM (2). Anything else needs a sourced statement.
  const ownsWorkday = /\bworkday\b/i.test(text) ? 4 : /\bhris\b|\bhcm\b/i.test(text) ? 2 : 0;
  return {
    functional: fn?.[1] ?? 0, functionLabel: fn?.[2] ?? "Unrelated or unknown function",
    seniority: level?.[1] ?? 0, seniorityLabel: level?.[2] ?? "Unknown level",
    ownsWorkday,
  };
}

// Team rubric Authority role bases (22/20/18/15/10/5/0), read from the title text only.
// "Specific" = explicitly HRIS / HR technology / HR operations / enterprise or IT systems; generic HR/IT is not specific.
export function authorityBand(title: string | null | undefined): { base: number; label: string } {
  const c = classifyTitle(title);
  if (c.functional === 0) return { base: 0, label: "unrelated role" };
  const specific = c.functional >= 6;
  const headOnly = /\bhead\b/i.test(title ?? "") && c.seniority === 6 && !/\bvp\b|vice president/i.test(title ?? "");
  if (specific && c.seniority >= 6) return { base: 22, label: "executive over HRIS/HR ops/enterprise systems" };
  if (specific && c.seniority >= 4) return { base: 20, label: "director/senior manager over HR tech or enterprise systems" };
  if (!specific && c.seniority >= 6 && !headOnly) return { base: 18, label: "general HR or IT executive" };
  if (!specific && (c.seniority === 5 || headOnly)) return { base: 15, label: "general HR/IT director or head" };
  if (c.seniority >= 2) return { base: 10, label: "relevant manager, lead or specialist" };
  return { base: 5, label: "relevant staff member" };
}

// Titles the enrichment step searches for, in priority order.
export const TARGET_TITLES = ["VP HR", "HRIS lead", "VP Enterprise Applications", "IT operations manager", "Workday lead", "Director HRIS"];
