import { z } from "zod";

const text = z.string().trim().min(1);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const url = z.url().refine(value => ["https:", "http:"].includes(new URL(value).protocol), "Expected HTTP(S) URL");
const timestamp = z.iso.datetime({ offset: true });
const publishedDate = z.object({
  raw: text,
  // Preserve approximate/relative dates without inventing an exact day.
  normalized: z.iso.date().nullable(),
  precision: z.enum(["day", "month", "year", "relative", "unknown"]),
}).strict().refine(value => value.normalized === null || value.precision === "day", "Only exact days can have a normalized date");

export const sourceTypes = ["discussion", "job_listing", "case_study", "article", "client_list", "other"] as const;
export const sourceConfigSchema = z.object({
  schema_version: z.literal(1),
  sources: z.array(z.object({
    id,
    priority: z.number().int().positive(),
    enabled: z.boolean(),
    start_urls: z.array(url).min(1),
    search_terms: z.array(text).min(1),
    lookback_days: z.number().int().positive(),
    max_pages: z.number().int().positive(),
    max_minutes: z.number().int().positive(),
  }).strict()).min(1),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  const priorities = new Set<number>();
  value.sources.forEach((source, index) => {
    if (ids.has(source.id)) context.addIssue({ code: "custom", path: ["sources", index, "id"], message: "Duplicate source ID" });
    if (priorities.has(source.priority)) context.addIssue({ code: "custom", path: ["sources", index, "priority"], message: "Duplicate priority" });
    ids.add(source.id); priorities.add(source.priority);
  });
});

export const collectionBriefSchema = z.object({
  schema_version: z.literal(1),
  run_id: id,
  source_id: id,
  started_at: timestamp,
  lookback_start: z.iso.date(),
  start_urls: z.array(url).min(1),
  search_terms: z.array(text).min(1),
  max_pages: z.number().int().positive(),
  max_minutes: z.number().int().positive(),
}).strict().refine(value => value.lookback_start <= value.started_at.slice(0, 10), "Lookback cannot start after the run");

const segmentSchema = z.object({
  id,
  parent_id: id.nullable(),
  kind: z.enum(["page", "post", "comment"]),
  author: text.nullable(),
  url: url.nullable(),
  published_date: publishedDate.nullable(),
  text,
}).strict();

const captureSchema = z.object({
  source_id: id,
  url,
  title: text.nullable(),
  source_type: z.enum(sourceTypes),
  collected_at: timestamp,
  published_date: publishedDate.nullable(),
  content_scope: z.enum(["full_visible_text", "selected_passages"]),
  segments: z.array(segmentSchema).min(1),
  links_followed: z.array(url),
  // These are interpretations, never source evidence.
  agent_observations: z.array(text),
}).strict().superRefine((capture, context) => {
  const ids = new Set<string>();
  capture.segments.forEach((segment, index) => {
    if (ids.has(segment.id)) context.addIssue({ code: "custom", path: ["segments", index, "id"], message: "Duplicate segment ID" });
    ids.add(segment.id);
  });
  capture.segments.forEach((segment, index) => {
    if (segment.parent_id !== null && (!ids.has(segment.parent_id) || segment.parent_id === segment.id)) context.addIssue({ code: "custom", path: ["segments", index, "parent_id"], message: "Parent must reference a different segment in this capture" });
    const seen = new Set([segment.id]);
    let parent = segment.parent_id;
    while (parent !== null) {
      if (seen.has(parent)) { context.addIssue({ code: "custom", path: ["segments", index, "parent_id"], message: "Cyclic segment ancestry" }); break; }
      seen.add(parent);
      parent = capture.segments.find(item => item.id === parent)?.parent_id ?? null;
    }
  });
});

// One portable JSON file per run; no company guesses or scores at collection time.
export const captureBatchSchema = z.object({
  schema_version: z.literal(1),
  brief: collectionBriefSchema,
  finished_at: timestamp,
  outcome: z.enum(["completed", "limit_reached", "blocked", "partial"]),
  pages_visited: z.number().int().nonnegative(),
  captures: z.array(captureSchema),
  failures: z.array(z.object({ url, occurred_at: timestamp, reason: text }).strict()),
}).strict().superRefine((batch, context) => {
  const start = Date.parse(batch.brief.started_at);
  const finish = Date.parse(batch.finished_at);
  if (finish < start) context.addIssue({ code: "custom", path: ["finished_at"], message: "Run finishes before it starts" });
  if (batch.pages_visited > batch.brief.max_pages) context.addIssue({ code: "custom", path: ["pages_visited"], message: "Page budget exceeded" });
  if (batch.captures.length > batch.pages_visited) context.addIssue({ code: "custom", path: ["captures"], message: "More captures than visited pages" });
  const ids = new Set<string>();
  const urls = new Set<string>();
  batch.captures.forEach((capture, index) => {
    if (ids.has(capture.source_id) || urls.has(capture.url)) context.addIssue({ code: "custom", path: ["captures", index], message: "Duplicate capture ID or URL" });
    ids.add(capture.source_id); urls.add(capture.url);
    const time = Date.parse(capture.collected_at);
    if (time < start || time > finish) context.addIssue({ code: "custom", path: ["captures", index, "collected_at"], message: "Collection time is outside this run" });
  });
  batch.failures.forEach((failure, index) => {
    const time = Date.parse(failure.occurred_at);
    if (time < start || time > finish) context.addIssue({ code: "custom", path: ["failures", index, "occurred_at"], message: "Failure time is outside this run" });
  });
  if (batch.outcome === "blocked" && batch.failures.length === 0) context.addIssue({ code: "custom", path: ["failures"], message: "Blocked runs must explain the failure" });
});

export type CollectionBrief = z.infer<typeof collectionBriefSchema>;
export type CaptureBatch = z.infer<typeof captureBatchSchema>;
