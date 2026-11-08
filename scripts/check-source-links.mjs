// Read-only: opens the source links of recently added companies (companies.source and their signals' source_url)
// and flags dead links, fake Workday sites and links that are not Workday at all.
// Usage: npm run links:check -- [--days 7] [--limit 50] [--local] [--no-ownership]   (--local reads the pipeline DB: PIPELINE_SUPABASE_URL/KEY)
import { createClient } from "@supabase/supabase-js";

// A real Workday careers site answers its job-search API (POST /wday/cxs/{tenant}/{site}/jobs) with 200;
// a made-up tenant or site gives 404/410/422 even when the page itself loads. Anything else (429 rate limit, 5xx, timeout)
// says nothing about the site and is reported as unknown. Cached per site.
const siteChecks = new Map();
export function workdaySite(url) {
  const u = new URL(url);
  const m = u.hostname.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/);
  const site = u.pathname.split("/").find((p, i) => p && !(i === 1 && /^[a-z]{2}-[A-Z]{2}$/.test(p)));
  return m && site ? { origin: u.origin, tenant: m[1], site } : null;
}
function verifySite({ origin, tenant, site }) {
  const key = `${origin}/${site}`;
  if (!siteChecks.has(key)) siteChecks.set(key, fetch(`${origin}/wday/cxs/${tenant}/${site}/jobs`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 1, offset: 0, searchText: "" }), signal: AbortSignal.timeout(15000),
  }).then(r => (r.ok ? "verified" : [404, 410, 422].includes(r.status) ? "invalid" : "unknown"), () => "unknown"));
  return siteChecks.get(key);
}

// workday: "verified" (Workday careers site whose API answers), "invalid" (Workday host, site does not exist), "unknown" (could not tell),
// "not-workday" (any other host: only the page text is checked, so treat a mention as weak evidence).
export async function checkLink(url) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 link-check" } });
    const wd = workdaySite(url);
    if (wd) return { opens: res.ok, status: res.status, workday: await verifySite(wd) };
    // ponytail: JS-rendered pages may hide "workday" from raw HTML; this is a hint, not proof
    return { opens: res.ok, status: res.status, workday: "not-workday", mentionsWorkday: res.ok && /workday/i.test(await res.text()) };
  } catch (e) {
    return { opens: false, status: e.name, workday: "unknown" };
  }
}

// Soft check only: tenants are not always the company name (Procter & Gamble is "pg", Wells Fargo "wf"), so a miss means
// "look at this one", never "wrong". Matches when the tenant and name contain one another or the tenant is the name's initials.
const WORD = /^(and|of|the|inc|corp|corporation|co|company|plc|ltd|llc)$/i;
export function tenantMatchesName(tenant, name) {
  const key = x => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const words = name.split(/[^A-Za-z0-9]+/).filter(w => w && !WORD.test(w));
  const t = key(tenant), n = words.map(key).join(""), initials = words.map(w => w[0]).join("").toLowerCase();
  return n.length > 1 && (n.includes(t) || t.includes(n) || t === initials);
}

// ---------- Does this Workday site belong to the company? ----------
// No registry maps a tenant to a company, so this collects evidence. Strong: a job posting names the company as its
// employer, or the company's own website links to the tenant. Weak: the tenant name resembles the company name.
const PODS = ["wd5", "wd1", "wd3", "wd12", "wd103", "wd501", "wd503", "wd10", "wd108"]; // same list the pipeline's resolver probes
const key = x => x.toLowerCase().replace(/[^a-z0-9]/g, "");
const nameWords = name => name.split(/[^A-Za-z0-9]+/).filter(w => w && !WORD.test(w));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = (url, init = {}) => fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 link-check" }, ...init });

// Every tenant name worth probing for a company: full name, first word, first two words, initials, and the website's label.
export function tenantVariants(name, domain) {
  const words = nameWords(name).map(w => w.toLowerCase());
  const label = domain ? key(domain.replace(/^www\./, "").split(".")[0]) : null;
  const all = [words.join(""), words[0], words.slice(0, 2).join(""), words.length > 1 ? words.map(w => w[0]).join("") : null, label];
  return [...new Set(all.filter(t => t && /^[a-z0-9][a-z0-9-]{1,40}$/.test(t)))];
}

// A posting's hiringOrganization.name is often a subsidiary ("S73 Pfizer Investment Co., Ltd. China"), so containment either way, 4+ letters.
export function employerMatches(employer, company) {
  const n = nameWords(company).map(key).join(""), e = key(employer ?? "");
  return n.length >= 4 && e.length >= 4 && (e.includes(n) || n.includes(e));
}

export const linksToTenant = (html, tenant) => new RegExp(`https?://${tenant}[.]wd[0-9]+[.]myworkdayjobs[.]com`, "i").test(html);

async function postingEmployer({ origin, tenant, site }) {
  try {
    const base = `${origin}/wday/cxs/${tenant}/${site}`;
    const list = await (await get(`${base}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }) })).json();
    const path = list.jobPostings?.[0]?.externalPath;
    return path ? (await (await get(base + path)).json()).hiringOrganization?.name ?? null : null;
  } catch { return null; }
}

// ponytail: raw HTML only, so a link that a script adds later is missed; no match means "unconfirmed", never "wrong"
async function companySiteLink(domain, tenant) {
  for (const url of [`https://${domain}`, `https://${domain}/careers`, `https://careers.${domain}`]) {
    try { const res = await get(url); if (res.ok && linksToTenant(await res.text(), tenant)) return url; } catch { /* blocked or unreachable: try the next page */ }
  }
  return null;
}

export async function ownership(company, wd) {
  const evidence = [], employer = await postingEmployer(wd);
  if (employerMatches(employer, company.name)) evidence.push(`posting employer "${employer}"`);
  const link = company.domain ? await companySiteLink(company.domain, wd.tenant) : null;
  if (link) evidence.push(`company site ${link} links to it`);
  const strong = evidence.length > 0;
  if (tenantMatchesName(wd.tenant, company.name)) evidence.push("tenant resembles name");
  return { status: strong ? "confirmed" : evidence.length ? "likely" : "unconfirmed", evidence };
}

// Candidate Workday sites for a company: every tenant name variant on every pod, sites read from the tenant's robots.txt
// (what the pipeline's resolver does), and only those whose page and job-search API both answer 200.
export async function suggestSites(company, exclude = new Set()) {
  const found = [];
  for (const tenant of tenantVariants(company.name, company.domain)) {
    for (const pod of PODS) {
      const origin = `https://${tenant}.${pod}.myworkdayjobs.com`;
      let robots;
      try { robots = await get(`${origin}/robots.txt`); } catch { continue; }
      if (robots.status === 429) return { found, rateLimited: true };
      if (!robots.ok) continue;
      const sites = [...(await robots.text()).matchAll(/^Sitemap:\s*https:\/\/[^/\s]+\/([A-Za-z0-9_-]+)\/siteMap\.xml/gim)].map(m => m[1]);
      for (const site of [...new Set(sites)].slice(0, 4)) {
        const url = `${origin}/${site}`;
        if (exclude.has(url.toLowerCase())) continue;
        const check = await checkLink(url);
        if (!check.opens || check.workday !== "verified") continue;
        const employer = await postingEmployer({ origin, tenant, site });
        found.push({ url, status: check.status, employer, employerMatch: employerMatches(employer, company.name) });
      }
      break; // a tenant lives on one pod
    }
    await sleep(200);
  }
  return { found: found.sort((a, b) => b.employerMatch - a.employerMatch), rateLimited: false };
}

// companies.source is free text (a name or a URL); only http(s) values are links.
export const linksOf = c => [...new Set([c.source, ...(c.signals ?? []).map(s => s.source_url)].filter(u => /^https?:\/\//.test(u ?? "")))];

if (process.argv[1]?.endsWith("check-source-links.mjs")) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => Number(args[args.indexOf(`--${name}`) + 1]) || fallback;
  const local = args.includes("--local");
  const [url, key] = local ? [process.env.PIPELINE_SUPABASE_URL, process.env.PIPELINE_SUPABASE_KEY] : [process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY];
  if (!url || !key) throw new Error(local ? "Set PIPELINE_SUPABASE_URL and PIPELINE_SUPABASE_KEY in .env.pipeline.local." : "Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local.");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const since = new Date(Date.now() - arg("days", 7) * 864e5).toISOString();
  const { data, error } = await db.from("companies").select("id, name, domain, source, signals(source_url)").gte("created_at", since).order("created_at", { ascending: false }).limit(arg("limit", 50));
  if (error) throw new Error(error.message);
  const jobs = data.flatMap(c => linksOf(c).map(u => ({ company: c.name, url: u })));
  const rows = [];
  for (let i = 0; i < jobs.length; i += 6) rows.push(...await Promise.all(jobs.slice(i, i + 6).map(async j => ({ ...j, ...(await checkLink(j.url)) })))); // ponytail: 6 at a time, Workday answers 429 to bursts
  for (const r of rows) {
    const site = r.workday === "verified" ? workdaySite(r.url) : null;
    if (site) r.tenantName = tenantMatchesName(site.tenant, r.company) ? "ok" : "check";
  }
  // Ownership: one verdict per company and Workday site, then suggestions for companies with no confirmed site.
  if (!args.includes("--no-ownership")) {
    const verdicts = [], suggestions = [];
    for (const c of data) {
      const sites = new Map(linksOf(c).map(u => [u, workdaySite(u)]).filter(([, wd]) => wd).map(([, wd]) => [`${wd.origin}/${wd.site}`.toLowerCase(), wd]));
      const results = [];
      for (const wd of sites.values()) { const v = await ownership(c, wd); results.push(v); verdicts.push({ company: c.name, site: `${wd.origin}/${wd.site}`, ownership: v.status, evidence: v.evidence.join("; ") || "none" }); }
      // Suggest only when every site is unconfirmed: a confirmed or name-matching tenant is probably right, and its sibling sites are not alternatives.
      if (!results.length || results.some(v => v.status !== "unconfirmed")) continue;
      const { found, rateLimited } = await suggestSites(c, new Set(sites.keys()));
      suggestions.push(...found.map(x => ({ company: c.name, suggestion: x.url, status: x.status, employer: x.employer ?? "", employerMatch: x.employerMatch })));
      if (!found.length) suggestions.push({ company: c.name, suggestion: rateLimited ? "(rate limited, re-run)" : "(no valid Workday site found)", status: "", employer: "", employerMatch: "" });
    }
    console.log("\nWorkday ownership (confirmed = a posting names the company or its own site links to the tenant):");
    console.table(verdicts);
    if (suggestions.length) { console.log("Suggested Workday sites for companies whose linked site is unconfirmed (each answered 200):"); console.table(suggestions); }
  }
  const noLink = data.filter(c => !linksOf(c).length).map(c => c.name);
  console.table(rows);
  console.log(`${data.length} companies, ${rows.length} links: ${rows.filter(r => !r.opens && r.status !== 429).length} dead, ${rows.filter(r => r.status === 429 || r.workday === "unknown").length} could not be checked (rate limit or timeout, re-run), ${rows.filter(r => r.workday === "invalid").length} not a real Workday site, ${rows.filter(r => r.workday === "not-workday").length} on a non-Workday host (check by hand), ${rows.filter(r => r.tenantName === "check").length} Workday tenants that do not resemble the company name (check by hand, not necessarily wrong)`);
  if (noLink.length) console.log(`No source link at all (fill by hand): ${noLink.join(", ")}`);
  process.exitCode = rows.some(r => (!r.opens && r.status !== 429) || r.workday === "invalid") ? 1 : 0;
}
