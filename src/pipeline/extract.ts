// Extraction: structured fields are read directly (no model). The model only reads messy text and fills
// the fixed schema; its output is grounded (verbatim quotes, values present in the text) before anything is kept.
import { readFileSync } from "node:fs";
import { extractionJsonSchema, extractionOutputSchema, groundExtraction, type CheckedExtraction } from "../domain/ingestion/extraction-schema.ts";
import { normalizeName } from "../domain/ingestion/normalize.ts";
import type { ProjectType } from "../domain/ingestion/pipeline-score.ts";
import { htmlToText, verifyQuote } from "../domain/ingestion/quote.ts";
import { sitesFromRobots, primarySites, origin } from "./collectors/workday.ts";
import type { CaptureRow, LLMProvider, SignalInput } from "./types.ts";

// extract-v2 (prompt + type/company/length checks) beat v1 on the golden set in round 1; v1 stays for comparison.
export const PROMPT_VERSION = process.env.PIPELINE_PROMPT_VERSION ?? "extract-v2";
export const MAX_TEXT_CHARS = 10000;

export function loadPrompt(version: string = PROMPT_VERSION): string {
  return readFileSync(new URL(`./prompts/${version}.md`, import.meta.url), "utf8");
}

// Keyword evidence a project type needs in the text; a model label without it counts as a hallucination.
const PROJECT_EVIDENCE: Record<ProjectType, RegExp> = {
  implementation: /implement|deploy|roll-?out|migrat|go-?live|transition to workday|new workday/i,
  release_testing: /release|regression|\bR[12]\b|testing/i,
  integration: /integrat|\bEIB\b|studio|\bAPIs?\b|interface/i,
  support: /support|administ|maintain|optimi[sz]/i,
};

export type ModelReading = { ok: true; checked: CheckedExtraction; attempts: number; ms: number; cost_usd: number; projectDropped: boolean } | { ok: false; error: string; attempts: number; retryable: boolean; ms: number; cost_usd: number };

// One model reading with one retry on invalid JSON or schema. Connection errors are retryable next run.
// Extraction version = prompt version. v1 keeps the original grounding (quotes + values); v2+ also checks that each
// quote supports its signal type. Older versions stay reproducible for evaluation.
export const typeChecksFor = (version: string) => version !== "extract-v1";

export async function readWithModel(llm: LLMProvider, kind: string, title: string | null, text: string, prompt: string, version: string = PROMPT_VERSION): Promise<ModelReading> {
  const user = `SOURCE TYPE: ${kind}\n${title ? `TITLE: ${title}\n` : ""}TEXT:\n<<<\n${text.slice(0, MAX_TEXT_CHARS)}\n>>>`;
  let lastError = "", ms = 0, cost = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await llm.complete({ system: prompt, user, schema: extractionJsonSchema as Record<string, unknown> });
    ms += reply.ms; cost += reply.cost_usd;
    if (!reply.ok) {
      if (/unreachable|timeout|HTTP 5\d\d|HTTP 404/.test(reply.error)) return { ok: false, error: reply.error, attempts: attempt, retryable: true, ms, cost_usd: cost };
      lastError = reply.error; continue;
    }
    const parsed = extractionOutputSchema.safeParse(reply.json);
    if (!parsed.success) { lastError = `schema: ${parsed.error.issues.slice(0, 3).map(i => `${i.path.join(".")} ${i.message}`).join("; ")}`; continue; }
    const fullText = `${title ?? ""}\n${text}`;
    const checked = groundExtraction(parsed.data, fullText, { typeEvidence: typeChecksFor(version) });
    let projectDropped = false;
    if (checked.output.project_type && !PROJECT_EVIDENCE[checked.output.project_type].test(fullText)) {
      checked.dropped.push({ field: "project_type", value: checked.output.project_type, reason: "no supporting words in source text" });
      checked.output.project_type = null; projectDropped = true;
    }
    return { ok: true, checked, attempts: attempt, ms, cost_usd: cost, projectDropped };
  }
  return { ok: false, error: lastError || "invalid reply", attempts: 2, retryable: false, ms, cost_usd: cost };
}

// Which texts are worth a model call. Job postings must mention Workday (Workday's own search is fuzzy:
// searchText=Workday returns postings that never say it); Reddit posts must touch Workday or releases.
export function needsModelText(kind: string, title: string | null, text: string): boolean {
  const all = `${title ?? ""}\n${text}`;
  if (/job posting/i.test(kind)) return !!workdaySentence(text) || isWorkdaySoftwareMention(title ?? "");
  if (/reddit/i.test(kind)) return /\bworkday\b|\bR[12]\b|release|rising|go-?live|implementation/i.test(all) && text.trim().length > 0;
  return true;
}

// "March 4, 2026", "4 March 2026", "2026-03-04" -> ISO day. Month-only or relative dates stay null; a day is never invented.
export function isoDay(text: string | null | undefined): string | null {
  if (!text) return null;
  const iso = text.match(/\b(20\d\d)-(\d\d)-(\d\d)\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const a = text.toLowerCase().match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(20\d\d)\b/);
  const b = text.toLowerCase().match(/\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december),?\s+(20\d\d)\b/);
  const [month, day, year] = a ? [a[1], a[2], a[3]] : b ? [b[2], b[1], b[3]] : [null, null, null];
  if (!month) return null;
  const value = `${year}-${String(months.indexOf(month) + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : null;
}

// "role": the work is on Workday (title, or a sentence about building/running it). "skill": Workday is one listed tool.
const WORKDAY_TITLE = /workday|\bhris\b|\bhcm\b|hr (?:systems|technology|tech)|people (?:systems|technology)|payroll systems/i;
const WORKDAY_WORK = /implement|configur|build|develop|integrat|support (?:features|the|our)|administ|optimi[sz]|maintain|test(?:ing)?|design|deploy|own(?:s|ing)? /i;
// A career site can be genuine while its posting only uses the ordinary word "workday".
// Do not turn physical requirements or workplace prose into software evidence.
export function isWorkdaySoftwareMention(sentence: string): boolean {
  const ordinary = /\b(?:typical|flexible|normal|standard|eight.hour|8.hour)\s+workday\b|\b(?:of|during|throughout)\s+(?:a|the|your|their)\s+workday\b|\bin\s+(?:your|their)\s+workday\b|\bworkday\s+(?:hours|schedule|ends|begins|starts)\b/gi;
  const remaining = sentence.replace(ordinary, "");
  if (!/\bworkday\b/i.test(remaining)) return false;
  return /\bWorkday\b/.test(remaining) || /\b(?:hris|hcm|ats|erp|payroll|software|systems?|platforms?|tenants?|compensation|recruitment)\b|integrat|configur|implement/i.test(remaining);
}
export function hiringStrength(title: string | null, sentence: string): "role" | "skill" {
  if (WORKDAY_TITLE.test(title ?? "")) return "role";
  return WORKDAY_WORK.test(sentence) ? "role" : "skill";
}

// First sentence that mentions Workday, used as the structured hiring quote. Always a verbatim span.
export function workdaySentence(text: string): string | null {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => isWorkdaySoftwareMention(s) && s.split(/\s+/).length >= 3);
  const best = sentences.find(s => s.split(/\s+/).length <= 60) ?? sentences[0];
  if (!best) return null;
  const check = verifyQuote(best.split(/\s+/).length > 60 ? best.split(/\s+/).slice(0, 60).join(" ") : best, text);
  return check.ok ? check.quote : null;
}

export type ExtractedCapture = {
  signals: Omit<SignalInput, "capture_id" | "extraction_id" | "seen_at">[];
  structured: Record<string, unknown> | null;
  model: ModelReading | null;
  // The capture has text only a model can read; without a working model it stays queued.
  needsModel?: boolean;
  sites?: { tenant: string; pod: string; site: string; company_name: string; normalized_name: string; match_kind: "full_name" | "first_word" }[];
};

type Meta = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : null);

function base(companyName: string | null): { company_id: string | null; review_item_id: string | null; company_name: string | null; products: null; project_type: null; role_seniority: null; timing_words: null } {
  return { company_id: null, review_item_id: null, company_name: companyName, products: null, project_type: null, role_seniority: null, timing_words: null } as const;
}

// Reads one capture. `llm` may be null (model off or down): structured signals are still produced.
export async function extractCapture(capture: CaptureRow & { meta?: Meta }, llm: LLMProvider | null, prompt: string): Promise<ExtractedCapture> {
  const meta = (capture.meta ?? {}) as Meta;
  switch (meta.kind) {
    case "sec_company_list":
      return { signals: [], structured: { rows: meta.rows ?? null }, model: null };

    case "workday_robots": {
      const tenant = String(meta.tenant), pod = String(meta.pod);
      const sites = primarySites(sitesFromRobots(capture.body, tenant, pod));
      const company = String(meta.company_name);
      const line = capture.body.split(/\r?\n/).find(l => l.includes(`/${sites[0]}/siteMap.xml`)) ?? "";
      const quote = verifyQuote(line, capture.body, 1);
      const trusted = meta.match_kind === "full_name";
      return {
        structured: { tenant, pod, sites, company_name: company, match_kind: meta.match_kind },
        sites: sites.map(site => ({ tenant, pod, site, company_name: company, normalized_name: normalizeName(company), match_kind: trusted ? "full_name" : "first_word" })),
        model: null,
        signals: quote.ok ? [{ ...base(company), type: "known_customer", signal_date: null, source_url: `${origin(tenant, pod)}/${sites[0]}`, quote: quote.quote, confidence: trusted ? 0.95 : 0.6, method: "structured" }] : [],
      };
    }

    case "workday_job": {
      // The site already belongs to a company or waits in review: its postings go to the same place.
      const owner = { company_id: s(meta.company_id), review_item_id: s(meta.company_id) ? null : s(meta.review_item_id) };
      const json = JSON.parse(capture.body) as { jobPostingInfo?: Record<string, unknown> };
      const info = json.jobPostingInfo ?? {};
      const title = s(info.title);
      const text = htmlToText(s(info.jobDescription) ?? "");
      const url = s(info.externalUrl) ?? capture.url;
      const posted = s(info.startDate)?.slice(0, 10) ?? null;
      const company = s(meta.company_name);
      const structured = { title, posted, url, location: s(info.location), req_id: s(info.jobReqId), company_name: company };
      const mentionsWorkday = !!workdaySentence(text) || isWorkdaySoftwareMention(title ?? "");
      if (!mentionsWorkday) return { signals: [], structured: { ...structured, mentions_workday: false }, model: null };
      const quote = workdaySentence(text) ?? (title && isWorkdaySoftwareMention(title) ? verifyQuote(title, title).ok ? title : null : null);
      const hiring = quote ? { ...base(company), ...owner, type: "hiring" as const, signal_date: posted, source_url: url, quote, confidence: hiringStrength(title, quote) === "role" ? 0.9 : 0.6, method: "structured" as const } : null;
      const model = llm ? await readWithModel(llm, "job posting", title, text, prompt) : null;
      const signals: ExtractedCapture["signals"] = [];
      if (model?.ok) {
        const out = model.checked.output;
        const fields = { products: out.workday_products.length ? out.workday_products : null, project_type: out.project_type, role_seniority: out.role_seniority, timing_words: out.timing_words.length ? out.timing_words : null };
        if (hiring) signals.push({ ...hiring, ...fields });
        for (const sig of model.checked.signals) {
          if (sig.type === "hiring") continue; // the posting itself is the hiring signal
          signals.push({ ...base(company), ...owner, ...fields, type: sig.type, signal_date: isoDay(sig.date_text), source_url: url, quote: sig.quote, confidence: 0.75, method: "llm" });
        }
      } else if (hiring) signals.push(hiring);
      return { signals, structured: { ...structured, mentions_workday: true }, model, needsModel: true };
    }

    case "reddit_feed": {
      const posts = redditPosts(capture.body);
      const signals: ExtractedCapture["signals"] = [];
      let model: ModelReading | null = null;
      const relevant = posts.filter(p => /\bworkday\b|\bR[12]\b|release/i.test(`${p.title}\n${p.text}`));
      for (const post of relevant.slice(0, 15)) {
        if (!llm) break;
        const reading = await readWithModel(llm, "Reddit post in r/workday", post.title, post.text, prompt);
        model = reading;
        if (!reading.ok) { if (reading.retryable) break; continue; }
        for (const sig of reading.checked.signals) {
          signals.push({ ...base(reading.checked.output.company_name), type: sig.type,
            // A post's publication date is not an event date: go-live keeps only a date stated in its own sentence.
            signal_date: sig.type === "go_live" ? isoDay(sig.date_text) : isoDay(sig.date_text) ?? post.created, source_url: post.url, quote: sig.quote, confidence: 0.6,
            products: reading.checked.output.workday_products.length ? reading.checked.output.workday_products : null, project_type: reading.checked.output.project_type, role_seniority: null,
            timing_words: reading.checked.output.timing_words.length ? reading.checked.output.timing_words : null, method: "llm" });
        }
      }
      return { signals, structured: { posts: posts.length, relevant: relevant.length }, model, needsModel: relevant.length > 0 };
    }
    default:
      return { signals: [], structured: { note: `no reader for ${String(meta.kind)}` }, model: null };
  }
}

export type RedditPost = { title: string; text: string; url: string; created: string | null };

// Finds post-shaped objects anywhere in a provider's Reddit JSON (field names differ between providers).
export function redditPosts(body: string): RedditPost[] {
  const out: RedditPost[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 12) return;
    if (Array.isArray(node)) { node.forEach(n => visit(n, depth + 1)); return; }
    const o = node as Record<string, unknown>;
    // Reddit app feed (tikhub): { groupId: "t3_<id>", cells: [{createdAt}, {title}, {text}, ...] } with no permalink.
    if (typeof o.groupId === "string" && o.groupId.startsWith("t3_") && Array.isArray(o.cells)) {
      const cells = o.cells as Record<string, unknown>[];
      const title = cells.map(c => s(c.title)).find(Boolean);
      const url = `https://www.reddit.com/comments/${o.groupId.slice(3)}/`;
      if (title && !seen.has(url)) {
        seen.add(url);
        out.push({ title, text: cells.map(c => s(c.text)).find(Boolean) ?? "", url, created: cells.map(c => s(c.createdAt)).find(Boolean)?.slice(0, 10) ?? null });
      }
      return;
    }
    const title = s(o.title) ?? s((o.postTitle as unknown));
    const permalink = s(o.permalink) ?? s(o.url) ?? s(o.link);
    if (title && permalink && /reddit\.com|^\/r\//.test(permalink)) {
      const url = permalink.startsWith("/") ? `https://www.reddit.com${permalink}` : permalink;
      const text = s(o.selftext) ?? s(o.text) ?? s(o.body) ?? s((o.content as Record<string, unknown> | undefined)?.markdown) ?? "";
      const createdRaw = o.created_utc ?? o.created ?? o.createdAt;
      const created = typeof createdRaw === "number" ? new Date(createdRaw * (createdRaw < 1e12 ? 1000 : 1)).toISOString().slice(0, 10) : typeof createdRaw === "string" ? createdRaw.slice(0, 10) : null;
      if (!seen.has(url)) { seen.add(url); out.push({ title, text, url, created }); }
    }
    for (const value of Object.values(o)) visit(value, depth + 1);
  };
  try { visit(JSON.parse(body), 0); } catch { /* not JSON */ }
  return out;
}
