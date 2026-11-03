// Task 1 skeleton: no provider, database or application imports.
export const DISCOVERY_SOURCES = Object.freeze([
  'sec-company-list', 'workday-site-resolver',
  'workday-tenant-crawl', 'workday-tenant-wayback', 'workday-career-sites',
]);

export function discoveryPlan(limit = 10) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('limit must be an integer from 1 to 100');
  return {
    version: 1, limit, paid_services: false,
    steps: [...DISCOVERY_SOURCES.map(source => ({ plan: 'collect', source })),
      ...['extract', 'match', 'score'].map(plan => ({ plan }))],
  };
}

export function assertLocalTarget(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('Skeleton execution requires local Supabase with an explicit port; remote targets are disabled');
  }
}

export function assertSources(sources) {
  const unavailable = DISCOVERY_SOURCES.filter(id => !sources.some(s => s.id === id && s.enabled));
  if (unavailable.length) throw Error(`Integrate and configure required sources first: ${unavailable.join(', ')}`);
}

export async function executeDiscovery(ctx, run, plan) {
  // Preflight all dependencies before starting any collection or writing run logs.
  assertSources(await ctx.store.sources());
  const reports = [];
  for (const step of plan.steps) {
    const report = await run(ctx, { ...step, limit: plan.limit, dryRun: false, trigger: 'manual' });
    reports.push(report);
    // Independent collectors may continue; dependent stages stop on an unhealthy predecessor.
    const unhealthy = !report.jobs.length || report.jobs.some(j => j.status !== 'succeeded');
    if (unhealthy && step.plan !== 'collect') break;
  }
  return { status: reports.length !== plan.steps.length || reports.some(r => !r.jobs.length || r.jobs.some(j => j.status !== 'succeeded'))
    ? 'needs_attention' : 'succeeded', reports };
}
