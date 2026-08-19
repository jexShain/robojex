// packages/ceo-core/src/loop.ts
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LLMClient } from "./llm.js";
import type { TaskBoard } from "./board.js";
import type { ContextAssembler } from "./context.js";
import type { AgentOrchestrator } from "./orchestrator.js";
import type { Auditor } from "./auditor.js";
import type { BudgetGovernor } from "./budget.js";
import { manualsBlock } from "./skills.js";
import type { ToolScout } from "./toolscout.js";
import type { TentacleManager } from "./tentacles.js";
import WebSocket from "ws";

// Minimal socket surface the loop needs; ws's WebSocket satisfies it structurally.
export interface WsLike {
  readyState: number;
  on(event: "message", cb: (raw: unknown) => void): unknown;
  on(event: "open", cb: () => void): unknown;
  on(event: "close", cb: () => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  send(data: string): unknown;
  close(): unknown;
}

const WS_OPEN = 1;
const RECONNECT_MAX_MS = 60_000;

export interface LoopDeps {
  llm: LLMClient; board: TaskBoard; ctx: ContextAssembler;
  orchestrator: AgentOrchestrator; auditor: Auditor; budget: BudgetGovernor;
  runtimeDir: string; takeoverUrl?: string;
  skillsDir?: string;                   // repo-root skills/ by default
  scout?: ToolScout | null;             // autonomous tool inventory; absent = wiring off
  tentacles?: TentacleManager | null;   // external connector system; absent = wiring off
  wsFactory?: (url: string) => WsLike;   // test seam: substitute sockets
  reconnectBaseMs?: number;              // test seam: first reconnect delay
}

// packages/ceo-core/{src,dist} -> repo root -> skills/; under a pkg binary
const DEFAULT_SKILLS_DIR = process.env.ROBOJEX_SKILLS_DIR
  ?? (import.meta.url ? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills") : join(dirname(process.execPath), "skills"));

// Verified tool names that are also everyday English words: attaching their
// manuals on a bare word-boundary hit would fire on half of all prompts.
const GENERIC_NAMES = ["go", "make", "file", "http", "convert", "identify", "just", "delta"];

export class SchedulerLoop {
  private queue: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private wakeN = 0;
  private ws: WsLike | null = null;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private backoffMs = 1000;
  private stopped = true; // no reconnect machinery may run before start()
  private running = false;
  private idleWaiters: (() => void)[] = [];
  constructor(private d: LoopDeps) {}

  wakeCount(): number { return this.wakeN; }

  push(event: string): void {
    this.queue.push(event);
    // merge events inside a 500ms window into one decision cycle
    if (!this.debounce) {
      this.debounce = setTimeout(() => { this.debounce = undefined; this.runOnceQueue().catch((e) => console.error(`[ceo] cycle failed: ${e instanceof Error ? e.message : String(e)}`)); }, 500);
    }
  }

  private async runOnceQueue(): Promise<void> {
    if (this.running) {
      // a cycle is in flight: leave the queued events in place, retry after it ends
      if (!this.debounce) this.debounce = setTimeout(() => { this.debounce = undefined; this.runOnceQueue().catch((e) => console.error(`[ceo] cycle failed: ${e instanceof Error ? e.message : String(e)}`)); }, 500);
      return;
    }
    const q = this.queue.splice(0);
    if (q.length) await this.runOnce(q.join("; "));
  }

  async runOnce(eventSummary: string): Promise<void> {
    // in-flight guard: exactly one decision cycle executes at a time; later
    // callers queue behind the running one instead of interleaving with it.
    // (Node 18 lacks Promise.withResolvers, hence the executor form.)
    while (this.running) {
      let release: () => void = () => {};
      const idle = new Promise<void>((r) => { release = r; });
      this.idleWaiters.push(release);
      await idle;
    }
    this.running = true;
    try {
      await this.cycle(eventSummary);
    } finally {
      this.running = false;
      this.idleWaiters.splice(0).forEach((r) => r());
    }
  }

  private async cycle(eventSummary: string): Promise<void> {
    this.wakeN++;
    const gate = this.d.budget.gate();
    if (gate === "observe-only") return; // spend nothing, observe silently
    const read = (f: string) => { try { return readFileSync(join(this.d.runtimeDir, f), "utf8"); } catch { return `(${f} missing)`; } };
    const context = this.d.ctx.build({
      mission: read("MISSION.md"), rubric: read("RUBRIC.md"), memory: read("MEMORY.md"),
      board: this.d.board.list(), events: [eventSummary], budgetLine: this.d.budget.line(),
    });
    // layer 1: cheap patrol triage
    const p = await this.d.llm.chat("patrol", [
      { role: "system", content: "You triage events for an autonomous jex agent. Reply ONLY JSON: {\"action\":\"none\"} if nothing needs a decision, {\"action\":\"act\"} otherwise." },
      { role: "user", content: context },
    ], { json: true, maxTokens: 512 }); // reasoning models spend completion tokens on reasoning before content
    let triage: { action?: unknown } = {}; try { triage = JSON.parse(p.content); } catch { await this.maybeAudit(p.usage, []); return; } // patrol cost still booked on parse failure
    if (gate === "patrol-only") { await this.maybeAudit(p.usage, []); return; } // near the cap: no expensive decide pass
    if (triage.action !== "act") { await this.maybeAudit(p.usage, []); return; }

    // layer 2: strong decide pass — the only prompt that carries the framework manuals
    const manuals = manualsBlock(this.d.skillsDir ?? DEFAULT_SKILLS_DIR);
    const tools = this.d.scout?.readToolsBlock() ?? ""; // inventory tail: only the decide pass pays for it
    const tentacles = this.d.tentacles?.listBlock() ?? ""; // connector inventory rides the same tail
    const dec = await this.d.llm.chat("decide", [
      { role: "system", content: `You are jex, orchestrator of an autonomous agent fleet. Choose actions. Reply ONLY JSON: {"actions":[{"type":"spawn","framework":"hermes"|"claude-code","title":"...","prompt":"..."} | {"type":"message","text":"..."} | {"type":"mission_update","text":"..."} | {"type":"steer","task_id":"...","correction":"..."} | {"type":"takeover","input":{"kind":"key"|"move"|"click"|"type",...}} | {"type":"cdp","op":"cdp_open"|"cdp_snapshot","url":"..."} | {"type":"toolscout","query":"..."} | {"type":"tentacle_call","tentacle":"...","op":"...","args":{}} | {"type":"tentacle_register","spec":{"name":"...","kind":"rest"|"webhook"|"poller"|"hardware"|"custom","endpoint":"...","auth":{"header":"...","apiKeyEnv":"ENV_VAR_NAME"},"ops":[{"name":"...","method":"GET","path":"/x/{id}","description":"..."}],"enabled":true,"blurb":"...","openapiUrl":"https://.../openapi.json","openapiContent":"<full OpenAPI document>"}}]}. Take 0-3 actions. Prefer spawning sub-agents over doing work yourself. The toolscout action re-scans, verifies, and manuals the installed CLI tools in the background — use it when a needed tool seems missing or the inventory looks stale; describe the job in query so the scout can also discover tools beyond its seed list. tentacle_call invokes one op of a registered external connector (see # TENTACLES in the context); tentacle_register validates and saves a new connector spec — a short spec template (name, kind, endpoint, a few ops) is enough for simple APIs, while spec.openapiUrl or spec.openapiContent imports a full OpenAPI document as a rest tentacle instead; specs written by spawned agents under runtime/tentacles/ are hot-loaded right after each register. Reference API keys only through auth.apiKeyEnv (an environment variable name), never the key itself.` },
      { role: "user", content: context + (manuals ? `\n\n${manuals}` : "") + (tools ? `\n\n# AVAILABLE TOOLS\n${tools}` : "") + (tentacles ? `\n\n# TENTACLES\n${tentacles}` : "") },
    ], { json: true, maxTokens: 4096 });
    let parsed: any; try { parsed = JSON.parse(dec.content); } catch { parsed = { actions: [] }; }

    for (const a of parsed.actions ?? []) {
      let taskId: string | null = null;
      try {
        if (a?.type === "spawn") {
          const promptOk = typeof a.prompt === "string" && a.prompt.length > 0;
          const fwOk = a.framework === "hermes" || a.framework === "claude-code";
          // create the task first so even an invalid action stays visible on the board
          const t = this.d.board.add({
            title: a.title ?? (promptOk ? a.prompt.slice(0, 60) : "(spawn without prompt)"),
            assignee: fwOk ? a.framework : String(a.framework),
          });
          taskId = t.id;
          if (!fwOk || !promptOk) {
            const problems: string[] = [];
            if (!fwOk) problems.push(`framework must be 'hermes' or 'claude-code' (got ${JSON.stringify(a.framework)})`);
            if (!promptOk) problems.push("prompt must be a non-empty string");
            throw new Error(`invalid spawn action: ${problems.join("; ")}`);
          }
          this.d.board.update(t.id, { status: "running" });
          // background: the cycle moves on to the next action; the card settles
          // when the sub-agent exits, and the completion re-wakes jex
          const title = t.title;
          const prompt = this.withToolManuals(a.prompt);
          void this.d.orchestrator.spawn(a.framework, prompt).then((r) => {
            if (r.summaryUsage) this.d.budget.spend(r.summaryUsage); // sub-agent summary cost belongs to this wake
            this.d.board.update(t.id, {
              status: r.exitCode === 0 && !r.summary.startsWith("FAIL") ? "done" : "blocked",
              resultSummary: r.summary, attempts: 1,
            });
            this.push(`agent_done: ${title} -> ${r.summary}`);
          }).catch((err: unknown) => {
            const reason = err instanceof Error ? err.message : String(err);
            console.error(`[ceo] action failed: ${reason}`);
            this.d.board.update(t.id, { status: "blocked", resultSummary: `action failed: ${reason}`, attempts: 1 });
          }).catch((err: unknown) => {
            // terminal guard: a crash inside the settlement handlers above must
            // not escape as an unhandled rejection and take the process down
            console.error(`[ceo] spawn handler crashed: ${err instanceof Error ? err.message : String(err)}`);
          });
        } else if (a.type === "mission_update") {
          if (typeof a.text !== "string" || a.text.length === 0) throw new Error("invalid mission_update action: text must be a non-empty string");
          // snapshot the pre-edit docs first: git history keeps the old
          // mission recoverable, then jex's write-through lands on top
          this.d.auditor.snapshotRuntime();
          writeFileSync(join(this.d.runtimeDir, "MISSION.md"), a.text);
        } else if (a.type === "message") {
          console.log(`[ceo->human] ${a.text}`);
        } else if (a.type === "takeover") {
          if (typeof a.input !== "object" || a.input === null) throw new Error("invalid takeover action: input must be an object");
          if (this.ws && this.ws.readyState === WS_OPEN) {
            this.ws.send(JSON.stringify({ t: "ctrl", op: "input", id: randomUUID(), action: a.input }));
          }
        } else if (a.type === "cdp") {
          if (a.op !== "cdp_open" && a.op !== "cdp_snapshot") throw new Error("invalid cdp action: op must be 'cdp_open' or 'cdp_snapshot'");
          // browser observation rides the takeover link; the server re-gates by mode
          if (this.ws && this.ws.readyState === WS_OPEN) {
            this.ws.send(JSON.stringify({ t: "ctrl", op: a.op, url: a.url }));
          } else {
            console.error(`[ceo] cdp action dropped: takeover link down`);
          }
        } else if (a.type === "steer") {
          if (typeof a.task_id !== "string" || typeof a.correction !== "string" || a.correction.length === 0) throw new Error("invalid steer action: task_id and a non-empty correction are required");
          const card = this.d.board.list().find((t) => t.id === a.task_id);
          if (!card) throw new Error(`invalid steer action: no task ${a.task_id} on the board`);
          // orchestrator has no per-task kill interface yet: record the
          // steering intent for the operator; real kill+respawn is deferred
          console.log(`[ceo] steer noted (kill+respawn deferred): ${card.title} <- ${a.correction}`);
        } else if (a.type === "toolscout") {
          if (a.query !== undefined && typeof a.query !== "string") throw new Error("invalid toolscout action: query must be a string");
          // fire-and-forget: a full scan+verify+manuals pass can take minutes;
          // the cycle never waits on it, and ToolScout.run itself collapses
          // re-entry while a pass is in flight
          if (this.d.scout) {
            void this.d.scout.run(typeof a.query === "string" ? a.query : undefined).then((r) => {
              console.log(`[ceo] toolscout: ${r.verified.length} verified`);
            }).catch((err: unknown) => {
              console.error(`[ceo] toolscout failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        } else if (a.type === "tentacle_call") {
          if (typeof a.tentacle !== "string" || typeof a.op !== "string" || a.op.length === 0) throw new Error("invalid tentacle_call action: tentacle and op must be non-empty strings");
          if (!this.d.tentacles) throw new Error("tentacle_call action: no tentacle manager wired");
          const args = (a.args && typeof a.args === "object" && !Array.isArray(a.args)) ? a.args as Record<string, unknown> : {};
          const name = a.tentacle, op = a.op;
          // fire-and-forget: every call is independent (no reentry guard), the
          // cycle moves on, and the result rides the log + the next wake's
          // event queue — jex sees it, the human sees it, nothing blocks
          void this.d.tentacles.call(name, op, args).then((r) => {
            console.log(`[ceo] tentacle ${name}.${op} -> ${r}`);
            this.push(`tentacle ${name}.${op} -> ${r.slice(0, 200)}`);
          }).catch((err: unknown) => {
            console.error(`[ceo] tentacle ${name}.${op} failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        } else if (a.type === "tentacle_register") {
          if (typeof a.spec !== "object" || a.spec === null || Array.isArray(a.spec)) throw new Error("invalid tentacle_register action: spec must be an object");
          if (!this.d.tentacles) throw new Error("tentacle_register action: no tentacle manager wired");
          // awaited inline: validation is instant and the probe is bounded by
          // its own timeout, so the cycle at most pauses a few seconds
          const r = await this.d.tentacles.register(a.spec);
          console.log(`[ceo] tentacle registered: ${r.def.name} [${r.probe.status}]`);
          // hot-load: a spawned sub-agent may have dropped specs under
          // runtime/tentacles/ while this cycle ran — pick them up now
          // instead of waiting for the next boot's loadAll
          await this.d.tentacles.reload();
        }
      } catch (e) {
        // one bad action must not kill the rest of the wake: block its task (if any) and move on
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`[ceo] action failed: ${reason}`);
        if (taskId) this.d.board.update(taskId, { status: "blocked", resultSummary: `action failed: ${reason}`, attempts: 1 });
      }
    }
    await this.maybeAudit({ promptTokens: p.usage.promptTokens + dec.usage.promptTokens, completionTokens: p.usage.completionTokens + dec.usage.completionTokens }, parsed.actions ?? []);
  }

  // Attach the manuals of verified tools and named tentacles the spawn prompt
  // actually mentions: just-in-time knowledge with no permanent context tax.
  // Word-boundary matching keeps "jqx" from pulling in the jq manual — except
  // for names that are everyday English words ("go check the file"), which
  // count only when backticked or heading their own line. Tentacle manuals
  // share the same 2400-char budget as tool manuals.
  private withToolManuals(prompt: string): string {
    const parts: string[] = [];
    let total = 0;
    const scout = this.d.scout;
    if (scout) {
      for (const name of scout.verifiedNames()) {
        if (total >= 2400) break; // manual budget: the prompt must stay small
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const named = GENERIC_NAMES.includes(name)
          ? new RegExp(`\`${esc}\``).test(prompt) || new RegExp(`\n${esc} `).test(prompt)
          : new RegExp(`\\b${esc}\\b`).test(prompt);
        if (!named) continue;
        const manual = scout.readManual(name);
        if (manual === null) continue;
        const piece = `## ${name}\n${manual.slice(0, 800)}`;
        if (total + piece.length > 2400) break;
        parts.push(piece);
        total += piece.length;
      }
    }
    const tentacles = this.d.tentacles;
    if (tentacles) {
      for (const t of tentacles.list()) {
        if (total >= 2400) break; // one shared budget across tool + tentacle manuals
        const esc = t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // tentacle names that are everyday English words follow the same
        // backtick/line-start rule as generic tool names
        const named = GENERIC_NAMES.includes(t.name)
          ? new RegExp(`\`${esc}\``).test(prompt) || new RegExp(`\n${esc} `).test(prompt)
          : new RegExp(`\\b${esc}\\b`).test(prompt);
        if (!named) continue;
        const manual = tentacles.manual(t.name);
        if (manual === null) continue;
        const piece = `## ${t.name}\n${manual.slice(0, 800)}`;
        if (total + piece.length > 2400) break;
        parts.push(piece);
        total += piece.length;
      }
    }
    return parts.length ? `${prompt}\n\n# TOOL MANUALS\n${parts.join("\n\n")}` : prompt;
  }

  private async maybeAudit(u: { promptTokens: number; completionTokens: number }, actions: unknown[]): Promise<void> {
    this.d.budget.spend(u);
    this.d.auditor.record({ contextDigest: `wake#${this.wakeN}`, actions, cost: u.promptTokens + u.completionTokens });
    if (this.d.auditor.due()) {
      const patches = await this.d.auditor.review(this.d.llm);
      this.d.budget.spend(patches.usage); // the review pass itself burns tokens — book them
      this.d.auditor.applyPatches(patches);
      if (patches.missionNote && patches.missionNote !== "none") console.log(`[audit] mission note: ${patches.missionNote}`);
    }
  }

  start(tickMs = 60_000): void {
    this.stop();
    this.stopped = false;
    this.backoffMs = this.d.reconnectBaseMs ?? 1000;
    this.connectWs();
    this.timer = setInterval(() => this.push("tick"), tickMs);
    this.timer.unref();
  }
  stop(): void {
    this.stopped = true; // first: late socket events must not reschedule anything
    clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    clearTimeout(this.debounce);
    this.debounce = undefined;
  }

  private connectWs(): void {
    if (!this.d.takeoverUrl) return;
    const ws = this.d.wsFactory ? this.d.wsFactory(this.d.takeoverUrl) : new WebSocket(this.d.takeoverUrl);
    this.ws = ws;
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (m.t === "evt" && m.type === "screen_diff") this.push(`screen_diff hamming=${m.hamming}${m.ocrText ? ` ocr="${String(m.ocrText).slice(0,120)}"` : ""}`);
        if (m.t === "evt" && m.type === "mode_changed") this.push(`mode_changed -> ${m.mode}`);
        if (m.t === "evt" && m.type === "cdp_result") this.push(`cdp_${m.op}: ${String(m.result ?? "").slice(0, 200)}`);
        if (m.t === "human") this.push(`human: ${m.text}`);
      } catch { /* ignore malformed */ }
    });
    ws.on("open", () => { this.backoffMs = this.d.reconnectBaseMs ?? 1000; }); // healthy link: next failure starts from the base delay
    ws.on("close", () => { this.onWsDown(ws); }); // degrade to pure CLI until reconnect
    ws.on("error", () => { this.onWsDown(ws); }); // takeoverd down is operational, not fatal: never crash jex
  }

  private onWsDown(ws: WsLike): void {
    if (this.ws === ws) this.ws = null; // a late event from an already-replaced socket must not unset the fresh one
    if (this.stopped) return;
    if (this.reconnectTimer) return; // 'error' and 'close' both fire: one pending reconnect is enough
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connectWs(); }, delay);
    this.reconnectTimer.unref();
  }
}
