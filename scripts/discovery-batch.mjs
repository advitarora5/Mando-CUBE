// Sequential admission attempts. Each worker retains the one-company safety cap.
export function batchDeadline(stopAt, now = Date.now()) {
  if (!stopAt) return 50 * 60000;
  const end = Date.parse(stopAt);
  if (!Number.isFinite(end) || end <= now) throw Error('Batch stop time reached or invalid');
  return Math.min(50 * 60000, end - now);
}

export async function runCandidateBatch({ maxCandidates, deadlineMs, run, now = Date.now, save = () => {} }) {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 5 || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 50 * 60000) throw Error('Invalid batch bounds');
  const started = now();
  const result = { status: 'running', max_candidates: maxCandidates, candidates_checked: 0, admitted: 0, attempts: [], paid_services: false };
  for (let i = 0; i < maxCandidates; i++) {
    const remaining = deadlineMs - (now() - started);
    if (remaining <= 0) { result.status = 'time_limit'; break; }
    const attempt = await run(i, Math.min(remaining, 10 * 60000));
    result.attempts.push(attempt);
    const match = attempt.jobs?.find(j => j.job === 'match');
    const score = attempt.jobs?.find(j => j.job === 'score');
    const checked = match?.counts?.candidates ?? 0, admitted = match?.counts?.new_companies ?? 0;
    if (![checked, admitted].every(n => Number.isInteger(n) && n >= 0 && n <= 1) || admitted > checked) throw Error('Worker exceeded batch scope; inspect completed writes');
    result.candidates_checked += checked; result.admitted += admitted;
    if (!['succeeded', 'needs_attention'].includes(attempt.status) || match?.status !== 'succeeded' || score?.status !== 'succeeded') {
      result.status = 'needs_attention'; save(result); break;
    }
    if (!checked) { result.status = 'no_eligible_candidates'; save(result); break; }
    save(result);
  }
  if (result.status === 'running') result.status = result.attempts.some(a => a.status !== 'succeeded') ? 'needs_attention' : 'completed';
  save(result); return result;
}
