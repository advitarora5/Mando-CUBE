import { z } from "zod";
import { projectTypes, signalTypes } from "./pipeline-score.ts";
import { verifyQuote } from "./quote.ts";

// The fixed form a model fills from messy text. Missing information stays null or empty; nothing is inferred.
export const seniorityLevels = ["executive", "director", "manager", "senior_individual", "individual"] as const;

export const modelSignalSchema = z.object({
  type: z.enum(signalTypes),
  quote: z.string(),
  date_text: z.string().nullable(),
}).strict();

export const extractionOutputSchema = z.object({
  company_name: z.string().nullable(),
  workday_products: z.array(z.string()).max(12),
  project_type: z.enum(projectTypes).nullable(),
  role_seniority: z.enum(seniorityLevels).nullable(),
  timing_words: z.array(z.string()).max(8),
  signals: z.array(modelSignalSchema).max(5),
}).strict();

export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

// Sent to Ollama as `format` (and to OpenAI-compatible APIs as a json_schema) so replies are shaped before validation.
export const extractionJsonSchema = z.toJSONSchema(extractionOutputSchema);

export type CheckedSignal = { type: ExtractionOutput["signals"][number]["type"]; quote: string; date_text: string | null };
export type CheckedExtraction = {
  output: ExtractionOutput;
  signals: CheckedSignal[];
  dropped: { field: string; value: string; reason: string }[];
};

// Words a quote must contain for its signal type (extraction v2+). A verbatim quote that does not support its
// type ("implement, test ... Workday modules" labelled go_live) is an inference, so the signal is dropped.
export const TYPE_EVIDENCE: Record<CheckedSignal["type"], RegExp> = {
  go_live: /go[- ]?live|went live|gone live|live on|launch|deploy|roll(?:ed|ing)?[- ]?out|cut-?over|migrat|transition(?:ed)? to|switch(?:ed)? to|implementation (?:was |is )?(?:complete|finished|successful)/i,
  hiring: /hir(?:e|ing)|seek|join|looking for|role|position|candidate|you will|responsib|experience|apply|opening|recruit/i,
  release_planning: /release|\bR[12]\b|regression|semi-?annual|feature update|updates|upgrade|preview tenant/i,
  known_customer: /workday/i,
  budget_clue: /purchas|contract|select(?:ed|s)?\b|invest|(?:approved|allocated|dedicated|new) budget|budget (?:was )?approved|funded|funding|licen[cs]|\bbuy|bought|vendor|partner(?:ed|ing)? with|leverag|engag(?:ed|ing)|subscri|credits|\bcost|spend|\bRFP|new (?:tool|system|platform|module)/i,
  event: /rising|webinar|conference|summit|devcon|user group|keynote|\bevent|session|meetup|forum/i,
};

const present = (value: string, text: string) => value.trim().length > 1 && text.toLowerCase().includes(value.trim().toLowerCase());

// Grounds a model reading in its source text. Quotes must be verbatim (otherwise the signal is dropped);
// company, products, timing words and dates must appear in the text (otherwise they are cleared).
// Every removal is recorded so evaluation can count hallucinations.
export function groundExtraction(output: ExtractionOutput, text: string, opts: { typeEvidence?: boolean } = {}): CheckedExtraction {
  const dropped: CheckedExtraction["dropped"] = [];
  const keep = (field: string, values: string[]) => values.filter(value => {
    if (present(value, text)) return true;
    dropped.push({ field, value, reason: "not in source text" });
    return false;
  });
  let company = output.company_name && present(output.company_name, text) ? output.company_name.trim() : null;
  if (output.company_name && !company) dropped.push({ field: "company_name", value: output.company_name, reason: "not in source text" });
  // v2+: a company is a name ("Acme Corp"), not a description ("a globally recognized ... organization") or a role tag ("oCFO").
  if (company && opts.typeEvidence && (!/^[A-Z0-9]/.test(company) || company.split(/\s+/).length > 6)) {
    dropped.push({ field: "company_name", value: company, reason: "not a proper organisation name" });
    company = null;
  }
  const signals: CheckedSignal[] = [];
  const seen = new Set<string>();
  for (const signal of output.signals) {
    const check = verifyQuote(signal.quote, text);
    if (!check.ok) { dropped.push({ field: `signals.${signal.type}.quote`, value: signal.quote, reason: check.reason }); continue; }
    // v2+: a quote is one sentence of evidence, not the whole page.
    if (opts.typeEvidence && check.quote.split(/\s+/).length > 60) { dropped.push({ field: `signals.${signal.type}.quote`, value: check.quote.slice(0, 120), reason: "quote longer than 60 words" }); continue; }
    if (opts.typeEvidence && !TYPE_EVIDENCE[signal.type].test(check.quote)) { dropped.push({ field: `signals.${signal.type}.type`, value: check.quote, reason: `quote does not support type ${signal.type}` }); continue; }
    const key = `${signal.type}|${check.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const date = signal.date_text && present(signal.date_text, text) ? signal.date_text.trim() : null;
    if (signal.date_text && !date) dropped.push({ field: `signals.${signal.type}.date_text`, value: signal.date_text, reason: "not in source text" });
    signals.push({ type: signal.type, quote: check.quote, date_text: date });
  }
  return {
    output: { ...output, company_name: company, workday_products: keep("workday_products", output.workday_products), timing_words: keep("timing_words", output.timing_words) },
    signals, dropped,
  };
}
