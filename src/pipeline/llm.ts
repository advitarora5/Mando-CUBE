// Model providers behind one LLMProvider interface. Ollama (local, free) is the default.
// OpenAI and Gemini (OpenAI-compatible endpoint) are optional and OFF unless PIPELINE_ALLOW_PAID_LLM=1 and a key is set.
import type { LLMProvider, LLMRequest, LLMResponse } from "./types.ts";

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  readonly worstCaseUsd = 0;
  readonly model: string;
  private host: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  // 6144 tokens fits prompt + 10k characters of text + reply, and keeps a 7B model fully on a 6 GB GPU.
  private numCtx: number;
  constructor(opts: { host?: string; model?: string; fetchImpl?: typeof fetch; timeoutMs?: number; numCtx?: number } = {}) {
    this.host = (opts.host ?? "http://localhost:11434").replace(/\/$/, "");
    this.model = opts.model ?? "qwen2.5:7b";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 180000;
    this.numCtx = opts.numCtx ?? Number(process.env.OLLAMA_NUM_CTX ?? 6144);
  }
  async complete(request: LLMRequest): Promise<LLMResponse> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.host}/api/chat`, {
        method: "POST", signal: controller.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model, stream: false, format: request.schema,
          options: { temperature: 0, seed: request.seed ?? 42, num_ctx: this.numCtx },
          messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
        }),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, error: `ollama HTTP ${res.status}: ${text.slice(0, 200)}`, cost_usd: 0, ms: Date.now() - started };
      let content: string;
      try { content = JSON.parse(text)?.message?.content ?? ""; } catch { return { ok: false, error: "ollama returned non-JSON envelope", raw: text.slice(0, 500), cost_usd: 0, ms: Date.now() - started }; }
      try { return { ok: true, json: JSON.parse(content), raw: content, cost_usd: 0, ms: Date.now() - started }; }
      catch { return { ok: false, error: "model reply is not valid JSON", raw: content.slice(0, 500), cost_usd: 0, ms: Date.now() - started }; }
    } catch (error) {
      return { ok: false, error: (error as Error)?.name === "AbortError" ? "ollama timeout" : `ollama unreachable: ${(error as Error)?.message}`, cost_usd: 0, ms: Date.now() - started };
    } finally { clearTimeout(timer); }
  }
}

// OpenAI-compatible chat completions with a JSON schema response format. Prices are per million tokens.
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly worstCaseUsd: number;
  private baseUrl: string;
  private apiKey: string;
  private price: { input: number; output: number };
  private fetchImpl: typeof fetch;
  constructor(opts: { name: string; baseUrl: string; apiKey: string; model: string; pricePerMTok: { input: number; output: number }; fetchImpl?: typeof fetch }) {
    this.name = opts.name; this.model = opts.model; this.baseUrl = opts.baseUrl.replace(/\/$/, ""); this.apiKey = opts.apiKey;
    this.price = opts.pricePerMTok; this.fetchImpl = opts.fetchImpl ?? fetch;
    // 6k input + 1k output tokens is above any single extraction prompt.
    this.worstCaseUsd = (6000 * this.price.input + 1000 * this.price.output) / 1e6;
  }
  async complete(request: LLMRequest): Promise<LLMResponse> {
    const started = Date.now();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          // Gemini's OpenAI-compatible endpoint answers 400 to a seed field.
          model: this.model, temperature: 0, ...(this.name === "gemini" ? {} : { seed: request.seed ?? 42 }),
          response_format: { type: "json_schema", json_schema: { name: "extraction", strict: false, schema: request.schema } },
          messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
        }),
      });
      const data = await res.json().catch(() => null) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
      const usage = data?.usage ?? {};
      const cost = ((usage.prompt_tokens ?? 0) * this.price.input + (usage.completion_tokens ?? 0) * this.price.output) / 1e6;
      if (!res.ok || !data) return { ok: false, error: `${this.name} HTTP ${res.status}`, cost_usd: cost, ms: Date.now() - started };
      const content = data.choices?.[0]?.message?.content ?? "";
      try { return { ok: true, json: JSON.parse(content), raw: content, cost_usd: cost, ms: Date.now() - started }; }
      catch { return { ok: false, error: "model reply is not valid JSON", raw: content.slice(0, 500), cost_usd: cost, ms: Date.now() - started }; }
    } catch (error) {
      return { ok: false, error: `${this.name} unreachable: ${(error as Error)?.message}`, cost_usd: 0, ms: Date.now() - started };
    }
  }
}

// PIPELINE_LLM=ollama (default) | openai | gemini. Paid providers also need PIPELINE_ALLOW_PAID_LLM=1.
export function llmFromEnv(env: NodeJS.ProcessEnv): LLMProvider | null {
  const choice = (env.PIPELINE_LLM ?? "ollama").toLowerCase();
  if (choice === "none") return null;
  if (choice === "ollama") return new OllamaProvider({ host: env.OLLAMA_HOST, model: env.OLLAMA_MODEL });
  if (env.PIPELINE_ALLOW_PAID_LLM !== "1") throw new Error(`PIPELINE_LLM=${choice} is a paid model; set PIPELINE_ALLOW_PAID_LLM=1 after approval.`);
  if (choice === "openai" && env.OPENAI_API_KEY) {
    return new OpenAICompatibleProvider({ name: "openai", baseUrl: "https://api.openai.com/v1", apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL ?? "gpt-4o-mini", pricePerMTok: { input: 0.15, output: 0.6 } });
  }
  if (choice === "gemini" && env.GEMINI_API_KEY) {
    return new OpenAICompatibleProvider({ name: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL ?? "gemini-2.0-flash", pricePerMTok: { input: 0.1, output: 0.4 } });
  }
  throw new Error(`PIPELINE_LLM=${choice} needs its API key in the environment.`);
}
