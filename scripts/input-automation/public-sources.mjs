import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Retain the existing standalone collector commands as preview-only entry points.
export async function previewCLI(moduleUrl, inputName, collect) {
  if (!process.argv[1] || moduleUrl !== pathToFileURL(process.argv[1]).href) return;
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i++) {
      const flag = process.argv[i];
      if (![ `--${inputName}`, '--out' ].includes(flag) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) {
        throw new Error(`Usage: node ${process.argv[1]} --${inputName} FILE [--out FILE]`);
      }
      args[flag.slice(2)] = process.argv[++i];
    }
    if (!args[inputName]) throw new Error(`--${inputName} FILE is required`);
    if (args.out && resolve(args.out) === resolve(args[inputName])) throw new Error('Output must not overwrite input');
    const input = JSON.parse(await readFile(args[inputName], 'utf8'));
    const list = Array.isArray(input) ? input : input[inputName];
    if (!Array.isArray(list)) throw new Error(`Input must be an array or { ${inputName}: [...] }`);
    const result = await collect(list);
    const json = JSON.stringify(result, null, 2) + '\n';
    if (args.out) await writeFile(args.out, json);
    console.log(json.trimEnd());
    console.error('Preview only: no database writes or scores assigned. Review source evidence before use.');
    const rows = Array.isArray(result) ? result : result.checks;
    if (rows.some(r => ['unreachable', 'discovery_failed'].includes(r.date_type) || r.status === 'unknown')) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

export function publicUrl(value) {
  const u = new URL(value);
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') ||
      isIP(host.replace(/[\[\]]/g, '')) || !host.includes('.') ||
      /(^|\.)(localhost|local|internal|linkedin\.com|lnkd\.in)$/.test(host)) {
    throw new Error('Only public HTTPS sources are allowed; LinkedIn is excluded');
  }
  u.hash = '';
  return u.href;
}

// Report bounded, non-sensitive diagnostics rather than response bodies or keys.
export function sourceFailure(error) {
  const code = error?.cause?.code ?? error?.code;
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return { failure_kind: 'dns', failure_detail: 'Source hostname could not be resolved.' };
  if (['TimeoutError', 'AbortError'].includes(error?.name)) return { failure_kind: 'timeout', failure_detail: 'Source timed out.' };
  const http = /^HTTP (\d{3})$/.exec(error?.message ?? '');
  if (http) return { failure_kind: 'http', failure_detail: `Source returned HTTP ${http[1]}.` };
  if (error instanceof SyntaxError) return { failure_kind: 'invalid_response', failure_detail: 'Source returned malformed data.' };
  return { failure_kind: 'unavailable_or_invalid', failure_detail: 'Source request or validation failed; review the public URL.' };
}

function privateAddress(address) {
  if (isIP(address) === 6) return !/^2[0-9a-f]{3}:/i.test(address) || /^2001:db8:/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 168].includes(b)) || (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && [18, 19].includes(b));
}

// Manual redirects validate every destination. API credentials never follow redirects.
export async function request(url, { fetchImpl = fetch, headers = {}, maxBytes = 2_000_000, method = 'GET', body } = {}) {
  let current = publicUrl(url);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (fetchImpl === fetch) {
      const addresses = await lookup(new URL(current).hostname, { all: true });
      if (!addresses.length || addresses.some(a => privateAddress(a.address))) throw new Error('Non-public source address');
    }
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetchImpl(current, { method, body, redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { 'user-agent': 'Mando-CUBE-public-inputs/1.0', ...headers } });
      if (![429, 502, 503, 504].includes(response.status) || attempt === 2) break;
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
    if (response.status >= 300 && response.status < 400) {
      if (Object.keys(headers).length) throw new Error('Authenticated request redirect refused');
      const location = response.headers.get('location');
      await response.body?.cancel();
      current = publicUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    if (Number(response.headers?.get('content-length')) > maxBytes) {
      await response.body?.cancel(); throw new Error('Source response too large');
    }
    let text = '';
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) { await reader.cancel(); throw new Error('Source response too large'); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } else {
      text = await response.text();
      if (Buffer.byteLength(text) > maxBytes) throw new Error('Source response too large');
    }
    return { text, url: current };
  }
  throw new Error('Too many source redirects');
}

export function plainText(html) {
  return String(html).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(?:p|div|li|h[1-6]|section)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|#160);/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'")
    .replace(/[ \t\r]+/g, ' ').trim();
}

export function links(html, base) {
  const result = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try { result.push({ url: publicUrl(new URL(m[1].replaceAll('&amp;', '&'), base).href), label: plainText(m[2]) }); }
    catch { /* unsupported/private links are never fetched */ }
  }
  return result;
}

export async function search(query, { key = process.env.BRAVE_SEARCH_API_KEY, fetchImpl = fetch } = {}) {
  if (!key) return [];
  const { text } = await request(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
    { fetchImpl, headers: { 'X-Subscription-Token': key, Accept: 'application/json' } });
  const payload = JSON.parse(text);
  if (!Array.isArray(payload.web?.results)) throw new Error('Unexpected search response');
  return payload.web.results.flatMap(r => {
    try { return [{ url: publicUrl(r.url), title: r.title }]; } catch { return []; }
  });
}

export function ownedHost(url, company) {
  if (!company.domain) return false;
  const domain = new URL(company.domain.includes('://') ? company.domain : `https://${company.domain}`).hostname.replace(/^www\./, '');
  const host = new URL(url).hostname;
  return host === domain || host.endsWith(`.${domain}`);
}

export function sourceTrusted(url, company, config = {}) {
  const host = new URL(url).hostname;
  return host === 'workday.com' || host.endsWith('.workday.com') || ownedHost(url, company) ||
    (config.trusted_hosts ?? []).includes(host);
}
