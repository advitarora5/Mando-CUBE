import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeName } from '../src/domain/ingestion/normalize.ts';
import { guessDomains } from '../src/pipeline/website.ts';
import { assertLocalAdmissionUrl, assertLocalAdmissionStore, localIdentityAdmission } from '../src/pipeline/local-identity-admission.ts';

export function assertLocalIdentityMode({ execute, approved }, env) {
  if (!execute || approved || env.PIPELINE_ALLOW_REMOTE) throw Error('AI discovery is local-only');
  assertLocalAdmissionUrl(env.PIPELINE_SUPABASE_URL || '');
  const host = env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  assertLocalAdmissionUrl(host);
  if (env.OLLAMA_MODEL && env.OLLAMA_MODEL !== 'qwen2.5:7b') throw Error('Required model is qwen2.5:7b');
  return { host, model: 'qwen2.5:7b', maxChecks: 3, timeoutMs: 240000 };
}

// First local pilot: one candidate, all enabled sibling sites checked by the
// existing identity policy. Human-only and rejected decisions remain protected.
export async function selectLocalIdentityCandidates(store) {
  const [reviews, sites, signals] = await Promise.all([store.reviewItems(), store.workdaySites(false), store.unassignedSignals()]);
  const protectedNames = new Set(reviews.filter(r => r.status !== 'pending' || r.reason === 'similar_name').map(r => r.normalized_name));
  const eligible = new Set(sites.filter(site => site.enabled && !site.company_id && !sites.some(other => other.normalized_name === site.normalized_name && !other.enabled)).map(site => site.normalized_name));
  const ordered = [...reviews.filter(r => r.status === 'pending').sort((a, b) => a.created_at.localeCompare(b.created_at)).map(r => r.candidate_name),
    ...signals.map(signal => signal.company_name).filter(Boolean)];
  const name = ordered.find(name => eligible.has(normalizeName(name)) && !protectedNames.has(normalizeName(name)));
  if (!name) return [];
  const slug = normalizeName(name).replace(/ /g, '');
  // Candidate hypotheses only: reuse the normal resolver's bounded .com/.org/.edu
  // guesses. Every page and Workday sibling still needs the full identity check.
  const corporate_urls = /^[a-z0-9-]{2,63}$/.test(slug) ? guessDomains(slug).slice(0, 3).map(domain => `https://${domain}/`) : [];
  return [{ name, corporate_urls }];
}

export async function prepareLocalDiscoveryIdentity(ctx, output, config, preflight = false) {
  assertLocalAdmissionStore(ctx);
  const candidates = preflight ? [] : await selectLocalIdentityCandidates(ctx.store);
  const directory = join(output, 'identity');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return localIdentityAdmission(ctx, candidates, { ...config,
    save: (name, value) => {
      if (!['identity-packets', 'identity-results', 'identity-outcomes', 'identity-call-counts'].includes(name)) throw Error('Unexpected identity artifact');
      writeFileSync(join(directory, `${name}.json`), JSON.stringify(value, null, 2), { mode: 0o600 });
    } });
}
