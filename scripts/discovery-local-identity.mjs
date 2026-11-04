import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeName } from '../src/domain/ingestion/normalize.ts';
import { guessDomains } from '../src/pipeline/website.ts';
import { assertLocalAdmissionUrl, assertLocalAdmissionStore, assertApprovedIdentityTarget, localIdentityAdmission, approvedIdentityAdmission } from '../src/pipeline/local-identity-admission.ts';
import { assertApprovedTarget } from './discovery-plan.mjs';

export function assertLocalIdentityMode({ execute, approved }, env) {
  if (!execute || approved || env.PIPELINE_ALLOW_REMOTE) throw Error('AI discovery is local-only');
  assertLocalAdmissionUrl(env.PIPELINE_SUPABASE_URL || '');
  const host = env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  assertLocalAdmissionUrl(host);
  if (env.OLLAMA_MODEL && env.OLLAMA_MODEL !== 'qwen2.5:7b') throw Error('Required model is qwen2.5:7b');
  return { host, model: 'qwen2.5:7b', maxChecks: 3, timeoutMs: 240000 };
}

export function assertApprovedIdentityMode({ execute, approved }, env) {
  if (!execute || !approved || env.DISCOVERY_AI_EXECUTION_ENABLED !== 'true' || env.DISCOVERY_SCHEMA_CONFIRMED !== 'true') throw Error('Approved AI execution or schema readiness is not confirmed');
  assertApprovedTarget(env);
  if (!/^[a-f0-9]{64}$/.test(env.DISCOVERY_APPROVED_MODEL_DIGEST || '')) throw Error('An approved local model revision is required');
  const host = env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  assertLocalAdmissionUrl(host);
  if (env.OLLAMA_MODEL && env.OLLAMA_MODEL !== 'qwen2.5:7b') throw Error('Required model is qwen2.5:7b');
  return { host, model: 'qwen2.5:7b', maxChecks: 3, timeoutMs: 240000 };
}

// First local pilot: one candidate, all enabled sibling sites checked by the
// existing identity policy. Human-only and rejected decisions remain protected.
export async function selectLocalIdentityCandidates(store, { retries = {}, now = Date.now() } = {}) {
  const [reviews, sites, signals] = await Promise.all([store.reviewItems(), store.workdaySites(false), store.unassignedSignals()]);
  const protectedNames = new Set(reviews.filter(r => r.status !== 'pending' || r.reason === 'similar_name').map(r => r.normalized_name));
  const eligible = new Set(sites.filter(site => site.enabled && !site.company_id && !sites.some(other => other.normalized_name === site.normalized_name && !other.enabled)).map(site => site.normalized_name));
  const ordered = [...reviews.filter(r => r.status === 'pending').sort((a, b) => a.created_at.localeCompare(b.created_at)).map(r => r.candidate_name),
    ...signals.map(signal => signal.company_name).filter(Boolean)];
  const signature = name => createHash('sha256').update(JSON.stringify({
    sites: sites.filter(s => s.normalized_name === normalizeName(name)).map(s => [s.id, s.capture_id, s.enabled, s.company_id]).sort(),
    // Assigning signals to a new review is bookkeeping, not new identity evidence.
    // Human decisions are protected above; only a new domain hypothesis changes this part.
    domains: [...new Set(reviews.filter(r => r.normalized_name === normalizeName(name)).map(r => r.candidate_domain).filter(Boolean))].sort(),
  })).digest('hex');
  const name = ordered.find(name => {
    const key = normalizeName(name), previous = retries[key];
    return eligible.has(key) && !protectedNames.has(key)
      && !(previous?.signature === signature(name) && previous.retry_after > now);
  });
  if (!name) return [];
  const slug = normalizeName(name).replace(/ /g, '');
  // Candidate hypotheses only: reuse the normal resolver's bounded .com/.org/.edu
  // guesses. Every page and Workday sibling still needs the full identity check.
  const corporate_urls = /^[a-z0-9-]{2,63}$/.test(slug) ? guessDomains(slug).slice(0, 3).map(domain => `https://${domain}/`) : [];
  return [{ name, corporate_urls, retry_signature: signature(name) }];
}

export async function prepareLocalDiscoveryIdentity(ctx, output, config, preflight = false, approvedEnv = null) {
  if (approvedEnv) assertApprovedIdentityTarget(ctx, approvedEnv);
  else assertLocalAdmissionStore(ctx);
  const retryPath = resolve('var/discovery/identity-retries.json');
  const targetKey = createHash('sha256').update(ctx.store.databaseUrl).digest('hex');
  let retryState = {};
  if (!preflight) {
    try { retryState = JSON.parse(readFileSync(retryPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw Error('Identity retry state unreadable; inspect before execution'); }
  }
  const candidates = preflight ? [] : await selectLocalIdentityCandidates(ctx.store, { retries: retryState[targetKey] ?? {}, now: +ctx.now() });
  const directory = join(output, 'identity');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const options = { ...config,
    save: (name, value) => {
      if (!['identity-packets', 'identity-results', 'identity-outcomes', 'identity-call-counts'].includes(name)) throw Error('Unexpected identity artifact');
      writeFileSync(join(directory, `${name}.json`), JSON.stringify(value, null, 2), { mode: 0o600 });
      if (!preflight && name === 'identity-outcomes' && value.length) {
        const records = retryState[targetKey] ?? {};
        for (const outcome of value) {
          const key = normalizeName(outcome.name), candidate = candidates.find(c => normalizeName(c.name) === key);
          if (!candidate) continue;
          if (outcome.status === 'confirmed') delete records[key];
          else records[key] = { signature: candidate.retry_signature, retry_after: +ctx.now() + 60 * 60 * 1000 };
        }
        // Expired records need not accumulate as the company list grows.
        retryState[targetKey] = Object.fromEntries(Object.entries(records).filter(([, r]) => r.retry_after > +ctx.now()));
        mkdirSync(resolve('var/discovery'), { recursive: true });
        writeFileSync(`${retryPath}.tmp`, JSON.stringify(retryState), { mode: 0o600 });
        renameSync(`${retryPath}.tmp`, retryPath);
      }
    } };
  return approvedEnv ? approvedIdentityAdmission(ctx, candidates, options, approvedEnv) : localIdentityAdmission(ctx, candidates, options);
}
