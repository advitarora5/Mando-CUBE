import type { ExtractedClaim } from "./extraction.ts";

type DateField = { raw: string } | null | undefined;
type Source = { capture_ref: string; published_date?: DateField; segments: { id: string; text: string; published_date?: DateField }[] };

const MIN_QUOTE_WORDS = 3;

// Only typography is forgiven: line breaks and curly vs straight quotes. Wording and case must match exactly.
const squash = (value: string) => value.replace(/[‘’‚‛]/g, "'").replace(/[“”„]/g, '"').replace(/\s+/g, " ").trim();
const words = (value: string) => squash(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

// The statement restates its quote; only these glue words may be added. This also stops it calling a posting
// still open or verified unless the source itself says so.
const GLUE = new Set(["a", "an", "the", "is", "are", "was", "were", "has", "have", "had", "its", "their", "it", "they", "to", "of", "and", "in", "on", "for", "with", "by", "at", "as"]);

// One quote may back claims about two companies (customer and partner), so the company is part of what makes a claim distinct.
const key = (claim: ExtractedClaim) => [claim.evidence.capture_ref, claim.evidence.segment_id, squash(claim.evidence.quote).toLowerCase(), claim.company.name?.toLowerCase(), claim.signal_type].join("|");

/** Returns why the claim is not usable, or null when its quote is verbatim in the cited segment and its other fields stay inside the source. */
export function evidenceProblem(claim: ExtractedClaim, sources: Source[]): string | null {
  const { capture_ref, segment_id, quote } = claim.evidence;
  const source = sources.find(item => item.capture_ref === capture_ref);
  if (!source) return `unknown capture_ref ${capture_ref}`;
  const segment = source.segments.find(item => item.id === segment_id);
  if (!segment) return `unknown segment_id ${segment_id} in ${capture_ref}`;
  if (squash(quote).split(" ").length < MIN_QUOTE_WORDS) return `quote is shorter than ${MIN_QUOTE_WORDS} words`;
  if (!squash(segment.text).includes(squash(quote))) return `quote is not verbatim in ${segment_id}`;

  const quoteWords = new Set(words(quote));
  const added = words(claim.statement).filter(word => !quoteWords.has(word) && !GLUE.has(word));
  if (added.length) return `statement adds words not in the quote: ${[...new Set(added)].join(", ")}`;

  // Names and dates may come from anywhere in the capture (a post title, a parent comment), not only the quoted segment.
  const captureText = squash(source.segments.map(item => item.text).join(" ")).toLowerCase();
  const { name, role } = claim.company;
  if (name === null && role !== "unknown") return `role ${role} without a company name`;
  if (name !== null && !captureText.includes(squash(name).toLowerCase())) return `company ${name} is not named in ${capture_ref}`;
  if (claim.date) {
    const stated = [source.published_date, ...source.segments.map(item => item.published_date)].map(d => d?.raw).filter(Boolean).map(raw => squash(raw!).toLowerCase());
    const raw = squash(claim.date.raw).toLowerCase();
    if (!captureText.includes(raw) && !stated.includes(raw)) return `date "${claim.date.raw}" is not in ${capture_ref}`;
  }
  return null;
}

/** Splits claims into those backed by their source and those rejected, with the reason. Repeats of an accepted quote are rejected. */
export function checkEvidence(claims: ExtractedClaim[], sources: Source[]) {
  const accepted: ExtractedClaim[] = [];
  const rejected: { claim: ExtractedClaim; reason: string }[] = [];
  const seen = new Set<string>();
  for (const claim of claims) {
    const reason = evidenceProblem(claim, sources) ?? (seen.has(key(claim)) ? "duplicate of an earlier claim" : null);
    if (reason) rejected.push({ claim, reason });
    else { accepted.push(claim); seen.add(key(claim)); }
  }
  return { accepted, rejected };
}
