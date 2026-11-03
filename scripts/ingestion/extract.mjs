// Sends captures to a local Ollama model and keeps only claims whose quote is verbatim in the cited segment.
// No database or browser access.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { extractionJsonSchema, extractionSchema } from '../../src/data/ingestion/extraction.ts';
import { checkEvidence } from '../../src/data/ingestion/evidence.ts';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
export const MODEL = process.env.OLLAMA_MODEL ?? 'llama3.1:latest';

const INSTRUCTIONS = `Extract Workday research claims from the source captures below. Use only the source text; never browse or guess.
Return JSON matching the schema. One claim per fact. Rules:
- evidence.quote must be copied word for word (at least 3 words) from the segment named by evidence.segment_id; evidence.capture_ref is the capture's capture_ref.
- signal_type: "hiring" = an open role; "implementation" = a Workday project underway or planned; "testing" = parallel, regression or release testing; "other" = relationships, metrics, anything else. Emit a claim for a type only when the quote itself describes it; most captures yield one to four claims. Never emit a claim just to cover a type. The statement must restate its quote and add nothing the quote does not say.
- company.role "customer" = the organization uses or is implementing Workday itself, including an employer posting its own job. Use "unknown" only when the text does not say.
- You cannot tell from a saved page whether a posting or project is live today. Never say a posting is still open, active or verified.
- company.name is the organization the text is about, only if the text states it; otherwise null with role "unknown". Keep separate legal entities separate. A vendor, partner or index owner is not the customer. Do not guess an employer from geography, industry or module list.
- date.kind: "published" for when the source was posted, "event" for go-live, webinar or project dates, "removal" for when a posting was closed. Copy the text as date.raw. Use normalized only for an exact day, with precision "day"; otherwise normalized is null ("1 day ago" is kind "published", precision "relative"). If the claim has no stated date, date must be null, not an object. The capture's collected_at is not a publication date.
- Do not infer budget, buyer authority, licensed modules or exact dates. Do not apply one customer's facts to another.
- If nothing qualifies, return {"claims": []}.`;

function prompt(captures) {
  const view = captures.map(c => ({
    capture_ref: c.capture_ref, url: c.url, title: c.title, source_type: c.source_type,
    collected_at: c.collected_at, published_date: c.published_date,
    segments: c.segments.map(s => ({ id: s.id, parent_id: s.parent_id, kind: s.kind, author: s.author, published_date: s.published_date, text: s.text })),
  }));
  return `${INSTRUCTIONS}\n\n${JSON.stringify({ captures: view })}`;
}

// Fixed seed with temperature 0 so the same input gives the same claims run to run; a retry moves to the next seed.
export const SEED = Number(process.env.OLLAMA_SEED ?? 42);

async function chat(content, seed, fetchImpl) {
  const res = await fetchImpl(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      // Streamed: a long input otherwise sends no response headers for minutes and Node's fetch gives up.
      model: MODEL, stream: true, format: extractionJsonSchema,
      options: { temperature: 0, seed, num_ctx: 16384, num_predict: 4000 },
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const lines = (await res.text()).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { content: lines.map(line => line.message?.content ?? '').join(''), truncated: lines.at(-1)?.done_reason === 'length' };
}

// Halves a batch that is too big for one reply. A single capture is split by segment, and every half keeps the
// first segment (the post or page header) so replies keep their context and names stay checkable.
function halves(captures) {
  if (captures.length > 1) return [captures.slice(0, captures.length / 2 | 0), captures.slice(captures.length / 2 | 0)];
  const [capture] = captures, [head, ...rest] = capture.segments;
  if (rest.length < 2) return null;
  const mid = rest.length / 2 | 0;
  return [rest.slice(0, mid), rest.slice(mid)].map(part => [{ ...capture, segments: [head, ...part] }]);
}

async function rawClaims(captures, fetchImpl, seed) {
  const content = prompt(captures);
  let error = 'no attempt';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await chat(content, seed + attempt, fetchImpl);
      if (reply.truncated) {
        const parts = halves(captures);
        if (!parts) { error = 'reply cut off at num_predict'; continue; }
        const done = [];
        for (const part of parts) done.push(await rawClaims(part, fetchImpl, seed));
        return { claims: done.flatMap(d => d.claims), error: done.map(d => d.error).filter(Boolean).join('; ') || null };
      }
      const parsed = extractionSchema.safeParse(JSON.parse(reply.content));
      if (parsed.success) return { claims: parsed.data.claims, error: null };
      error = parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    } catch (e) {
      error = e.message;
      if (e.message.startsWith('Ollama')) break;
    }
  }
  return { claims: [], error };
}

/** captures need capture_ref. Returns { accepted, rejected, error }. error is set when a request or part of a split request
 * produced no valid JSON after one retry; accepted then holds whatever the other parts produced. */
export async function extractCaptures(captures, fetchImpl = fetch, seed = SEED) {
  const { claims, error } = await rawClaims(captures, fetchImpl, seed);
  // Checked against the whole captures, not the split halves, so duplicates across halves collapse.
  return { ...checkEvidence(claims, captures), error };
}

const norm = s => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
// What must not drift between runs of the same input once the quote is the same.
const fields = c => `${c.company.name ?? '?'} (${c.company.role}) [${c.signal_type}] ${c.product_area ?? '-'} ${c.date ? `${c.date.kind}:${c.date.raw}` : 'no date'}`;

/** Compares several extractCaptures results for one input: claims that only some runs found, and quotes whose fields differ. */
export function compareRuns(runs) {
  const seen = new Map();
  runs.forEach((run, i) => run.accepted.forEach(c => {
    const key = `${c.evidence.capture_ref}|${c.evidence.segment_id}|${norm(c.evidence.quote)}`;
    if (!seen.has(key)) seen.set(key, { quote: c.evidence.quote, byRun: new Map() });
    const { byRun } = seen.get(key);
    byRun.set(i, [...(byRun.get(i) ?? []), fields(c)].sort());
  }));
  // One quote can back two claims in a run (customer and partner), so each run's whole set is compared.
  const all = [...seen.values()].map(x => ({ quote: x.quote, runs: x.byRun.size, versions: new Set([...x.byRun.values()].map(f => f.join(' + '))) }));
  return {
    stable: all.filter(x => x.runs === runs.length && x.versions.size === 1).length,
    unstable: all.filter(x => x.runs < runs.length).map(x => `${x.runs}/${runs.length} runs: "${x.quote}"`),
    drift: all.filter(x => x.versions.size > 1).map(x => `"${x.quote}": ${[...x.versions].join(' vs ')}`),
  };
}

/** A capture batch (validate-capture format) to captures with run-scoped refs. */
export const batchCaptures = batch => batch.captures.map(c => ({ ...c, capture_ref: `${batch.brief.run_id}/${c.source_id}` }));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) { console.error('Usage: node scripts/ingestion/extract.mjs <captures.json> <claims.json>'); process.exit(1); }
  const captures = batchCaptures(JSON.parse(await readFile(input, 'utf8')));
  const results = [];
  for (const capture of captures) { // one capture per call keeps claims attributable and prompts short
    const { accepted, rejected, error } = await extractCaptures([capture]);
    console.log(`${capture.capture_ref}: ${accepted.length} accepted, ${rejected.length} rejected${error ? `, FAILED (${error})` : ''}`);
    results.push({ capture_ref: capture.capture_ref, accepted, rejected, error });
  }
  await writeFile(output, JSON.stringify({ model: MODEL, results }, null, 2));
}
