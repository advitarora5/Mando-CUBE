// Shared identities and completion policy for both contact workers.
export const normalizedContactName = value => value.trim().toLowerCase().replace(/\s+/g, ' ');
export function contactCallKey(endpoint, body) {
  if (endpoint === 'treg.people.email.find') return `find:${normalizedContactName(body.full_name)}`;
  if (endpoint === 'treg.people.email.verify') return `verify:${body.email.trim().toLowerCase()}`;
  return null;
}
export function contactNeedsCompletion(contact) {
  return !(contact.email && (contact.email_verified === true || contact.email_status === 'valid'));
}
export function contactEmployerMismatch(contact) {
  return contact.contact_sources?.role_review?.status === 'different_employer';
}
export async function completeContact({ company, contact, call }) {
  if (!contactNeedsCompletion(contact) || contactEmployerMismatch(contact)) return null;
  let email = contact.email;
  const provenance = { ...(contact.contact_sources ?? {}) };
  const completion = { ...(provenance.contact_completion ?? {}) };
  provenance.contact_completion = completion;
  if (!email) {
    const found = await call(company.id, 'treg.people.email.find', { domain: company.domain, full_name: contact.name });
    const value = found.response?.output?.email;
    email = typeof value === 'string' ? value.trim().toLowerCase() : null;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.split('@')[1] !== company.domain.toLowerCase()
      || found.response?._treg?.domain_match === false) email = null;
    completion[contactCallKey('treg.people.email.find', { full_name: contact.name })] = { provider: found.provider, call_id: found.call_id, endpoint: 'treg.people.email.find' };
  }
  let state = { email_status: 'not_found', email_verified: false };
  if (email) {
    const verified = await call(company.id, 'treg.people.email.verify', { email });
    const result = verified.response?.output;
    const verdict = typeof result?.status === 'string' ? result.status.toLowerCase() : null;
    const provider = verified.response?._treg?.served_by ?? verified.provider;
    // Filtrat reports a successful verification as "verified" without a separate valid flag.
    const isVerified = (verdict === 'valid' && result.valid === true)
      || (verdict === 'verified' && result.valid !== false && ['filtrat.people.email.verify', 'filtrat.people.email.verify.resolve_catchall'].includes(provider));
    state = { email_status: isVerified ? 'valid' : verdict === 'invalid' ? 'invalid' : 'risky',
      email_verified: isVerified };
    completion[contactCallKey('treg.people.email.verify', { email })] = { verdict: state.email_status, provider: verified.provider, call_id: verified.call_id, endpoint: 'treg.people.email.verify' };
  }
  if (!contact.email && state.email_status === 'invalid') email = null;
  // Never clear a manually supplied address, even when verification rejects it.
  const patch = { email, ...state, contact_sources: provenance };
  if (Object.entries(patch).every(([key, value]) => JSON.stringify(contact[key]) === JSON.stringify(value))) return null;
  return patch;
}
