// Extends the Greenhouse/Lever collector from krish/input-automation.
import { links, ownedHost, plainText, previewCLI, publicUrl, request, search, sourceFailure } from './input-automation/public-sources.mjs';

export function boardFromUrl(value) {
  const u = new URL(publicUrl(value));
  const wd = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/.exec(u.hostname);
  if (wd) {
    const parts = u.pathname.split('/').filter(Boolean);
    const siteIndex = /^[a-z]{2}-[a-z]{2}$/i.test(parts[0] ?? '') ? 1 : 0;
    const site = parts[siteIndex];
    if (site && /^[\w-]+$/.test(site)) return { board: 'workday', board_token: wd[1], site,
      board_url: `${u.origin}/${parts.slice(0, siteIndex + 1).join('/')}` };
    return null;
  }
  const token = u.pathname.split('/').filter(Boolean)[0];
  if (!token || !/^[\w-]+$/.test(token)) return null;
  if (['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(u.hostname)) return { board: 'greenhouse', board_token: token, region: 'global' };
  if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(u.hostname)) return { board: 'lever', board_token: token, region: u.hostname.includes('.eu.') ? 'eu' : 'global' };
  return null;
}

async function collectWorkday(entry, fetchImpl, now, boardKey) {
  const page = await request(entry.board_url, { fetchImpl });
  const observed = boardFromUrl(page.url);
  const tenant = /\btenant:\s*["']([\w-]+)["']/.exec(page.text)?.[1];
  const site = /\bsiteId:\s*["']([\w-]+)["']/.exec(page.text)?.[1];
  if (observed?.board !== 'workday' || tenant !== entry.board_token || site !== entry.site) throw new Error('Career page configuration changed');
  // The public site's anonymous CXS frontend feed, not a supported tenant API.
  // Derive its identifiers from the actual employer-linked page, never a guess.
  const origin = new URL(page.url).origin;
  const api = `${origin}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const postings = [];
  let expectedTotal;
  for (let offset = 0; offset < 1000; offset += 20) {
    const payload = JSON.parse((await request(`${api}/jobs`, { fetchImpl, method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 20, offset, searchText: 'Workday', appliedFacets: {} }) })).text);
    if (!Number.isInteger(payload.total) || payload.total < 0 || !Array.isArray(payload.jobPostings) ||
        payload.jobPostings.some(j => typeof j.externalPath !== 'string' || !j.externalPath.startsWith('/job/'))) throw new Error('Invalid Workday feed');
    expectedTotal ??= payload.total;
    if (payload.total !== expectedTotal) throw new Error('Workday feed changed during pagination');
    postings.push(...payload.jobPostings);
    if (postings.length === payload.total) break;
    if (!payload.jobPostings.length || postings.length > payload.total || offset >= 980) throw new Error('Incomplete Workday feed');
  }
  const jobs = [];
  for (const posting of postings) {
    const detailUrl = new URL(`${api}${posting.externalPath}`);
    if (detailUrl.origin !== origin || !detailUrl.pathname.startsWith(`/wday/cxs/${tenant}/${site}/job/`)) throw new Error('Invalid posting path');
    const info = JSON.parse((await request(detailUrl.href, { fetchImpl })).text).jobPostingInfo;
    if (!info?.title || !info.jobDescription || !info.externalUrl || !info.jobReqId) throw new Error('Incomplete Workday job detail');
    const url = publicUrl(info.externalUrl);
    if (new URL(url).origin !== origin || boardFromUrl(url)?.site !== site) throw new Error('Unexpected posting host/site');
    const match = relevance(info.title, info.jobDescription);
    if (!match) continue;
    jobs.push({ company_id: entry.company_id, employer: entry.company, title: plainText(info.title), posting_url: url,
      posting_id: String(info.jobReqId), requisition: String(info.jobReqId), board_key: boardKey,
      source: 'workday_public_careers', location: info.location ?? null, checked_at: now.toISOString(),
      status: info.posted === true && info.canApply === true ? 'active' : 'unknown',
      relevance: match.relevance, excerpt: match.excerpt, evidence: `${url} | ${match.evidence}`,
      mapping_evidence: entry.mapping_evidence ?? entry.board_url });
  }
  return { jobs, check: { company_id: entry.company_id, board_key: boardKey, status: 'ok',
    checked_at: now.toISOString(), posting_ids: jobs.map(j => j.posting_id), complete_inventory: false, source_url: page.url } };
}

export function relevance(title, description) {
  const text = plainText(`${title}. ${description}`);
  const at = text.search(/\bworkday\b/i);
  if (at < 0) return null;
  const excerpt = text.slice(Math.max(0, at - 120), at + 350).replace(/\s+/g, ' ');
  const consulting = /\b(consultant|consulting|client implementations|our clients)\b/i.test(text);
  const relevant = /\b(workday|hris|hcm)\b/i.test(title) || /\b(administer|configure|maintain|support|manage|implement|integrat\w*|hris|hcm|business processes)\b/i.test(excerpt);
  return { excerpt, relevance: consulting ? 'consulting_review' : relevant ? 'workday_role_review' : 'incidental_review',
    evidence: `Workday mentioned in ${consulting ? 'a potential consulting role' : 'the role'}; confirm internal employer scope. ${excerpt}` };
}

async function loadBoard(entry, fetchImpl) {
  const token = encodeURIComponent(entry.board_token);
  const api = entry.board === 'greenhouse' ? `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true` :
    `https://api${entry.region === 'eu' ? '.eu' : ''}.lever.co/v0/postings/${token}?mode=json`;
  const jobs = [];
  for (let page = 0; page < 50; page++) {
    const url = entry.board === 'lever' ? `${api}&limit=100&skip=${page * 100}` : api;
    const payload = JSON.parse((await request(url, { fetchImpl, maxBytes: 10_000_000 })).text);
    const batch = entry.board === 'greenhouse' ? payload.jobs : payload;
    if (!Array.isArray(batch) || batch.some(j => !j || j.id == null)) throw new Error('Invalid job-board payload');
    if (entry.board === 'greenhouse' && payload.meta?.total != null && payload.meta.total !== batch.length) throw new Error('Incomplete board response');
    jobs.push(...batch);
    if (entry.board === 'greenhouse' || batch.length < 100) return { jobs, api };
  }
  throw new Error('Board exceeds pagination limit; refresh is incomplete');
}

export async function collectJobPostings(boards, { fetchImpl = fetch, now = new Date() } = {}) {
  const jobs = [], checks = [];
  for (const entry of boards) {
    const boardKey = `${entry.company_id}:${entry.board}:${entry.region ?? 'global'}:${entry.board_token}${entry.board === 'workday' ? `:${entry.site}` : ''}`;
    try {
      if (!entry.company_id || !['greenhouse', 'lever', 'workday'].includes(entry.board) || !/^[\w-]+$/.test(entry.board_token)) throw new Error('Invalid board mapping');
      if (entry.board === 'workday') {
        const result = await collectWorkday(entry, fetchImpl, now, boardKey);
        jobs.push(...result.jobs); checks.push(result.check); continue;
      }
      const result = await loadBoard(entry, fetchImpl);
      const normalized = [];
      for (const job of result.jobs) {
        const title = job.title ?? job.text;
        const description = entry.board === 'greenhouse' ? job.content :
          [job.descriptionPlain ?? job.description, ...(job.lists ?? []).map(l => `${l.text} ${l.content}`)].join(' ');
        const match = relevance(title ?? '', description ?? '');
        if (!match) continue;
        if (typeof title !== 'string' || !title.trim()) throw new Error('Posting lacks title');
        const url = publicUrl(job.absolute_url ?? job.hostedUrl);
        normalized.push({ company_id: entry.company_id, employer: entry.company, title: plainText(title),
          posting_url: url, requisition: job.requisition_id == null ? null : String(job.requisition_id),
          posting_id: String(job.id), board_key: boardKey, source: entry.board,
          location: job.location?.name ?? job.categories?.location ?? null, checked_at: now.toISOString(),
          status: 'active', excerpt: match.excerpt, relevance: match.relevance,
          evidence: `${url} | ${match.evidence}`, mapping_evidence: entry.mapping_evidence ?? 'Explicitly configured employer board' });
      }
      jobs.push(...normalized);
      checks.push({ company_id: entry.company_id, board_key: boardKey, status: 'ok', checked_at: now.toISOString(),
        posting_ids: result.jobs.map(j => String(j.id)), complete_inventory: true, source_url: result.api });
    } catch (error) {
      checks.push({ company_id: entry.company_id, board_key: boardKey, status: 'unknown', checked_at: now.toISOString(), reason: 'Board refresh failed or incomplete; do not infer expiration.', ...sourceFailure(error) });
    }
  }
  return { jobs, checks };
}

export async function discoverBoards(company, config = {}, { fetchImpl = fetch, key, now = new Date() } = {}) {
  let domainEvidence = null;
  if (!company.domain && config.employer_domain) {
    company = { ...company, domain: new URL(publicUrl(`https://${config.employer_domain}`)).hostname };
    domainEvidence = 'Explicitly reviewed employer_domain configuration';
  }
  if (!company.domain && company.source) {
    try {
      const story = await request(company.source, { fetchImpl });
      const host = new URL(story.url).hostname;
      if ((host === 'workday.com' || host.endsWith('.workday.com')) && new URL(story.url).pathname.includes('/customer-stories/')) {
        const domain = employerDomainFromStory(story.text, story.url, company.name);
        if (domain) { company = { ...company, domain }; domainEvidence = story.url; }
      }
    } catch { /* Without a verified domain, search results remain mapping leads. */ }
  }
  const boards = (config.boards ?? []).map(b => ({ ...b, company_id: company.id, company: company.name }));
  const pages = new Set(config.career_urls ?? []), leads = [], employerJobs = [];
  if (company.domain) {
    try { pages.add(publicUrl(company.domain.includes('://') ? company.domain : `https://${company.domain}`)); } catch { /* report missing below */ }
  }
  try {
    for (const r of await search(`"${company.name}" careers jobs -site:linkedin.com`, { key, fetchImpl })) {
      if (ownedHost(r.url, company)) pages.add(r.url);
      else leads.push({ ...r, status: 'employer_mapping_review' });
    }
  } catch (error) { leads.push({ status: 'discovery_failed', reason: 'Career search failed', ...sourceFailure(error) }); }
  const visited = new Set();
  for (const url of pages) {
    if (visited.size >= 6) break;
    visited.add(url);
    try {
      const page = await request(url, { fetchImpl });
      const approved = ownedHost(page.url, company) || (config.career_urls ?? []).includes(page.url);
      if (approved) employerJobs.push(...structuredPostings(page.text, page.url, company, now));
      const directBoard = boardFromUrl(page.url);
      if ((approved || ownedHost(url, company)) && directBoard) boards.push({ ...directBoard, company_id: company.id, company: company.name, mapping_evidence: url });
      for (const link of links(page.text, page.url)) {
        const board = boardFromUrl(link.url);
        if (approved && board) boards.push({ ...board, company_id: company.id, company: company.name, mapping_evidence: page.url });
        else if (approved && ownedHost(link.url, company) && /career|jobs|vacanc/i.test(`${link.url} ${link.label}`)) pages.add(link.url);
        else if (/myworkdayjobs\.com$/.test(new URL(link.url).hostname)) leads.push({ url: link.url, status: 'unsupported_board_review' });
      }
    } catch (error) { leads.push({ url, status: 'unreachable', ...sourceFailure(error) }); }
  }
  return { boards: [...new Map(boards.map(b => [`${b.board}:${b.region ?? 'global'}:${b.board_token}:${b.site ?? ''}`, b])).values()],
    leads: [...new Map(leads.map(l => [`${l.url}:${l.status}`, l])).values()], employerJobs,
    employer_domain: company.domain, domain_evidence: domainEvidence };
}

export function employerDomainFromStory(html, url, name) {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized.length < 2) return null;
  const domains = new Set();
  for (const link of links(html, url)) {
    const labels = new URL(link.url).hostname.split('.');
    // Narrow exact-label match only; aliases, abbreviations, and ambiguous
    // parent/subsidiary domains require a reviewed config.
    const count = ['co', 'com', 'org', 'ac', 'gov'].includes(labels.at(-2)) ? 3 : 2;
    if (labels.at(-count)?.replaceAll('-', '') === normalized) domains.add(labels.slice(-count).join('.'));
  }
  return domains.size === 1 ? [...domains][0] : null;
}

// A readable page alone cannot establish activity. JSON-LD jobs without a future
// validThrough stay unknown, and search results never become verified postings.
export function structuredPostings(html, url, company, now = new Date()) {
  const jobs = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value['@graph']) visit(value['@graph']);
    if (![value['@type']].flat().includes('JobPosting')) return;
    if (value.hiringOrganization?.name?.trim().toLowerCase() !== company.name.toLowerCase()) return;
    const match = relevance(value.title ?? '', value.description ?? '');
    if (!match || !value.title || !value.url) return;
    try {
      const postingUrl = publicUrl(new URL(value.url, url).href);
      if (new URL(postingUrl).hostname !== new URL(url).hostname) return;
      const deadline = typeof value.validThrough === 'string' ? Date.parse(value.validThrough) : NaN;
      // Listing-page JSON-LD without an actual posting URL remains a research lead.
      const status = Number.isFinite(deadline) ? (deadline > now.getTime() ? 'active' : 'expired') : 'unknown';
      jobs.push({ company_id: company.id, employer: company.name, title: plainText(value.title), posting_url: postingUrl,
        posting_id: postingUrl, requisition: value.identifier?.value == null ? null : String(value.identifier.value),
        board_key: `${company.id}:employer:${url}`, source: 'employer_jsonld', location: value.jobLocation?.address?.addressLocality ?? null,
        checked_at: now.toISOString(), status, excerpt: match.excerpt, relevance: match.relevance,
        evidence: `${postingUrl} | ${match.evidence}`, mapping_evidence: url });
    } catch { /* missing/unsafe URLs remain unverified */ }
  }
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(m[1])); } catch { /* malformed structured data is not a fact */ }
  }
  return jobs;
}

export function mergePostings(previous, current, checks) {
  const byKey = new Map(current.map(j => [`${j.board_key}:${j.posting_id}`, j]));
  for (const old of previous) {
    const id = `${old.board_key}:${old.posting_id}`;
    if (byKey.has(id)) continue;
    const check = checks.find(c => c.board_key === old.board_key);
    const absent = check?.status === 'ok' && check.complete_inventory !== false && !check.posting_ids.includes(old.posting_id);
    byKey.set(id, { ...old, status: absent ? 'expired' : 'unknown', last_observed_status: old.last_observed_status ?? old.status,
      checked_at: absent ? check.checked_at : old.checked_at, last_seen_at: old.last_seen_at ?? old.checked_at,
      last_attempt_at: check?.checked_at ?? null, reason: absent ? 'Absent from a complete public board refresh.' : 'Not refreshed or no longer matched; previous evidence retained.' });
  }
  return [...byKey.values()];
}

await previewCLI(import.meta.url, 'boards', collectJobPostings);
