export type Evidence = { source: string; reason: string };

// Stored format, one string per category: "https://source | one-line reason".
// Format validation establishes presence, not factual credibility of the source.
export function parseEvidence(value: string | null | undefined): Evidence | null {
  if (!value) return null;
  const split = value.indexOf("|");
  if (split < 0) return null;
  const reason = value.slice(split + 1).trim();
  if (!reason) return null;
  try {
    const url = new URL(value.slice(0, split).trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { source: url.href, reason };
  } catch { return null; }
}

export function hasEvidence(value: string | null | undefined): boolean {
  return parseEvidence(value) !== null;
}

// Returns null when the source is not an HTTP(S) link or the reason is empty.
export function formatEvidence(source: string | null | undefined, reason: string | null | undefined): string | null {
  const line = (reason ?? "").replace(/\s+/g, " ").trim();
  // The separator must not appear in the link, or the reason would be split in the wrong place.
  const link = (source ?? "").trim().replaceAll("|", "%7C");
  const value = `${link} | ${line}`;
  return parseEvidence(value) ? value : null;
}
