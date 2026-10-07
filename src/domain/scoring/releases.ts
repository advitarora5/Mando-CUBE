import { chicagoToday } from "./go-live.ts";
import { releaseBands } from "./rubric.ts";

export type WorkdayRelease = { name: string; date: string; confirmed: boolean };

// Workday delivers two feature releases a year to every production tenant on the same Saturday:
// R1 in March and R2 in September. Add each date here once Workday publishes it.
const confirmedReleases: Record<string, string> = {
  "2023R1": "2023-03-11", "2023R2": "2023-09-16",
  "2024R1": "2024-03-09", "2024R2": "2024-09-21",
  "2025R1": "2025-03-15", "2025R2": "2025-09-20",
  "2026R1": "2026-03-14", "2026R2": "2026-09-19",
};

function nthSaturday(year: number, month: number, n: number): string {
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const day = 1 + ((6 - firstWeekday + 7) % 7) + 7 * (n - 1);
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

// Unpublished dates are estimated from the usual pattern: second Saturday of March, third Saturday of September.
export function workdayRelease(year: number, half: 1 | 2): WorkdayRelease {
  const name = `${year}R${half}`;
  const confirmed = confirmedReleases[name];
  return { name, date: confirmed ?? (half === 1 ? nthSaturday(year, 2, 2) : nthSaturday(year, 8, 3)), confirmed: !!confirmed };
}

// First feature release whose production date is on or after the given YYYY-MM-DD date.
export function firstReleaseOnOrAfter(date: string): WorkdayRelease {
  const year = Number(date.slice(0, 4));
  return [workdayRelease(year, 1), workdayRelease(year, 2), workdayRelease(year + 1, 1)].find(release => release.date >= date)!;
}

// Release Alignment points from the release calendar alone (Chicago calendar days).
// Every Workday customer shares the same release date, so this is the same for all companies on a given day.
export function releaseScore(now: Date = new Date()): { score: number; reason: string } {
  const today = chicagoToday(now);
  const release = firstReleaseOnOrAfter(today);
  const days = Math.round((Date.parse(release.date) - Date.parse(today)) / 86400000);
  const { score, label } = releaseBands.find(band => days <= band.maxDays)!;
  const when = days === 0 ? "today" : `${days} ${days === 1 ? "day" : "days"} away`;
  return { score, reason: `Next Workday release ${release.name} is ${release.confirmed ? "on" : "estimated for"} ${release.date}, ${when} (${label}).` };
}
