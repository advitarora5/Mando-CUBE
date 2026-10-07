import fs from "node:fs";
import Papa from "papaparse";

const filename = process.argv[2];
if (!filename) {
  console.error('Usage: node scripts/preview-import.mjs "path/to/companies.csv"');
  process.exit(1);
}

const clean = (value) => String(value ?? "").trim();
const normalize = (value) =>
  clean(value).replace(/\s+/g, " ").toLowerCase();

let text;
try {
  text = fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, "");
} catch (error) {
  console.error(`Could not read CSV: ${error.message}`);
  process.exit(1);
}

const parsed = Papa.parse(text, { skipEmptyLines: "greedy" });
if (parsed.errors.length) {
  console.error(parsed.errors);
  process.exit(1);
}

const headerRow = parsed.data.findIndex((row) =>
  row.some((cell) => normalize(cell) === "company") &&
  row.some((cell) => normalize(cell) === "trigger event date")
);

if (headerRow < 0) {
  console.error("Could not find Company and Trigger Event Date headers.");
  process.exit(1);
}

const headers = parsed.data[headerRow].map(normalize);
const required = [
  "company",
  "trigger event date",
  "functional authority /25",
  "reachability & conviction /25",
  "customer budget /20",
  "workday release alignment /15",
  "timing trigger /15",
  "total /100",
];

if (required.some((name) => !headers.includes(name))) {
  console.error(
    "Missing headers:",
    required.filter((name) => !headers.includes(name))
  );
  process.exit(1);
}

const errors = [];
const warnings = [];
const companies = [];
const seen = new Set();

for (let i = headerRow + 1; i < parsed.data.length; i++) {
  const row = parsed.data[i];
  const get = (name) => clean(row[headers.indexOf(name)]);
  const company = get("company");

  if (!company || company === "Blue = manual input / judgment call.") continue;

  const label = `Row ${i + 1} (${company})`;
  if (seen.has(normalize(company))) {
    errors.push(`${label}: duplicate company.`);
  }
  seen.add(normalize(company));

  const rawDate = get("trigger event date");
  let triggerDate = null;

  if (!rawDate || /^(tbd\b|n\/a$|[—-]$)/i.test(rawDate)) {
    warnings.push(`${company}: trigger date unknown.`);
  } else {
    const match = rawDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

    if (match) {
      const [, month, day, year] = match.map(Number);
      const date = new Date(Date.UTC(year, month - 1, day));

      if (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      ) {
        triggerDate = date.toISOString().slice(0, 10);
      }
    }

    if (!triggerDate) {
      errors.push(
        `${label}: invalid date "${rawDate}"; expected MM/DD/YYYY.`
      );
    }
  }

  const scores = required.slice(2, 7).map((name, index) => {
    const raw = get(name);
    const value = Number(raw);
    const maximum = [25, 25, 20, 15, 15][index];

    if (!raw || !Number.isFinite(value) || value < 0 || value > maximum) {
      errors.push(`${label}: invalid ${name}.`);
    }

    return value;
  });

  const total = scores.reduce((sum, value) => sum + value, 0);
  const savedTotal = get("total /100");

  if (
    !savedTotal ||
    !Number.isFinite(Number(savedTotal)) ||
    Number(savedTotal) !== total
  ) {
    errors.push(
      `${label}: spreadsheet total does not match category sum ${total}.`
    );
  }

  companies.push({
    company,
    trigger_date: triggerDate ?? "Unknown",
    total,
  });
}

if (!companies.length) errors.push("No company rows found.");

console.table(companies);
console.log(`\n${companies.length} companies checked. No database writes performed.`);

for (const warning of warnings) console.warn(`WARNING: ${warning}`);
for (const error of errors) console.error(`ERROR: ${error}`);

console.log("\nCategory evidence must be reviewed before assigning dashboard tiers.");
process.exitCode = errors.length ? 1 : 0;