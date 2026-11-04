const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const candidateKeys = job => Array.isArray(job?.candidate_keys) ? job.candidate_keys.filter(key => /^[0-9a-f]{16}$/.test(key)) : [];

// What a run or batch achieved, from stage counters only. Unique candidates stay null unless every match pass
// reported its hashed names, so a sum across retried workers is never presented as a unique count.
export function discoveryRollup(jobs) {
  const rows = (Array.isArray(jobs) ? jobs : []).filter(job => job && typeof job === 'object');
  const of = name => rows.filter(job => job.job === name);
  const sum = (name, key) => of(name).reduce((total, job) => total + count(job.counts?.[key]), 0);
  const match = of('match');
  const prefixed = (name, prefix, skip = []) => {
    const totals = {};
    for (const job of of(name)) for (const [key, value] of Object.entries(job.counts ?? {})) {
      if (key.startsWith(prefix) && !skip.includes(key)) totals[key.slice(prefix.length)] = (totals[key.slice(prefix.length)] ?? 0) + count(value);
    }
    return totals;
  };
  const newByReason = prefixed('match', 'review_', ['review_existing']), existingByReason = prefixed('match', 'pending_reason_');
  const byReason = { ...newByReason };
  for (const [reason, value] of Object.entries(existingByReason)) byReason[reason] = (byReason[reason] ?? 0) + value;
  const checked = sum('match', 'candidates');
  const measured = match.every(job => candidateKeys(job).length === count(job.counts?.candidates));
  return {
    candidates: { checked, unique: measured ? new Set(match.flatMap(candidateKeys)).size : null },
    admissions: { new_companies: sum('match', 'new_companies'), attached_existing: sum('match', 'attached_existing') },
    held: {
      new_reviews: Object.values(newByReason).reduce((total, value) => total + value, 0),
      still_held: sum('match', 'joined_pending_review') + sum('match', 'review_existing'),
      identity_held: sum('match', 'identity_held'),
      by_reason: byReason,
    },
    scoring: {
      assessments_written: sum('score', 'scored') + sum('score', 'rescored'), unchanged: sum('score', 'unchanged'),
      zero_points: prefixed('score', 'zero_'), financials: prefixed('score', 'financials_'),
    },
    // Per score pass: a company touched by two workers is counted in both passes.
    contacts: {
      scored_with_contacts: sum('score', 'with_contacts'), scored_without_contacts: sum('score', 'without_contacts'),
      added: sum('enrich', 'contacts_added'), research_evidence_missing: sum('enrich', 'research_evidence_missing'), waiting_for_provider: sum('enrich', 'no_treg'),
    },
  };
}

// Keep source diagnostics useful without retaining raw provider bodies or URL tokens.
export function summarizeJob(job) {
  return { job: job.job, source: job.source_id, status: job.status, ms: job.ms, counts: job.counts,
    requests: job.requests ?? 0, cache_hit: job.cache_hit === true, candidate_keys: candidateKeys(job),
    reason: job.blocked === 'source time budget reached' ? 'source_deadline' : job.blocked ? 'source_blocked' : null,
    diagnostics: (job.errors || []).slice(0, 5).map(error => {
      const value = String(error);
      let host = null;
      try { host = new URL(value.match(/https?:\/\/[^\s]+/)?.[0]).hostname; } catch { /* no URL in this error */ }
      return { host, http_status: Number(value.match(/HTTP\s+(\d{3})/i)?.[1]) || null };
    }) };
}
