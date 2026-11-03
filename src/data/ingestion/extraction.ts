import { z } from "zod";

const text = z.string().trim().min(1);

// Same precision rules as collection dates, plus what the date is about so a
// webinar, removal or go-live date cannot pass as the publication date.
const claimDate = z.object({
  raw: text,
  normalized: z.iso.date().nullable(),
  precision: z.enum(["day", "month", "year", "relative", "unknown"]),
  kind: z.enum(["published", "event", "removal"]),
}).strict().refine(value => value.normalized === null || value.precision === "day", "Only exact days can have a normalized date");

// There is deliberately no active/open/verified field: a saved page cannot show that a posting is live today.
const claim = z.object({
  statement: text,
  company: z.object({
    name: text.nullable(),
    role: z.enum(["customer", "implementation_partner", "vendor", "parent", "candidate", "unknown"]),
  }).strict(),
  // other: relationships, metrics and anything that is not a hiring, implementation or testing signal.
  signal_type: z.enum(["hiring", "implementation", "testing", "other"]),
  product_area: text.nullable(),
  date: claimDate.nullable(),
  evidence: z.object({ capture_ref: text, segment_id: text, quote: text }).strict(),
}).strict();

export const extractionSchema = z.object({ claims: z.array(claim) }).strict();

// Sent to Ollama as `format` so the reply is shaped before validation.
export const extractionJsonSchema = z.toJSONSchema(extractionSchema);

export type Extraction = z.infer<typeof extractionSchema>;
export type ExtractedClaim = Extraction["claims"][number];
