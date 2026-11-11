import { randomUUID, createHash } from 'node:crypto';
export function transferFixture() {
  const id = randomUUID(), capture = randomUUID(), extraction = randomUUID(), now = '2026-10-01T12:00:00Z';
  const tag = randomUUID().replaceAll('-', '');
  const name = `Zephyrloom ${tag}`, domain = `${tag}.example`, url = `https://${domain}/careers`, body = `Fictional public evidence ${tag}`;
  return { version: 1, exported_at: now, source_database: 'http://127.0.0.1:54321',
    companies: [{ company: { id, name, domain, created_at: now, employee_count: 4000, source: url },
      review: { approved: true, note: 'Fictional reviewed fixture', reviewed_at: now, evidence_urls: [url] },
      signals: [{ id: randomUUID(), company_id: id, capture_id: capture, extraction_id: extraction,
        type: 'hiring', source_url: url, quote: body, confidence: 0.9, first_seen_at: now, last_seen_at: now, method: 'structured' }],
      sites: [{ id: randomUUID(), company_id: id, tenant: tag, pod: 'wd5', site: 'Careers', company_name: name,
        normalized_name: name.toLowerCase(), match_kind: 'manual', discovered_from: 'workday-career-sites', capture_id: capture,
        enabled: true, created_at: now, last_checked_at: now, last_status: '200' }] }],
    captures: [{ id: capture, source_id: 'workday-career-sites', run_id: randomUUID(), url, fetched_at: now, http_status: 200, content_type: 'text/plain',
      content_hash: createHash('sha256').update(body).digest('hex'), body, meta: { fixture: true } }],
    extractions: [{ id: extraction, capture_id: capture, run_id: randomUUID(), method: 'structured', model: '', status: 'done', output: { fixture: true },
      cost_usd: 0, created_at: now, attempts: 1, prompt_version: '' }],
    sources: [{ id: 'workday-career-sites', type: 'workday_career_site', name: 'Workday career sites', config: { secret: 'never export' } }] };
}
