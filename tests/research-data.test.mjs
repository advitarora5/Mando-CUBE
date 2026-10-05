import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Papa from "papaparse";
import {dataPath, validateResearch, csv} from "../scripts/research-data.mjs";
const data = JSON.parse(await readFile(dataPath,"utf8"));

test("research cohort matches existing tables with complete source coverage", () => {
  assert.deepEqual(validateResearch(data), {companies:110, contacts:73, companiesWithContacts:72, sourcedSizeAtLeast3000:102});
});
test("reject orphan contacts, guessed signal dates, fake scores, and duplicate profiles", () => {
  for (const mutate of [d => d.contacts[0].company_id = "missing", d => d.companies[0].workday_signal_date = "2026-01-01", d => d.company_evidence[0].qualification_score = 80, d => d.contacts[1].linkedin_url = d.contacts[0].linkedin_url]) {
    const changed = structuredClone(data); mutate(changed);
    assert.throws(() => validateResearch(changed));
  }
});
test("reject missing identity evidence and claimed unverified mutuals", () => {
  const changed = structuredClone(data);
  changed.contact_evidence[0].identity_source = "";
  assert.throws(() => validateResearch(changed));
  changed.contact_evidence[0].identity_source = data.contact_evidence[0].identity_source;
  changed.contacts[0].mutual_connection = "Adi";
  assert.throws(() => validateResearch(changed));
});
test("CSV round trips international names, commas, quotes, and empty unknowns", () => {
  const parsed = Papa.parse(csv(data.contacts), {header:true,skipEmptyLines:true});
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.data.length,73);
  assert.equal(parsed.data.find(c => c.name === "Jürgen Schwenk").title, data.contacts.find(c => c.name === "Jürgen Schwenk").title);
  assert.equal(parsed.data[0].mutual_connection, "");
});

test("current-source contacts require matching identity, date and employer evidence", () => {
  assert.equal(data.contact_evidence.filter(e => e.role_status === "company_listed_role_checked").length, 19);
  for (const field of ["identity_source", "checked_at", "verification_basis"]) {
    const changed = structuredClone(data);
    changed.contact_evidence.find(e => e.role_status === "company_listed_role_checked")[field] = "";
    assert.throws(() => validateResearch(changed));
  }
});
