"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authConfig, startSession, endSession } from "@/server/auth/session";
import { passwordMatches } from "@/server/auth/token";

// Best-effort per-instance throttle. Vercel Firewall can enforce a shared limit across instances.
const attempts = new Map<string, { count: number; until: number }>();
const WINDOW = 15 * 60 * 1000;
function attemptAllowed(key: string) {
  const now = Date.now();
  for (const [ip, value] of attempts) if (value.until <= now) attempts.delete(ip);
  const entry = attempts.get(key);
  if (entry) {
    if (entry.count >= 10) return false;
    entry.count++;
  } else {
    if (attempts.size >= 1000) return false;
    attempts.set(key, { count: 1, until: now + WINDOW });
  }
  return true;
}

export type LoginState = { error?: string };
export async function login(_: LoginState, form: FormData): Promise<LoginState> {
  const config = authConfig();
  if (!config) return { error: "Dashboard access is not configured yet. Please contact the project owner." };
  const requestHeaders = await headers();
  const ip = process.env.VERCEL
    ? requestHeaders.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"
    : "local";
  if (!attemptAllowed(ip)) return { error: "Too many attempts. Please try again in 15 minutes." };
  const password = form.get("password");
  if (typeof password !== "string" || password.length > 1024 || !passwordMatches(password, config.password)) {
    return { error: "Incorrect password. Please try again." };
  }
  attempts.delete(ip);
  await startSession();
  redirect("/");
}
export async function logout() {
  await endSession();
  redirect("/login");
}
