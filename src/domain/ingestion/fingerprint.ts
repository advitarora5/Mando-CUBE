import { createHash } from "node:crypto";

// Stable JSON: object keys sorted at every level, so key order never changes a fingerprint.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Fingerprint of a raw item's content. JSON bodies are canonicalised; volatile fields can be dropped first.
export function contentFingerprint(body: string, volatileKeys: string[] = []): string {
  try {
    const parsed = JSON.parse(body);
    return sha256(canonicalJson(dropKeys(parsed, new Set(volatileKeys))));
  } catch {
    return sha256(body.replace(/\r\n/g, "\n"));
  }
}

function dropKeys(value: unknown, keys: Set<string>): unknown {
  if (!keys.size) return value;
  if (Array.isArray(value)) return value.map(item => dropKeys(item, keys));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !keys.has(key)).map(([key, item]) => [key, dropKeys(item, keys)]));
  }
  return value;
}

// Idempotency key for a paid call: the same subject and step always produce the same key.
export function paidCallKey(provider: string, step: string, subject: string): string {
  return `${provider}:${step}:${sha256(subject.trim().toLowerCase()).slice(0, 32)}`;
}
