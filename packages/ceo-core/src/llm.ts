// packages/ceo-core/src/llm.ts
export interface LlmConfig { baseUrl: string; apiKey: string; patrolModel: string; decideModel: string; }
export type Slot = "patrol" | "decide";
export interface ChatMsg { role: string; content: string; }
export class NonRetryableError extends Error { constructor(msg: string) { super(msg); this.name = "NonRetryableError"; } }

export class LLMClient {
  constructor(private cfg: LlmConfig, private fetchImpl: typeof fetch = fetch) {}

  /** The model a call on `slot` would use (override first). Empty config
   *  falls back per slot: patrol wants broad observation (thinking ok);
   *  decide must emit strict JSON — thinking models burn the whole budget
   *  on reasoning and return empty content (observed as decide-starve
   *  loops), so the non-thinking chat model is the safe default there. */
  modelName(slot: Slot, override?: string): string {
    if (override) return override
    if (slot === "patrol") return this.cfg.patrolModel || "deepseek-v4-flash"
    return this.cfg.decideModel || "deepseek-chat"
  }

  async chat(slot: Slot, messages: ChatMsg[], opts: { maxTokens?: number; json?: boolean } = {}):
    Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } }> {
    const model = this.modelName(slot);
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

  // Streaming chat (OpenAI-compatible SSE): delta.reasoning_content drives
  // onReasoning (the visible thinking stream), delta.content drives onContent.
  // Retries with backoff only while the connection has not produced any SSE
  // payload yet — once the stream started, a failure surfaces immediately.
  async chatStream(slot: Slot, messages: ChatMsg[], opts: {
    maxTokens?: number; signal?: AbortSignal; model?: string;
    onReasoning?: (delta: string) => void; onContent?: (delta: string) => void;
  } = {}): Promise<{ content: string; reasoning: string; usage: { promptTokens: number; completionTokens: number } }> {
    const model = this.modelName(slot, opts.model);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let started = false; // first SSE payload seen: past this point no retry
      try {
        const res = await this.fetchImpl(`${this.cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify({
            model, messages, max_tokens: opts.maxTokens ?? 2048, stream: true,
            stream_options: { include_usage: true }, // final chunk carries usage
          }),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        if (!res.ok) {
          if (res.status >= 500 && !opts.signal?.aborted) { lastErr = new Error(`llm ${res.status}`); if (attempt < 2) await sleep(2 ** attempt * 200); continue; }
          throw new NonRetryableError(`llm ${res.status}: ${await res.text()}`);
        }
        if (!res.body) throw new NonRetryableError("llm stream: empty body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let content = "";
        let reasoning = "";
        let usage = { promptTokens: 0, completionTokens: 0 };
        // one `data: ` payload; returns true on [DONE]
        const payload = (p: string): boolean => {
          if (p === "[DONE]") return true;
          let j: { choices?: { delta?: { content?: unknown; reasoning_content?: unknown } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
          try { j = JSON.parse(p); } catch { return false; } // keep-alive/评论行
          if (j.usage) usage = { promptTokens: j.usage.prompt_tokens ?? 0, completionTokens: j.usage.completion_tokens ?? 0 };
          const delta = j.choices?.[0]?.delta;
          if (delta) {
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
              started = true; reasoning += delta.reasoning_content; opts.onReasoning?.(delta.reasoning_content);
            }
            if (typeof delta.content === "string" && delta.content) {
              started = true; content += delta.content; opts.onContent?.(delta.content);
            }
          }
          return false;
        };
        const block = (b: string): boolean => {
          for (const raw of b.split("\n")) {
            const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
            if (!line.startsWith("data:")) continue;
            const p = line.slice(5).trim();
            if (!p) continue;
            if (payload(p)) return true;
          }
          return false;
        };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep: number;
          // SSE events are separated by a blank line
          while ((sep = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            if (block(chunk)) { buf = ""; try { void reader.cancel(); } catch { /* already closed */ } return { content, reasoning, usage }; }
          }
        }
        if (buf.trim() && block(buf)) return { content, reasoning, usage }; // unterminated tail
        return { content, reasoning, usage };
      } catch (e) {
        if (e instanceof NonRetryableError) throw e;
        if (opts.signal?.aborted) throw e; // user stop: never retried
        lastErr = e;
        if (started) throw e instanceof Error ? e : new Error("llm stream failed"); // mid-stream: no retry
        if (attempt < 2) await sleep(2 ** attempt * 200); // connection failure only
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("llm failed");
  }

  // GET /v1/models proxied for the settings UI. Success caches 10 minutes;
  // failure returns the configured patrol/decide models (deduped) uncached so
  // a later call can retry the upstream.
  private modelsCache: { at: number; models: string[] } | null = null;
  async listModels(): Promise<string[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < 600_000) return this.modelsCache.models;
    try {
      const res = await this.fetchImpl(`${this.cfg.baseUrl}/models`, { headers: { authorization: `Bearer ${this.cfg.apiKey}` } });
      if (!res.ok) throw new Error(`llm ${res.status}`);
      const j = await res.json() as { data?: { id?: unknown }[] };
      const ids = (j.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
      if (ids.length === 0) throw new Error("empty model list");
      this.modelsCache = { at: Date.now(), models: ids };
      return ids;
    } catch {
      return [...new Set([this.cfg.patrolModel, this.cfg.decideModel].filter((m) => m.length > 0))];
    }
  }
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
