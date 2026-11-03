// Polite HTTP for collectors: plain HTTP/JSON only, robots.txt respected, at most one request per
// min-delay per host, bounded backoff on 429/503, and blocked/CAPTCHA/"unavailable" pages treated as failures.
// It never solves or evades anything: a blocking response stops the source for this run.

export type FailureKind = "blocked" | "captcha" | "rate_limited" | "unavailable" | "malformed" | "http" | "timeout" | "network" | "robots" | "budget";
// These stop the whole source; the others fail only one request.
export const STOPPING_FAILURES: FailureKind[] = ["blocked", "captcha", "rate_limited", "budget"];

export type HttpOk = { ok: true; status: number; body: string; json: unknown; contentType: string | null; url: string };
export type HttpFail = { ok: false; kind: FailureKind; status: number; message: string; url: string };
export type HttpResult = HttpOk | HttpFail;

type Deps = { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; now: () => Date; contact: string };
type Options = { maxRequests: number; minDelayMs: number; timeoutMs?: number; maxRetries?: number; userAgent?: string };

const CAPTCHA = /captcha|cf-chl-|challenge-platform|are you a (robot|human)|verify you are human|px-captcha|access denied|request blocked|unusual traffic/i;
const UNAVAILABLE = /(temporarily|currently|service) unavailable|under maintenance|scheduled maintenance|page (is )?not available|this (site|page) (can't|cannot) be reached|something went wrong|no longer available/i;

type Rule = { allow: boolean; path: string };

export function parseRobots(text: string, agentToken: string): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1].toLowerCase(), value = m[2].trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === "allow" || field === "disallow") && current) {
      lastWasAgent = false;
      if (field === "disallow" && !value) continue; // "Disallow:" with no path allows everything
      current.rules.push({ allow: field === "allow", path: value });
    } else lastWasAgent = false;
  }
  const token = agentToken.toLowerCase();
  const specific = groups.filter(g => g.agents.some(a => a !== "*" && token.includes(a)));
  return (specific.length ? specific : groups.filter(g => g.agents.includes("*"))).flatMap(g => g.rules);
}

function ruleMatches(rulePath: string, path: string): number {
  const anchored = rulePath.endsWith("$");
  const pattern = "^" + rulePath.replace(/\$$/, "").split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : "");
  return new RegExp(pattern).test(path) ? rulePath.length : -1;
}

export function robotsAllows(rules: Rule[], path: string): boolean {
  let best: Rule | null = null, bestLen = -1;
  for (const rule of rules) {
    const len = ruleMatches(rule.path, path);
    if (len > bestLen || (len === bestLen && rule.allow)) { best = rule; bestLen = len; }
  }
  return !best || best.allow;
}

export class PoliteHttp {
  requests = 0;
  private lastByHost = new Map<string, number>();
  private robots = new Map<string, Rule[] | "unavailable">();
  readonly userAgent: string;
  private deps: Deps;
  private opts: Options;
  constructor(deps: Deps, opts: Options) {
    this.deps = deps;
    this.opts = opts;
    this.userAgent = opts.userAgent ?? `mando-cube-ingestion/1.0 (+https://github.com/advitarora5/Mando-CUBE; ${deps.contact || "contact unset"})`;
  }

  get remaining() { return Math.max(0, this.opts.maxRequests - this.requests); }

  private async pace(host: string) {
    const last = this.lastByHost.get(host);
    const wait = last == null ? 0 : last + this.opts.minDelayMs - this.deps.now().getTime();
    if (wait > 0) await this.deps.sleep(wait);
    this.lastByHost.set(host, this.deps.now().getTime());
  }

  private async raw(url: string, init: RequestInit): Promise<{ res: Response; body: string } | HttpFail> {
    if (this.requests >= this.opts.maxRequests) return { ok: false, kind: "budget", status: 0, message: `request cap ${this.opts.maxRequests} reached`, url };
    // Pace per site, not per host: every Workday tenant is a different host on the same myworkdayjobs.com servers.
    await this.pace(new URL(url).hostname.split(".").slice(-2).join("."));
    this.requests++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 20000);
    try {
      const res = await this.deps.fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
      const body = await res.text();
      return { res, body };
    } catch (error) {
      const aborted = (error as Error)?.name === "AbortError";
      return { ok: false, kind: aborted ? "timeout" : "network", status: 0, message: aborted ? `timed out after ${this.opts.timeoutMs ?? 20000} ms` : String((error as Error)?.message ?? error), url };
    } finally { clearTimeout(timer); }
  }

  // robots.txt is fetched once per host. If it cannot be read (other than 404), the host is treated as off-limits.
  async allowed(url: string): Promise<boolean | HttpFail> {
    const u = new URL(url);
    let rules = this.robots.get(u.host);
    if (!rules) {
      const got = await this.raw(`${u.protocol}//${u.host}/robots.txt`, { headers: { "user-agent": this.userAgent } });
      if ("ok" in got) { if (STOPPING_FAILURES.includes(got.kind)) return got; rules = "unavailable"; }
      else if (got.res.status === 404 || got.res.status === 410) rules = [];
      else if (got.res.status === 401 || got.res.status === 403) return { ok: false, kind: CAPTCHA.test(got.body.slice(0, 5000)) ? "captcha" : "blocked", status: got.res.status, message: `robots.txt returned HTTP ${got.res.status}`, url };
      else if (got.res.status >= 400 || CAPTCHA.test(got.body.slice(0, 5000))) rules = "unavailable";
      else rules = parseRobots(got.body, "mando-cube-ingestion");
      this.robots.set(u.host, rules);
    }
    return rules !== "unavailable" && robotsAllows(rules, u.pathname + u.search);
  }

  // Fetch robots.txt itself (the Workday resolver reads site names from it). Paced and counted like any request.
  async robotsTxt(origin: string): Promise<HttpResult> {
    return this.request(`${origin.replace(/\/$/, "")}/robots.txt`, { expect: "text", checkRobots: false });
  }

  async request(url: string, opts: { method?: "GET" | "POST"; json?: unknown; headers?: Record<string, string>; expect: "json" | "text"; checkRobots?: boolean }): Promise<HttpResult> {
    if (opts.checkRobots !== false) {
      const allowed = await this.allowed(url);
      if (typeof allowed !== "boolean") return allowed;
      if (!allowed) return { ok: false, kind: "robots", status: 0, message: "disallowed by robots.txt (or robots.txt unreadable)", url };
    }
    const headers: Record<string, string> = { "user-agent": this.userAgent, accept: opts.expect === "json" ? "application/json" : "text/plain, text/html;q=0.9, */*;q=0.5", ...opts.headers };
    const init: RequestInit = { method: opts.method ?? "GET", headers };
    if (opts.json !== undefined) { init.body = JSON.stringify(opts.json); headers["content-type"] = "application/json"; }
    const retries = this.opts.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const got = await this.raw(url, init);
      if ("ok" in got) {
        if ((got.kind === "timeout" || got.kind === "network") && attempt < retries) { await this.deps.sleep(this.backoff(attempt, null)); continue; }
        return got;
      }
      const { res, body } = got;
      const status = res.status;
      const contentType = res.headers.get("content-type");
      if (status === 429 || status === 503) {
        if (attempt < retries) { await this.deps.sleep(this.backoff(attempt, res.headers.get("retry-after"))); continue; }
        return { ok: false, kind: "rate_limited", status, message: `HTTP ${status} after ${attempt + 1} attempts`, url };
      }
      const head = body.slice(0, 20000);
      if (status === 403 || status === 401) return { ok: false, kind: CAPTCHA.test(head) ? "captcha" : "blocked", status, message: `HTTP ${status}`, url };
      if (status >= 400) return { ok: false, kind: "http", status, message: `HTTP ${status}: ${body.slice(0, 160).replace(/\s+/g, " ")}`, url };
      const looksHtml = /<html|<!doctype html/i.test(head);
      if (looksHtml && CAPTCHA.test(head)) return { ok: false, kind: "captcha", status, message: "CAPTCHA or bot challenge page", url };
      if (opts.expect === "json") {
        try { return { ok: true, status, body, json: JSON.parse(body), contentType, url }; }
        catch { return { ok: false, kind: looksHtml && UNAVAILABLE.test(head) ? "unavailable" : "malformed", status, message: looksHtml ? "HTML page where JSON was expected" : "response is not valid JSON", url }; }
      }
      if (looksHtml && UNAVAILABLE.test(head)) return { ok: false, kind: "unavailable", status, message: "page says it is unavailable", url };
      return { ok: true, status, body, json: null, contentType, url };
    }
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(30000, seconds * 1000);
    return Math.min(30000, Math.max(this.opts.minDelayMs, 1000) * 2 ** (attempt + 1));
  }
}
