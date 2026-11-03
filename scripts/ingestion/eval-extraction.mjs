// Runs the 12 hand-annotated cases through the extractor and prints a per-case report.
// expected-results.json is used only for scoring, never shown to the model.
// Usage: node scripts/ingestion/eval-extraction.mjs [case-02 ...] [--repeat N]
//   --repeat N reruns every case with N seeds and lists claims or fields that change between runs.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { MODEL, SEED, compareRuns, extractCaptures } from './extract.mjs';

const dir = new URL('../../docs/ingestion/extraction-test-set-2026-10-11/', import.meta.url);
const read = async name => JSON.parse(await readFile(new URL(name, dir), 'utf8'));
const norm = s => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
// A claim recovers a required fact when its quote and the annotated excerpt overlap.
const overlaps = (quote, excerpt) => norm(quote).includes(norm(excerpt)) || norm(excerpt).includes(norm(quote));

const [inputs, expected] = await Promise.all([read('inputs.json'), read('expected-results.json')]);
const args = process.argv.slice(2);
const repeat = args.includes('--repeat') ? Number(args[args.indexOf('--repeat') + 1]) : 1;
const only = args.filter(a => a.startsWith('case-'));
let flagged = 0;
const saved = [];

console.log(`Model ${MODEL}, seed ${SEED}${repeat > 1 ? `, ${repeat} runs per case` : ''}\n`);
for (const input of inputs.cases) {
  if (only.length && !only.includes(input.case_id)) continue;
  const want = expected.cases.find(c => c.case_id === input.case_id);
  const runs = [];
  // Seeds step by 2 because a run's one retry uses the next seed.
  for (let r = 0; r < repeat; r++) runs.push(await extractCaptures(input.captures, fetch, SEED + 2 * r));
  saved.push({ case_id: input.case_id, runs });
  const { accepted, rejected, error } = runs[0];
  console.log(`== ${input.case_id} ${want.label}`);
  if (error) { console.log(`   FAILED: ${error}`); flagged++; }
  if (repeat > 1) {
    const { stable, unstable, drift } = compareRuns(runs);
    flagged += unstable.length + drift.length;
    console.log(`   consistency: ${stable} claims identical in all ${repeat} runs, ${unstable.length} missing from some runs, ${drift.length} with changing fields`);
    for (const line of [...unstable, ...drift]) console.log(`   ~ ${line}`);
  }

  const names = accepted.map(c => c.company.name).filter(Boolean);
  const identities = want.identities.map(i => `${i.name} ${names.some(n => norm(n).includes(norm(i.name)) || norm(i.name).includes(norm(n))) ? 'found' : 'MISSING'}`);
  const recovered = want.required_claims.filter(r => accepted.some(c => overlaps(c.evidence.quote, r.support.verbatim_excerpt)));

  console.log(`   identities: ${identities.join('; ') || 'none expected'}`);
  console.log(`   required facts recovered: ${recovered.length}/${want.required_claims.length}`);
  console.log(`   claims accepted ${accepted.length}, rejected ${rejected.length}`);
  for (const c of accepted) console.log(`   + [${c.signal_type}] ${c.company.name ?? '?'} (${c.company.role}): ${c.statement}${c.date ? ` {${c.date.kind} ${c.date.raw}}` : ''}`);
  for (const r of rejected) console.log(`   - ${r.reason}: ${r.claim.statement}`);
  console.log(`   check by hand, must not assert: ${want.must_not_assert.join(' | ')}\n`);
}
// Full output kept so quality and run-to-run consistency can be analyzed without re-running the model.
await mkdir(new URL('../../var/ingestion/', import.meta.url), { recursive: true });
await writeFile(new URL(`../../var/ingestion/eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url), JSON.stringify({ model: MODEL, seed: SEED, repeat, cases: saved }, null, 2));
if (flagged) process.exitCode = 1;
