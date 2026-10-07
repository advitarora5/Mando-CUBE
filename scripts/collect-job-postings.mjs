// Collect active Workday job postings from public job-board APIs.
//
// Preview-only: this script never writes to the database and never assigns
// scores. It queries the public Greenhouse and Lever JSON APIs for postings
// mentioning Workday and prints reviewer-ready rows (posting URL,
// requisition, employer, checked date, active status) for the research queue.
//
// Board mappings must be supplied by a human in the input file; the script
// never guesses which board a company uses.
//
// Usage:
//   node scripts/collect-job-postings.mjs --boards <file.json> [--out <file.json>]
//
// Input JSON: [{ "company": "Acme", "board": "greenhouse", "board_token": "acme" }]
// Supported boards: "greenhouse" (token = boards-api board token),
// "lever" (token = Lever site name).

const FETCH_TIMEOUT_MS = 15000;
const KEYWORDS = /\bworkday\b/i;

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function fetchJson(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "user-agent": "mando-cube-job-postings-collector/1.0 (review use)" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function greenhouseRows(company, boardToken, payload, checkedAt) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  return jobs
    .filter((job) => KEYWORDS.test(`${job?.title ?? ""} ${job?.content ?? ""}`))
    .map((job) => ({
      company,
      title: job.title ?? "(untitled)",
      posting_url: job.absolute_url ?? `https://boards.greenhouse.io/${boardToken}/jobs/${job.id ?? ""}`,
      requisition: job.requisition_id ? String(job.requisition_id) : null,
      location: job?.location?.name ?? null,
      employer: company,
      checked_at: checkedAt,
      active: true,
      source: "greenhouse",
    }));
}

export async function collectJobPostings(boards, { fetchImpl = fetch, now = new Date() } = {}) {
  const checkedAt = now.toISOString().slice(0, 10);
  const rows = [];
  for (const entry of boards) {
    const company = entry?.company;
    const board = String(entry?.board ?? "").toLowerCase();
    const token = entry?.board_token;
    if (!company || (board !== "greenhouse" && board !== "lever") || !token) {
      rows.push({
        company: company ?? "(unnamed)",
        title: null,
        posting_url: null,
        requisition: null,
        location: null,
        employer: company ?? null,
        checked_at: checkedAt,
        active: false,
        source: board || null,
        note: "Needs company, board (greenhouse|lever), and board_token; board mappings are never guessed.",
      });
      continue;
    }
    const url = board === "greenhouse"
      ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`
      : `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;
    let payload;
    try {
      payload = await fetchJson(url, fetchImpl);
    } catch (error) {
      rows.push({
        company,
        title: null,
        posting_url: null,
        requisition: null,
        location: null,
        employer: company,
        checked_at: checkedAt,
        active: false,
        source: board,
        note: `Board unreadable (${error instanceof Error ? error.message : "fetch failed"}); check the token manually.`,
      });
      continue;
    }
    const matches = board === "greenhouse"
      ? greenhouseRows(company, token, payload, checkedAt)
      : leverRows(company, token, payload, checkedAt);
    if (!matches.length) {
      rows.push({
        company,
        title: null,
        posting_url: null,
        requisition: null,
        location: null,
        employer: company,
        checked_at: checkedAt,
        active: false,
        source: board,
        note: "No Workday postings on this board right now; recheck weekly.",
      });
    } else {
      rows.push(...matches);
    }
  }
  return rows;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--boards") args.boards = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.boards) throw new Error("Usage: node scripts/collect-job-postings.mjs --boards <file.json> [--out <file.json>]");
  return args;
}

if (process.argv[1] && import.meta.url.endsWith(String(process.argv[1]).split("/").pop())) {
  const { readFile, writeFile } = await import("node:fs/promises");
  try {
    const { boards, out } = parseArgs(process.argv.slice(2));
    const input = JSON.parse(await readFile(boards, "utf8"));
    const list = Array.isArray(input) ? input : input.boards;
    if (!Array.isArray(list)) throw new Error("Input must be an array or { boards: [...] }.");
    const rows = await collectJobPostings(list);
    const active = rows.filter((row) => row.title).length;
    console.log(JSON.stringify(rows, null, 2));
    console.log(`\n${rows.length} rows (${active} active Workday postings). No database writes performed and no scores assigned.`);
    if (out) {
      await writeFile(out, JSON.stringify(rows, null, 2) + "\n");
      console.log(`Wrote postings to ${out}.`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function leverRows(company, siteName, payload, checkedAt) {
  const postings = Array.isArray(payload) ? payload : [];
  return postings
    .filter((posting) => KEYWORDS.test(`${posting?.text ?? ""} ${posting?.description ?? ""} ${posting?.descriptionPlain ?? ""}`))
    .map((posting) => ({
      company,
      title: posting.text ?? "(untitled)",
      posting_url: posting.hostedUrl ?? `https://${siteName}.lever.co/${posting.id ?? ""}`,
      requisition: posting.id ? String(posting.id) : null,
      location: posting?.categories?.location ?? null,
      employer: posting?.categories?.department ? `${company} (${posting.categories.department})` : company,
      checked_at: checkedAt,
      active: true,
      source: "lever",
    }));
}
