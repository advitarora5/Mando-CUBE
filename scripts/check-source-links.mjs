// Read-only: opens the source links of recently added companies (companies.source and their signals' source_url)
// and flags dead links and pages that never mention Workday.
// Usage: npm run links:check -- [--days 7] [--limit 50] [--local]   (--local reads the pipeline DB: PIPELINE_SUPABASE_URL/KEY)
import { createClient } from "@supabase/supabase-js";

export async function checkLink(url) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 link-check" } });
    // ponytail: JS-rendered pages may hide "workday" from raw HTML; false there means "verify by hand", not "wrong"
    const mentionsWorkday = res.ok && /workday/i.test(await res.text());
    return { opens: res.ok, status: res.status, mentionsWorkday };
  } catch (e) {
    return { opens: false, status: e.name, mentionsWorkday: false };
  }
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
  const { data, error } = await db.from("companies").select("id, name, source, signals(source_url)").gte("created_at", since).order("created_at", { ascending: false }).limit(arg("limit", 50));
  if (error) throw new Error(error.message);
  const rows = (await Promise.all(data.map(async c => Promise.all(linksOf(c).map(async u => ({ company: c.name, url: u, ...(await checkLink(u)) })))))).flat();
  const noLink = data.filter(c => !linksOf(c).length).map(c => c.name);
  console.table(rows);
  console.log(`${data.length} companies, ${rows.length} links: ${rows.filter(r => !r.opens).length} dead, ${rows.filter(r => r.opens && !r.mentionsWorkday).length} open without a Workday mention`);
  if (noLink.length) console.log(`No source link at all (fill by hand): ${noLink.join(", ")}`);
  process.exitCode = rows.some(r => !r.opens) ? 1 : 0;
}
