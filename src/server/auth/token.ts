import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_SECONDS = 7 * 24 * 60 * 60;
export function passwordMatches(input: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(input).digest(), createHash("sha256").update(expected).digest());
}
function signature(payload: string, secret: string, password: string) {
  // Changing either environment value invalidates existing sessions.
  const key = createHmac("sha256", secret).update(password).digest();
  return createHmac("sha256", key).update(payload).digest("base64url");
}
export function createToken(secret: string, password: string, now = Date.now()): string {
  const payload = `${Math.floor(now / 1000) + SESSION_SECONDS}.${randomBytes(16).toString("hex")}`;
  return `${payload}.${signature(payload, secret, password)}`;
}
export function validToken(token: string | undefined, secret: string, password: string, now = Date.now()): boolean {
  if (!token || token.length > 256) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expiry, nonce, supplied] = parts;
  if (!/^\d+$/.test(expiry) || !/^[a-f0-9]{32}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) return false;
  const remaining = Number(expiry) - Math.floor(now / 1000);
  if (remaining <= 0 || remaining > SESSION_SECONDS) return false;
  const expected = signature(`${expiry}.${nonce}`, secret, password);
  return supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
