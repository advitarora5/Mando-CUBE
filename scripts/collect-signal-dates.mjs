// Collect Workday go-live signal-date candidates for reviewer approval.
//
// Preview-only: this script never writes to the database. It fetches each
// company's Workday story (or homepage fallback), scans for go-live-date
// statements, and prints reviewer-ready rows. Only rows marked storable may
// become a workday_signal_date; everything else is research context.
//
// Usage:
//   node scripts/collect-signal-dates.mjs --companies <file.json> [--out <file.json>]
//
// Input JSON: [{ "name": "Acme", "domain": "acme.example", "source": "https://www.workday.com/..." }]
// At least one of domain/source is required per company; the script never
// guesses URLs.
//
// Research rule: an exact HCM go-live date is storable only when a source
// states it. Announcement dates, selection dates, finance-only launches,
// year-only phrases ("went live in 2025"), and date ranges are not storable.

const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_CHARS = 500000;
const MONTHS = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)";

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

// Exported for tests: fetch is injectable so checks stay offline.
export async function fetchText(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "user-agent": "mando-cube-signal-date-collector/1.0 (review use)" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    return text.slice(0, MAX_HTML_CHARS);
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}
// A date counts as EXACT only when it has a day-level calendar date:
// "March 4, 2024", "4 March 2024", "03/04/2024", or ISO "2024-03-04".
// Month-year ("March 2024"), year-only ("2025"), quarters, seasons, and
// ranges are approximate by construction.
const EXACT_PATTERNS = [
  new RegExp(`${MONTHS}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}`, "i"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS}\\s+\\d{4}`, "i"),
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
];
const APPROXIMATE_PATTERNS = [
  new RegExp(`${MONTHS}\\s+\\d{4}`, "i"),
  /\bQ[1-4]\s+\d{4}\b/i,
  /\b(19|20)\d{2}\b/,
];
const GO_LIVE_KEYWORDS = /\b(went live|go-live|go live|live on workday|live with workday|deployed workday|launched workday|workday (is|went) live)\b/i;
const ANNOUNCEMENT_KEYWORDS = /\b(announced|announcement|selected|selection|chose|chooses|partnership|partnered|plans to|will deploy|implementation (begins|starts|underway)|contract|signed)\b/i;
const FINANCE_ONLY_KEYWORDS = /\b(financial management|financials|accounting|adaptive planning|payroll only)\b/i;

function findDates(text) {
  const found = [];
  for (const pattern of EXACT_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    let match;
    while ((match = re.exec(text)) !== null) found.push({ raw: match[0], exact: true });
  }
  if (!found.length) {
    for (const pattern of APPROXIMATE_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
      let match;
      while ((match = re.exec(text)) !== null) found.push({ raw: match[0], exact: false });
    }
  }
  return found;
}

function contextAround(text, raw, window = 160) {
  const index = text.indexOf(raw);
  if (index < 0) return raw;
  const start = Math.max(0, index - window);
  const end = Math.min(text.length, index + raw.length + window);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

function normalizeIso(raw) {
  const iso = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slashed = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slashed) {
    return `${slashed[3]}-${slashed[1].padStart(2, "0")}-${slashed[2].padStart(2, "0")}`;
  }
  return null;
}


export function extractSignalCandidates(html, sourceUrl) {
  const text = stripHtml(html);
  const rows = [];
  if (!GO_LIVE_KEYWORDS.test(text)) {
    return [{
      candidate_date: null,
      date_type: "none",
      source_url: sourceUrl,
      reason: "No go-live statement found on this page.",
      storable: false,
    }];
  }
  for (const { raw, exact } of findDates(text)) {
    const context = contextAround(text, raw);
    const announced = ANNOUNCEMENT_KEYWORDS.test(context);
    const financeOnly = FINANCE_ONLY_KEYWORDS.test(context);
    let dateType = exact ? "exact" : "approximate";
    let reason;
    let storable = false;
    if (!exact) {
      reason = `Approximate date "${raw}" near a go-live statement; not an exact HCM go-live date. Context: ${context}`;
    } else if (financeOnly) {
      dateType = "announcement";
      reason = `Date "${raw}" appears tied to a non-HCM product; HCM go-live not confirmed. Context: ${context}`;
    } else if (announced) {
      dateType = "announcement";
      reason = `Date "${raw}" reads as an announcement/selection date, not a go-live date. Context: ${context}`;
    } else {
      const iso = normalizeIso(raw);
      reason = `Exact date "${raw}"${iso ? ` (${iso})` : ""} beside a Workday go-live statement; reviewer must confirm HCM scope before storing. Context: ${context}`;
      storable = true;
    }
    rows.push({
      candidate_date: normalizeIso(raw) ?? raw,
      date_type: dateType,
      source_url: sourceUrl,
      reason,
      storable,
    });
  }
  if (!rows.length) {
    rows.push({
      candidate_date: null,
      date_type: "none",
      source_url: sourceUrl,
      reason: "Go-live language found but no calendar date nearby; manual review needed.",
      storable: false,
    });
  }
  return rows;
}

export async function collectSignalDates(companies, { fetchImpl = fetch } = {}) {
  const rows = [];
  for (const company of companies) {
    if (!company?.name || (!company.source && !company.domain)) {
      rows.push({
        company: company?.name ?? "(unnamed)",
        candidate_date: null,
        date_type: "skipped",
        source_url: null,
        reason: "Needs a Workday story URL or company domain; URLs are never guessed.",
        storable: false,
      });
      continue;
    }
    const urls = [company.source, company.domain ? `https://${String(company.domain).replace(/^https?:\/\//, "")}` : null].filter(Boolean);
    for (const url of urls) {
      let html;
      try {
        html = await fetchText(url, fetchImpl);
      } catch (error) {
        rows.push({
          company: company.name,
          candidate_date: null,
          date_type: "unreachable",
          source_url: url,
          reason: `Could not read page (${error instanceof Error ? error.message : "fetch failed"}).`,
          storable: false,
        });
        continue;
      }
      for (const candidate of extractSignalCandidates(html, url)) {
        rows.push({ company: company.name, ...candidate });
      }
      break;
    }
  }
  return rows;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--companies") args.companies = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.companies) throw new Error("Usage: node scripts/collect-signal-dates.mjs --companies <file.json> [--out <file.json>]");
  return args;
}

if (process.argv[1] && import.meta.url.endsWith(String(process.argv[1]).split("/").pop())) {
  const { readFile, writeFile } = await import("node:fs/promises");
  try {
    const { companies, out } = parseArgs(process.argv.slice(2));
    const input = JSON.parse(await readFile(companies, "utf8"));
    const list = Array.isArray(input) ? input : input.companies;
    if (!Array.isArray(list)) throw new Error("Input must be an array or { companies: [...] }.");
    const rows = await collectSignalDates(list);
    const storable = rows.filter((row) => row.storable).length;
    console.log(JSON.stringify(rows, null, 2));
    console.log(`\n${rows.length} candidate rows (${storable} storable exact dates). No database writes performed; a reviewer must approve storable rows.`);
    if (out) {
      await writeFile(out, JSON.stringify(rows, null, 2) + "\n");
      console.log(`Wrote candidates to ${out}.`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
