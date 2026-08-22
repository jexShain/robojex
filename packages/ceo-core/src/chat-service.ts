// packages/ceo-core/src/chat-service.ts
// Direct-chat streaming service: ChatGPT-style conversations with durable
// history (ChatStore), DeepSeek SSE pass-through (reasoning + content), abort
// support, first-round title generation and a per-conversation single-stream
// guard. SSE frames match packages/web/src/state/types.ts ChatStreamEvent.
// When tools are wired, the stream also grounds machine facts: a reply may
// open with a <<tool:NAME>> {...} sentinel line, which runs one builtin tool
// per round and feeds the real result back before the model answers.
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
  /** Live-lookup grounding (optional): when wired, the direct chat may run one
   *  builtin tool per round through the <<tool:NAME>> sentinel protocol
   *  instead of inventing machine facts. Structural (not ToolManager itself)
   *  so headless tests inject stubs. */
  tools?: {
    call(name: string, args: Record<string, unknown>, gate: "observe" | "assist" | "full"): Promise<string>;
    schemasBlock(): string;
  } | null;
  /** Effective gate for chat-side tool calls; defaults to full (butler). */
  gate?: () => "observe" | "assist" | "full";
}

const TEXT_MAX_BYTES = 16 * 1024;
const HISTORY_MAX = 40; // messages sent to the model per stream
const CHAT_MAX_TOKENS = 8192;
const TITLE_MAX = 20;
const TOOL_ROUNDS_MAX = 3;    // sentinel→run→feed-back rounds before a forced direct answer
const TOOL_PREVIEW_MAX = 400; // chars of tool output shipped in the done frame (the full text still feeds the model)

// Grounding doctrine appended to the chat system prompt when tools are wired:
// machine facts come from live tools, never from memory. The sentinel is a
// self-made one-line JSON protocol (not native function calling) so thinking
// models and any OpenAI-compatible backend can follow it.
const LIVE_LOOKUP_DOC = `# LIVE LOOKUP (grounding)
You have LIVE tools for facts about THIS machine. If answering needs real-time system data (hardware, OS, files, processes, network, task progress), NEVER invent it: output EXACTLY one line
<<tool:terminal>> {"command":"nvidia-smi"}
and nothing else — the sentinel line must be the VERY FIRST characters of your reply (no narration before it). The tool name and every parameter name must be copied EXACTLY from the Allowed tools list below (e.g. the terminal tool takes "command", not "arg" or "cmd"). The system runs it and feeds you the real result; then answer grounded in it. One tool per reply. Live lookup is read-only — writing files or mutating the board belongs to the butler loop, not to this chat. If no live data is needed, just answer normally (no sentinel).`;

// Read-only tools the chat channel may invoke (R11): facts only. Everything
// write-class — write_file/patch, kanban mutations, delegate_task,
// computer_use, job_start/kill — stays with the orchestration loop.
const LOOKING_TOOLS = new Set([
  "terminal", "process",                       // system + hardware facts
  "read_file", "search_files",                 // file facts
  "kanban_list", "kanban_show",                // task-board progress facts
  "memory", "todo",                            // jex's own state (internal, safe)
  "skills_list", "skill_view",                 // delegation capability facts
  "job_output", "job_list",                    // background job facts
]);

/** Keep only the allowlisted schema lines from a ToolManager schemasBlock
 *  (two header lines + one `name(params) — desc` line per tool). */
function lookingSchemas(block: string): string {
  const lines = block.split("\n");
  const kept = lines.filter((l, i) => i < 2 || LOOKING_TOOLS.has(l.split("(")[0]?.trim() ?? ""));
  return kept.join("\n");
}

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
    // grounding tail: only when tools are wired AND at least one is available
    // (an empty schemas block means nothing could run — the sentinel would
    // only waste a round, so the prompt stays untouched)
    const tools = this.d.tools ?? null;
    // R11 LOOKING allowlist: the chat channel grounds FACTS — reads, board
    // inspection, memory. Writes (files, kanban mutations, delegation,
    // desktop control) belong to the orchestration loop, never to a chat
    // stream: a conversational reply must not side-effect the system.
    const schemas = tools ? lookingSchemas(tools.schemasBlock()) : "";
    const grounding = tools && schemas ? `\n\n${LIVE_LOOKUP_DOC}\n\nAllowed tools:\n${schemas}` : "";
    const llmMessages = [
      { role: "system", content: chatPrompt(this.d.gear.current()) + grounding },
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
        // grounding rounds: while tools are wired, a round may carry a
        // <<tool:NAME>> {...} sentinel line — run the tool, feed the real
        // result back, let the model answer on top of it. The sentinel is
        // taught as position-0-only, but detection covers the whole reply:
        // models narrate first ("换用正确的命令…") and then emit it mid-text,
        // so forwarding lags the stream by a marker-length tail and any
        // marker position commits the round to tool mode (the narration
        // before it stays visible — honest progress notes). A round without
        // the sentinel (or a tools-less deployment) streams through with the
        // exact old behavior.
        for (let round = 0; ; round++) {
          if (grounding && round === TOOL_ROUNDS_MAX) {
            // the model kept calling tools: one last streamed round, sentinel
            // detection off — it must answer from what it already has
            llmMessages.push({ role: "system", content: "No more tool calls allowed — answer directly from what you have; if the data never arrived, say honestly what failed. Never promise to fetch it later (this reply is your last move)." });
          }
          const detect = !!grounding && round < TOOL_ROUNDS_MAX;
          const MARKER = "<<tool:";
          let acc = "";      // everything the model said this round
          let sentLen = 0;   // chars of acc already forwarded to the client
          let toolAt = -1;   // marker position in acc; -1 = none (yet)
          const forward = (text: string): void => { if (text === "") return; content += text; send({ type: "content", delta: text }); };
          const r = await this.d.llm.chatStream("patrol", llmMessages, {
            maxTokens: CHAT_MAX_TOKENS, signal: ctl.signal, model: modelOverride,
            onReasoning: (delta) => { reasoning += delta; send({ type: "reasoning", delta }); },
            onContent: (delta) => {
              acc += delta;
              if (!detect) { forward(acc.slice(sentLen)); sentLen = acc.length; return; } // detection off: stream through
              if (toolAt < 0 && acc.includes(MARKER)) {
                // mid-reply sentinel: forward the narration before it, then
                // absorb — nothing from the marker on leaves this round
                toolAt = acc.indexOf(MARKER);
                forward(acc.slice(sentLen, toolAt));
                sentLen = acc.length;
                return;
              }
              if (toolAt >= 0) return; // absorbing the sentinel line
              // no verdict yet: forward all but a marker-length lag tail, so a
              // marker split across deltas can still be caught unshown
              const safeEnd = acc.length - (MARKER.length - 1);
              if (safeEnd > sentLen) { forward(acc.slice(sentLen, safeEnd)); sentLen = safeEnd; }
            },
          });
          usage = { promptTokens: usage.promptTokens + r.usage.promptTokens, completionTokens: usage.completionTokens + r.usage.completionTokens };
          // stream end with no marker: the lag tail was just text — flush it
          if (detect && toolAt < 0) forward(acc.slice(sentLen));
          if (toolAt < 0) break; // plain reply: the stream settles as before
          if (ctl.signal.aborted) { aborted = true; break; } // stop landed on the sentinel: no tool runs
          // the complete sentinel line: from the marker to the next newline (a
          // marker at the very end with no trailing break still parses).
          // <<tool:NAME>> {json}; a bad JSON falls back to the first {...}
          // blob on the line, and anything still unparseable feeds an error
          // text back as the tool result (the model sees the refusal and
          // recovers on the next round)
          const line = acc.slice(toolAt).split("\n")[0].trim();
          const m = line.match(/<<tool:([a-zA-Z0-9_]+)>>\s*(\{.*\})/);
          const name = m?.[1] ?? line.match(/<<tool:([a-zA-Z0-9_]+)>>/)?.[1] ?? "";
          const candidates = m ? [m[2]!] : [];
          const first = line.match(/\{.*\}/); // fallback: first brace blob anywhere on the line
          if (first) candidates.push(first[0]);
          let args: Record<string, unknown> = {};
          let parsed = false;
          for (const c of candidates) {
            try { args = JSON.parse(c) as Record<string, unknown>; parsed = true; break; } catch { /* try the next blob */ }
          }
          let result: string | null = null; // non-null skips execution (parse refusal)
          if (!name) result = `error: no tool call could be parsed from the sentinel line: ${line.slice(0, 120)}`;
          else if (!parsed) result = `error: unparseable arguments on the sentinel line: ${line.slice(0, 120)}`;
          if (result === null) {
            send({ type: "tool", name, args: JSON.stringify(args), state: "running" });
            result = await tools!.call(name, args, this.d.gate?.() ?? "full"); // ToolManager truncates to 8KB
            send({ type: "tool", name, state: "done", preview: result.slice(0, TOOL_PREVIEW_MAX) });
          }
          llmMessages.push({ role: "assistant", content: line }); // the sentinel, verbatim
          llmMessages.push({ role: "user", content: `# TOOL RESULT (${name})\n${result}` });
        }
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
