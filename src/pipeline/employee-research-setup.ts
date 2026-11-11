import type { PipelineContext } from "./types.ts";

export const EMPLOYEE_SETUP_WARNING = "Employee website research skipped: cache storage or permissions are unavailable. "
  + "Check company_employee_research and execute access to claim_employee_research/finish_employee_research for the pipeline service_role. "
  + "One-time prerequisite: supabase/migrations/202611080001_employee_research.sql and 202611100001_employee_research_readiness.sql through the approved database release process; no migration was applied automatically. "
  + "Saved Workday collection and unrelated pipeline stages continue. See research/authority-headcount/TEAMMATE_SETUP.md.";

// Missing/empty configuration uses the normal enabled default. A boolean false
// also serves direct PipelineContext callers; tests can explicitly opt out.
export function employeeResearchEnabled(value?: string | boolean): boolean {
  return value !== false && !/^(?:0|false|off|no|disabled?)$/i.test(String(value ?? "").trim());
}

// Bound optional work even when a database adapter ignores cancellation. Callers
// check the signal before continuing after an await. Never log raw errors/keys.
export async function employeeDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Employee research timed out or was cancelled."));
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => controller.abort(), ms);
        if (signal.aborted) abort();
      }),
      Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); }),
    ]);
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

export async function ensureEmployeeResearchReady(ctx: PipelineContext) {
  if (ctx.employeeResearchReadiness) return ctx.employeeResearchReadiness;
  if (!employeeResearchEnabled(ctx.employeeWebResearch)) {
    ctx.employeeResearchReadiness = { status: "disabled" };
    ctx.log.info("Employee research disabled explicitly; no Workday or website lookup will run.");
  } else {
    try {
      await employeeDeadline(signal => ctx.store.checkEmployeeResearchStorage(signal), 5000, ctx.signal);
      ctx.employeeResearchReadiness = { status: "ready" };
      ctx.log.info("Employee research enabled: saved Workday descriptions and bounded official-site/annual-report collection.");
    } catch {
      ctx.employeeResearchReadiness = { status: "unavailable" };
      ctx.log.warn(EMPLOYEE_SETUP_WARNING);
    }
  }
  return ctx.employeeResearchReadiness;
}
