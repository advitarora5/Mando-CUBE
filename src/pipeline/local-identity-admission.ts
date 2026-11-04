// Guarded identity admission. Explicit local/approved entry points create capabilities.
// It never writes website_resolutions: AI proof must not populate the direct-link cache.
import { SupabaseStore } from "./store/supabase.ts";
import { normalizeDomain, normalizeName } from "../domain/ingestion/normalize.ts";
import { corporateCandidates } from "./collectors/corporate-careers.ts";
import { prepareIdentityCase } from "./identity-evidence.ts";
import { IDENTITY_MODEL_OPTIONS, MAX_IDENTITY_AGE_MS, reusableIdentity, verifyIdentity, type IdentityCase, type IdentityResult } from "./identity.ts";
import { OllamaProvider } from "./llm.ts";
import type { EmployerWebsiteLink, PipelineContext, WebsiteResolution, WorkdaySite } from "./types.ts";
import type { WebsiteHttp } from "./website.ts";

export function assertLocalAdmissionUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw Error("AI admission requires an explicit loopback HTTP endpoint with a port; remote overrides are not supported");
  }
}

export function assertLocalAdmissionStore(ctx: PipelineContext): void {
  if (!(ctx.store instanceof SupabaseStore)) throw Error("AI admission requires local Supabase");
  assertLocalAdmissionUrl(ctx.store.databaseUrl);
}

export type LocalAdmissionCandidate = { name: string; corporate_urls?: string[] };
export type LocalIdentityAdmission = {
  names: Set<string>;
  resolve(ctx: PipelineContext, name: string, sites: WorkdaySite[], http: WebsiteHttp, refs: EmployerWebsiteLink[]): Promise<WebsiteResolution>;
};

// Approved capabilities are bound to one concrete store. A copied/hand-built
// policy cannot authorize a remote store through the runner's localIdentity hook.
const approvedPolicies = new WeakMap<LocalIdentityAdmission, (context: PipelineContext) => void>();
export function assertIdentityAdmissionContext(ctx: PipelineContext, policy: LocalIdentityAdmission): void {
  const guard = approvedPolicies.get(policy);
  if (!guard) return assertLocalAdmissionStore(ctx);
  guard(ctx);
}

export function assertApprovedIdentityTarget(ctx: PipelineContext, env: Readonly<Record<string, string | undefined>>): void {
  const ref = env.DISCOVERY_APPROVED_PROJECT_REF;
  if (!(ctx.store instanceof SupabaseStore) || ctx.llm !== null || ctx.treg !== null
    || env.DISCOVERY_EXECUTION_ENABLED !== "true" || env.DISCOVERY_AI_EXECUTION_ENABLED !== "true"
    || env.DISCOVERY_SINGLE_WRITER_CONFIRMED !== "true" || !/^[a-z0-9]{20}$/.test(ref ?? "")
    || env.DISCOVERY_SCHEMA_CONFIRMED !== "true"
    || env.PIPELINE_ALLOW_REMOTE !== ref || env.PIPELINE_SUPABASE_URL !== `https://${ref}.supabase.co`
    || ctx.store.databaseUrl !== env.PIPELINE_SUPABASE_URL
    || !/^[a-f0-9]{64}$/.test(env.DISCOVERY_APPROVED_MODEL_DIGEST ?? "")) {
    throw Error("Approved AI requires execution/schema confirmation, exact database target, single writer and pinned model revision");
  }
}

// Only collapse subdomains when the parent was itself observed and AI-confirmed.
// Never guess a registrable domain or equate differently named corporate hosts.
export function confirmedCorporateDomain(domains: Iterable<string>): string | null {
  const unique = [...new Set(domains)];
  return unique.find(parent => unique.every(domain => domain === parent || domain.endsWith(`.${parent}`))) ?? null;
}

type IdentityAdmissionOptions = {
  host: string; model: string; maxChecks: number;
  timeoutMs?: number;
  packets?: IdentityCase[];
  cachedResults?: IdentityResult[];
  save: (name: string, value: unknown) => void;
};

export async function localIdentityAdmission(ctx: PipelineContext, candidates: LocalAdmissionCandidate[], opts: IdentityAdmissionOptions): Promise<LocalIdentityAdmission> {
  return identityAdmission(ctx, candidates, opts, assertLocalAdmissionStore);
}

export async function approvedIdentityAdmission(ctx: PipelineContext, candidates: LocalAdmissionCandidate[], opts: IdentityAdmissionOptions, env: NodeJS.ProcessEnv): Promise<LocalIdentityAdmission> {
  const approval = Object.freeze(Object.fromEntries([
    "DISCOVERY_EXECUTION_ENABLED", "DISCOVERY_AI_EXECUTION_ENABLED", "DISCOVERY_SINGLE_WRITER_CONFIRMED",
    "DISCOVERY_APPROVED_PROJECT_REF", "DISCOVERY_APPROVED_MODEL_DIGEST", "PIPELINE_ALLOW_REMOTE", "PIPELINE_SUPABASE_URL",
    "DISCOVERY_SCHEMA_CONFIRMED",
  ].map(key => [key, env[key]])));
  assertApprovedIdentityTarget(ctx, approval);
  if (candidates.length > 1 || opts.maxChecks > 3) throw Error("Approved AI pilot permits one candidate and at most three model checks");
  const store = ctx.store as SupabaseStore;
  const guard = (context: PipelineContext) => {
    assertApprovedIdentityTarget(context, approval);
    if (context.store !== store) throw Error("Approved AI capability belongs to a different database store");
  };
  const policy = await identityAdmission(ctx, candidates, opts, guard, approval.DISCOVERY_APPROVED_MODEL_DIGEST);
  approvedPolicies.set(policy, guard);
  return policy;
}

async function identityAdmission(ctx: PipelineContext, candidates: LocalAdmissionCandidate[], opts: IdentityAdmissionOptions,
  guard: (context: PipelineContext) => void, approvedDigest?: string): Promise<LocalIdentityAdmission> {
  guard(ctx);
  assertLocalAdmissionUrl(opts.host);
  if (opts.model !== "qwen2.5:7b") throw Error("This experiment is pinned to qwen2.5:7b");
  if (!Number.isInteger(opts.maxChecks) || opts.maxChecks < 1 || opts.maxChecks > 100) throw Error("maxChecks must be 1–100");
  const timeoutMs = opts.timeoutMs ?? 120000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 240000) throw Error("Identity request timeout must be 1–240 seconds");
  const response = await ctx.fetch(`${opts.host.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error(`Ollama tags HTTP ${response.status}`);
  const tag = (await response.json()).models?.find((m: { name: string; digest: string }) => m.name === opts.model);
  if (!tag?.digest) throw Error("Install qwen2.5:7b in local Ollama before running admission");
  if (approvedDigest && tag.digest !== approvedDigest) throw Error("Local model revision does not match the approved revision");
  const llm = new OllamaProvider({ host: opts.host, model: opts.model, fetchImpl: ctx.fetch, timeoutMs, ...IDENTITY_MODEL_OPTIONS });
  const packets: IdentityCase[] = [], results: IdentityResult[] = [];
  const outcomes: { name: string; status: string; reason: string; domain: string | null }[] = [];
  let checks = 0, cacheHits = 0;
  const allowedNames = new Set(candidates.map(candidate => normalizeName(candidate.name)));
  const persist = () => {
    opts.save("identity-packets", packets);
    opts.save("identity-results", { mode: approvedDigest ? "approved_admission" : "local_admission", model: opts.model, model_revision: tag.digest, results });
    opts.save("identity-outcomes", outcomes);
    opts.save("identity-call-counts", { model_calls: checks, reused_answers: cacheHits });
  };
  persist();
  return {
    names: new Set(allowedNames),
    async resolve(context, name, sites, http, refs) {
      guard(context);
      const normalized = normalizeName(name), now = context.now().toISOString();
      const resolution: WebsiteResolution = { normalized_name: normalized, company_name: name, domain: null,
        status: "unresolved", reason: "no enabled exact Workday site discovered", input_signature: approvedDigest ? "approved-ai-admission" : "local-ai-admission",
        checked_at: now, next_check_at: now, evidence: { candidates: [], checks: [] } };
      const finish = (reason: string, domain: string | null = null) => {
        resolution.reason = reason; resolution.domain = domain; resolution.status = domain ? "confirmed" : "unresolved";
        outcomes.push({ name, status: resolution.status, reason, domain }); persist(); return resolution;
      };
      if (!allowedNames.has(normalized)) return finish("candidate outside identity admission scope");
      if (!sites.length) return finish(resolution.reason);
      // Existing admission RPCs link sites by normalized company name. Do not transfer an
      // unchecked sibling site (including disabled sites) to a newly admitted company.
      const allSites = (await context.store.workdaySites(false)).filter(s => s.normalized_name === normalized);
      if (allSites.some(s => !s.enabled) || sites.length > 3) return finish("manual site review required: disabled or more than three sibling sites");
      const source = context.store as SupabaseStore;
      const { data: captures, error } = await source.db.from("raw_captures").select("url,fetched_at")
        .eq("meta->>kind", "corporate_careers").eq("meta->>normalized_name", normalized).eq("http_status", 200)
        .gte("fetched_at", new Date(+context.now() - MAX_IDENTITY_AGE_MS).toISOString()).order("fetched_at", { ascending: false }).limit(10);
      if (error) throw Error(`corporate evidence candidates: ${error.message}`);
      const explicit = candidates.find(c => normalizeName(c.name) === normalized)?.corporate_urls ?? [];
      const reviews = await context.store.reviewItems("pending"), known = await context.store.companies();
      const domains = [...reviews.filter(r => r.normalized_name === normalized).map(r => r.candidate_domain),
        ...known.filter(c => normalizeName(c.name) === normalized).map(c => c.domain), ...refs.map(r => r.domain)].filter((d): d is string => !!d);
      const cached = await context.store.websiteResolution(normalized);
      const urls = [...explicit, ...(captures ?? []).map(c => c.url), ...(cached?.domain ? [`https://${cached.domain}/`] : []),
        ...corporateCandidates(name, domains, undefined)];
      const frozen = opts.packets?.filter(p => normalizeName(p.target_name) === normalized);
      const candidatesByUrl = [...new Set(frozen ? frozen.map(p => p.corporate_url) : urls)].filter(url => {
        try { const u = new URL(url); return u.protocol === "https:" && !u.username && !u.password && !u.port; } catch { return false; }
      }).slice(0, 3);
      const confirmed = new Set<string>();
      let incomplete = false;
      for (const corporateUrl of candidatesByUrl) {
        let domain: string | null = null, everySiteMatched = true;
        for (const site of sites) {
          if (checks >= opts.maxChecks) { incomplete = true; everySiteMatched = false; break; }
          const savedPacket = frozen?.find(p => p.corporate_url === corporateUrl && p.site.tenant === site.tenant && p.site.pod === site.pod && p.site.site === site.site);
          if (frozen && !savedPacket) { everySiteMatched = false; break; }
          const packet = savedPacket ?? await prepareIdentityCase(context, { id: `local-${normalized}-${packets.length + 1}`, target_name: name,
            corporate_url: corporateUrl, site: { tenant: site.tenant, pod: site.pod, site: site.site }, review_id: site.review_item_id }, http, { refreshJobs: true });
          packets.push(packet); persist(); // Freeze evidence on disk before inference.
          const cached = frozen && opts.cachedResults?.find(r => r.case_id === packet.id && reusableIdentity(r, packet, opts.model, tag.digest, context.now()));
          const result = cached || await verifyIdentity(packet, llm, tag.digest, context.now());
          if (cached) cacheHits++;
          else if (result.status !== "insufficient_input") checks++;
          results.push(result); persist();
          // When a consistency check held the model's verdict, show that reason rather than the model's own explanation.
          let detail = result.error ?? result.answer?.explanation ?? "";
          const held = result.answer?.consistency_holds ?? [];
          if (!result.error && held.length > 0) detail = `held: ${held.join("; ")}`;
          resolution.evidence.checks.push({ domain: normalizeDomain(packet.corporate_url) ?? "", url: packet.corporate_url,
            reason: `${result.status}: ${result.verdict}; ${detail}` });
          if (result.status !== "done" || result.verdict !== "same_company") { everySiteMatched = false; break; }
          const observed = normalizeDomain(packet.corporate_url);
          if (domain && domain !== observed) { everySiteMatched = false; break; }
          domain = observed;
        }
        if (everySiteMatched && domain) confirmed.add(domain);
      }
      if (incomplete) return finish("AI check limit reached; candidate remains held");
      const confirmedDomain = confirmedCorporateDomain(confirmed);
      if (confirmedDomain) return finish("AI confirmed the corporate identity against every observed enabled Workday site", confirmedDomain);
      if (confirmed.size > 1) return finish("multiple corporate domains matched; human review required");
      return finish("AI did not confirm: different company, uncertainty, missing input or model failure; see identity-results");
    },
  };
}
