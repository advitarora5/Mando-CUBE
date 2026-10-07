import { goLiveBands } from "./rubric.ts";

// Today's calendar date in Chicago as YYYY-MM-DD.
export function chicagoToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// Whole calendar days in Chicago between a YYYY-MM-DD date and today. Negative when the date is in the future.
export function daysSince(date: string | null | undefined, now: Date = new Date()): number | null {
  if (!date) return null;
  const then = Date.parse(date);
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.parse(chicagoToday(now)) - then) / 86400000);
}

// Timing Trigger points from the Workday go-live date alone. The release calendar belongs to Release Alignment.
export function goLiveScore(goLiveDate: string | null | undefined, now: Date = new Date()): { score: number; reason: string } {
  const days = daysSince(goLiveDate, now);
  if (days === null) return { score: 0, reason: "No Workday go-live date on record." };
  const { score, label } = goLiveBands.find(band => days <= band.maxDays)!;
  const count = `${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"}`;
  const when = days < 0 ? `Workday go-live announced for ${goLiveDate}, ${count} away` : `Went live on Workday ${count} ago`;
  return { score, reason: `${when} (${label}).` };
}
