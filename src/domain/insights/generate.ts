export const levels = ["C-level", "VP", "Director", "Manager", "Individual contributor"] as const;
export type Generated = { persona: string; level: (typeof levels)[number]; why_now: string };

type Input = {
  name: string; industry: string | null; employee_count: number | null; workday_signal_date: string | null;
  contacts: { name: string; title: string | null }[];
  score: Record<string, string | number | null>;
};

// The model sees only stored evidence, so every claim traces to a source link on the company page.
export function buildPrompt(c: Input): string {
  const evidence = ["authority", "reachability", "budget", "release", "timing"]
    .map((k) => `- ${k} (${c.score[`${k}_score`]}): ${c.score[`${k}_evidence`] || "none"}`).join("\n");
  const people = c.contacts.map((p) => `- ${p.name}, ${p.title ?? "unknown title"}`).join("\n") || "- none";
  return `You help a sales team selling to Workday customers. Use ONLY the facts below; never invent facts. If evidence is thin, say so. Use the days-ago figure given; never compute dates yourself.
Company: ${c.name} | industry: ${c.industry ?? "unknown"} | employees: ${c.employee_count ?? "unknown"} | Workday signal: ${c.workday_signal_date ? `${c.workday_signal_date} (${Math.floor((Date.now() - Date.parse(c.workday_signal_date)) / 86400000)} days ago)` : "unknown"}
Contacts:\n${people}
Scored evidence:\n${evidence}

Reply with JSON only: {"persona": "<the buyer role and what it owns, max 15 words; no personal names>", "level": "<one of: ${levels.join(", ")}>", "why_now": "<1-2 natural sentences stating the TRIGGER, opening with the fact itself (e.g. "Went live on Workday N days ago..."): what happened (go-live, release, hiring, budget) and why that makes this the window to buy. A reason, never an instruction: do not start with "Reach out" or mention contacting anyone. Cite facts from the evidence, not score numbers.>"}`;
}

export function parseInsights(text: string): Generated {
  let json;
  try { json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { json = {}; }
  const ok = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  if (!ok(json.persona) || !ok(json.why_now) || !levels.includes(json.level)) throw new Error(`Bad model output: ${text.slice(0, 200)}`);
  return { persona: json.persona.trim(), level: json.level, why_now: json.why_now.trim() };
}
