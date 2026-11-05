// Long enough to use a source's request allowance at one request a second. The archives also need one slow index query,
// which answers in up to 60 seconds and is then cached for a day.
export const sourceBudgetMs = source => (['workday-tenant-crawl', 'workday-tenant-wayback'].includes(source) ? 120000 : 75000);

export async function withSourceBudget(ctx, run, milliseconds = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  const scoped = { ...ctx, signal: controller.signal };
  scoped.fetch = (url, options = {}) => ctx.fetch(url, { ...options,
    signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
  // Backoff must wake at the deadline without throwing away already buffered items.
  scoped.sleep = ms => new Promise(resolve => {
    if (controller.signal.aborted) return resolve();
    const finish = () => { clearTimeout(wait); controller.signal.removeEventListener('abort', finish); resolve(); };
    const wait = setTimeout(finish, ms);
    controller.signal.addEventListener('abort', finish, { once: true });
  });
  try { return await run(scoped); }
  finally { clearTimeout(timer); ctx.collected = scoped.collected; }
}
