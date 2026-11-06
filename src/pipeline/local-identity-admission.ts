// Guarded identity admission. Explicit local/approved entry points create capabilities.
// It never writes website_resolutions: AI proof must not populate the direct-link cache.
import { SupabaseStore } from "./store/supabase.ts";
import { normalizeDomain, normalizeName } from "../domain/ingestion/normalize.ts";
import { corporateCandidates } from "./collectors/corporate-careers.ts";
import { prepareIdentityCase } from "./identity-evidence.ts";
import { IDENTITY_MODEL_OPTIONS, MAX_IDENTITY_AGE_MS, reusableIdentity, sourceIdentityGroups, verifyIdentity, type IdentityCase, type IdentityResult } from "./identity.ts";
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

// Evidence-derived URLs are candidate hypotheses, never proof of identity.
// Posting links often point elsewhere (eeoc.gov, cnn.com, urldefense.com), so within the three-URL bound the order is:
// observed URLs that carry the company's name, .com guesses, other observed URLs, then other guesses.
const hostCarriesName = (url: string, nameTerms: string[]) => {
  if (!nameTerms.length) return true;
  const host = new URL(url).hostname.toLowerCase(), labels = host.split(".");
  // Short terms must be a whole label: "ing" is not in marketing.com.
  return nameTerms.some(term => term.length >= 4 ? host.includes(term) : labels.includes(term));
};
// A careers host says where the company's real site probably is: jobs.thecignagroup.com points to thecignagroup.com,
// search-careers.gm.com to gm.com. The parent is only another hypothesis, and goes through the same identity check.
const CAREERS_LABEL = /^(jobs?|careers?|search-careers|workday|talent|apply|recruit(ing)?|hiring)$/i;
const careersParent = (url: string) => {
  const labels = new URL(url).hostname.split(".");
  return labels.length >= 3 && CAREERS_LABEL.test(labels[0]) ? `https://${labels.slice(1).join(".")}/` : null;
};
export function identityCorporateUrls(evidenceUrls: string[], guessedUrls: string[], nameTerms: string[] = []): string[] {
  const safe = (url: string) => {
    try { const u = new URL(url); return u.protocol === "https:" && !u.username && !u.password && !u.port; } catch { return false; }
  };
  const named = (url: string) => hostCarriesName(url, nameTerms);
  const isCom = (url: string) => new URL(url).hostname.endsWith(".com");
  const evidence = evidenceUrls.filter(safe).flatMap(url => { const parent = careersParent(url); return parent ? [url, parent] : [url]; }), guesses = guessedUrls.filter(safe);
  return [...new Set([...evidence.filter(named), ...guesses.filter(isCom), ...evidence.filter(url => !named(url)), ...guesses.filter(url => !isCom(url))])].slice(0, 3);
}

// The name a guessed host stands for, and whether that name's .com answered. A company whose .com exists does not
// also live on a same-name .org: when cadence.com blocks us, cadence.org is a namesake, not a fallback.
const hostLabel = (url: string) => new URL(url).hostname.split(".").at(-2) ?? "";
const dnsMiss = (packet: IdentityCase) => packet.errors.some(error => /ENOTFOUND/.test(error));
// A guess at a charity or college domain says nothing about a company with a legal form in its name, and the model can be
// persuaded by one shared word (it accepted cadence.org for Cadence Design Systems). Such a pair stays with human review.
// Sites actually observed in the evidence, and names without a legal form (Allina Health at allinahealth.org), still count.
const LEGAL_FORM = /\b(inc|incorporated|corp|corporation|plc|llc|ltd|limited|co|company|nv|ag|sa|se|asa|ab|lp|holdings?)\b/i;
export const namesakeGuess = (url: string, name: string) => /\.(org|edu|gov|mil)$/i.test(new URL(url).hostname) && LEGAL_FORM.test(name);

// With a site confirmed, only two checks can still change the answer: the parent of a confirmed careers subdomain,
// and another observed site carrying the company's name, which would make the company ambiguous.
function worthCheckingAfterConfirmation(url: string, confirmed: Set<string>, observed: boolean, nameTerms: string[]): boolean {
  const host = normalizeDomain(url) ?? "";
  if ([...confirmed].some(domain => domain.endsWith(`.${host}`))) return true;
  if ([...confirmed].some(domain => host === domain || host.endsWith(`.${domain}`))) return false;
  return observed && hostCarriesName(url, nameTerms);
}

// A first_word site came from guessing a tenant from one word of the name, and the model only
// compares the corporate site with the Workday site: emerson.edu and the "emerson" tenant can truly
// match while saying nothing about Emerson Electric. So the corporate page must carry the target's own name.
// The Workday side does not count: Cadence Design Systems' postings say nothing about whether cadence.org is theirs.
// Compared as whole words, joined so a slug ("lamresearch") still matches "Lam Research".
// A dotted legal form ("N.V.") normalizes to separate letters, which no page writes joined to the name.
const DOTTED_LEGAL_FORM = /\s*,?\s*\b(?:n\.\s?v|s\.\s?a|a\.\s?g|s\.\s?e|b\.\s?v|p\.\s?l\.\s?c|l\.\s?l\.\s?c|l\.\s?p)\.?\s*(?:\/[a-z]{2,3}\/?)?\s*$/i;
export function targetNameWritten(packet: IdentityCase, target: string): boolean {
  const wanted = normalizeName(target.replace(DOTTED_LEGAL_FORM, "")).replace(/ /g, "");
  if (!wanted) return false;
  const text = packet.sources.filter(source => source.side === "corporate")
    .flatMap(source => [source.text, ...sourceIdentityGroups(source).flatMap(group => group.names.map(name => name.value))]).join("\n");
  const words = normalizeName(text).split(" ");
  return words.some((_, start) => {
    let joined = "";
    for (let at = start; at < words.length && joined.length < wanted.length; at++) joined += words[at];
    return joined === wanted;
  });
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
      const observedUrls = [...refs.map(r => `https://${r.domain}/`), ...(captures ?? []).map(c => c.url),
        ...domains.map(domain => `https://${domain}/`), ...(cached?.domain ? [`https://${cached.domain}/`] : [])];
      const nameTerms = [...new Set([...sites.map(site => site.tenant), normalized.replace(/ /g, ""), ...normalized.split(" ").filter(word => word.length >= 3)])];
      const urls = identityCorporateUrls(observedUrls, [...explicit, ...corporateCandidates(name, domains, undefined)], nameTerms);
      const frozen = opts.packets?.filter(p => normalizeName(p.target_name) === normalized);
      const candidatesByUrl = [...new Set(frozen ? frozen.map(p => p.corporate_url) : urls)].filter(url => {
        try { const u = new URL(url); return u.protocol === "https:" && !u.username && !u.password && !u.port; } catch { return false; }
      }).slice(0, 3);
      const confirmed = new Set<string>();
      let incomplete = false, nameUnverified = false;
      const comAnswered = new Set<string>(), matchedWithoutName = new Set<string>();
      for (const corporateUrl of candidatesByUrl) {
        if (!frozen) {
          const observed = observedUrls.includes(corporateUrl);
          if (confirmed.size && !worthCheckingAfterConfirmation(corporateUrl, confirmed, observed, nameTerms)) continue;
          if (!observed && !new URL(corporateUrl).hostname.endsWith(".com") && comAnswered.has(hostLabel(corporateUrl))) continue;
          if (!observed && namesakeGuess(corporateUrl, name)) continue;
        }
        let domain: string | null = null, everySiteMatched = true;
        for (const site of sites) {
          if (checks >= opts.maxChecks) { incomplete = true; everySiteMatched = false; break; }
          const savedPacket = frozen?.find(p => p.corporate_url === corporateUrl && p.site.tenant === site.tenant && p.site.pod === site.pod && p.site.site === site.site);
          if (frozen && !savedPacket) { everySiteMatched = false; break; }
          const packet = savedPacket ?? await prepareIdentityCase(context, { id: `local-${normalized}-${packets.length + 1}`, target_name: name,
            corporate_url: corporateUrl, site: { tenant: site.tenant, pod: site.pod, site: site.site }, review_id: site.review_item_id }, http, { refreshJobs: true });
          packets.push(packet); persist(); // Freeze evidence on disk before inference.
          if (new URL(corporateUrl).hostname.endsWith(".com") && !dnsMiss(packet)) comAnswered.add(hostLabel(corporateUrl));
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
          if (site.match_kind === "first_word" && !targetNameWritten(packet, name)) {
            nameUnverified = true; everySiteMatched = false;
            const matched = normalizeDomain(packet.corporate_url);
            if (matched) matchedWithoutName.add(matched);
            break;
          }
          const observed = normalizeDomain(packet.corporate_url);
          if (domain && domain !== observed) { everySiteMatched = false; break; }
          domain = observed;
        }
        if (everySiteMatched && domain) confirmed.add(domain);
      }
      // A domain already confirmed against every site stands even if the budget ran out on a later candidate URL.
      // The owner of a parent domain controls its subdomains. So when careers.manulife.com carries the full name and
      // manulife.com matched but does not spell it out, the name check on the subdomain also answers for its exact parent.
      const confirmedDomain = confirmedCorporateDomain(confirmed);
      if (confirmedDomain) {
        const parent = confirmedDomain.slice(confirmedDomain.indexOf(".") + 1);
        return finish("AI confirmed the corporate identity against every observed enabled Workday site", matchedWithoutName.has(parent) ? parent : confirmedDomain);
      }
      if (confirmed.size > 1) return finish("multiple corporate domains matched; human review required");
      if (incomplete) return finish("AI check limit reached; candidate remains held");
      if (nameUnverified) return finish("corporate and Workday sites match, but the candidate's name is a first-word guess not written in their evidence; human review required");
      return finish("AI did not confirm: different company, uncertainty, missing input or model failure; see identity-results");
    },
  };
}
