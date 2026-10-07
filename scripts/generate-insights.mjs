// Generates persona / level / why-now from stored score evidence. Dry run by default: review the printout, then add --apply. --only=<text> limits to company names containing <text>.
// Works with any OpenAI-compatible endpoint. Default is local Ollama; for OpenAI set LLM_BASE_URL=https://api.openai.com/v1, LLM_API_KEY, LLM_MODEL.
// Only *_generated columns are written, so human overrides are never touched. Companies already generated since their latest score are skipped (--force to redo).
import { createClient } from "@supabase/supabase-js";
import { buildPrompt, parseInsights } from "../src/domain/insights/generate.ts";

const { SUPABASE_URL, SUPABASE_SECRET_KEY, LLM_API_KEY = "ollama", LLM_BASE_URL = "http://localhost:11434/v1", LLM_MODEL = "llama3.1" } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error("Configure database credentials in .env.local first.");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).toLowerCase(); // e.g. --only="Demo Company"
const apply = process.argv.includes("--apply"), force = process.argv.includes("--force");
const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const { data, error } = await db.from("companies").select("*, contacts(name, title), scores(*), company_insights(generated_at)");
if (error) throw new Error(error.message);

for (const c of data) {
  const score = c.scores.sort((a, b) => b.assessed_at.localeCompare(a.assessed_at))[0];
  const done = [c.company_insights].flat()[0]?.generated_at;
  if (!score || (only && !c.name.toLowerCase().includes(only)) || (!force && done && done > score.assessed_at)) continue;
  try {
    const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({ model: LLM_MODEL, temperature: 0.2, response_format: { type: "json_object" }, messages: [{ role: "user", content: buildPrompt({ ...c, score }) }] }),
    }).catch(() => { throw new Error(`cannot reach ${LLM_BASE_URL}. Is Ollama running?`); });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
    const out = parseInsights((await res.json()).choices[0].message.content);
    console.log(`\n${c.name} (score ${score.total})\n  persona: ${out.persona}\n  level:   ${out.level}\n  why now: ${out.why_now}`);
    if (apply) {
      const { error } = await db.from("company_insights").upsert({ company_id: c.id, persona_generated: out.persona, level_generated: out.level, why_now_generated: out.why_now, generated_at: new Date().toISOString() });
      if (error) throw new Error(error.message);
    }
  } catch (e) { console.error(`\n${c.name}: SKIPPED - ${e.message}`); }
}
if (!apply) console.log("\nDry run. Nothing saved; re-run with --apply after spot-checking.");
