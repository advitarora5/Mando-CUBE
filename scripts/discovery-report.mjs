// Keep source diagnostics useful without retaining raw provider bodies or URL tokens.
export function summarizeJob(job) {
  return { job: job.job, source: job.source_id, status: job.status, ms: job.ms, counts: job.counts,
    reason: job.blocked === 'source time budget reached' ? 'source_deadline' : job.blocked ? 'source_blocked' : null,
    diagnostics: (job.errors || []).slice(0, 5).map(error => {
      const value = String(error);
      let host = null;
      try { host = new URL(value.match(/https?:\/\/[^\s]+/)?.[0]).hostname; } catch { /* no URL in this error */ }
      return { host, http_status: Number(value.match(/HTTP\s+(\d{3})/i)?.[1]) || null };
    }) };
}
