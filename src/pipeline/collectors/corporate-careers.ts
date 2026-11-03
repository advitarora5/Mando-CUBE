// Candidate discovery only. A corporate-page link does not change admission confidence.
import { normalizeDomain, normalizeName } from "../../domain/ingestion/normalize.ts";
import { WebsiteHttp, pageIdentity, links, careersLinks } from "../website.ts";
import type { PipelineContext } from "../types.ts";

export type CorporateWorkdayLink = { tenant: string; pod: string; site: string; url: string; quote: string };

export function corporateWorkdayLinks(html: string, base: string, name: string): CorporateWorkdayLink[] {
  const home = new URL(base);
  if (home.protocol !== "https:" || home.username || home.password || home.port || !pageIdentity(html, name)) return [];
  const out: CorporateWorkdayLink[] = [];
  const visible = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  for (const match of visible.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
    if (match[0].length > 2000) continue;
    for (const { url } of links(match[0], base)) {
      const host = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(url.hostname);
      if (!host || url.protocol !== "https:" || url.username || url.password || url.port || /%2f|%5c|%2e|\\/i.test(url.pathname)) continue;
      const segments = url.pathname.split("/").filter(Boolean);
      let site: string | undefined;
      if (segments[0] === "wday") {
        if (segments[1] !== "cxs" || segments[2] !== host[1]) continue;
        site = segments[3];
      } else {
        if (/^[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0] ?? "")) segments.shift();
        site = segments[0];
      }
      if (!site || !/^[A-Za-z0-9_-]+$/.test(site) || /^(login|signin|refreshFacet)$/i.test(site)) continue;
      const canonical = `https://${url.hostname}/${site}`;
      if (!out.some(x => x.url === canonical)) out.push({ tenant: host[1], pod: host[2], site, url: canonical, quote: match[0] });
    }
  }
  return out.slice(0, 3);
}

export async function discoverCorporateCareers(ctx: PipelineContext, name: string, candidates: string[], budget: number) {
  const http = new WebsiteHttp(ctx, Math.min(12, budget));
  const pages: { url: string; html: string }[] = [];
  const errors: { url: string; error: string }[] = [];
  const attempted = new Set<string>();
  let incomplete = false;
  for (const candidate of [...new Set(candidates)].slice(0, 2)) {
    if (http.requests >= Math.min(12, budget)) { incomplete = true; break; }
    const visit = async (url: string) => {
      attempted.add(url);
      try { return await http.page(url); }
      catch (error) {
        const message = (error as Error).message;
        errors.push({ url, error: message });
        // A nonexistent guessed domain/path is an ordinary miss. Access and transport
        // failures remain retryable; do not record them as evidence of absence.
        if (!/HTTP (404|410)|ENOTFOUND/.test(message)) incomplete = true;
        return null;
      }
    };
    const home = await visit(candidate);
    if (!home || !pageIdentity(home.html, name)) continue;
    if (corporateWorkdayLinks(home.html, home.url, name).length) { pages.push(home); break; }
    const root = normalizeDomain(new URL(home.url).hostname)!;
    const urls = [...careersLinks(home.html, home.url, root), `https://careers.${root}/`, `https://jobs.${root}/`, new URL("/careers", home.url).href];
    for (const url of [...new Set(urls)].filter(url => !attempted.has(url)).slice(0, 3)) {
      const page = await visit(url);
      if (!page) continue;
      const domain = normalizeDomain(new URL(page.url).hostname);
      if (!domain || !(domain === root || domain.endsWith(`.${root}`))) continue;
      // Every returned page independently names the target; an inferred domain or a
      // search result cannot supply identity, and off-domain ATS redirects are rejected.
      if (corporateWorkdayLinks(page.html, page.url, name).length) { pages.push(page); break; }
    }
    if (pages.length) break;
  }
  return { pages, requests: http.requests, errors, incomplete };
}

export function corporateCandidates(name: string, domains: string[], configured: unknown): string[] {
  const explicit = typeof configured === "string" ? [configured] : Array.isArray(configured) ? configured.filter((x): x is string => typeof x === "string") : [];
  const guessed = normalizeName(name).replace(/ /g, "");
  return [...explicit, ...domains.map(d => `https://${d}/`), ...(/^[a-z0-9-]{2,63}$/.test(guessed) ? [`https://${guessed}.com/`] : [])];
}
