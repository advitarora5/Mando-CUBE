import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createToken, validToken, SESSION_SECONDS } from "./token";

const COOKIE = "mando_session";
export function authConfig() {
  const password = process.env.DASHBOARD_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  return password && secret && secret.length >= 32 ? { password, secret } : null;
}
export async function hasSession() {
  const config = authConfig();
  return !!config && validToken((await cookies()).get(COOKIE)?.value, config.secret, config.password);
}
export async function requireSession() {
  if (!await hasSession()) throw new Error("Your session has expired. Sign in again to save changes.");
}
export async function requirePageSession() {
  if (!await hasSession()) redirect("/login");
}
export async function startSession() {
  const config = authConfig();
  if (!config) throw new Error("Dashboard access is not configured.");
  (await cookies()).set(COOKIE, createToken(config.secret, config.password), {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: SESSION_SECONDS,
  });
}
export async function endSession() {
  (await cookies()).delete(COOKIE);
}
