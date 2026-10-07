import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { createClient } from '@supabase/supabase-js';

export const normalize = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const clean = value => String(value ?? '').trim();
const credentials = /^(JD|CHCIO|CPA|CEP|CECP|PhD|MBA|MD)$/i;
const person = value => /^[\p{L}][\p{L}.'’-]*(?:\s+[\p{L}][\p{L}.'’-]*){1,7}$/u.test(value);
const identity = name => normalize(name.split(',').filter(part => !credentials.test(part.trim())).join(','));
function stableId(companyId, name) {
  const hex = createHash('sha256').update(`mando-contact:${companyId}:${identity(name)}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
function url(value, profile = false) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    if (profile) {
      if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname) || !/^\/in\/[^/]+\/?$/.test(parsed.pathname)) throw new Error();
      return `https://www.linkedin.com${parsed.pathname.replace(/\/$/, '')}`;
    }
    return parsed.href;
  } catch { throw new Error(profile ? 'Invalid individual LinkedIn URL' : 'Invalid source URL'); }
}

export function parseTarget(company, original) {
  const text = clean(original);
  if (!text) return { action: 'No named person', reason: 'Empty target cell' };
  if (/unverified|conflict|not confirmed/i.test(text)) return { action: 'Needs review', reason: 'Explicitly unverified or conflicting target' };
  if (/^no (confirmed |current )?(current )?named/i.test(text)) return { action: 'No named person', reason: 'Unnamed target role; no person inferred' };
  // Accept only one explicit name, optional recognized credentials, a role, and
  // the exact company suffix. Multi-person prose and qualifications are reviewed.
  const aliases = [company, company.replace(/\s+\([^()]+\)$/, ''), company.match(/\(([^()]+)\)$/)?.[1], company.replace(/,?\s+(Inc\.?|plc)$/i, '')].filter(Boolean);
  const suffix = aliases.map(alias => `, ${alias}`).find(ending => text.toLowerCase().endsWith(ending.toLowerCase()));
  const body = suffix ? text.slice(0, -suffix.length) : '';
  if (!suffix || /[();]|,\s+and\s|\bincoming\b/i.test(body)) {
    return { action: 'Needs review', reason: 'Multi-person, qualified, or ambiguous prose; use reviewed CSV' };
  }
  const parts = body.split(',').map(clean);
  const name = parts.shift();
  if (!person(name)) return { action: 'Needs review', reason: 'Cannot establish an explicit person name' };
  const creds = [];
  while (parts.length && credentials.test(parts[0])) creds.push(parts.shift());
  const title = parts.join(', ');
  if (!/^(chief\b|head of\b|vp\b|vice president\b|director\b|manager\b|evp\b|svp\b|human capital director\b|global erp\b|rfp designated contact\b)/i.test(title) || /\band\s+[A-Z][a-z]+\s+[A-Z]/.test(title)) {
    return { action: 'Needs review', reason: 'Role boundary is uncertain; use reviewed CSV' };
  }
  return { action: 'Needs review', reason: 'Extracted candidate only; explicit approval required in reviewed CSV', candidate: { name: [name, ...creds].join(', '), title, linkedin_url: null, source: null, mutual_connection: null } };
}

export function readContacts(filename, reviewed = false) {
  const parsed = Papa.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''), { skipEmptyLines: 'greedy' });
  if (parsed.errors.length) throw new Error('Malformed CSV');
  const start = parsed.data.findIndex(row => row.map(normalize).includes('company'));
  if (start < 0) throw new Error('Missing company header');
  const headers = parsed.data[start].map(normalize);
  const required = reviewed ? ['company','name','title','approved','original_notes'] : ['company','linkedin contact / target'];
  if (required.some(h => !headers.includes(h))) throw new Error(`Required headers: ${required.join(', ')}`);
  return parsed.data.slice(start + 1).flatMap((row, i) => {
    const get = h => clean(row[headers.indexOf(h)]);
    const company = get('company');
    if (!company || company === 'Blue = manual input / judgment call.') return [];
    const context = { row: start + i + 2, company, original_notes: reviewed ? get('original_notes') : get('linkedin contact / target'), evidence: get('evidence / source') };
    if (!reviewed) return [{ ...context, ...parseTarget(company, context.original_notes) }];
    try {
      const name = get('name');
      const nameParts = name.split(',').map(clean);
      if (!person(nameParts[0]) || nameParts.slice(1).some(p => !credentials.test(p))) throw new Error('Explicit person name required; credentials must be recognizable');
      if (!get('title') || !context.original_notes) throw new Error('Title and original notes required');
      if (normalize(get('approved')) !== 'yes') throw new Error('Not explicitly approved');
      if (/unverified|unresolved|conflicting/i.test(context.original_notes)) throw new Error('Unverified/conflicting notes require resolution before approval');
      return [{ ...context, action: 'Candidate', reason: 'Reviewed CSV approval', candidate: { name, title: get('title'), linkedin_url: url(get('linkedin_url'), true), source: url(get('source')), mutual_connection: get('mutual_connection') || null } }];
    } catch (error) { return [{ ...context, action: 'Needs review', reason: error.message }]; }
  });
}

export function planContacts(records, companies, contacts) {
  const plan = records.map(record => ({ ...record }));
  const groups = new Map();
  for (const item of plan) {
    const matches = companies.filter(c => normalize(c.name) === normalize(item.company));
    if (matches.length !== 1) {
      item.action = 'Needs review'; item.reason = matches.length ? 'Ambiguous company match' : 'No existing company match'; continue;
    }
    item.company_id = matches[0].id;
    if (item.action !== 'Candidate') continue;
    item.id = stableId(item.company_id, item.candidate.name);
    const group = groups.get(item.id) ?? [];
    group.push(item); groups.set(item.id, group);
  }
  for (const group of groups.values()) {
    if (new Set(group.map(item => JSON.stringify(item.candidate))).size > 1) {
      for (const item of group) { item.action = 'Needs review'; item.reason = 'Conflicting duplicate input'; }
      continue;
    }
    const item = group[0];
    const existing = contacts.filter(c => c.company_id === item.company_id);
    const matches = existing.filter(c => c.id === item.id || identity(c.name) === identity(item.candidate.name) || (item.candidate.linkedin_url && (() => { try { return url(c.linkedin_url, true) === item.candidate.linkedin_url; } catch { return false; } })()));
    if (matches.length > 1 || (matches.length === 1 && matches[0].id !== item.id && (identity(matches[0].name) !== identity(item.candidate.name) || (matches[0].linkedin_url && item.candidate.linkedin_url && (() => { try { return url(matches[0].linkedin_url, true) !== item.candidate.linkedin_url; } catch { return true; } })())))) {
      item.action = 'Needs review'; item.reason = 'Conflicting identity or multiple existing contacts';
    } else {
      item.action = matches.length ? 'Preserve existing' : 'Add';
      item.reason = matches.length ? 'Existing contact retained entirely' : 'Approved unmatched contact';
    }
    for (const duplicate of group.slice(1)) { duplicate.action = item.action === 'Needs review' ? 'Needs review' : 'Preserve existing'; duplicate.reason = item.action === 'Needs review' ? item.reason : 'Duplicate input candidate; no second insert'; }
  }
  // Distinct names claiming the same profile must not create two contacts.
  for (const item of plan.filter(p => p.action === 'Add' && p.candidate.linkedin_url)) {
    if (plan.some(p => p !== item && p.company_id === item.company_id && p.candidate?.linkedin_url === item.candidate.linkedin_url && p.id !== item.id)) {
      item.action = 'Needs review'; item.reason = 'Profile claimed by different input identities';
    }
  }
  return plan;
}

export async function importContacts(db, records, apply = false) {
  const readAll = async table => {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db.from(table).select(table === 'companies' ? 'id,name' : '*').order('id').range(offset, offset + 499);
      if (error) throw new Error(`Could not read ${table}`);
      rows.push(...data); if (data.length < 500) return rows;
    }
  };
  const [companies, contacts] = await Promise.all([readAll('companies'), readAll('contacts')]);
  const plan = planContacts(records, companies, contacts);
  show(plan);
  const additions = plan.filter(item => item.action === 'Add');
  if (apply && additions.length) {
    // Insert-only conflict handling preserves even edited deterministic-ID rows.
    const { error } = await db.from('contacts').upsert(additions.map(item => ({ id: item.id, company_id: item.company_id, ...item.candidate })), { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw new Error('Contact insert not confirmed; preview before retrying');
  }
  return plan;
}
function show(records) {
  for (const item of records) console.log(JSON.stringify(item));
}
export async function main(args = process.argv.slice(2)) {
  const flags = args.filter(a => a.startsWith('--'));
  const filenames = args.filter(a => !a.startsWith('--'));
  if (filenames.length !== 1 || new Set(flags).size !== flags.length || flags.some(f => !['--reviewed','--offline','--apply'].includes(f)) || (flags.includes('--offline') && flags.includes('--apply'))) throw new Error('Usage: node scripts/import-contacts.mjs FILE [--reviewed] [--offline | --apply]');
  const records = readContacts(filenames[0], flags.includes('--reviewed'));
  if (flags.includes('--offline')) { show(records); console.log('OFFLINE: extracted candidates only; no company/contact matching or saves.'); return records; }
  if (flags.includes('--apply') && !flags.includes('--reviewed')) throw new Error('Saving requires --reviewed with explicit approved=yes rows');
  const { SUPABASE_URL: endpoint, SUPABASE_SECRET_KEY: key } = process.env;
  if (!endpoint || !key) throw new Error('Missing Supabase configuration');
  const db = createClient(endpoint, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const plan = await importContacts(db, records, flags.includes('--apply'));
  console.log(flags.includes('--apply') ? 'Apply complete; existing contacts and research metadata preserved.' : 'PREVIEW ONLY: no writes.');
  return plan;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(error => { console.error(error.message); process.exitCode = 1; });
