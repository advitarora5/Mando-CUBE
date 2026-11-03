// Shared fakes for pipeline tests: fetch, model, treg, clock and a fixture-backed "world" of Workday tenants.
// Recorded responses live in tests/fixtures/ingestion (real Workday/SEC bodies, no secrets). Tenants other than
// nvidia/target are synthetic copies of the recorded bodies with the tenant name replaced; their names are fictional.
import { readFileSync } from 'node:fs';
import { MemoryStore } from '../../src/pipeline/store/memory.ts';
import { LedgerSpendGuard } from '../../src/pipeline/ledger.ts';

const F = new URL('../fixtures/ingestion/', import.meta.url);
export const fixture = name => readFileSync(new URL(name, F), 'utf8');
export const fixtureJson = name => JSON.parse(fixture(name));

export const silent = { info() {}, warn() {}, error() {} };

export function clock(iso = '2026-10-13T12:00:00Z') {
  let t = Date.parse(iso);
  const now = () => new Date(t);
  now.advanceDays = days => { t += days * 86400000; };
  now.set = value => { t = Date.parse(value); };
  return now;
}

const response = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers } });

// routes: [{ match: RegExp, method?: 'GET'|'POST', respond: (url, init) => Response | 'timeout' | 'network' }]
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, method: init.method ?? 'GET', body: init.body });
    const route = routes.find(r => r.match.test(href) && (!r.method || r.method === (init.method ?? 'GET')));
    if (!route) return response(404, '{"errorCode":"HTTP_404"}');
    const out = await route.respond(href, init);
    if (out === 'timeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (out === 'network') throw new TypeError('fetch failed');
    return out;
  };
  fn.calls = calls;
  return fn;
}
export { response };

// A fake LLMProvider. `reply(user)` returns the JSON the model would send, an { error } or a raw string.
export function fakeLLM(reply, opts = {}) {
  const calls = [];
  return {
    name: 'fake', model: opts.model ?? 'fake-model', worstCaseUsd: opts.worstCaseUsd ?? 0, calls,
    async complete(request) {
      calls.push(request.user);
      const out = await reply(request.user, calls.length);
      if (out && out.error) return { ok: false, error: out.error, cost_usd: 0, ms: 1 };
      if (typeof out === 'string') { try { return { ok: true, json: JSON.parse(out), raw: out, cost_usd: opts.costPerCall ?? 0, ms: 1 }; } catch { return { ok: false, error: 'model reply is not valid JSON', raw: out, cost_usd: opts.costPerCall ?? 0, ms: 1 }; } }
      return { ok: true, json: out, raw: JSON.stringify(out), cost_usd: opts.costPerCall ?? 0, ms: 1 };
    },
  };
}

// A model that copies the first sentence mentioning Workday as a hiring signal: grounded and deterministic.
export const groundedModel = () => fakeLLM(user => {
  const text = user.split('<<<\n')[1]?.split('\n>>>')[0] ?? '';
  const sentence = text.split(/(?<=[.!?])\s+|\n+/).find(s => /workday/i.test(s) && s.split(/\s+/).length >= 4);
  return { company_name: null, workday_products: /Workday/.test(text) ? ['Workday'] : [], project_type: /implement/i.test(text) ? 'implementation' : null, role_seniority: 'individual', timing_words: [], signals: sentence ? [{ type: 'hiring', quote: sentence.trim(), date_text: null }] : [] };
});

// handlers: { [endpoint]: (opts, n) => TregResult }
export function fakeTreg(handlers) {
  const calls = [];
  return {
    calls,
    async call(endpoint, opts = {}) {
      calls.push({ endpoint, opts });
      const handler = handlers[endpoint];
      if (!handler) return { ok: false, status: 404, error: `no fake for ${endpoint}`, cost_usd: 0 };
      return handler(opts, calls.filter(c => c.endpoint === endpoint).length);
    },
  };
}

export function spendGuard(caps = { treg: 0.5, llm: 0 }, now = clock()) {
  return new LedgerSpendGuard({ path: null, session: 'test', caps, log: silent, now });
}

export function makeCtx({ store, fetch, llm = null, treg = null, now = clock(), caps } = {}) {
  return { store: store ?? new MemoryStore({ now }), now, log: silent, fetch: fetch ?? fakeFetch([]), treg, llm, spend: spendGuard(caps, now), contact: 'test@example.com', sleep: async () => {}, runId: null };
}

// ---------- Fixture world ----------

export const WORLD_NAMES = [
  'Alder Robotics Inc', 'Birchway Logistics Corp', 'Cedarline Health Systems', 'Dunmore Foods Inc', 'Elmstead Energy Corp',
  'Fernhill Insurance Group', 'Glenrock Mining Ltd', 'Hollowell Retail Inc', 'Ironbark Chemicals Corp', 'Juniper Freight Co',
  'Kestrel Aerospace Inc', 'Larchmont Bancorp', 'Maplecrest Pharma Inc', 'Northwind Utilities Corp', 'Oakridge Media Holdings',
];
// Random pronounceable names, so integration runs on a shared local database never look "similar" to earlier runs.
export function randomNames(count, seed = Date.now()) {
  let x = seed % 2147483647 || 1;
  const rand = () => (x = (x * 48271) % 2147483647) / 2147483647;
  const syl = ['ba', 'ko', 'ri', 'zu', 'te', 'mo', 'la', 'vex', 'dar', 'qui', 'pol', 'sen', 'tor', 'gal', 'fin', 'yem', 'hu', 'wex', 'cor', 'nim'];
  const kinds = ['Robotics Inc', 'Logistics Corp', 'Health Systems', 'Foods Inc', 'Energy Corp', 'Insurance Group', 'Mining Ltd', 'Retail Inc', 'Chemicals Corp', 'Freight Co'];
  return Array.from({ length: count }, (_, i) => {
    // Six syllables: long enough that two runs' names are almost never "similar" (Dice < 0.8) in a shared local database.
    const word = Array.from({ length: 6 }, () => syl[Math.floor(rand() * syl.length)]).join('');
    return `${word[0].toUpperCase()}${word.slice(1)} ${kinds[i % kinds.length]}`;
  });
}

// Tenants that exist (by full-name guess); the last three resolve to nothing.
export const worldTenant = name => name.toLowerCase().replace(/\b(inc|corp|co|ltd|group|holdings)\b/g, '').replace(/[^a-z0-9]/g, '');

export function secFixture(names = WORLD_NAMES) {
  const rows = {};
  names.forEach((title, i) => { rows[i] = { cik_str: 1000 + i, ticker: `T${i}`, title }; });
  for (let i = names.length; i < 120; i++) rows[i] = { cik_str: 5000 + i, ticker: `Z${i}`, title: `Zz Filler Trust ${i}` };
  return JSON.stringify(rows);
}

export function worldFetch(opts = {}) {
  const names = opts.names ?? WORLD_NAMES;
  const existing = new Set(names.slice(0, opts.existingTenants ?? 12).map(worldTenant));
  const robots = fixture('workday-robots-nvidia.txt');
  const jobs = fixtureJson('workday-jobs-nvidia.json');
  const details = fixtureJson('workday-job-details-nvidia.json');
  const detailFor = path => details.find(d => d.url.endsWith(path)) ?? details[0];
  return fakeFetch([
    { match: /sec\.gov\/robots\.txt/, respond: () => response(200, 'User-agent: *\nDisallow: /search/\n') },
    { match: /sec\.gov\/files\/company_tickers\.json/, respond: () => opts.secDown ? response(503, 'down') : response(200, secFixture(names), { 'content-type': 'application/json' }) },
    { match: /^https:\/\/([a-z0-9]+)\.wd5\.myworkdayjobs\.com\/robots\.txt$/, respond: url => {
      const tenant = url.match(/https:\/\/([a-z0-9]+)\./)[1];
      return existing.has(tenant) ? response(200, robots.replaceAll('nvidia', tenant).replaceAll('NVIDIAExternalCareerSite', `${tenant}Careers`)) : response(422, '{"errorCode":"HTTP_422"}');
    } },
    { match: /myworkdayjobs\.com\/robots\.txt$/, respond: () => response(422, '{"errorCode":"HTTP_422"}') },
    { match: /\/wday\/cxs\/[a-z0-9]+\/[A-Za-z0-9]+\/jobs$/, method: 'POST', respond: () => opts.jobsDown ? response(503, 'unavailable') : response(200, jobs) },
    // Each tenant gets its own copy of the recorded posting (its own externalUrl), as a real career site would.
    { match: /\/wday\/cxs\/[a-z0-9]+\/[A-Za-z0-9]+\/job\//, respond: url => {
      const tenant = url.match(/https:\/\/([a-z0-9]+)\./)[1];
      const body = JSON.stringify(detailFor(url.slice(url.indexOf('/job/'))).body);
      return response(200, tenant === 'nvidia' ? body : body.replaceAll('nvidia.wd5', `${tenant}.wd5`).replaceAll('NVIDIAExternalCareerSite', `${tenant}Careers`));
    } },
  ]);
}

// Free domain finder: confirmed `<tenant>.example` for every name except those listed as unconfirmed.
export function worldTreg(opts = {}) {
  return fakeTreg({
    'hunter.x.domain-finder': ({ query }) => {
      const tenant = worldTenant(query.company);
      if (opts.unconfirmed?.includes(query.company)) return { ok: true, status: 200, body: { data: [{ domain: `other-${tenant}.example`, company_name: 'Somebody Else' }] }, cost_usd: 0, call_id: 'c' };
      return { ok: true, status: 200, body: { data: [{ domain: `${tenant}.example`, company_name: query.company.replace(/ (Inc|Corp|Co|Ltd|Group|Holdings)$/, '') }] }, cost_usd: 0, call_id: 'c' };
    },
    'quickenrich.people.search': () => ({ ok: true, status: 200, body: { data: [
      { first_name: 'Pat', last_name: 'Lee', title: 'Director, HRIS', employee_linkedin: 'https://www.linkedin.com/in/pat-lee-test' },
      { first_name: 'Sam', last_name: 'Ray', title: 'Plant Manager', employee_linkedin: 'https://www.linkedin.com/in/sam-ray-test' },
    ] }, cost_usd: 0, call_id: 'p' }),
    'treg.people.email.find': opts.emailFind ?? (() => ({ ok: true, status: 200, body: { output: { email: 'pat.lee@alderrobotics.example' }, _treg: { served_by: 'fake', verification: { verdict: 'valid', checked: true } } }, cost_usd: 0.006, call_id: 'e' })),
    ...(opts.extra ?? {}),
  });
}
