// packages/ceo-core/src/chat-service.ts
// Direct-chat streaming service: ChatGPT-style conversations with durable
// history (ChatStore), DeepSeek SSE pass-through (reasoning + content), abort
// support, first-round title generation and a per-conversation single-stream
// guard. SSE frames match packages/web/src/state/types.ts ChatStreamEvent.
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { LLMClient } from "./llm.js";
import type { ChatStore } from "./chat-store.js";
import type { GearController } from "./gears.js";
import { chatPrompt } from "./gears.js";
import type { BudgetGovernor } from "./budget.js";

export interface DayUsage { day: string; tokensIn: number; tokensOut: number; calls: number; }

export interface ChatServiceDeps {
  store: ChatStore;
  llm: LLMClient;
  gear: GearController;
  budget?: BudgetGovernor | null; // chat burn books into the same daily ledger
  runtimeDir?: string;            // traces.sqlite lives here (loop-cost merge)
  /** 对话即委托: every settled chat stream also feeds the orchestration loop
   *  (loop.push) — an explicit mode:'chat-only' request opts out */
  onAgentEvent?: (text: string) => void;
}

const TEXT_MAX_BYTES = 16 * 1024;
const HISTORY_MAX = 40; // messages sent to the model per stream
const CHAT_MAX_TOKENS = 8192;
const TITLE_MAX = 20;

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class ChatService {
  private active = new Map<string, AbortController>();
  constructor(private d: ChatServiceDeps) {}

  get store(): ChatStore { return this.d.store; }

  /** POST /api/chat/stream — body already JSON-parsed by the api layer.
   *  text === "" means regenerate: truncate after the last user message and
   *  stream a fresh reply over the same history. */
  async handleStream(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const rawText = typeof body.text === "string" ? body.text : null;
    if (rawText === null) { json(res, 400, { error: "text must be a string" }); return; }
    const regenerate = rawText === "";
    if (!regenerate && (rawText.trim().length === 0 || Buffer.byteLength(rawText, "utf8") > TEXT_MAX_BYTES)) {
      json(res, 400, { error: "text must be a non-empty string of at most 16KB" });
      return;
    }
    const modelOverride = typeof body.model === "string" && body.model.length > 0 ? body.model : undefined;
    // dual-channel default: a plain chat is also a delegation candidate — only
    // an explicit 'chat-only' opts out ('agent' stays accepted as an alias of
    // the now-default behavior)
    const mode = body.mode === "chat-only" ? "chat-only" : "agent";
    const convIdRaw = typeof body.conversationId === "string" && body.conversationId.length > 0 ? body.conversationId : null;

    // resolve conversation: named-but-missing → 404 (stale client id); unnamed → create
    let conv = convIdRaw ? this.d.store.get(convIdRaw) : null;
    if (convIdRaw && !conv) { json(res, 404, { error: "conversation not found" }); return; }
    if (!conv) conv = this.d.store.create(undefined, { gear: this.d.gear.current(), model: modelOverride });
    const convId = conv.id;

    // one live stream per conversation: a re-entry must not interleave rows
    if (this.active.has(convId)) { json(res, 409, { error: "stream in progress" }); return; }

    // land the user turn (regenerate keeps the existing one as history tail)
    let userMsgId: string;
    if (regenerate) {
      const lastUser = [...this.d.store.listMessages(convId)].reverse().find((m) => m.role === "user");
      if (!lastUser) { json(res, 400, { error: "nothing to regenerate: no user message in this conversation" }); return; }
      this.d.store.truncateAfterLastUser(convId);
      userMsgId = lastUser.id;
    } else {
      userMsgId = this.d.store.appendMessage(convId, { role: "user", content: rawText }).id;
    }

    // history ends at the just-landed user message; failed replies never coach the model
    const history = this.d.store.listMessages(convId).filter((m) => (m.role === "user" || m.role === "assistant") && m.content.length > 0 && !m.error);
    const isFirstRound = !history.some((m) => m.role === "assistant");
    const usedModel = this.d.llm.modelName("patrol", modelOverride);
    const llmMessages = [
      { role: "system", content: chatPrompt(this.d.gear.current()) },
      ...history.slice(-HISTORY_MAX).map((m) => ({ role: m.role, content: m.content })),
    ];

    // SSE headers first; everything past this point speaks frames, not statuses
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const assistantId = randomUUID(); // pre-allocated: meta ships it before the stream starts
    const send = (ev: Record<string, unknown>): void => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client gone: stream continues for persistence */ } };
    send({ type: "meta", conversationId: convId, userMsgId, assistantMsgId: assistantId, model: usedModel });

    const ctl = new AbortController();
    this.active.set(convId, ctl);
    let content = "";
    let reasoning = "";
    let usage = { promptTokens: 0, completionTokens: 0 };
    let streamError: string | null = null;
    let aborted = false;
    const onClose = (): void => { ctl.abort(); };
    req.on("close", onClose);
    try {
      try {
        const r = await this.d.llm.chatStream("patrol", llmMessages, {
          maxTokens: CHAT_MAX_TOKENS, signal: ctl.signal, model: modelOverride,
          onReasoning: (delta) => { reasoning += delta; send({ type: "reasoning", delta }); },
          onContent: (delta) => { content += delta; send({ type: "content", delta }); },
        });
        content = r.content; // same accumulation; canonical from the client
        reasoning = r.reasoning;
        usage = r.usage;
      } catch (e) {
        if (ctl.signal.aborted) aborted = true; // client stop: keep the partials
        else streamError = e instanceof Error ? e.message : String(e);
      }

      if (!aborted && !streamError) send({ type: "usage", tokensIn: usage.promptTokens, tokensOut: usage.completionTokens });
      if (!streamError && isFirstRound) {
        const title = await this.genTitle(convId, content);
        if (title) {
          send({ type: "title", title });
          this.d.store.update(convId, { title });
        }
      }
      if (streamError) send({ type: "error", message: streamError });
      else send({ type: "done" }); // aborted streams also settle with done

      // persist the assistant row: full on success, partial on abort, error-tagged on failure
      this.d.store.appendMessage(convId, {
        id: assistantId, role: "assistant", content, reasoning, model: usedModel,
        tokensIn: usage.promptTokens, tokensOut: usage.completionTokens,
        ...(aborted ? { error: "aborted" } : streamError ? { error: streamError } : {}),
      });
      if (!aborted && !streamError) this.d.budget?.spend(usage);
      // 对话即委托 (chat-as-errand): once the reply settled (done frame sent,
      // nothing below blocks the stream), the user's words also reach the butler
      // loop — greetings and small talk included; patrol triage tells errands
      // from chatter. Skipped for chat-only opt-outs, regenerations (their turn
      // was delegated by the original stream) and failed streams (no done —
      // the user will ask again). The legacy /api/chat route pushes on its own
      // and never rides this path, so /jex never double-sends.
      if (!regenerate && mode === "agent" && !streamError) {
        this.d.onAgentEvent?.(`chat: ${rawText}`);
      }
    } finally {
      req.off("close", onClose);
      this.active.delete(convId);
      try { res.end(); } catch { /* already destroyed */ }
    }
  }

  /** ≤20-char conversation title from the first exchange (patrol slot, non-stream). */
  private async genTitle(convId: string, reply: string): Promise<string> {
    const firstUser = this.d.store.listMessages(convId).find((m) => m.role === "user");
    const text = (firstUser?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    try {
      const r = await this.d.llm.chat("patrol", [
        { role: "system", content: "你为一段对话生成简短标题。只输出标题本身：不超过 20 个字，不要引号、句号、emoji 或任何说明文字。" },
        { role: "user", content: `用户消息：${text}\n助手回复：${reply.slice(0, 200)}` },
      ], { maxTokens: 256 });
      this.d.budget?.spend(r.usage);
      const t = r.content.trim().split("\n")[0].trim().replace(/^["'「『]+/, "").replace(/["'」』]+$/, "").slice(0, TITLE_MAX);
      if (t.length > 0) return t;
    } catch { /* fall through: derive from the user text */ }
    return text.slice(0, TITLE_MAX) || "新对话";
  }

  /** POST /api/chat/stop — abort one conversation's stream, or all of them. */
  stop(conversationId?: string): number {
    let stopped = 0;
    for (const [id, ctl] of this.active) {
      if (!conversationId || id === conversationId) { ctl.abort(); stopped++; }
    }
    return stopped;
  }

  /** GET /api/usage?days — per-day token ledger: chat (exact in/out) merged
   *  with the loop's per-cycle cost from traces.sqlite (booked as out-tokens,
   *  one call per decision row). Days outside either source stay as zeros. */
  usage(days = 7): DayUsage[] {
    const n = Math.max(1, Math.min(90, Math.floor(Number(days)) || 7));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const from = today.getTime() - (n - 1) * 86_400_000;
    const byDay = new Map<string, DayUsage>();
    for (let i = 0; i < n; i++) {
      const day = localDay(from + i * 86_400_000);
      byDay.set(day, { day, tokensIn: 0, tokensOut: 0, calls: 0 });
    }
    const merge = (day: string, tin: number, tout: number, calls: number): void => {
      const u = byDay.get(day) ?? { day, tokensIn: 0, tokensOut: 0, calls: 0 };
      u.tokensIn += tin; u.tokensOut += tout; u.calls += calls;
      byDay.set(day, u);
    };
    for (const u of this.d.store.usageSince(from)) merge(u.day, u.tokensIn, u.tokensOut, u.calls);
    const traces = this.d.runtimeDir ? join(this.d.runtimeDir, "traces.sqlite") : null;
    if (traces && existsSync(traces)) {
      try {
        const db = new DatabaseSync(traces);
        try {
          const rows = db.prepare("SELECT ts, cost FROM decisions WHERE ts>=?").all(from) as unknown as { ts?: number; cost?: number }[];
          for (const r of rows) merge(localDay(Number(r.ts ?? 0)), 0, Number(r.cost ?? 0), 1);
        } finally { db.close(); }
      } catch { /* unreadable traces: chat-only usage is still returned */ }
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }
}
