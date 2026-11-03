// Verbatim quote check. A signal is kept only when its quote is found in the source text.
// Only typography is forgiven (runs of whitespace, curly vs straight quotes, dash variants), the same
// tolerance as the extraction checker on the aadi-scraping-engine branch. Wording and case must match.
// The stored quote is the exact span cut from the source, so it is always a true substring.

export const MIN_QUOTE_WORDS = 3;

const TYPO: Record<string, string> = { "‘": "'", "’": "'", "‚": "'", "‛": "'", "“": '"', "”": '"', "„": '"', "–": "-", "—": "-", " ": " " };

// Normalised text plus, for each normalised character, the index of the source character it came from.
function squash(text: string): { value: string; map: number[] } {
  let value = "";
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    const ch = TYPO[text[i]] ?? text[i];
    if (/\s/.test(ch)) {
      if (!lastSpace) { value += " "; map.push(i); lastSpace = true; }
      continue;
    }
    value += ch; map.push(i); lastSpace = false;
  }
  if (value.endsWith(" ")) { value = value.slice(0, -1); map.pop(); }
  return { value, map };
}

export type QuoteCheck = { ok: true; quote: string } | { ok: false; reason: string };

// minWords guards model quotes against trivial spans ("Workday"); structured evidence such as a robots.txt line may pass 1.
export function verifyQuote(quote: string | null | undefined, source: string, minWords: number = MIN_QUOTE_WORDS): QuoteCheck {
  const q = squash(quote ?? "").value.replace(/^["']+|["']+$/g, "").trim();
  if (!q) return { ok: false, reason: "empty quote" };
  if (q.split(" ").length < minWords) return { ok: false, reason: `quote is shorter than ${minWords} words` };
  const s = squash(source);
  const at = s.value.indexOf(q);
  if (at < 0) return { ok: false, reason: "quote is not verbatim in the source" };
  const start = s.map[at], end = s.map[at + q.length - 1] + 1;
  return { ok: true, quote: source.slice(start, end) };
}

// Plain text from HTML job descriptions: tags become spaces, common entities are decoded, whitespace is kept readable.
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/div|\/tr)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();
}
