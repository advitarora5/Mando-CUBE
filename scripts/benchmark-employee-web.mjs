// Public-source coverage benchmark. No database, LLM or search credentials; optional recorded URL discovery.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { researchEmployeeWebsite } from '../src/pipeline/employee-web-research.ts';
const discovery = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], "utf8")) : null;
const companies = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(companies) || companies.length > 30) throw new Error('Provide an array of at most 30 company names and domains.');
const dns = new Map();
async function lookupHost(host) {
  if (process.env.EMPLOYEE_BENCHMARK_DOH !== '1') return lookup(host, { all: true });
  if (!dns.has(host)) dns.set(host, (async () => {
    const result = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000),
    });
    if (!result.ok) throw new Error('Public DNS lookup failed.');
    const payload = await result.json();
    return (payload.Answer ?? []).filter(row => row.type === 1 && isIP(row.data) === 4)
      .map(row => ({ address: row.data, family: 4 }));
  })());
  return dns.get(host);
}
const results = [];
for (const company of companies) {
  const now = () => new Date(process.env.EMPLOYEE_BENCHMARK_NOW ?? Date.now());
  const ctx = { now, lookupHost, fetch: globalThis.fetch.bind(globalThis), contact: '', treg: discovery ? { call: async () => ({ ok: true, status: 200, cost_usd: 0, body: { results: (discovery[company.domain] ?? []).map(url => ({ url })) } }) } : null,
    log: { info() {}, warn() {}, error() {} }, spend: { spent: () => 0, record: async () => {}, allow: async () => false },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), runId: null };
  const result = await researchEmployeeWebsite(ctx, { ...company, id: company.domain });
  results.push({ ...company, ...result });
  console.error(`${company.name}: ${result.status} (${result.requests} requests)`);
}
console.log(JSON.stringify({ checked_at: new Date().toISOString(), mode: discovery ? 'recorded_search_URLs_with_live_document_fetch' : 'direct_official_sites_no_search_provider', dns: process.env.EMPLOYEE_BENCHMARK_DOH === '1' ? 'cloudflare_https_actual_A_records' : 'system',
  database_accessed: false, companies: results.length, found: results.filter(row => row.evidence).length, results }, null, 2));
