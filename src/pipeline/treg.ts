// treg access. Two transports with one interface: HTTP with TREG_TOKEN (CI), or the locally signed-in
// `treg` CLI (a teammate's laptop). Neither ever prints or logs the token. 402 = out of balance: paid work stops.
import { execFile } from "node:child_process";
import type { TregResult, TregTransport } from "./types.ts";

export const TREG_BASE = "https://treg.to";

export class HttpTreg implements TregTransport {
  private token: string;
  private org: string | null;
  private fetchImpl: typeof fetch;
  constructor(token: string, org: string | null, fetchImpl: typeof fetch = fetch) {
    this.token = token; this.org = org; this.fetchImpl = fetchImpl;
  }
  async call(endpoint: string, opts: { query?: Record<string, string | number>; body?: unknown; headers?: Record<string, string>; idempotencyKey?: string; timeoutMs?: number }): Promise<TregResult> {
    const url = new URL(`${TREG_BASE}/call/${endpoint}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { "X-Treg-Token": this.token, accept: "application/json", ...opts.headers };
    if (this.org) headers["X-Treg-Org"] = this.org;
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const init: RequestInit = { method: opts.body === undefined ? "GET" : "POST", headers };
    if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); headers["content-type"] = "application/json"; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60000);
    try {
      const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const cost = Number(res.headers.get("x-treg-cost-micro") ?? 0) / 1e6;
      const text = await res.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* keep text */ }
      if (!res.ok) return { ok: false, status: res.status, error: `treg HTTP ${res.status}`, cost_usd: cost, body };
      return { ok: true, status: res.status, body, cost_usd: cost, call_id: res.headers.get("x-treg-call-id") };
    } catch (error) {
      const aborted = (error as Error)?.name === "AbortError";
      return { ok: false, status: 0, error: aborted ? "treg timeout" : `treg network error: ${(error as Error)?.message}`, cost_usd: 0 };
    } finally { clearTimeout(timer); }
  }
}

type ExecFn = (file: string, args: string[], opts: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv }, cb: (error: Error | null, stdout: string, stderr: string) => void) => void;

export class CliTreg implements TregTransport {
  private exec: ExecFn;
  constructor(exec: ExecFn = execFile as unknown as ExecFn) { this.exec = exec; }
  call(endpoint: string, opts: { query?: Record<string, string | number>; body?: unknown; headers?: Record<string, string>; idempotencyKey?: string; timeoutMs?: number }): Promise<TregResult> {
    const args = ["--json", "call", endpoint];
    for (const [key, value] of Object.entries(opts.query ?? {})) args.push("--query", `${key}=${value}`);
    for (const [key, value] of Object.entries({ ...opts.headers, ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}) })) args.push("--header", `${key}: ${value}`);
    if (opts.body !== undefined) args.push("--method", "POST", "--data", JSON.stringify(opts.body));
    return new Promise(resolve => {
      // The CLI is Python: on Windows it crashes printing non-ASCII names (cp1252) unless UTF-8 is forced.
      this.exec("treg", args, { timeout: opts.timeoutMs ?? 90000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } }, (error, stdout) => {
        let parsed: { result?: unknown; _treg?: { http_status?: number; call_id?: string; charged_micro?: number } } | null = null;
        try { parsed = JSON.parse(String(stdout).trim().split("\n").pop() ?? ""); } catch { parsed = null; }
        if (!parsed) return resolve({ ok: false, status: 0, error: error ? `treg CLI failed: ${error.message.split("\n")[0]}` : "treg CLI returned no JSON", cost_usd: 0 });
        const status = parsed._treg?.http_status ?? 0;
        const cost = (parsed._treg?.charged_micro ?? 0) / 1e6;
        if (status >= 400 || status === 0) return resolve({ ok: false, status, error: `treg HTTP ${status}`, cost_usd: cost, body: parsed.result });
        resolve({ ok: true, status, body: parsed.result, cost_usd: cost, call_id: parsed._treg?.call_id ?? null });
      });
    });
  }
}

// TREG_TOKEN wins; otherwise the CLI if it is installed; otherwise no treg (treg steps are skipped, the run continues).
export async function tregFromEnv(env: NodeJS.ProcessEnv): Promise<TregTransport | null> {
  if (env.TREG_TOKEN) return new HttpTreg(env.TREG_TOKEN, env.TREG_ORG ?? null);
  if (env.TREG_DISABLE_CLI === "1") return null;
  const available = await new Promise<boolean>(resolve => execFile("treg", ["--version"], { timeout: 10000 }, error => resolve(!error)));
  return available ? new CliTreg() : null;
}
