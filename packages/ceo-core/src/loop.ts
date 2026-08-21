// packages/ceo-core/src/loop.ts
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatMsg, LLMClient } from "./llm.js";
import type { TaskBoard } from "./board.js";
import type { ContextAssembler } from "./context.js";
import type { AgentOrchestrator } from "./orchestrator.js";
import type { Auditor } from "./auditor.js";
import type { BudgetGovernor } from "./budget.js";
import { manualsBlock } from "./skills.js";
import { taskView, type ChatFrom } from "./api.js";
import type { ToolScout } from "./toolscout.js";
import type { TentacleManager } from "./tentacles.js";
import type { ToolManager } from "./tools/manager.js";
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

// Outlet into the operator-facing api surface: jex chat replies and lifecycle
// frames (cycle/tasks/mode/budget) ride one WS broadcast; ApiServer implements it.
export interface LoopOutlet {
  chatOut(from: ChatFrom, text: string): void;
  frame(f: Record<string, unknown>): void;
}

export interface LoopDeps {
  llm: LLMClient; board: TaskBoard; ctx: ContextAssembler;
  orchestrator: AgentOrchestrator; auditor: Auditor; budget: BudgetGovernor;
  runtimeDir: string; takeoverUrl?: string;
  skillsDir?: string;                   // repo-root skills/ by default
  scout?: ToolScout | null;             // autonomous tool inventory; absent = wiring off
  tentacles?: TentacleManager | null;   // external connector system; absent = wiring off
  builtinTools?: ToolManager | null;    // direct-capability layer: tool_call actions
  wsFactory?: (url: string) => WsLike;   // test seam: substitute sockets
  outlet?: LoopOutlet | null;               // api broadcast; absent = headless (frames dropped)
  reconnectBaseMs?: number;              // test seam: first reconnect delay
}

// packages/ceo-core/{src,dist} -> repo root -> skills/; under a pkg binary
export const DEFAULT_SKILLS_DIR = process.env.ROBOJEX_SKILLS_DIR
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

  // takeover mode as last reported by takeoverd; observe is the safe default
  private modeNow: "observe" | "assist" | "full" = "observe";
  // gantt pump idempotence: tasks already surfaced by due_spawn/unlocked stay
  // quiet until their status changes; lost on restart, re-emit is idempotent
  private ganttDispatched = new Set<string>();
  // verify pump idempotence: tasks already nudged for acceptance stay quiet
  // for 5 minutes; lost on restart, re-nudge is idempotent
  private verifyNudgedAt = new Map<string, number>();

  mode(): "observe" | "assist" | "full" { return this.modeNow; }

  // api seam: forward a ctrl frame over the takeover link; false = link down
  sendCtrl(frame: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  // chat-driven approval resolution: "approve <id>" / "deny <id>" from the
  // human settles a pending assist-mode write-class tool call. The current
  // gate rides along: a mode drop to observe since the call was queued must
  // refuse the write even after a yes (Task 6 semantics).
  async resolveToolApproval(id: string, ok: boolean): Promise<string | null> {
    if (!this.d.builtinTools) return null;
    const r = await this.d.builtinTools.resolveApproval(id, ok, this.modeNow);
    if (r !== null) this.push(`tool approval ${id} ${ok ? "approved" : "denied"}: ${r}`);
    return r;
  }
  // Minute-Gantt pump: runs at every tick BEFORE the "tick" event is queued
  // so due/overdue/unlocked ride the same wake. Emits are event back-fill —
  // decide responds by spawning or steering, never by doing the work itself.
  pumpGantt(now = Date.now()): void {
    const fmtClock = (ts: number): string => {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    for (const t of this.d.board.dueSpawnTasks(now)) {
      if (this.ganttDispatched.has(t.id)) continue;
      this.ganttDispatched.add(t.id);
      this.push(`due_spawn: ${t.id.slice(0, 8)} ${t.title}${t.dueAt ? ` [due ${fmtClock(t.dueAt)}]` : ""}`);
    }
    const NAG_MS = 30 * 60_000;
    for (const t of this.d.board.overdueTasks(now)) {
      if (t.overdueNaggedAt !== null && now - t.overdueNaggedAt < NAG_MS) continue;
      this.d.board.update(t.id, { overdueNaggedAt: now });
      this.push(`overdue: ${t.id.slice(0, 8)} ${t.title} [due ${fmtClock(t.dueAt!)}]`);
    }
    // a dispatched task that left todo (spawned/blocked/done) re-earns its
    // gantt events if it returns to todo (e.g. kanban_unblock): reset then
    const byId = new Map(this.d.board.list().map((t) => [t.id, t] as const));
    for (const [id, t] of byId) if (t.status !== "todo") this.ganttDispatched.delete(id);
    for (const t of byId.values()) {
      if (t.status !== "todo" || !t.parentId) continue;
      const p = byId.get(t.parentId);
      if (!p || p.status !== "done") continue;
      if (t.scheduledAt !== null && t.scheduledAt > now) continue; // future-scheduled child waits for its own due_spawn
      if (this.ganttDispatched.has(t.id)) continue;
      this.ganttDispatched.add(t.id);
      this.push(`unlocked: ${t.id.slice(0, 8)} ${t.title}`);
    }
    // acceptance loop: running tasks with a standard get a verify_due nudge,
    // 5-minute throttle (in-memory; a restart simply re-nudges — idempotent)
    for (const t of this.d.board.list()) {
      if (t.status !== "running" || !t.acceptance) continue;
      const last = this.verifyNudgedAt.get(t.id) ?? 0;
      if (now - last < 5 * 60_000) continue;
      this.verifyNudgedAt.set(t.id, now);
      this.push(`verify_due: ${t.id.slice(0, 8)} ${t.title} accept: ${t.acceptance.slice(0, 120)}`);
    }
  }

  // wire the api broadcast after construction (the api itself needs this loop)
  setOutlet(o: LoopOutlet): void { this.d.outlet = o; }

  private emitTasks(): void { this.d.outlet?.frame({ t: "tasks", tasks: this.d.board.list().map(taskView) }); }

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
    // the cycle frame reports whatever this wake cost and decided, even on the
    // cheap early exits — the operator sees every heartbeat
    let cost = 0;
    let actions: unknown[] = [];
    try {
      const gate = this.d.budget.gate();
      if (gate === "observe-only") return; // spend nothing, observe silently
      const read = (f: string) => { try { return readFileSync(join(this.d.runtimeDir, f), "utf8"); } catch { return `(${f} missing)`; } };
      const context = this.d.ctx.build({
        mission: read("MISSION.md"), rubric: read("RUBRIC.md"), memory: read("MEMORY.md"),
        board: this.d.board.list(), events: [eventSummary], budgetLine: this.d.budget.line(),
      });
      // layer 1: cheap patrol triage
      const p = await this.d.llm.chat("patrol", [
        { role: "system", content: "You triage events for an autonomous jex agent. Reply ONLY JSON: {\"action\":\"none\"} if nothing needs a decision, {\"action\":\"act\"} otherwise. A 'chat:' event is the human talking to jex: always act on it. A 'tool <name> -> ...' event is a builtin tool result jex itself just produced mid-flow: always act on it (continue: next tool, reply to the human, or wrap the task up). The same applies to 'tool approval ...' events: a queued write just got approved or denied, continue the flow. The same applies to 'due_spawn:', 'overdue:', 'unlocked:' and 'verify_due:' events (minute-Gantt: something is due now, late, freed by its parent, or needs its acceptance checked — always act)." },
        { role: "user", content: context },
      ], { json: true, maxTokens: 512 }); // reasoning models spend completion tokens on reasoning before content
      let triage: { action?: unknown } = {}; try { triage = JSON.parse(p.content); } catch { cost = await this.maybeAudit(p.usage, []); return; } // patrol cost still booked on parse failure
      if (gate === "patrol-only") { cost = await this.maybeAudit(p.usage, []); return; } // near the cap: no expensive decide pass
      if (triage.action !== "act") { cost = await this.maybeAudit(p.usage, []); return; }

      // layer 2: strong decide pass — the only prompt that carries the framework manuals
      const manuals = manualsBlock(this.d.skillsDir ?? DEFAULT_SKILLS_DIR);
      const tools = this.d.scout?.readToolsBlock() ?? ""; // inventory tail: only the decide pass pays for it
      const tentacles = this.d.tentacles?.listBlock() ?? ""; // connector inventory rides the same tail
      const builtin = this.d.builtinTools?.schemasBlock() ?? ""; // builtin tool schemas ride it too
      const agentsBlock = this.d.orchestrator.getRegistry()?.toPromptBlock() ?? "";
      const decideMessages = [
        { role: "system", content: `You are jex, orchestrator of an autonomous agent fleet. Choose actions. Reply ONLY JSON: {"actions":[{"type":"spawn","framework":"<agent name from AVAILABLE AGENTS>","title":"...","prompt":"...","parent":"task id (optional)","scheduledAt":"ISO 8601 (optional)","dueAt":"ISO 8601 (optional)","accept":"acceptance criteria (optional)"} | {"type":"reply","text":"conversational reply to the human in the chat"} | {"type":"message","text":"..."} | {"type":"mission_update","text":"..."} | {"type":"steer","task_id":"...","correction":"..."} | {"type":"takeover","input":{"kind":"key"|"move"|"click"|"type",...}} | {"type":"cdp","op":"cdp_open"|"cdp_snapshot","url":"..."} | {"type":"toolscout","query":"..."} | {"type":"tentacle_call","tentacle":"...","op":"...","args":{}} | {"type":"tool_call","tool":"<name from BUILTIN TOOLS>","args":{}} | {"type":"verify","task_id":"...","progress":0-100,"verdict":"pass|partial|fail","note":"one-line evidence"} | {"type":"tentacle_register","spec":{"name":"...","kind":"rest"|"webhook"|"poller"|"hardware"|"custom","endpoint":"...","auth":{"header":"...","apiKeyEnv":"ENV_VAR_NAME"},"ops":[{"name":"...","method":"GET","path":"/x/{id}","description":"..."}],"enabled":true,"blurb":"...","openapiUrl":"https://.../openapi.json","openapiContent":"<full OpenAPI document>"}}]}. Take 0-3 actions. Prefer spawning sub-agents over doing work yourself. Reply to human chat with the reply action; it costs no task and no sub-agent. The toolscout action re-scans, verifies, and manuals the installed CLI tools in the background — use it when a needed tool seems missing or the inventory looks stale; describe the job in query so the scout can also discover tools beyond its seed list. tentacle_call invokes one op of a registered external connector (see # TENTACLES in the context); tentacle_register validates and saves a new connector spec — a short spec template (name, kind, endpoint, a few ops) is enough for simple APIs, while spec.openapiUrl or spec.openapiContent imports a full OpenAPI document as a rest tentacle instead; specs written by spawned agents under runtime/tentacles/ are hot-loaded right after each register. tool_call runs one builtin tool directly (see # BUILTIN TOOLS in the context): small file, terminal, memory, or board work needs no sub-agent, and the result arrives as an event on the next wake. Reference API keys only through auth.apiKeyEnv (an environment variable name), never the key itself. You are an orchestrator and acceptance judge, never a worker: ALL productive work goes to coding agents via spawn; builtin tools are for LOOKING (verifying outputs, checking state), never for building.` },
        { role: "user", content: context + (agentsBlock ? `\n\n${agentsBlock}` : "") + (manuals ? `\n\n${manuals}` : "") + (tools ? `\n\n# AVAILABLE TOOLS\n${tools}` : "") + (tentacles ? `\n\n# TENTACLES\n${tentacles}` : "") + (builtin ? `\n\n${builtin}` : "") },
      ] satisfies ChatMsg[];
      let dec = await this.d.llm.chat("decide", decideMessages, { json: true, maxTokens: 8192 }); // big contexts (tools+tentacles inventories) starve reasoning models below this
      // reasoning models can burn the whole completion budget on reasoning and
      // emit no content; one adaptive retry at double budget recovers those
      // cycles instead of silently no-opping them
      if (dec.content.length === 0 && dec.usage.completionTokens >= 8192) {
        console.warn(`[loop] decide starved (completion=${dec.usage.completionTokens}) — retrying at 16384`);
        dec = await this.d.llm.chat("decide", decideMessages, { json: true, maxTokens: 16384 });
      }
      let parsed: any; try { parsed = JSON.parse(dec.content); } catch {
        console.warn(`[loop] decide content unparseable (len=${dec.content.length}, completion=${dec.usage.completionTokens}) — treating as no-op`);
        parsed = { actions: [] };
      }
      actions = parsed.actions ?? [];

      for (const a of parsed.actions ?? []) {
        let taskId: string | null = null;
        try {
          if (a?.type === "spawn") {
            const promptOk = typeof a.prompt === "string" && a.prompt.length > 0;
            const registryNames = this.d.orchestrator.getRegistry()?.names() ?? [];
            const fwOk = typeof a.framework === "string" && (a.framework === "hermes" || a.framework === "claude-code" || registryNames.includes(a.framework));
            // optional tree/schedule fields: best-effort, each parse problem
            // costs one warn line and never blocks the spawn itself
            const parentId = this.spawnParent(a.parent);
            const scheduledAt = this.spawnTime(a.scheduledAt, "scheduledAt");
            const dueAt = this.spawnTime(a.dueAt, "dueAt");
            const t = this.d.board.add({
              title: a.title ?? (promptOk ? a.prompt.slice(0, 60) : "(spawn without prompt)"),
              assignee: fwOk ? a.framework : String(a.framework),
              parentId, scheduledAt, dueAt,
              ...(typeof a.accept === "string" && a.accept ? { acceptance: a.accept } : {}),
            });
            taskId = t.id;
            if (!fwOk || !promptOk) {
              const problems: string[] = [];
              if (!fwOk) {
                const names = this.d.orchestrator.getRegistry()?.names() ?? ["hermes", "claude-code"];
                problems.push(`framework must be a registered agent name (got ${JSON.stringify(a.framework)}). Available: ${names.join(", ")}`);
              }
              if (!promptOk) problems.push("prompt must be a non-empty string");
              throw new Error(`invalid spawn action: ${problems.join("; ")}`);
            }
            // minute-Gantt: a future-scheduled spawn only lands on the board;
            // the pump's due_spawn event re-wakes jex to launch it on time
            if ((scheduledAt ?? 0) > Date.now()) {
              console.log(`[ceo] spawn deferred to ${new Date(scheduledAt as number).toISOString()}: ${t.title}`);
              this.push(`spawn_deferred: ${t.title} until ${new Date(scheduledAt as number).toISOString()}`);
            } else {
            this.d.board.update(t.id, { status: "running" });
            this.emitTasks();
            // background: the cycle moves on to the next action; the card settles
            // when the sub-agent exits, and the completion re-wakes jex
            const title = t.title;
            const prompt = this.withToolManuals(a.prompt);
            void this.d.orchestrator.spawn(a.framework, prompt).then((r) => {
              if (r.summaryUsage) this.d.budget.spend(r.summaryUsage); // sub-agent summary cost belongs to this wake
              const card = this.d.board.list().find((x) => x.id === t.id);
              const hasAccept = (card?.acceptance ?? "") !== "";
              const verdictOk = !hasAccept || (card?.verdict === "pass");
              this.d.board.update(t.id, {
                status: r.exitCode === 0 && !r.summary.startsWith("FAIL") && verdictOk ? "done" : "blocked",
                resultSummary: r.exitCode === 0 && !verdictOk ? `${r.summary} [awaiting acceptance: verify with tools, then {"type":"verify","task_id":"...","verdict":"pass",...}]` : r.summary,
                attempts: 1,
              });
              this.emitTasks();
              this.push(`agent_done: ${title} -> ${r.summary}`);
            }).catch((err: unknown) => {
              const reason = err instanceof Error ? err.message : String(err);
              console.error(`[ceo] action failed: ${reason}`);
              this.d.board.update(t.id, { status: "blocked", resultSummary: `action failed: ${reason}`, attempts: 1 });
              this.emitTasks();
            }).catch((err: unknown) => {
              // terminal guard: a crash inside the settlement handlers above must
              // not escape as an unhandled rejection and take the process down
              console.error(`[ceo] spawn handler crashed: ${err instanceof Error ? err.message : String(err)}`);
            });
            }
          } else if (a.type === "mission_update") {
            if (typeof a.text !== "string" || a.text.length === 0) throw new Error("invalid mission_update action: text must be a non-empty string");
            // snapshot the pre-edit docs first: git history keeps the old
            // mission recoverable, then jex's write-through lands on top
            this.d.auditor.snapshotRuntime();
            writeFileSync(join(this.d.runtimeDir, "MISSION.md"), a.text);
          } else if (a.type === "reply") {
            if (typeof a.text !== "string" || a.text.length === 0) throw new Error("invalid reply action: text must be a non-empty string");
            this.d.outlet?.chatOut("jex", a.text); // conversational reply: no spawn, no board card
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
          } else if (a.type === "tool_call") {
            if (typeof a.tool !== "string" || a.tool.length === 0) throw new Error("invalid tool_call action: tool must be a non-empty string");
            if (!this.d.builtinTools) throw new Error("tool_call action: no builtin tool manager wired");
            const args = (a.args && typeof a.args === "object" && !Array.isArray(a.args)) ? a.args as Record<string, unknown> : {};
            const name = a.tool;
            // fire-and-forget like tentacle_call: the result rides the log +
            // the next wake's event queue; observe mode is refused inside the
            // manager, and assist-mode writes land in the approval queue
            void this.d.builtinTools.call(name, args, this.modeNow).then((r) => {
              console.log(`[ceo] tool ${name} -> ${r.slice(0, 200)}`);
              this.push(`tool ${name} -> ${r}`);
            }).catch((err: unknown) => {
              console.error(`[ceo] tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          } else if (a.type === "verify") {
            if (typeof a.task_id !== "string" || a.task_id.length === 0) throw new Error("invalid verify action: task_id required");
            const progress = Math.max(0, Math.min(100, Number(a.progress ?? 0)));
            const verdict = a.verdict;
            if (verdict !== "pass" && verdict !== "partial" && verdict !== "fail") throw new Error(`invalid verify action: verdict must be pass|partial|fail (got ${JSON.stringify(verdict)})`);
            const card = this.d.board.list().find((x) => x.id === a.task_id || x.id.startsWith(a.task_id));
            if (!card) throw new Error(`invalid verify action: no task ${a.task_id} on the board`);
            const note = typeof a.note === "string" ? a.note : "";
            this.d.board.update(card.id, { progress, verdict, resultSummary: [card.resultSummary, note].filter(Boolean).join(" | ") });
            // acceptance loop closes here: a pass on a task that finished
            // cleanly but was held blocked pending acceptance promotes it
            if (verdict === "pass" && card.status === "blocked" && card.resultSummary.includes("[awaiting acceptance")) {
              this.d.board.update(card.id, { status: "done" });
            }
            this.emitTasks();
            console.log(`[ceo] verify ${card.id.slice(0, 8)} -> ${verdict} ${progress}%${verdict === "pass" && card.status === "blocked" ? " -> done" : ""} ${note.slice(0, 80)}`);
          }
        } catch (e) {
          // one bad action must not kill the rest of the wake: block its task (if any) and move on
          const reason = e instanceof Error ? e.message : String(e);
          console.error(`[ceo] action failed: ${reason}`);
          this.push(`action failed: ${reason}`);
          if (reason.includes("verify action")) {
            this.push(`verify failed: ${reason}`);
          }
          if (taskId) { this.d.board.update(taskId, { status: "blocked", resultSummary: `action failed: ${reason}`, attempts: 1 }); this.emitTasks(); }
        }
      }
      cost = await this.maybeAudit({ promptTokens: p.usage.promptTokens + dec.usage.promptTokens, completionTokens: p.usage.completionTokens + dec.usage.completionTokens }, parsed.actions ?? []);
    } finally {
      // every cycle ends on the wire: the heartbeat frame plus the fresh budget line
      this.d.outlet?.frame({ t: "cycle", wake: this.wakeN, cost, actions });
      // full snapshot (not just the line) so clients' progress bars advance
      // live; the line stays for one-line CLI summaries
      this.d.outlet?.frame({ t: "budget", line: this.d.budget.line(), budget: this.d.budget.snapshot() });
    }
  }

  // Resolves a spawn action's "parent" to a board card: exact id, or a prefix
  // that names one card uniquely (the board block only ever shows 8 chars of
  // each id). Unknown/malformed → undefined plus one warn line.
  private spawnParent(v: unknown): string | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string" || v.length === 0) {
      console.warn(`[loop] spawn parent ignored: must be a task id string`);
      return undefined;
    }
    const tasks = this.d.board.list();
    const candidates = tasks.filter((t) => t.id.startsWith(v));
    const hit = candidates.find((t) => t.id === v)
      ?? (candidates.length === 1 ? candidates[0] : undefined)
      // LLMs naturally reference a just-spawned epic by its title, not its id
      ?? (tasks.filter((t) => t.title === v).length === 1 ? tasks.find((t) => t.title === v) : undefined);
    if (!hit) {
      console.warn(`[loop] spawn parent ignored: no task '${v}' on the board`);
      return undefined;
    }
    return hit.id;
  }

  // as undefined, anything unparseable is dropped with one warn line. A
  // trailing Z is stripped first: the decide prompt mandates local-offset
  // timestamps, so a Z is the model forgetting to convert, never a real UTC
  // instant (naive ISO parses as local per spec).
  private spawnTime(v: unknown, field: "scheduledAt" | "dueAt"): number | undefined {
    if (v === undefined || v === null || v === "") return undefined;
    const ms = typeof v === "string" ? Date.parse(v) : Number.NaN; // Z-suffixed parses as UTC, bare as local — never strip Z (that shifted UTC into local, 8h off)
    if (!Number.isFinite(ms)) {
      console.warn(`[loop] spawn ${field} ignored: not an ISO 8601 timestamp (${JSON.stringify(v)})`);
      return undefined;
    }
    return ms;
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

  // Books a cost batch (plus the audit review, when due) and returns the total
  // booked this call — the number the cycle frame reports.
  private async maybeAudit(u: { promptTokens: number; completionTokens: number }, actions: unknown[]): Promise<number> {
    let booked = u.promptTokens + u.completionTokens;
    this.d.budget.spend(u);
    this.d.auditor.record({ contextDigest: `wake#${this.wakeN}`, actions, cost: booked });
    if (this.d.auditor.due()) {
      const patches = await this.d.auditor.review(this.d.llm);
      this.d.budget.spend(patches.usage); // the review pass itself burns tokens — book them
      booked += patches.usage.promptTokens + patches.usage.completionTokens;
      this.d.auditor.applyPatches(patches);
      if (patches.missionNote && patches.missionNote !== "none") console.log(`[audit] mission note: ${patches.missionNote}`);
    }
    return booked;
  }

  start(tickMs = 60_000): void {
    this.stop();
    this.stopped = false;
    this.backoffMs = this.d.reconnectBaseMs ?? 1000;
    this.connectWs();
    this.timer = setInterval(() => { this.pumpGantt(); this.push("tick"); }, tickMs);
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
        if (m.t === "evt" && m.type === "mode_changed") {
          if (m.mode === "observe" || m.mode === "assist" || m.mode === "full") {
            this.modeNow = m.mode;
            this.d.outlet?.frame({ t: "mode", mode: m.mode });
          }
          this.push(`mode_changed -> ${m.mode}`);
        }
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
