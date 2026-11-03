// Creates a bounded collection brief locally. Does not launch an agent.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceConfigSchema, collectionBriefSchema } from '../../src/data/ingestion/contracts.ts';

try {
  const sourceId = process.argv[2] ?? 'reddit-workday';
  if (process.argv.length > 3) throw new Error('Usage: node scripts/ingestion/prepare-run.mjs [source-id]');
  const config = sourceConfigSchema.parse(JSON.parse(await readFile(new URL('../../config/ingestion/sources.json', import.meta.url), 'utf8')));
  const source = config.sources.find(item => item.id === sourceId);
  if (!source?.enabled) throw new Error(`Source ${sourceId} is unknown or disabled.`);
  const now = new Date();
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - source.lookback_days);
  const runId = `${source.id}-${now.toISOString().replace(/[:.]/g, '-')}`;
  const brief = collectionBriefSchema.parse({
    schema_version: 1, run_id: runId, source_id: source.id, started_at: now.toISOString(),
    lookback_start: start.toISOString().slice(0, 10), start_urls: source.start_urls,
    search_terms: source.search_terms, max_pages: source.max_pages, max_minutes: source.max_minutes,
  });
  const directory = resolve(fileURLToPath(new URL('../../var/ingestion/runs/', import.meta.url)), runId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'brief.json'), JSON.stringify(brief, null, 2) + '\n', { flag: 'wx' });
  console.log(`Brief: ${join(directory, 'brief.json')}\nSave captures: ${join(directory, 'captures.json')}\nRead docs/ingestion/browser-agent.md before collection. This command does not start a browser or schedule a run.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
