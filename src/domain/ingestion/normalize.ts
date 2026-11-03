// Company identity helpers used by matching and dedupe. Pure functions: no I/O.

// Legal and filler words that do not distinguish one company from another.
const SUFFIXES = new Set([
  "inc", "incorporated", "corp", "corporation", "co", "company", "companies", "ltd", "limited", "llc", "llp", "lp", "plc",
  "holdings", "holding", "group", "sa", "ag", "nv", "se", "bv", "gmbh", "spa", "the", "de", "class", "a", "b", "com",
]);

// "NVIDIA CORP" -> "nvidia", "Land O'Lakes, Inc." -> "land olakes", "AT&T Inc." -> "at and t".
export function normalizeName(name: string | null | undefined): string {
  const words = (name ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\/[a-z]{2}\/?/g, " ") // SEC state tags such as "/DE/" or "/ON/"
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim().split(" ").filter(Boolean);
  const kept = words.filter(word => !SUFFIXES.has(word));
  return (kept.length ? kept : words).join(" ");
}

// "https://www.Example.com/careers?x=1" -> "example.com". Returns null for anything that is not a host.
export function normalizeDomain(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(/^[a-z]+:\/\//.test(raw) ? raw : `https://${raw}`).hostname;
  } catch { return null; }
  host = host.replace(/^www\d?\./, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

function bigrams(value: string): Map<string, number> {
  const compact = value.replace(/ /g, "");
  const grams = new Map<string, number>();
  for (let i = 0; i < compact.length - 1; i++) {
    const gram = compact.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

// Dice coefficient on character bigrams of the normalized names, 0..1.
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const gx = bigrams(x), gy = bigrams(y);
  let overlap = 0, total = 0;
  for (const [gram, count] of gx) { overlap += Math.min(count, gy.get(gram) ?? 0); total += count; }
  for (const count of gy.values()) total += count;
  return total ? (2 * overlap) / total : 0;
}

// Similar enough that a person should decide whether two names are the same company.
export const SIMILAR_NAME_THRESHOLD = 0.8;

export function isSimilarName(a: string, b: string): boolean {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // One name is a whole-word prefix of the other: "brookfield" vs "brookfield asset management".
  if (x.length >= 4 && y.length >= 4 && (y.startsWith(`${x} `) || x.startsWith(`${y} `))) return true;
  return nameSimilarity(x, y) >= SIMILAR_NAME_THRESHOLD;
}

// Candidate Workday tenant names for a company name, most likely first.
// full_name: every kept word joined ("land olakes" -> "landolakes"); first_word is a weaker guess.
export function tenantCandidates(name: string): { tenant: string; kind: "full_name" | "first_word" }[] {
  const words = normalizeName(name).split(" ").filter(Boolean);
  if (!words.length) return [];
  const out: { tenant: string; kind: "full_name" | "first_word" }[] = [{ tenant: words.join(""), kind: "full_name" }];
  if (words.length > 1 && words[0].length >= 3 && !["and", "first", "american", "united", "general", "national"].includes(words[0])) {
    out.push({ tenant: words[0], kind: "first_word" });
  }
  return out.filter(c => /^[a-z0-9][a-z0-9-]{1,40}$/.test(c.tenant));
}
