// Task 1 skeleton: no provider, database or application imports.
export const DISCOVERY_SOURCES = Object.freeze([
  'sec-company-list', 'workday-site-resolver',
  'workday-tenant-crawl', 'workday-tenant-wayback', 'workday-career-sites',
]);

export function discoveryPlan(limit = 10) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('limit must be an integer from 1 to 100');
  return {
    version: 1, limit, paid_services: false,
    steps: [...DISCOVERY_SOURCES.slice(0, -1).map(source => ({ plan: 'collect', source })),
      { plan: 'extract' }, { plan: 'collect', source: 'workday-career-sites' },
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

export function assertApprovedTarget(env) {
  const ref = env.DISCOVERY_APPROVED_PROJECT_REF;
  if (env.DISCOVERY_EXECUTION_ENABLED !== 'true' || env.DISCOVERY_SINGLE_WRITER_CONFIRMED !== 'true'
    || !/^[a-z0-9]{20}$/.test(ref || '') || env.PIPELINE_ALLOW_REMOTE !== ref
    || env.PIPELINE_SUPABASE_URL !== `https://${ref}.supabase.co`) {
    throw Error('Approved execution requires explicit enablement, a single writer and an exact database project');
  }
}

export function assertSources(sources) {
  const unavailable = DISCOVERY_SOURCES.filter(id => !sources.some(s => s.id === id && s.enabled));
  if (unavailable.length) throw Error(`Integrate and configure required sources first: ${unavailable.join(', ')}`);
}

export async function executeDiscovery(ctx, run, plan) {
  // Preflight all dependencies before starting any collection or writing run logs.
  // The bounded admission-only plan consumes saved evidence, not collectors.
  // Keep the complete source gate for every other plan, including full discovery.
  const admissionOnly = plan.steps[0]?.plan === 'match'
    && (plan.steps.length === 1 || (plan.steps.length === 2 && plan.steps[1].plan === 'score'))
    && plan.steps.every(step => !step.source);
  if (!admissionOnly) assertSources(await ctx.store.sources());
  const reports = [];
  for (const step of plan.steps) {
    const report = await run(ctx, { ...step, limit: plan.limit, dryRun: false, trigger: 'manual' });
    reports.push(report);
    // Partial processing preserves usable work: an admitted company must still be scored
    // when another candidate's website fails. Fatal processing failures stop dependents.
    const fatal = !report.jobs.length || report.jobs.some(j => j.status === 'failed' || j.status === 'blocked');
    if (fatal && step.plan !== 'collect') break;
  }
  return { status: reports.length !== plan.steps.length || reports.some(r => !r.jobs.length || r.jobs.some(j => j.status !== 'succeeded'))
    ? 'needs_attention' : 'succeeded', reports };
}
