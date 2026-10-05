import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const dataPath = new URL("../src/data/research/workday-companies.json", import.meta.url);
const companyFields = ["id", "name", "domain", "industry", "headquarters", "employee_count", "workday_signal_date", "source"];
const contactFields = ["id", "company_id", "name", "title", "linkedin_url", "source", "mutual_connection"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assert(ok, message) { if (!ok) throw new Error(message); }
function url(value) { try { return new URL(value).protocol === "https:"; } catch { return false; } }
function unique(rows, field, label) {
  const values = rows.map(r => r[field]);
  assert(new Set(values).size === values.length, `Duplicate ${label}`);
}
export function validateResearch(data) {
  assert(data.schema_version === 1, "Unsupported research format");
  for (const field of ["companies", "contacts", "company_evidence", "contact_evidence"]) assert(Array.isArray(data[field]), `Missing ${field}`);
  assert(data.companies.length >= 100, "At least 100 companies required");
  unique(data.companies, "id", "company ID");
  unique(data.companies.map(c => ({name: c.name?.normalize("NFKC").trim().toLowerCase()})), "name", "company name");
  unique(data.contacts, "id", "contact ID");
  unique(data.contacts, "linkedin_url", "LinkedIn profile");
  unique(data.company_evidence, "company_id", "company evidence");
  unique(data.contact_evidence, "contact_id", "contact evidence");
  const companyIds = new Set(data.companies.map(c => c.id));
  const contactIds = new Set(data.contacts.map(c => c.id));
  assert(data.company_evidence.length === companyIds.size && data.contact_evidence.length === contactIds.size, "Evidence coverage incomplete");
  for (const c of data.companies) {
    assert(JSON.stringify(Object.keys(c).sort()) === JSON.stringify([...companyFields].sort()), "Company fields differ from existing contract");
    assert(uuid.test(c.id) && c.name.trim(), "Invalid company identity");
    assert(c.employee_count === null || (Number.isInteger(c.employee_count) && c.employee_count >= 0), "Invalid workforce count");
    assert(c.workday_signal_date === null, "Initial cohort must not invent signal dates");
    assert(url(c.source) && new URL(c.source).hostname === "www.workday.com" && new URL(c.source).pathname.includes("/customer-stories/"), "Company confirmation must link to the researched Workday story");
    const e = data.company_evidence.find(e => e.company_id === c.id);
    assert(e?.confirmation_source === c.source && e.confirmation_reason?.trim() && e.confirmed_product === "Workday Human Capital Management", "Missing HCM confirmation evidence");
    assert(e.qualification_score === null && e.qualification_rank === null, "Research queue must remain separate from scoring");
    assert(e.research_gaps.length > 0 && url(e.employee_count_source), "Missing workforce evidence or gaps");
    assert(data.contacts.filter(contact => contact.company_id === c.id).length <= 3, "More than three contacts per company");
  }
  for (const c of data.contacts) {
    assert(JSON.stringify(Object.keys(c).sort()) === JSON.stringify([...contactFields].sort()), "Contact fields differ from existing table");
    assert(uuid.test(c.id) && companyIds.has(c.company_id) && c.name.trim() && c.title?.trim(), "Invalid contact or employer reference");
    assert(url(c.linkedin_url) && new URL(c.linkedin_url).hostname === "www.linkedin.com" && /^\/in\/[^/]+$/.test(new URL(c.linkedin_url).pathname), "Invalid public LinkedIn profile");
    assert(url(c.source) && c.mutual_connection === null, "Contact source missing or unverified mutual asserted");
    const e = data.contact_evidence.find(e => e.contact_id === c.id);
    assert(e?.role_source === c.source && url(e.identity_source) && e.reason?.trim(), "Missing contact evidence");
    assert(["requires_current_role_review", "company_listed_role_checked"].includes(e.role_status) && e.mutual_status === "not_verified", "Role/mutual review status missing");
    if (e.role_status === "company_listed_role_checked") assert(e.verification_basis === "employer_source_and_matching_public_profile" && e.identity_source === c.linkedin_url && /^\d{4}-\d{2}-\d{2}$/.test(e.checked_at), "Company-listed role needs dated employer and matching-profile evidence");
  }
  assert(data.company_evidence.every(e => companyIds.has(e.company_id)) && data.contact_evidence.every(e => contactIds.has(e.contact_id)), "Orphan evidence");
  return {companies: data.companies.length, contacts: data.contacts.length, companiesWithContacts: new Set(data.contacts.map(c => c.company_id)).size, sourcedSizeAtLeast3000: data.companies.filter(c => c.employee_count !== null && c.employee_count >= 3000).length};
}

export function csv(rows) {
  const fields = Object.keys(rows[0]);
  const cell = v => `"${String(v === null || v === undefined ? "" : Array.isArray(v) ? JSON.stringify(v) : v).replaceAll('"', '""')}"`;
  return "\ufeff" + [fields.map(cell).join(","), ...rows.map(row => fields.map(f => cell(row[f])).join(","))].join("\r\n") + "\r\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = JSON.parse(await readFile(dataPath, "utf8"));
  console.log(JSON.stringify(validateResearch(data), null, 2));
  if (process.argv[2] === "--export") {
    assert(process.argv[3], "Usage: node scripts/research-data.mjs --export <directory>");
    const destination = path.resolve(process.argv[3]);
    await mkdir(destination, {recursive: true});
    for (const [filename, rows] of [["companies",data.companies],["contacts",data.contacts],["company-evidence",data.company_evidence],["contact-evidence",data.contact_evidence]]) await writeFile(path.join(destination,filename + ".csv"), csv(rows));
    const checkedContacts = data.contacts.filter(c => data.contact_evidence.some(e => e.contact_id === c.id && e.role_status === "company_listed_role_checked")).map(c => ({company_name: data.companies.find(company => company.id === c.company_id).name, ...c, checked_at: data.contact_evidence.find(e => e.contact_id === c.id).checked_at}));
    if (checkedContacts.length) await writeFile(path.join(destination,"current-contact-review.csv"), csv(checkedContacts));
    await writeFile(path.join(destination,"workday-company-research.json"), JSON.stringify(data,null,2) + "\n");
    const methodology = JSON.parse(await readFile(new URL("../src/data/research/methodology.json", import.meta.url), "utf8"));
    const markdown = `# ${methodology.title}\n\nResearch cutoff: ${methodology.cutoff}\n\n` + methodology.sections.map(section => `## ${section.title}\n\n${section.paragraphs.join("\n\n")}`).join("\n\n") + "\n";
    await writeFile(path.join(destination,"company-research-methodology.md"), markdown);
    await writeFile(path.join(destination,"company-research-handoff.md"), await readFile(new URL("../docs/company-research-handoff.md", import.meta.url), "utf8"));
    const priorTracker = JSON.parse(await readFile(new URL("../src/data/research/prior-tracker-leads.json", import.meta.url), "utf8"));
    await writeFile(path.join(destination,"prior-tracker-research-priorities.csv"), csv(priorTracker.leads));
    console.log(`Exported research files to ${destination}. No database writes performed.`);
  } else assert(process.argv.length === 2, "Usage: node scripts/research-data.mjs [--export <directory>]");
}
