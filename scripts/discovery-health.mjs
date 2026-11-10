import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DISCOVERY_SOURCES } from './discovery-plan.mjs';
import { discoveryRollup } from './discovery-report.mjs';

const labels = ['SEC names', 'Workday site resolver', 'Common Crawl', 'Wayback archive', 'Workday job postings'];
const statuses = new Set(['succeeded', 'partial', 'blocked', 'failed', 'needs_attention', 'time_limit', 'interrupted', 'overlap_blocked']);
const safeStatus = status => statuses.has(status) ? status : 'unknown';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

// Render only known labels and numeric counters. Never copy raw errors, URLs,
// names or arbitrary provider fields into the GitHub summary.
export function discoveryHealthMarkdown(summary) {
  if (!summary || !Array.isArray(summary.jobs)) return '## Discovery run\n\nNo completed execution report is available. No successful run is claimed.\n';
  const jobs = summary.jobs.filter(job => job && typeof job === 'object');
  const match = jobs.filter(job => job.job === 'match');
  const score = jobs.filter(job => job.job === 'score');
  const sum = (rows, key) => rows.reduce((total, row) => total + count(row.counts?.[key]), 0);
  const reviewKeys = ['no_website', 'similar_name', 'untrusted_signal', 'over_run_cap'];
  const newReviews = reviewKeys.reduce((total, reason) => total + sum(match, `review_${reason}`), 0);
  const complete = jobs.every(job => job.status === 'succeeded')
    && DISCOVERY_SOURCES.every(source => jobs.some(job => job.job === 'collect' && job.source === source && job.status === 'succeeded'))
    && jobs.filter(job => job.job === 'extract' && job.status === 'succeeded').length === 2
    && match.some(job => job.status === 'succeeded') && score.some(job => job.status === 'succeeded');
  const status = summary.status === 'succeeded' && !complete ? 'needs_attention' : safeStatus(summary.status);
  const lines = ['## Discovery run', '', `Result: **${status}**`, '',
    `New companies admitted: **${sum(match, 'new_companies')}**. New reviews: **${newReviews}**.`,
    `Assessments written: **${sum(score, 'scored') + sum(score, 'rescored')}**; unchanged assessments: **${sum(score, 'unchanged')}**.`, '',
    'These are reported stage counts, not a database audit or the total company count.', '',
    '| Source | Result | Items | Requests | Candidate cache reused |', '|---|---|---:|---:|---|'];
  DISCOVERY_SOURCES.forEach((source, index) => {
    const job = jobs.find(job => job.job === 'collect' && job.source === source);
    lines.push(`| ${labels[index]} | ${job ? safeStatus(job.status) : 'not run'} | ${count(job?.counts?.items)} | ${count(job?.requests)} | ${job?.cache_hit === true ? 'yes' : 'no'} |`);
  });
  lines.push('', `Matching: **${match.length ? safeStatus(match.at(-1).status) : 'not run'}**. Scoring: **${score.length ? safeStatus(score.at(-1).status) : 'not run'}**.`, '');
  if (!complete || status !== 'succeeded') lines.push('The full run is not confirmed healthy. Successful stages may still have saved useful work.', '');
  if (['time_limit', 'interrupted'].includes(status) || summary.interrupted_writes_may_have_completed === true)
    lines.push('The worker stopped early. In-flight writes may have completed; do not assume a rollback.', '');
  for (const reason of reviewKeys) {
    const held = sum(match, `pending_reason_${reason}`);
    if (held) lines.push(`Existing reviews still held (${reason}): **${held}**.`, '');
  }
  lines.push(...coverageLines(discoveryRollup(jobs)));
  lines.push('A successful scoring stage with zero assessments does not establish that new admissions were scored.', '');
  return lines.join('\n');
}

const categoryLabels = { authority: 'Authority', reachability: 'Reachability', budget: 'Budget', release: 'Release', timing: 'Timing' };
const financialLabels = { found: 'filing found', no_sec_match: 'no SEC name match', no_filing_facts: 'no annual filing facts', no_operating_income: 'no operating income reported', stale_filing: 'stale filing', no_contact: 'lookup off: no contact set', no_sec_list: 'lookup off: no SEC list', fetch_failed: 'SEC request failed' };

// Fixed labels and numbers only, like the rest of this report.
function coverageLines({ candidates, held, contacts, scoring }) {
  const scored = contacts.scored_with_contacts + contacts.scored_without_contacts;
  const named = (labels, values) => Object.entries(labels).map(([key, label]) => `${label} ${count(values[key])}`).join(', ');
  const lines = [`Candidates checked: **${candidates.checked}**; unique: **${candidates.unique ?? 'not measured'}**. Held: **${held.new_reviews}** new, **${held.still_held}** still held.`, ''];
  if (contacts.companies_researched || contacts.waiting_for_provider || contacts.research_evidence_missing) {
    lines.push(`Free enrichment: **${contacts.companies_researched}** researched, **${contacts.companies_verified}** with a verified contact, **${contacts.assessments_written}** updated assessments, **${contacts.waiting_for_provider}** waiting for a provider.`, '');
  }
  if (!scored) return lines;
  lines.push(`Contact coverage: **${contacts.scored_with_contacts}** of **${scored}** scored companies have contacts.`, '',
    `Categories scoring zero: ${named(categoryLabels, scoring.zero_points)}.`, '',
    `Financial evidence: ${named(financialLabels, scoring.financials)}.`, '');
  const off = count(scoring.financials.no_contact) + count(scoring.financials.no_sec_list) + count(scoring.financials.fetch_failed);
  if (off) lines.push(`**${off}** scored companies could not be checked for filing evidence, so their Budget may omit it. This is not evidence that capacity is absent.`, '');
  if (count(scoring.financials.deferred)) lines.push(`Saved assessments kept instead of being lowered during the outage: **${count(scoring.financials.deferred)}**.`, '');
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let summary;
  try { summary = JSON.parse(readFileSync('var/discovery/latest.json', 'utf8')); } catch { /* absent or incomplete execution */ }
  const markdown = discoveryHealthMarkdown(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  else process.stdout.write(markdown);
}
