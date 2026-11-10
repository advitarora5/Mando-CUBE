import { normalizeName } from "../domain/ingestion/normalize.ts";
import { chicagoToday, daysSince } from "../domain/scoring/go-live.ts";
import { documentDates, type WebEmployeeEvidence } from "./employee-document-evidence.ts";

// A deliberately narrow PDF-text layout: employee-information section, historical
// year columns followed by one explicitly dated column, two staff components and
// their reconciled total. Never infer a year-end date or take an arbitrary Total.
export function employeeTableEvidence(text: string, companyName: string, source: string, now: Date): WebEmployeeEvidence[] {
  const company = normalizeName(companyName);
  if (!company || !(` ${normalizeName(text.slice(0, 4000))} `).includes(` ${company} `)) return [];
  const results: WebEmployeeEvidence[] = [];
  const numericRow = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\s+(?:\d{1,3}(?:,\d{3})+|\d+))*$/;
  for (const match of text.matchAll(/(?:^|\n)([^\n]*employee information[^\n]*)\n([\s\S]{0,900}?\bTotal[^\n]*)([^\n]*(?:\n[^\n]*){0,2})/gi)) {
    const section = match[1] + "\n" + match[2];
    const previous = text.slice(Math.max(0, match.index! - 180), match.index).trim().split(/\n/).at(-1) ?? "";
    const precedingHeading = /^[A-Za-z &-]{1,80}$/.test(previous);
    if (precedingHeading && ![company, `${company} annual report`, "annual report", "operation highlights", "operational highlights"].includes(normalizeName(previous))) continue;
    if (/\b(?:operations|workforce|employees?|staff|region|division|branch)\b/i.test(previous) && !/^(?:[IVX.\s]+)?Operation(?:al)? Highlights$/i.test(previous)) continue;
    // A location/entity qualifier in the section title is not an employer total.
    const title = match[1].replace(/^\s*\d+\.\s*/, "");
    const sectionTitle = title.match(/^(?:Group\s+)?Employee information\b(.*)$/i);
    if (!sectionTitle || (sectionTitle[1].trim() && (!/^\s*(?:(?:as of|as at)\s+)?(?:[A-Za-z]+\s+\d{1,2},?\s+20\d{2}|20\d{2}-\d{2}-\d{2})\s*$/i.test(sectionTitle[1]) || documentDates(sectionTitle[1]).length !== 1))) continue;
    const context = (precedingHeading ? previous + "\n" : "") + section + match[3];
    // These qualifiers must not disappear when PDF cells/lines are flattened.
    if (/subsidiar|parent|affiliat|regional|domestic|overseas|division|branch|\b(?:UK|US|Europe|Asia|Taiwan|China)\b|contract|part.time|FTE|equivalent|customer|supplier|forecast|target|approximately|about|estimate|[~≈%]/i.test(context)) continue;
    if (/\bgroup\b/i.test(context) && !/\bgroup\b/i.test(companyName)) continue;
    const header = section.match(/\bYear\s+((?:20\d{2}\s+){1,5})As (?:of|at)\s+([\s\S]+?)\s+No\.?(?:\s+of)?\s+Employees?\s*\n/i);
    if (!header) continue;
    const dates = documentDates(header[2].replace(/\s+/g, " "));
    if (dates.length !== 1) continue;
    const as_of = dates[0], age = daysSince(as_of, now);
    if (age === null || age < 0 || age > 548) continue;
    const historical = header[1].trim().split(/\s+/).map(Number);
    if (historical.some((year, i) => year >= Number(as_of.slice(0, 4)) || (i > 0 && year <= historical[i - 1]))) continue;
    const rows = section.slice(header.index! + header[0].length).trim().split(/\n/).map(row => row.trim());
    if (rows.length !== 3) continue;
    const labels = [/^Direct staff\s+/i, /^Indirect staff\s+/i, /^Total\s+/i];
    const values = rows.map((row, i) => labels[i].test(row) ? row.replace(labels[i], "").trim() : "");
    if (values.some(row => !numericRow.test(row))) continue;
    const columns = historical.length + 1;
    const counts = values.map(row => row.split(/\s+/).map(value => Number(value.replaceAll(",", ""))));
    if (counts.some(row => row.length !== columns || row.some(value => !Number.isSafeInteger(value) || value < 0))) continue;
    if (counts[2].some((total, i) => counts[0][i] + counts[1][i] !== total)) continue;
    // A repeated section date must agree with the selected column, not override it.
    if (documentDates(match[1]).some(date => date !== as_of)) continue;
    results.push({ employee_count: counts[2][columns - 1], as_of, source,
      basis: "exact", date_basis: "effective", observed_on: chicagoToday(now), quote: section.trim().slice(0, 1000) });
  }
  return results;
}
