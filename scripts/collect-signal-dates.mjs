// Extends Krish's preview collector with source discovery and strict event/date binding.
import { plainText, publicUrl, request, search, sourceTrusted } from './input-automation/public-sources.mjs';

const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const monthPattern = months.join('|');
const datePattern = `(?:\\d{4}-\\d{2}-\\d{2}|(?:${monthPattern}) \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}|\\d{1,2}(?:st|nd|rd|th)? (?:${monthPattern}) \\d{4})(?![\\d-])`;
const eventPattern = `(?:went live|has gone live) (?:with )?Workday (?:HCM|Human Capital Management) on (${datePattern})`;

export function normalizeDate(raw) {
  let y, m, d;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) [, y, m, d] = iso.map(Number);
  else {
    const clean = raw.toLowerCase().replace(/(\d)(st|nd|rd|th)/g, '$1').replace(',', '');
    const parts = clean.split(' ');
    const monthFirst = months.includes(parts[0]);
    y = Number(parts[2]); m = months.indexOf(parts[monthFirst ? 0 : 1]) + 1; d = Number(parts[monthFirst ? 1 : 0]);
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (y < 2005 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

export function extractSignalCandidates(html, sourceUrl, { company, trusted = false, now = new Date() } = {}) {
  const text = plainText(html);
  const rows = [];
  const names = company ? [company.name] : [];
  for (const sentence of text.split(/\n|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean)) {
    if (!/workday/i.test(sentence) || !/live|launched|deployed/i.test(sentence)) continue;
    const matches = [...sentence.matchAll(new RegExp(eventPattern, 'gi'))];
    // Require the named company immediately before the completed-event phrase.
    const named = names.some(name => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^\\w])${escaped}\\s+${eventPattern}`, 'i').test(sentence);
    });
    const dates = [...sentence.matchAll(new RegExp(datePattern, 'gi'))];
    const date = matches.length === 1 ? normalizeDate(matches[0][1]) : null;
    const uncertain = /\b(will|would|plans?|expected|scheduled|target|not|never|may|might|subsidiary|division|region|pilot|phase|financial|payroll.only|between|through|until|or|approximately|around)\b|\s[-–]\s/i.test(sentence);
    const storable = Boolean(trusted && named && date && matches.length === 1 && dates.length === 1 &&
      !uncertain && date <= now.toISOString().slice(0, 10) && sentence.length < 700);
    rows.push({ candidate_date: date, source_url: sourceUrl, excerpt: sentence.slice(0, 1000),
      date_type: storable ? 'exact_hcm_go_live' : 'review', storable,
      reason: storable ? `${company.name} explicitly went live with Workday HCM on ${date}.` :
        'Review required: exact event/date binding, company/entity, trusted source, or completed HCM scope not confirmed.' });
  }
  return rows.length ? rows : [{ candidate_date: null, source_url: sourceUrl, excerpt: null,
    date_type: 'none', storable: false, reason: 'No explicit Workday go-live statement found.' }];
}

export async function collectSignalDates(companies, { fetchImpl = fetch, now = new Date(), configs = {}, key } = {}) {
  const rows = [];
  for (const company of companies) {
    const config = configs[company.id] ?? {};
    const urls = new Set([company.source, ...(config.signal_urls ?? [])].filter(Boolean));
    try {
      const results = await search(`"${company.name}" Workday HCM "go live" OR "went live" -site:linkedin.com`, { fetchImpl, key });
      for (const result of results) urls.add(result.url);
    } catch { rows.push({ company_id: company.id, company: company.name, storable: false, date_type: 'discovery_failed', reason: 'Search failed; existing sources will still be checked.' }); }
    for (const url of [...urls].slice(0, 8)) {
      try {
        const page = await request(publicUrl(url), { fetchImpl });
        for (const row of extractSignalCandidates(page.text, page.url, { company, now, trusted: sourceTrusted(page.url, company, config) })) {
          rows.push({ company_id: company.id, company: company.name, checked_at: now.toISOString(), ...row });
        }
      } catch {
        rows.push({ company_id: company.id, company: company.name, source_url: url, checked_at: now.toISOString(),
          candidate_date: null, date_type: 'unreachable', storable: false, reason: 'Source unavailable; existing date preserved.' });
      }
    }
    if (!urls.size) rows.push({ company_id: company.id, company: company.name, storable: false, date_type: 'skipped', reason: 'No source URL discovered or supplied.' });
  }
  return rows;
}

export function selectSignal(company, candidates) {
  const rows = candidates.filter(r => r.company_id === company.id);
  // Conflicting exact event candidates block writes even when one source needs review.
  const dates = new Set(rows.filter(r => r.candidate_date).map(r => r.candidate_date));
  if (dates.size > 1) return { status: 'conflict', date: null, evidence: null };
  const accepted = rows.find(r => r.storable);
  if (!accepted) return { status: 'review', date: null, evidence: null };
  if (company.workday_signal_date && company.workday_signal_date !== accepted.candidate_date) {
    return { status: 'existing_date_conflict', date: null, evidence: null };
  }
  return { status: company.workday_signal_date ? 'unchanged' : 'ready', date: accepted.candidate_date,
    evidence: `${accepted.source_url} | ${accepted.reason}`, excerpt: accepted.excerpt };
}
