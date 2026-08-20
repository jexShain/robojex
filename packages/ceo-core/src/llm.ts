// packages/ceo-core/src/llm.ts
export interface LlmConfig { baseUrl: string; apiKey: string; patrolModel: string; decideModel: string; }
export type Slot = "patrol" | "decide";
export interface ChatMsg { role: string; content: string; }
export class NonRetryableError extends Error { constructor(msg: string) { super(msg); this.name = "NonRetryableError"; } }

export class LLMClient {
  constructor(private cfg: LlmConfig, private fetchImpl: typeof fetch = fetch) {}

  async chat(slot: Slot, messages: ChatMsg[], opts: { maxTokens?: number; json?: boolean } = {}):
    Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } }> {
    const model = slot === "patrol" ? this.cfg.patrolModel : this.cfg.decideModel;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens ?? 2048, ...(opts.json ? { response_format: { type: "json_object" } } : {}) }),
        });
        if (!res.ok) { if (res.status >= 500) { lastErr = new Error(`llm ${res.status}`); if (attempt < 2) await sleep(2 ** attempt * 200); continue; } throw new NonRetryableError(`llm ${res.status}: ${await res.text()}`); }
        const j = await res.json() as { choices?: { finish_reason?: string; message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        if (process.env.ROBOJEX_DEBUG_LLM === "1") {
          console.error(`[llm:${slot}] usage=${JSON.stringify(j.usage)} finish=${j.choices?.[0]?.finish_reason} content=${JSON.stringify(j.choices?.[0]?.message?.content ?? "").slice(0, 300)}`);
        }
        return {
          content: j.choices?.[0]?.message?.content ?? "",
          usage: { promptTokens: j.usage?.prompt_tokens ?? 0, completionTokens: j.usage?.completion_tokens ?? 0 },
        };
      } catch (e) {
        if (e instanceof NonRetryableError) throw e;
        lastErr = e;
        if (attempt < 2) await sleep(2 ** attempt * 200);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("llm failed");
  }
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
