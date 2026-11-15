import { createHash } from 'node:crypto';
import { z } from 'zod';
import { completeContact, contactCallKey, contactEmployerMismatch, contactNeedsCompletion } from './contact-completion.mjs';

const personSchema = z.object({
  name: z.string().trim().min(2).max(200),
  title: z.string().trim().min(1).max(4000),
  linkedin_url: z.string().url().nullable(),
  email: z.string().email().max(254).nullable(),
});
const relevantTitle = /workday|hris|hrms|human resources|chief people|\bchro\b|hr (systems|technology|transformation)|human capital/i;
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const normalizedName = value => text(value)?.toLowerCase().replace(/\s+/g, ' ');

export class ResearchBudgetReached extends Error {}

export function companyDomain(value) {
  if (!text(value)) throw new Error('Company needs a corporate domain before contact research.');
  let parsed;
  try { parsed = new URL(value.includes('://') ? value : `https://${value}`); }
  catch { throw new Error('Company domain is invalid.'); }
  const domain = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain)
    || /(^|\.)(myworkdayjobs\.com|workday\.com|linkedin\.com)$/.test(domain)) {
    throw new Error('Use the corporate domain, not a Workday tenant or profile URL.');
  }
  return domain;
}

export function candidatesForCompany(people, company, limit) {
  if (!Array.isArray(people)) throw new Error('Malformed treg search response: people must be an array.');
  const domain = companyDomain(company.domain);
  const seen = new Set();
  return people.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const employer = row.company && typeof row.company === 'object' ? row.company : {};
    const employerDomain = row.company_domain ?? employer.domain ?? employer.website;
    const employerName = row.company_name ?? employer.name ?? (typeof row.company === 'string' ? row.company : null);
    if (employerDomain) {
      try { if (companyDomain(employerDomain) !== domain) return []; } catch { return []; }
    } else if (!employerName || normalizedName(employerName) !== normalizedName(company.name)) return [];
    const profile = text(row.linkedin_url ?? row.linkedin);
    const linkedin = profile && /^https:\/\/(www\.)?linkedin\.com\/in\/[^/?#]+\/?$/i.test(profile) ? profile : null;
    const parsed = personSchema.safeParse({
      name: text(row.name ?? row.full_name) ?? [text(row.first_name), text(row.last_name)].filter(Boolean).join(' '),
      title: text(row.title ?? row.job_title),
      linkedin_url: linkedin,
      email: text(row.email)?.toLowerCase() ?? null,
    });
    if (!parsed.success || !relevantTitle.test(parsed.data.title)) return [];
    const identity = normalizedName(parsed.data.name);
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [parsed.data];
  }).slice(0, limit);
}

export function verificationState(output) {
  const verdict = text(output?.status)?.toLowerCase();
  if (verdict === 'valid' && output.valid === true) return { email_status: 'valid', email_verified: true };
  if (verdict === 'invalid') return { email_status: 'invalid', email_verified: false };
  if (['risky', 'accept_all', 'catch_all', 'catch-all'].includes(verdict)) return { email_status: 'risky', email_verified: false };
  return { email_status: null, email_verified: false };
}

export function createTregClient({ token, maxRunUsd, maxCallUsd, fetchImpl = fetch, checkpoint }) {
  if (!token) throw new Error('TREG_TOKEN is required.');
  if (![maxRunUsd, maxCallUsd].every(value => Number.isFinite(value) && value > 0)) throw new Error('Positive finite spending caps are required.');
  const budgetMicro = Math.floor(maxRunUsd * 1e6);
  const ceilingMicro = Math.floor(maxCallUsd * 1e6);
  if (!ceilingMicro) throw new Error('Call ceiling must be at least one micro-dollar.');
  if (ceilingMicro > budgetMicro) throw new Error('Call ceiling cannot exceed the run budget.');
  let reservedMicro = 0;
  const stats = { requests: 0, chargedMicro: 0, unknownCharges: 0 };
  return {
    stats,
    async call(companyId, endpoint, body) {
      if (!['treg.people.search', 'treg.people.email.find', 'treg.people.email.verify'].includes(endpoint)) throw new Error('Unsupported treg endpoint.');
      const legacyKey = createHash('sha256').update(JSON.stringify({ endpoint, body })).digest('hex');
      const requestKey = contactCallKey(endpoint, body) ?? legacyKey;
      const cached = await checkpoint.get(companyId, requestKey) ?? (requestKey !== legacyKey ? await checkpoint.get(companyId, legacyKey) : null);
      if (cached) {
        if (cached.status !== 'succeeded') throw new Error('Prior call is unresolved. Reconcile its treg call before retrying.');
        return cached;
      }
      if (reservedMicro + ceilingMicro > budgetMicro) throw new ResearchBudgetReached('Run spending cap reached; saved checkpoints will resume on the next run.');
      await checkpoint.start(companyId, requestKey, endpoint);
      reservedMicro += ceilingMicro;
      stats.requests += 1;
      let response;
      try {
        response = await fetchImpl(`https://treg.to/call/${endpoint}`, {
          method: 'POST', redirect: 'error',
          headers: {
            'content-type': 'application/json', 'X-Treg-Token': token,
            'X-Treg-Route-Max-Cost': String(ceilingMicro / 1e6),
            'X-Treg-Route-Strict-Filters': '1',
            'X-Treg-Route-Verify': 'false',
            'Idempotency-Key': `${companyId}:${requestKey}`,
          },
          body: JSON.stringify(body), signal: AbortSignal.timeout(75_000),
        });
        const costHeader = response.headers.get('X-Treg-Cost-Micro');
        const costMicro = costHeader !== null && /^\d+$/.test(costHeader) && Number.isSafeInteger(Number(costHeader)) ? Number(costHeader) : null;
        const payload = await response.json().catch(() => null);
        const pending = response.status === 202 || payload?._treg?.outcome === 'pending';
        if (costMicro === null || pending) stats.unknownCharges += 1;
        else stats.chargedMicro += costMicro;
        const ignored = response.headers.get('X-Treg-Ignored-Filters');
        const succeeded = response.ok && response.status !== 202 && !['pending', 'error', 'failed'].includes(payload?._treg?.outcome)
          && payload?.output && typeof payload.output === 'object' && !Array.isArray(payload.output)
          && !ignored && costMicro !== null && costMicro <= ceilingMicro;
        const result = {
          status: succeeded ? 'succeeded' : 'blocked', response: payload,
          provider: response.headers.get('X-Treg-Served-By'),
          call_id: response.headers.get('X-Treg-Call-Id'), cost_micro: pending ? null : costMicro,
        };
        await checkpoint.finish(companyId, requestKey, result);
        if (!succeeded) throw new Error(`Treg call requires review (HTTP ${response.status}); inspect its saved call ID and result before retrying.`);
        return result;
      } catch (error) {
        if (!response) stats.unknownCharges += 1;
        if (!response) throw new Error('Treg response was lost; reconcile the running checkpoint before retrying.', { cause: error });
        throw error;
      }
    },
  };
}

export async function researchCompany({ company, existing, maxContacts, client, save, update }) {
  const domain = companyDomain(company.domain);
  const search = await client.call(company.id, 'treg.people.search', { company_domain: domain, title: 'Workday', limit: maxContacts });
  const people = candidatesForCompany(search.response.output.people, company, maxContacts);
  const summary = { returned: search.response.output.people.length, candidates: people.length, added: 0, preserved: 0, verified: 0, unverified: 0, rejectedEmails: 0 };
  let remaining = maxContacts;
  // Complete stored contacts independently of directory coverage, preserving manual identity fields.
  for (const contact of existing) {
    if (remaining <= 0) break;
    if (contactEmployerMismatch(contact) || !contactNeedsCompletion(contact)) continue;
    const snapshot = structuredClone(contact);
    const patch = await completeContact({ company: { ...company, domain }, contact: snapshot, call: client.call });
    if (patch) remaining -= 1;
    if (patch && await update(snapshot, patch)) {
      Object.assign(contact, patch);
      summary[patch.email_verified ? 'verified' : 'unverified'] += 1;
    }
  }
  for (const person of people) {
    if (remaining <= 0) break;
    if (existing.some(contact => normalizedName(contact.name) === normalizedName(person.name)
      || (contact.email && contact.email.toLowerCase() === person.email)
      || (contact.linkedin_url && person.linkedin_url && contact.linkedin_url.toLowerCase().replace(/\/$/, '') === person.linkedin_url.toLowerCase().replace(/\/$/, '')))) {
      summary.preserved += 1;
      continue;
    }
    // Directory emails still require a corporate-domain match and independent verification.
    if (person.email && person.email.split('@')[1] !== domain) { person.email = null; summary.rejectedEmails += 1; }
    const patch = await completeContact({ company: { ...company, domain }, contact: person, call: client.call });
    const contact = {
      ...person, ...patch, source: person.linkedin_url,
      linkedin_status: person.linkedin_url ? 'provided' : 'not_found',
      contact_sources: {
        ...patch.contact_sources,
        research: { source: 'treg.people.search', checked_by: search.provider, call_id: search.call_id, company_domain: domain },
        linkedin: { status: person.linkedin_url ? 'provided' : 'not_found' },
      },
    };
    remaining -= 1;
    const added = await save(company.id, contact);
    if (added) {
      summary.added += 1;
      summary[contact.email_verified ? 'verified' : 'unverified'] += 1;
      existing.push(contact);
    } else summary.preserved += 1;
  }
  return summary;
}
