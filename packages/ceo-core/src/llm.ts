// packages/ceo-core/src/llm.ts
import { createDeadline, createIdleWatchdog, type IdleWatchdog } from "./timeout.js";

export interface LlmConfig { baseUrl: string; apiKey: string; patrolModel: string; decideModel: string; thinking?: boolean; }
export type Slot = "patrol" | "decide";
export interface ChatMsg { role: string; content: string; }

/** Stable failure classes so callers (loop, chat-service, UI) can react to the
 *  *kind* of failure instead of parsing human message strings. The mapping is
 *  status-first, body-second — see httpError below. */
export type LLMErrorCode = "AUTH" | "RATE_LIMIT" | "QUOTA" | "CONTEXT_WINDOW" | "SERVER" | "NETWORK" | "TIMEOUT" | "EMPTY";

export class LLMError extends Error {
  constructor(message: string, readonly code: LLMErrorCode, readonly status?: number) { super(message); this.name = "LLMError"; }
}

/** Codes that must never be retried: the identical request would fail
 *  identically (bad key, drained balance, over-long prompt). RATE_LIMIT /
 *  SERVER / NETWORK / TIMEOUT are retryable (chatStream bounds TIMEOUT
 *  further: only while no frame has been delivered — see the started flag).
 *  EMPTY sits here defensively: the empty guard below throws it only after
 *  its one re-ask, so a catch must pass it through rather than burn more
 *  attempts. */
const NO_RETRY: ReadonlySet<LLMErrorCode> = new Set(["AUTH", "QUOTA", "CONTEXT_WINDOW", "EMPTY"]);

/** Marker for non-retryable failures that carry no stable code (unclassified
 *  4xx like 404). Kept for compatibility with pre-LLMError callers; new
 *  failures should classify into an LLMError instead. */
export class NonRetryableError extends Error { constructor(msg: string) { super(msg); this.name = "NonRetryableError"; } }

/** Hostile-throw-safe message extraction: anything can be thrown at us
 *  (strings, plain objects, even objects whose toString throws), and turning
 *  a caught value into a log/retry message must never itself crash. */
export function llmErrorMessage(e: unknown): string {
  let raw: string;
  if (e instanceof Error) raw = e.message;
  else { try { raw = String(e); } catch { raw = ""; } }
  raw = raw.trim();
  if (!raw) return "unknown llm error";
  return raw.length > 300 ? raw.slice(0, 300) : raw;
}

/** Map an HTTP failure onto a stable code (same policy as the deepseek-harness
 *  adapter's httpErrorCode). Quota wording is checked *before* 429 because a
 *  rate-limit response whose body says "quota" is balance exhaustion, not a
 *  passing throttle — retrying it only burns time. Unclassified statuses keep
 *  the old behavior: fail fast, no stable code. */
function httpError(status: number, body: string): LLMError | NonRetryableError {
  const detail = body.toLowerCase();
  const msg = `llm ${status}${body ? `: ${body.slice(0, 200)}` : ""}`; // 200 chars: status is the headline, body is a hint
  if (status === 401 || status === 403) return new LLMError(msg, "AUTH", status);
  if (status === 402 || detail.includes("insufficient_balance") || detail.includes("quota")) return new LLMError(msg, "QUOTA", status);
  if (status === 429) return new LLMError(msg, "RATE_LIMIT", status);
  if (status === 400 && detail.includes("context")) return new LLMError(msg, "CONTEXT_WINDOW", status);
  if (status >= 500) return new LLMError(msg, "SERVER", status);
  return new NonRetryableError(msg);
}

/** Retry-After is honored only as whole seconds (what providers actually
 *  send); HTTP-dates and junk fall back to pure backoff. */
function retryAfterMs(h: Headers): number | undefined {
  const v = h.get("retry-after");
  if (v !== null && /^\d+$/.test(v)) { const s = Number(v); return s > 0 ? s * 1000 : undefined; }
  return undefined;
}

/** Exponential backoff (200ms, 400ms). A 429 takes the larger of backoff and
 *  the server's Retry-After, capped at 30s so a hostile header cannot stall
 *  the agent indefinitely. */
function retryDelayMs(attempt: number, afterMs?: number): number {
  return Math.min(30_000, Math.max(2 ** attempt * 200, afterMs ?? 0));
}

/** Stream idle watchdog: no `data:` line for this long mid-stream → the answer
 *  stalled (providers do hang mid-answer); tear the read loop down instead of
 *  awaiting forever. Only data lines re-arm it — SSE comment keep-alives and
 *  consumer think time do not. */
const STREAM_IDLE_MS = 120_000;
/** Whole-attempt cap (headers + entire body). Bounds the one hang the idle
 *  watchdog cannot see: fetch() itself never settling, which only surfaces as
 *  an aborted fetch signal. Deliberately above STREAM_IDLE_MS so a
 *  slow-but-flowing stream is judged by idleness, not by total time. */
const ATTEMPT_DEADLINE_MS = 180_000;

export class LLMClient {
  /** Thinking mode is OFF unless explicitly enabled (user-facing default:
   *  plain answers, no hidden reasoning burn). Flipped live from settings. */
  private thinkingEnabled: boolean;
  constructor(private cfg: LlmConfig, private fetchImpl: typeof fetch = fetch) {
    this.thinkingEnabled = cfg.thinking === true;
  }

  /** Settings hot-apply: the next request picks the new mode, no restart. */
  setThinking(on: boolean): void { this.thinkingEnabled = on; }
  thinking(): boolean { return this.thinkingEnabled; }

  /** Wire field per the DeepSeek thinking-mode convention (same shape the
   *  deepseek-harness adapter serializes): always explicit — the product
   *  default beats the provider default. `force` overrides per call (title
   *  generation and other cheap passes never pay for reasoning). */
  private thinkingBody(force?: boolean): { thinking: { type: "enabled" | "disabled" } } {
    const on = force ?? this.thinkingEnabled;
    return { thinking: { type: on ? "enabled" : "disabled" } };
  }

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

  async chat(slot: Slot, messages: ChatMsg[], opts: { maxTokens?: number; json?: boolean; noThinking?: boolean } = {}):
    Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } }> {
    const model = this.modelName(slot);
    let lastErr: unknown = null;
    let emptyReasked = false; // the empty-response guard allows exactly one re-ask
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens ?? 2048, ...this.thinkingBody(opts.noThinking ? false : undefined), ...(opts.json ? { response_format: { type: "json_object" } } : {}) }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => ""); // body read can itself fail; the status alone still classifies
          const err = httpError(res.status, body);
          if (err instanceof LLMError && !NO_RETRY.has(err.code)) { // SERVER / RATE_LIMIT
            lastErr = err;
            if (attempt < 2) await sleep(retryDelayMs(attempt, err.code === "RATE_LIMIT" ? retryAfterMs(res.headers) : undefined));
            continue;
          }
          throw err; // AUTH / QUOTA / CONTEXT_WINDOW / unclassified 4xx: same request → same failure
        }
        const j = await res.json() as { choices?: { finish_reason?: string; message?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        if (process.env.ROBOJEX_DEBUG_LLM === "1") {
          console.error(`[llm:${slot}] usage=${JSON.stringify(j.usage)} finish=${j.choices?.[0]?.finish_reason} content=${JSON.stringify(j.choices?.[0]?.message?.content ?? "").slice(0, 300)}`);
        }
        // Empty-response guard: a 200 with no choice or null content means the
        // model produced nothing (e.g. a thinking model spending the whole
        // budget on hidden reasoning). Tool-call finishes legitimately carry
        // no content and pass through. One re-ask, then EMPTY instead of
        // silently returning "".
        const choice = j.choices?.[0];
        const content = choice?.message?.content;
        const toolFinish = typeof choice?.finish_reason === "string" && choice.finish_reason.includes("tool");
        if (choice === undefined || ((content === undefined || content === null) && !toolFinish)) {
          if (emptyReasked) throw new LLMError("empty response", "EMPTY");
          emptyReasked = true;
          lastErr = new LLMError("empty response", "EMPTY");
          if (attempt < 2) await sleep(retryDelayMs(attempt));
          continue;
        }
        return {
          content: content ?? "",
          usage: { promptTokens: j.usage?.prompt_tokens ?? 0, completionTokens: j.usage?.completion_tokens ?? 0 },
        };
      } catch (e) {
        if (e instanceof NonRetryableError || (e instanceof LLMError && NO_RETRY.has(e.code))) throw e;
        // fetch reports every transport failure (DNS, refused connection, TLS,
        // proxy) as a bare TypeError — label it NETWORK so callers can tell
        // "unreachable" apart from "broken answer".
        lastErr = e instanceof TypeError ? new LLMError(`llm network: ${llmErrorMessage(e)}`, "NETWORK") : e;
        if (attempt < 2) await sleep(retryDelayMs(attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(llmErrorMessage(lastErr));
  }

  // Streaming chat (OpenAI-compatible SSE): delta.reasoning_content drives
  // onReasoning (the visible thinking stream), delta.content drives onContent.
  // Retries with backoff only while the connection has not produced any SSE
  // payload yet — once the stream started, a failure surfaces immediately.
  // Retryable classes match chat(): 5xx, network failures, and 429 — plus
  // TIMEOUT, raised by the two hang guards below and retryable only pre-start
  // for the same reason (a retry would replay delivered deltas).
  async chatStream(slot: Slot, messages: ChatMsg[], opts: {
    maxTokens?: number; signal?: AbortSignal; model?: string;
    onReasoning?: (delta: string) => void; onContent?: (delta: string) => void;
  } = {}): Promise<{ content: string; reasoning: string; usage: { promptTokens: number; completionTokens: number } }> {
    const model = this.modelName(slot, opts.model);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let started = false; // first SSE payload seen: past this point no retry
      // Two hang guards per attempt (ported from deepseek-harness util/timeout):
      // 1) deadline — fuses the caller's abort with the whole-attempt cap and
      //    is handed to fetch(), so even a fetch() that never settles is cut.
      // 2) idle watchdog — arms the read loop; a stream that stops sending
      //    data lines mid-answer is cancelled at STREAM_IDLE_MS.
      const deadline = createDeadline(ATTEMPT_DEADLINE_MS, opts.signal);
      let watchdog: IdleWatchdog | undefined;
      let idleFired = false; // set by the watchdog callback; cancel() makes the pending read resolve as done
      try {
        const res = await this.fetchImpl(`${this.cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify({
            model, messages, max_tokens: opts.maxTokens ?? 2048, stream: true,
            stream_options: { include_usage: true }, // final chunk carries usage
            ...this.thinkingBody(), // chat streams honor the global toggle only
          }),
          signal: deadline.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          const err = httpError(res.status, body);
          if (err instanceof LLMError && !NO_RETRY.has(err.code) && !opts.signal?.aborted) { // SERVER / RATE_LIMIT, caller still wants the answer
            lastErr = err;
            if (attempt < 2) await sleep(retryDelayMs(attempt, err.code === "RATE_LIMIT" ? retryAfterMs(res.headers) : undefined));
            continue;
          }
          throw err;
        }
        if (!res.body) throw new NonRetryableError("llm stream: empty body");
        const reader = res.body.getReader();
        watchdog = createIdleWatchdog(STREAM_IDLE_MS, () => {
          idleFired = true;
          try { void reader.cancel(); } catch { /* already closed */ }
        });
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
            watchdog?.touch(); // any data line is liveness — even an unparseable keep-alive payload
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
        // reader.cancel() from the idle watchdog resolves the pending read as
        // done, so the loop above exits "cleanly" — translate that into TIMEOUT
        // here (unless the caller aborted: their cancellation wins).
        if (idleFired && !opts.signal?.aborted) throw new LLMError(`llm stream idle ${STREAM_IDLE_MS / 1000}s`, "TIMEOUT");
        if (buf.trim() && block(buf)) return { content, reasoning, usage }; // unterminated tail
        return { content, reasoning, usage };
      } catch (e) {
        if (e instanceof NonRetryableError || (e instanceof LLMError && NO_RETRY.has(e.code))) throw e;
        if (opts.signal?.aborted) throw e; // user stop: never retried
        // fetch()'s rejection shape on a deadline abort differs per runtime —
        // classify by our own marker (deadline.timedOut()), not by error text.
        lastErr = deadline.timedOut()
          ? new LLMError(`llm stream attempt exceeded ${ATTEMPT_DEADLINE_MS / 1000}s`, "TIMEOUT")
          : e instanceof TypeError ? new LLMError(`llm network: ${llmErrorMessage(e)}`, "NETWORK")
          : e;
        if (started) { // mid-stream: deltas were already delivered, a retry would replay them
          if (lastErr instanceof Error) throw lastErr;
          throw new Error(llmErrorMessage(lastErr));
        }
        if (attempt < 2) await sleep(retryDelayMs(attempt)); // connection failure only
      } finally {
        watchdog?.stop(); // nothing stays armed past the attempt, success or failure
        deadline.dispose();
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(llmErrorMessage(lastErr));
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
