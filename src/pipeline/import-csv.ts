// Import button: CSV rows go through the same raw store, matching and scoring as collected data.
// Columns (case-insensitive): company (required), website or domain, employees, source (http link), quote,
// signal_type (go_live | hiring | release_planning | known_customer | budget_clue | event), signal_date (YYYY-MM-DD).
// A row's signal needs a source link and a quote; the quote is a person's transcription and is stored as given.
import Papa from "papaparse";
import { companyAliases } from "../data/company-aliases.ts";
import { contentFingerprint } from "../domain/ingestion/fingerprint.ts";
import { decideMatch } from "../domain/ingestion/matching.ts";
import { normalizeDomain, normalizeName } from "../domain/ingestion/normalize.ts";
import { signalTypes, type SignalType } from "../domain/ingestion/pipeline-score.ts";
import { scoreStage, type StageResult } from "./stages.ts";
import type { PipelineContext } from "./types.ts";

export type ImportRow = { line: number; company: string; domain: string | null; employees: number | null; source: string | null; quote: string | null; signal_type: SignalType | null; signal_date: string | null; errors: string[] };

export function parseImportCsv(text: string): ImportRow[] {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: h => h.trim().toLowerCase() });
  return parsed.data.map((row, index) => {
    const get = (...keys: string[]) => keys.map(k => (row[k] ?? "").trim()).find(Boolean) ?? "";
    const errors: string[] = [];
    const company = get("company", "company name", "name");
    if (!company) errors.push("company is required");
    const rawDomain = get("website", "domain");
    const domain = rawDomain ? normalizeDomain(rawDomain) : null;
    if (rawDomain && !domain) errors.push(`website "${rawDomain}" is not a domain`);
    const employeesText = get("employees", "employee_count", "est. employees").replace(/,/g, "");
    const employees = /^\d+$/.test(employeesText) ? Number(employeesText) : null;
    const source = get("source", "source_url", "evidence");
    const sourceUrl = /^https?:\/\/\S+$/i.test(source) ? source : null;
    if (source && !sourceUrl) errors.push("source must be an http(s) link");
    const typeText = get("signal_type", "signal").toLowerCase();
    const signal_type = (signalTypes as readonly string[]).includes(typeText) ? typeText as SignalType : null;
    if (typeText && !signal_type) errors.push(`unknown signal_type "${typeText}"`);
    const quote = get("quote") || null;
    const date = get("signal_date", "date");
    const signal_date = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
    if (date && !signal_date) errors.push("signal_date must be YYYY-MM-DD");
    if ((quote || signal_type) && (!quote || !signal_type || !sourceUrl)) errors.push("a signal needs signal_type, quote and source together");
    return { line: index + 2, company, domain, employees, source: sourceUrl, quote, signal_type, signal_date, errors };
  });
}

export async function importCsv(ctx: PipelineContext, text: string, opts: { dryRun?: boolean } = {}): Promise<StageResult & { rows: ImportRow[] }> {
  const r = { counts: {} as Record<string, number>, errors: [] as string[], blocked: null, requests: 0, llm_spend_usd: 0, treg_spend_usd: 0 };
  const bump = (key: string) => { r.counts[key] = (r.counts[key] ?? 0) + 1; };
  const rows = parseImportCsv(text);
  const settings = await ctx.store.settings();
  const known = await ctx.store.companies();
  const affected: string[] = [];
  let created = 0;
  for (const row of rows) {
    if (row.errors.length) { bump("invalid_rows"); r.errors.push(`line ${row.line}: ${row.errors.join("; ")}`); continue; }
    if (opts.dryRun) { bump("valid_rows"); continue; }
    try {
      const raw = JSON.stringify({ company: row.company, website: row.domain, employees: row.employees, source: row.source, quote: row.quote, signal_type: row.signal_type, signal_date: row.signal_date });
      const fingerprint = contentFingerprint(raw);
      // A row without a link is stored under a reserved, non-resolving address rather than an invented page.
      const url = row.source ?? `https://import.invalid/csv/${fingerprint.slice(0, 16)}`;
      const capture = await ctx.store.saveCapture({ source: "csv-import", url, fetched_at: ctx.now().toISOString(), http_status: 200, content_type: "application/json", raw, fingerprint, meta: { kind: "csv_row", line: row.line } }, ctx.runId);
      const decision = decideMatch({ name: row.company, domain: row.domain, domain_confirmed: !!row.domain, best_confidence: 0.9 }, known, { canCreate: created < settings.max_new_companies_per_run }, companyAliases);
      let signalId: string | null = null;
      if (row.signal_type && row.quote && row.source) {
        signalId = (await ctx.store.upsertSignal({ company_id: null, review_item_id: null, capture_id: capture.id, extraction_id: null, type: row.signal_type, signal_date: row.signal_date, source_url: row.source, quote: row.quote, confidence: 0.9, company_name: row.company, products: null, project_type: null, role_seniority: null, timing_words: null, method: "structured", seen_at: ctx.now().toISOString() })).id;
      }
      const ids = signalId ? [signalId] : [];
      if (decision.action === "skip") { bump("excluded"); continue; }
      if (decision.action === "attach") {
        await ctx.store.assignSignals(ids, { company_id: decision.company_id });
        affected.push(decision.company_id); bump("matched_existing");
      } else if (decision.action === "create") {
        const id = await ctx.store.createPipelineCompany({ name: row.company, domain: row.domain, employee_count: row.employees, source: row.source ?? "csv-import" }, ctx.runId, { signal_ids: ids, normalized_name: normalizeName(row.company) });
        known.push({ id, name: row.company, domain: row.domain, employee_count: row.employees, pipeline: true });
        affected.push(id); created++; bump("new_companies");
      } else {
        const item = await ctx.store.addReviewItem({ candidate_name: row.company, normalized_name: normalizeName(row.company), candidate_domain: row.domain, employee_count: row.employees, suggested_company_id: decision.suggested_company_id, reason: decision.reason });
        await ctx.store.assignSignals(ids, { review_item_id: item.id });
        bump(`review_${decision.reason}`);
      }
    } catch (error) {
      bump("error_import");
      r.errors.push(`line ${row.line}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (affected.length) {
    const scored = await scoreStage(ctx, { companyIds: affected, trigger: "csv_import" });
    for (const [k, v] of Object.entries(scored.counts)) r.counts[`score_${k}`] = v;
    r.errors.push(...scored.errors);
  }
  return { ...r, rows };
}
