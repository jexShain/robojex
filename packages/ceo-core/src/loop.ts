// packages/ceo-core/src/loop.ts
import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatMsg, LLMClient } from "./llm.js";
import { overlapTokens, overlapScore } from "./token-match.js";
import type { TaskBoard } from "./board.js";
import type { ContextAssembler } from "./context.js";
import type { AgentOrchestrator } from "./orchestrator.js";
import type { Auditor } from "./auditor.js";
import type { BudgetGovernor } from "./budget.js";
import { manualsBlock } from "./skills.js";
import { taskView, type ChatFrom } from "./api.js";
import { getGearDef, loopPrompt, type GearId } from "./gears.js";
import type { ToolScout } from "./toolscout.js";
import type { TentacleManager } from "./tentacles.js";
import type { ToolManager, Gate } from "./tools/manager.js";
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

/* ───────────────── autonomy policy (SPEC-BUTLER §1) ───────────────── */

export type PolicyId = "butler" | "conservative";

/** Config validation: butler (max autonomy — full tool gate, hard blacklist
 *  only) is the default; anything unparseable warns and degrades to it, the
 *  same contract resolveBudgetConfig gives the other knobs. */
export function resolvePolicy(raw: unknown): PolicyId {
  if (raw === undefined || raw === null || raw === "") return "butler";
  if (raw === "butler" || raw === "conservative") return raw;
  console.warn(`[loop] invalid policy ${JSON.stringify(raw)}: falling back to butler`);
  return "butler";
}

// Outlet into the operator-facing api surface: jex chat replies and lifecycle
// frames (cycle/tasks/mode/budget + hud notices) ride one WS broadcast; ApiServer implements it.
export interface LoopOutlet {
  chatOut(from: ChatFrom, text: string): void;
  frame(f: Record<string, unknown>): void;
  hud?(kind: string, taskId: string): void; // one gantt event hit a task; absent = no HUD wiring
}

export interface LoopDeps {
  llm: LLMClient; board: TaskBoard; ctx: ContextAssembler;
  orchestrator: AgentOrchestrator; auditor: Auditor; budget: BudgetGovernor;
  runtimeDir: string; takeoverUrl?: string;
  skillsDir?: string;                   // repo-root skills/ by default
  scout?: ToolScout | null;             // autonomous tool inventory; absent = wiring off
  tentacles?: TentacleManager | null;   // external connector system; absent = wiring off
  builtinTools?: ToolManager | null;    // direct-capability layer: tool_call actions
  policy?: PolicyId;                    // autonomy doctrine; butler (default) forces the tool gate to full
  wsFactory?: (url: string) => WsLike;   // test seam: substitute sockets
  outlet?: LoopOutlet | null;               // api broadcast; absent = headless (frames dropped)
  reconnectBaseMs?: number;              // test seam: first reconnect delay
  watchdogFloorMs?: number;              // test seam: stall-detection floor (default 3 min)
}

// packages/ceo-core/{src,dist} -> repo root -> skills/; under a pkg binary
export const DEFAULT_SKILLS_DIR = process.env.ROBOJEX_SKILLS_DIR
  ?? (import.meta.url ? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills") : join(dirname(process.execPath), "skills"));

// Verified tool names that are also everyday English words: attaching their
// manuals on a bare word-boundary hit would fire on half of all prompts.
const GENERIC_NAMES = ["go", "make", "file", "http", "convert", "identify", "just", "delta"];

// One-line relative time for butler briefs ("3分钟后" / "2小时前"): coarse
// buckets keep the line short — precision is what the gantt band is for.
function relTime(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const [unitMs, unit] = abs < 60_000 ? [1_000, "秒"] as const
    : abs < 3_600_000 ? [60_000, "分钟"] as const
    : abs < 86_400_000 ? [3_600_000, "小时"] as const
    : [86_400_000, "天"] as const;
  return `${Math.max(1, Math.round(abs / unitMs))}${unit}${diff >= 0 ? "后" : "前"}`;
}

export class SchedulerLoop {
  private queue: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private wakeN = 0;
  private tickCount = 0; // decision-cycle counter shipped on the wire as tickN (hello.state + cycle frames)
  private ws: WsLike | null = null;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private backoffMs = 1000;
  // R10 heartbeat self-check: a fixed 60s watchman compares tickN across
  // checks; unchanged past 3 tick periods (floor 3 min — slow decide cycles
  // must never false-positive) means the tick timer died or the queue wedged,
  // and a forced wake is the self-recovery. Test seam: the floor.
  private lastTickSeen = { n: 0, at: 0 };
  private watchdog?: NodeJS.Timeout;
  private stopped = true; // no reconnect machinery may run before start()
  private running = false;
  private idleWaiters: (() => void)[] = [];
  // autonomy policy: butler runs the builtin tool layer at full (the hard
  // blacklist in the tool manager guards the sharp edges); conservative keeps
  // the mode-driven observe/assist gate
  private policyNow: PolicyId = "butler";
  constructor(private d: LoopDeps) { if (d.policy) this.policyNow = d.policy; }

  wakeCount(): number { return this.wakeN; }

  /** ApiLoopHandle seam: the tickN the wire ships — HUD clients compare it
   *  across hello.state and cycle frames to detect a stalled loop. */
  tickN(): number { return this.tickCount; }

  // takeover mode as last reported by takeoverd; observe is the safe default
  private modeNow: Gate = "observe";
  // autonomy gear: dormant stops ticking entirely; eco thins patrol to every
  // 5th tick; higher gears retime faster and buy bigger decide budgets
  private gearNow: GearId = "balanced";
  private tickMsNow = 60_000;
  private ticking = false;

  gear(): GearId { return this.gearNow; }
  currentTickMs(): number { return this.tickMsNow; }

  /** Hot gear switch (GearController.set → onApply): swaps the prompt profile
   *  and retimes the tick without restarting the loop or the takeover link. */
  setGear(gear: string): void {
    const def = getGearDef(gear);
    if (!def) { console.warn(`[loop] unknown gear ${JSON.stringify(gear)}: ignored`); return; }
    this.gearNow = def.id;
    this.setTickMs(def.tickMs);
  }

  /** Retime the tick interval: 0 stops ticking (dormant); while stopped
   *  (before start / after stop) only the default is recorded. */
  setTickMs(ms: number): void {
    const next = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
    this.tickMsNow = next;
    clearInterval(this.timer);
    this.timer = undefined;
    if (next > 0 && this.ticking) {
      this.timer = setInterval(() => { this.pumpGantt(); this.push("tick"); }, next);
      this.timer.unref();
    }
  }

  // gantt pump idempotence: tasks already surfaced by due_spawn/unlocked stay
  // quiet until their status changes; lost on restart, re-emit is idempotent
  private ganttDispatched = new Set<string>();
  // verify pump idempotence: tasks already nudged for acceptance stay quiet
  // for 5 minutes; lost on restart, re-nudge is idempotent
  private verifyNudgedAt = new Map<string, number>();
  // task_due pump debounce: one chase nudge per task per window (>=60s and at
  // least one tick, so a turbo tick cannot flood the queue); lost on restart
  private taskDueNudgedAt = new Map<string, number>();
  // repeat tool-call guard (dsh guard/repeat-tool-reminder pattern): the same
  // tool+args re-requested across consecutive cycles means the loop is stuck —
  // escalate a visible note inside the tool-result event (which rides into the
  // next decide context) instead of silently re-burning tokens. A different
  // call or a 10-minute gap resets the streak.
  private toolRepeat = { key: "", n: 0, at: 0 };
  // R20 concurrency queue: spawn actions parked at the 4-agent cap wait here
  // (prompt in closure — the board never stored it); any settlement drains
  // the queue. Lost on restart: those cards sit in todo and decide re-derives
  // them, which is exactly what it would have done anyway.
  private pendingSpawns = new Map<string, { framework: string; prompt: string; title: string }>();
  // R16 vitals: self-awareness the decide pass reads every cycle — runtime,
  // cycle count, recent failures. A butler that can say "I've been erroring,
  // something is wrong" behaves like a person noticing a headache.
  private bornAt = Date.now();
  private vitals = { cycles: 0, errors: 0, lastError: "", quietSkips: 0 };
  // R17 morning briefing: one digest per local day, fired by the gantt pump
  // inside the 08:00–11:00 window (a late boot still catches it). In-memory
  // only — a restart on the same morning may re-fire, which is idempotent
  // enough (the digest is a summary, not an action).
  private morningSent = "";
  // R22 periodic rescan: agents get installed while jex runs — a 6h nudge
  // keeps the fleet inventory honest without rescanning on every tick
  private lastScoutNudge = Date.now(); // boot scan just ran: first re-nudge lands 6h in
  // R35 butler's walk: a light house round every 30 min — disk, load, odd
  // processes. Only worth a chat line when something is actually wrong; a
  // silent healthy round still exercises LOOKING so skills stay warm.
  private lastWalkAt = Date.now(); // boot recon covers the first round: walk starts at +30min
  // R71 short-term decision memory: each decide cycle banks one replay line
  // (wake → actions → cost). Without it every cycle meets a "fresh" world and
  // re-verifies stable tasks — the soak's own MEMORY audit flagged exactly
  // that as the top no-op burn. decide sees the last 5 lines.
  private recentCycles: string[] = [];
  // R72 quiet skip: a pure-tick wake against an unchanged world (same board
  // digest, no running task, previous cycle took no action) skips patrol AND
  // decide — the soak measured ~2.8k burned per empty cycle, 20 in a row.
  // Real events (chat, tool results, due/verify pumps) still always wake.
  private lastBoardDigest: string | null = null; // null until the first full cycle banks one — the first wake always looks
  private lastCycleActed = false;
  // R73 nag cap: verify_due nudges per card per "episode" (status:attempts:
  // verdict:summary-length). Three nudges without the card moving = decide
  // keeps not judging it — stop nagging (each nudge is a full paid cycle)
  // until the card actually changes.
  private verifyNudgeState = new Map<string, { key: string; n: number }>();

  mode(): Gate { return this.modeNow; }

  // takeover link liveness: the socket exists and is past the handshake
  private linked(): boolean { return !!this.ws && this.ws.readyState === WS_OPEN; }

  // api seam: forward a ctrl frame over the takeover link; false = link down
  sendCtrl(frame: Record<string, unknown>): boolean {
    if (!this.linked()) return false;
    this.ws!.send(JSON.stringify(frame));
    return true;
  }

  policy(): PolicyId { return this.policyNow; }

  /** Hot policy switch (settings API / setModeLocal-style): butler forces the
   *  builtin tool layer to full — no approval rounds, the hard blacklist in
   *  the tool manager refuses deletions and system-dir writes; conservative
   *  restores the mode-driven gate. Desktop takeover semantics (sendCtrl,
   *  modeNow) are untouched. Unknown values are ignored, like setModeLocal. */
  setPolicy(p: string): void {
    if (p !== "butler" && p !== "conservative") return;
    if (p === this.policyNow) return;
    this.policyNow = p;
    this.d.outlet?.frame({ t: "policy", policy: p });
    this.push(`policy_changed -> ${p}`);
  }

  /** Effective gate for the builtin tool layer. Under butler the gate is
   *  always full: autonomy is maximal and the tool manager's hard blacklist
   *  (destructive commands, system-dir writes, sensitive paths) is the only
   *  refusal layer. Under conservative, observe exists to protect the desktop
   *  takeoverd drives; with the link down there is no desktop to protect, and
   *  a hard observe would only freeze jex's own reversible work — so tools
   *  run at assist (writes still face the approval queue). modeNow itself is
   *  untouched: towards takeoverd the mode stays observe. */
  gateForTools(): Gate {
    if (this.policyNow === "butler") return "full";
    if (this.modeNow === "observe" && !this.linked()) return "assist";
    return this.modeNow;
  }

  /** Local mode switch for the takeover-less deployment (desktop/headless):
   *  takeoverd is not there to own the switch, so the loop applies it directly
   *  and emits the same {t:'mode'} frame + wake event a takeoverd
   *  mode_changed would have produced — operator UIs and the tool gate stay
   *  truthful. Unknown values are ignored, like the mode_changed handler. */
  setModeLocal(mode: string): void {
    if (mode !== "observe" && mode !== "assist" && mode !== "full") return;
    this.modeNow = mode;
    this.d.outlet?.frame({ t: "mode", mode });
    this.push(`mode_changed -> ${mode}`);
  }

  // chat-driven approval resolution: "approve <id>" / "deny <id>" from the
  // human settles a pending assist-mode write-class tool call. The current
  // effective gate rides along: a mode drop to observe since the call was
  // queued must refuse the write even after a yes (Task 6 semantics).
  async resolveToolApproval(id: string, ok: boolean): Promise<string | null> {
    if (!this.d.builtinTools) return null;
    const r = await this.d.builtinTools.resolveApproval(id, ok, this.gateForTools());
    if (r !== null) this.push(`tool approval ${id} ${ok ? "approved" : "denied"}: ${r}`);
    return r;
  }
  // Minute-Gantt pump: runs at every tick BEFORE the "tick" event is queued
  // so due/overdue/unlocked ride the same wake. Emits are event back-fill —
  // decide responds by spawning or steering, never by doing the work itself.
  // Each emit also fires outlet.hud so HUD widgets can flash the card.
  pumpGantt(now = Date.now()): void {
    const fmtClock = (ts: number): string => {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    for (const t of this.d.board.dueSpawnTasks(now)) {
      if (this.ganttDispatched.has(t.id)) continue;
      this.ganttDispatched.add(t.id);
      this.push(`due_spawn: ${t.id.slice(0, 8)} ${t.title}${t.dueAt ? ` [due ${fmtClock(t.dueAt)}]` : ""}`);
      this.d.outlet?.hud?.("due_spawn", t.id);
    }
    const NAG_MS = 30 * 60_000;
    for (const t of this.d.board.overdueTasks(now)) {
      if (t.overdueNaggedAt !== null && now - t.overdueNaggedAt < NAG_MS) continue;
      this.d.board.update(t.id, { overdueNaggedAt: now });
      this.push(`overdue: ${t.id.slice(0, 8)} ${t.title} [due ${fmtClock(t.dueAt!)}]`);
      this.d.outlet?.hud?.("overdue", t.id);
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
      this.d.outlet?.hud?.("unlocked", t.id);
    }
    // acceptance loop: running tasks with a standard get a verify_due nudge,
    // 5-minute throttle (in-memory; a restart simply re-nudges — idempotent).
    // R18: a task parked at blocked [awaiting acceptance] also stays on the
    // pump — the agent finished but nobody judged it yet, and a restart must
    // never orphan that pending verdict.
    for (const t of this.d.board.list()) {
      // settled tasks release their nudge slot (the map is bounded by live
      // work). R18 escape hatch: a card that already burned its retry ladder
      // (attempts >= 2) stays parked for the HUMAN — re-nudging it forever
      // would burn the whole night's cycles on a doomed verify loop.
      const awaiting = t.status === "blocked" && t.resultSummary.includes("[awaiting acceptance") && t.attempts < 2;
      if (t.status !== "running" && !awaiting) { this.verifyNudgedAt.delete(t.id); this.verifyNudgeState.delete(t.id); }
      if ((t.status !== "running" && !awaiting) || !t.acceptance) continue;
      const last = this.verifyNudgedAt.get(t.id) ?? 0;
      if (now - last < 5 * 60_000) continue;
      // R73 nag cap: an unchanged card earns at most 3 nudges per episode
      const nk = `${t.status}:${t.attempts}:${t.verdict}:${t.resultSummary.length}`;
      const ns = this.verifyNudgeState.get(t.id) ?? { key: nk, n: 0 };
      if (ns.key !== nk) { ns.key = nk; ns.n = 0; }
      if (ns.n >= 3) continue;
      ns.n++;
      this.verifyNudgeState.set(t.id, ns);
      this.verifyNudgedAt.set(t.id, now);
      this.push(`verify_due: ${t.id.slice(0, 8)} ${t.title} accept: ${t.acceptance.slice(0, 120)}${awaiting ? " [awaiting acceptance since the agent finished — judge it now]" : ""}`);
      this.d.outlet?.hud?.("verify_due", t.id);
    }
    // task_due chase pump (SPEC-BUTLER §6): every tick the board is scanned
    // for live tasks past their dueAt — jex gets a nudge to check progress,
    // chase the worker or reassign. Debounced per task to >=60s and at least
    // one tick; settled tasks release their slot.
    const dueDebounce = Math.max(60_000, this.tickMsNow);
    for (const t of this.d.board.list()) {
      if (t.status !== "todo" && t.status !== "running") { this.taskDueNudgedAt.delete(t.id); continue; }
      if (t.dueAt === null || t.dueAt > now) continue;
      const last = this.taskDueNudgedAt.get(t.id) ?? 0;
      if (now - last < dueDebounce) continue;
      this.taskDueNudgedAt.set(t.id, now);
      this.push(`task due: ${t.title} — 检查进度，催办或重派`);
      // butler briefing rides the existing debounce: one chat line per chase
      this.d.outlet?.chatOut("jex", `提醒：「${t.title}」已到检查时间，我去核验进度`);
      this.d.outlet?.hud?.("task_due", t.id);
    }
    // R17 morning briefing pump: once per local day inside 08:00–11:00 the
    // butler owes its human a digest — yesterday's verdicts, board deltas,
    // lessons, today's plan. The event wakes decide to COMPOSE it (all the
    // material is already in its context); it is not a canned report.
    const d = new Date(now);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (d.getHours() >= 8 && d.getHours() < 11 && this.morningSent !== day) {
      this.morningSent = day;
      this.push("morning_briefing: compose today's digest for the human — yesterday's acceptance verdicts (see AGENT STATS deltas), what changed on the board, durable lessons from MEMORY, and today's plan; deliver it with the reply action, concise and warm");
    }
    // R22: every 6h the boot-time agent inventory may be stale — new CLI
    // installs deserve a scan before jex decides "no agent can do this"
    if (now - this.lastScoutNudge > 6 * 3_600_000) {
      this.lastScoutNudge = now;
      this.push("agents_rescan: agent CLIs may have been installed or removed since the last scan — run the toolscout action to refresh the fleet inventory");
    }
    // R35: the house round — quiet by default, loud only on anomaly
    if (now - this.lastWalkAt > 30 * 60_000) {
      this.lastWalkAt = now;
      this.push("patrol_walk: quick health round — check disk space, load, and anything unusual with LOOKING tools; stay silent unless something genuinely needs the human (then reply once, concisely)");
    }
  }

  // wire the api broadcast after construction (the api itself needs this loop)
  setOutlet(o: LoopOutlet): void { this.d.outlet = o; }

  private emitTasks(): void { this.d.outlet?.frame({ t: "tasks", tasks: this.d.board.list().map(taskView) }); }

  /** R72: cheap change fingerprint of the board — id:status:progress:verdict
   *  per card. An equal digest with nothing running means no new information
   *  since the last cycle; a pure tick against that world skips entirely. */
  private boardDigest(): string {
    return this.d.board.list().map((t) => `${t.id}:${t.status}:${t.progress}:${t.verdict}`).join("|");
  }

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
    this.tickCount++;
    this.vitals.cycles++;
    // the cycle frame reports whatever this wake cost and decided, even on the
    // cheap early exits — the operator sees every heartbeat
    let cost = 0;
    let actions: unknown[] = [];
    try {
      const gdef = getGearDef(this.gearNow)!;
      if (gdef.id === "dormant") return; // jex asleep: no patrol, no decide; direct chat still streams
      const gate = this.d.budget.gate();
      if (gate === "observe-only") return; // spend nothing, observe silently
      // eco thins the patrol cadence: pure tick wakes skip unless this is the
      // Nth tick; real events (chat, gantt, tool results) always pass through
      const parts = eventSummary.split(";").map((s) => s.trim()).filter(Boolean);
      const pureTick = parts.length > 0 && parts.every((p) => p === "tick");
      if (pureTick && gdef.patrolEvery > 0 && this.tickCount % gdef.patrolEvery !== 0) return;
      // R72 quiet skip: nothing about the world changed since the last cycle
      // (same board digest, nothing running, last cycle took no action) and
      // this wake carries no information of its own — skip patrol AND decide.
      // Real events (chat, tool results, due/verify pumps, spawn settlements)
      // never pass this gate: their summaries are not pure ticks.
      if (pureTick) {
        const digest = this.boardDigest();
        const anyRunning = this.d.board.list().some((t) => t.status === "running");
        if (!anyRunning && !this.lastCycleActed && digest === this.lastBoardDigest) {
          this.vitals.quietSkips++;
          return; // the finally block still emits the cycle heartbeat frame
        }
        this.lastBoardDigest = digest;
      }
      const gearPrefix = loopPrompt(this.gearNow);
      const read = (f: string) => { try { return readFileSync(join(this.d.runtimeDir, f), "utf8"); } catch { return `(${f} missing)`; } };
      const context = this.d.ctx.build({
        mission: read("MISSION.md"), rubric: read("RUBRIC.md"), memory: read("MEMORY.md"),
        board: this.d.board.list(), events: [eventSummary], budgetLine: this.d.budget.line(),
      });
      // layer 1: cheap patrol triage
      const p = await this.d.llm.chat("patrol", [
        { role: "system", content: (gearPrefix ? `${gearPrefix}\n\n` : "") + "You triage events for an autonomous jex agent. Reply ONLY JSON: {\"action\":\"none\"} if nothing needs a decision, {\"action\":\"act\"} otherwise. A 'chat:' event is the human talking to jex: act on it whenever it carries an errand or delegation — asking jex to do/make/write/fix/check/arrange something (帮我/做/建/写/修/查/安排…) or anything the direct-chat reply did not already settle; act on a chat: event unless it is a pure greeting or social chatter with no ask — a question about this machine or jex's work (hardware, system, files, processes, tasks, progress) ALWAYS acts (the direct-chat reply alone never settles it: it may be ungrounded), and any request or delegation always acts. When unsure, act — the human's words outrank thrift. A 'tool <name> -> ...' event is a builtin tool result jex itself just produced mid-flow: always act on it (continue: next tool, reply to the human, or wrap the task up). The same applies to 'tool approval ...' events: a queued write just got approved or denied, continue the flow. The same applies to 'due_spawn:', 'overdue:', 'unlocked:', 'task due:' and 'verify_due:' events (minute-Gantt: something is due now, late, freed by its parent, hit its deadline and needs chasing, or needs its acceptance checked — always act). A 'plan_created:' event means a goal was just decomposed into child steps on the board — always act: dispatch the ready steps (in the listed order when they depend on each other, in parallel when independent). A 'morning_briefing:' event is the daily digest mandate — always act: compose it and deliver with the reply action. An 'agents_rescan:' event means the agent inventory may be stale — act by running the toolscout action. A 'patrol_walk:' event is the quiet house round — act on it (LOOK with tools; reply ONLY if something genuinely needs the human). A 'boot:' event is the startup recon mandate — survey the system and today's goals, always act. An 'agents discovered:' event means fresh delegation capacity on this machine — always act." },
        { role: "user", content: context },
      ], { json: true, maxTokens: 512 }); // reasoning models spend completion tokens on reasoning before content
      let triage: { action?: unknown } = {}; try { triage = JSON.parse(p.content); } catch { cost = await this.maybeAudit(p.usage, []); this.lastCycleActed = false; return; } // patrol cost still booked on parse failure
      if (gate === "patrol-only") { cost = await this.maybeAudit(p.usage, []); this.lastCycleActed = false; return; } // near the cap: no expensive decide pass
      if (triage.action !== "act") { cost = await this.maybeAudit(p.usage, []); this.lastCycleActed = false; return; }

      // layer 2: strong decide pass — the only prompt that carries the framework manuals
      const manuals = manualsBlock(this.d.skillsDir ?? DEFAULT_SKILLS_DIR);
      const tools = this.d.scout?.readToolsBlock() ?? ""; // inventory tail: only the decide pass pays for it
      const tentacles = this.d.tentacles?.listBlock() ?? ""; // connector inventory rides the same tail
      const builtin = this.d.builtinTools?.schemasBlock() ?? ""; // builtin tool schemas ride it too
      const agentsBlock = this.d.orchestrator.getRegistry()?.toPromptBlock() ?? "";
      // the agent-scout's verified inventory (AGENTS.md) rides next to the
      // registry block: registry = what could spawn, AGENTS = what is actually
      // installed on this machine; blank or missing files inject nothing
      let agentsDoc = "";
      try { agentsDoc = readFileSync(join(this.d.runtimeDir, "AGENTS.md"), "utf8").trim(); } catch { /* not scouted yet */ }
      const stats = this.statsBlock(); // R8: per-agent verified track record
      // R16 vitals line: uptime / cycles / recent errors — self-awareness the
      // model can act on (mention it, slow down, or ask for help)
      const upH = Math.floor((Date.now() - this.bornAt) / 3_600_000);
      const vitals = `# VITALS（自我状态）: 运行 ${upH} 小时 · 决策周期 ${this.vitals.cycles} · 静默跳拍 ${this.vitals.quietSkips} · 近期错误 ${this.vitals.errors} 次${this.vitals.lastError ? `（最近：${this.vitals.lastError.slice(0, 60)}）` : ""} — 若错误偏多，向用户说明并在回复中体现克制`;
      // R19 time sense: the model has no clock of its own — scheduling,
      // morning briefings and "深夜别吵" judgment all need one line of now.
      const nd = new Date();
      const pad = (n: number): string => String(n).padStart(2, "0");
      const phase = nd.getHours() < 6 ? "凌晨" : nd.getHours() < 12 ? "上午" : nd.getHours() < 18 ? "下午" : "晚上";
      const timeLine = `# NOW: ${nd.getFullYear()}-${pad(nd.getMonth() + 1)}-${pad(nd.getDate())} ${pad(nd.getHours())}:${pad(nd.getMinutes())}（周${"日一二三四五六"[nd.getDay()]}，${phase}）— 深夜/凌晨时非紧急动作与通知从简，排程类任务移到白天`;
      // R71 replay of the last few cycles — decide's own short-term memory
      const recent = this.recentCycles.length > 0
        ? `# RECENT CYCLES（你最近几轮做过的事——世界没变就不要重复做；稳定任务不要反复 verify）\n${this.recentCycles.join("\n")}`
        : "";
      const decideMessages = [
        { role: "system", content: (gearPrefix ? `${gearPrefix}\n\n` : "") + `You are jex, orchestrator of an autonomous agent fleet. Choose actions. Reply ONLY JSON: {"actions":[{"type":"spawn","framework":"<agent name from AVAILABLE AGENTS>","title":"...","prompt":"...","parent":"task id (optional)","scheduledAt":"ISO 8601 (optional)","dueAt":"ISO 8601 (optional)","accept":"acceptance criteria: one objectively checkable success line (a fallback line is added when missing)"} | {"type":"reply","text":"conversational reply to the human in the chat"} | {"type":"message","text":"..."} | {"type":"mission_update","text":"..."} | {"type":"steer","task_id":"...","correction":"..."} | {"type":"takeover","input":{"kind":"key"|"move"|"click"|"type",...}} | {"type":"cdp","op":"cdp_open"|"cdp_snapshot","url":"..."} | {"type":"plan","goal":"...","steps":[{"title":"...","prompt":"...","framework":"<agent name>","scheduledAt":"ISO 8601 (optional)","dueAt":"ISO 8601 (optional)","accept":"..."}]} | {"type":"toolscout","query":"..."} | {"type":"tentacle_call","tentacle":"...","op":"...","args":{}} | {"type":"tool_call","tool":"<name from BUILTIN TOOLS>","args":{}} | {"type":"verify","task_id":"...","progress":0-100,"verdict":"pass|partial|fail","note":"one-line evidence from a real tool check (a pass without an evidence note is refused; a fail triggers one corrective re-dispatch)"} | {"type":"reflect","text":"a durable, REUSABLE lesson — trigger + what to do differently (e.g. '整理类任务先 du 看体积再动手'); not a narrative of what happened. Appended to MEMORY; related lessons are auto-injected into future matching dispatches, so write for the future worker (non-empty, <=4KB)"} | {"type":"tentacle_register","spec":{"name":"...","kind":"rest"|"webhook"|"poller"|"hardware"|"custom","endpoint":"...","auth":{"header":"...","apiKeyEnv":"ENV_VAR_NAME"},"ops":[{"name":"...","method":"GET","path":"/x/{id}","description":"..."}],"enabled":true,"blurb":"...","openapiUrl":"https://.../openapi.json","openapiContent":"<full OpenAPI document>"}}]}. Take 0-3 actions. Prefer spawning sub-agents over doing work yourself. Reply to human chat with the reply action; it costs no task and no sub-agent. The toolscout action re-scans, verifies, and manuals the installed CLI tools in the background — use it when a needed tool seems missing or the inventory looks stale; describe the job in query so the scout can also discover tools beyond its seed list. tentacle_call invokes one op of a registered external connector (see # TENTACLES in the context); tentacle_register validates and saves a new connector spec — a short spec template (name, kind, endpoint, a few ops) is enough for simple APIs, while spec.openapiUrl or spec.openapiContent imports a full OpenAPI document as a rest tentacle instead; specs written by spawned agents under runtime/tentacles/ are hot-loaded right after each register. tool_call runs one builtin tool directly (see # BUILTIN TOOLS in the context): small file, terminal, memory, or board work needs no sub-agent, and the result arrives as an event on the next wake. Reference API keys only through auth.apiKeyEnv (an environment variable name), never the key itself. You are an orchestrator and acceptance judge, never a worker: ALL productive work goes to coding agents via spawn; builtin tools are for LOOKING (verifying outputs, checking state), never for building. Questions about THIS machine or jex's fleet (hardware, OS, files, processes, network, installed tools, task progress) are LOOKING: answer them yourself via tool_call (terminal / read_file / process), grounded in the real output, then reply to the human — never state system facts from memory. Spawn sub-agents for work that builds or changes things; a long-running shell command that needs no agent is a background job (job_start, then job_output to harvest) — do not hold a cycle waiting on it. A goal needing 3+ ordered steps earns one plan action (epic + child steps with acceptance each) instead of ad-hoc spawns — the plan_created event re-wakes you to staff the steps. reflect banks a durable lesson into MEMORY — the butler's idle-cycle move when no task is ready: reflect, catch up on unverified work, or refine MISSION, instead of inventing busywork; a lesson already banked (see RECENT CYCLES / the MEMORY tail in context) must never be re-banked — the handler refuses duplicates, and an idle cycle with no NEW lesson takes no reflect at all. # RECENT CYCLES in the context lists what you did in the last few cycles: when a listed cycle already verified, answered, or dispatched the same thing and nothing material changed since (no new event, no agent completion, no due time hit), take no action on it — re-verifying a stable state or re-answering the same words is waste; act only on what is genuinely new.` },
        { role: "user", content: context + (agentsBlock ? `\n\n${agentsBlock}` : "") + (agentsDoc ? `\n\n# AGENTS (verified on this system)\n${agentsDoc}` : "") + (stats ? `\n\n${stats}` : "") + (vitals ? `\n\n${vitals}` : "") + `\n\n${timeLine}` + (recent ? `\n\n${recent}` : "") + (manuals ? `\n\n${manuals}` : "") + (tools ? `\n\n# AVAILABLE TOOLS\n${tools}` : "") + (tentacles ? `\n\n# TENTACLES\n${tentacles}` : "") + (builtin ? `\n\n${builtin}` : "") },
      ] satisfies ChatMsg[];
      const decideMax = gdef.decideMaxTokens; // the gear buys the decide budget
      let dec = await this.d.llm.chat("decide", decideMessages, { json: true, maxTokens: decideMax }); // big contexts (tools+tentacles inventories) starve reasoning models below this
      // reasoning models can burn the whole completion budget on reasoning and
      // emit no content; one adaptive retry at double budget recovers those
      // cycles instead of silently no-opping them
      if (dec.content.length === 0 && dec.usage.completionTokens >= decideMax) {
        console.warn(`[loop] decide starved (completion=${dec.usage.completionTokens}) — retrying at ${decideMax * 2}`);
        dec = await this.d.llm.chat("decide", decideMessages, { json: true, maxTokens: decideMax * 2 });
      }
      let parsed: any; try { parsed = JSON.parse(dec.content); } catch {
        console.warn(`[loop] decide content unparseable (len=${dec.content.length}, completion=${dec.usage.completionTokens}) — treating as no-op`);
        parsed = { actions: [] };
      }
      actions = parsed.actions ?? [];
      // R71: bank this cycle's replay line — the next decide sees what already
      // happened, so an unchanged world earns no repeated verify/reply
      {
        const hh = (n: number): string => String(n).padStart(2, "0");
        const cyc = new Date();
        const kinds = (parsed.actions ?? []).map((x: any) => {
          if (x?.type === "spawn") return `spawn(${String(x.title ?? "?").slice(0, 24)})`;
          if (x?.type === "verify") return `verify(${String(x.task_id ?? "?").slice(0, 8)}:${String(x.verdict ?? "?")})`;
          if (typeof x?.type === "string") return x.type;
          return "?";
        });
        this.recentCycles.push(`[${hh(cyc.getHours())}:${hh(cyc.getMinutes())}] wake=${eventSummary.slice(0, 60)} → ${kinds.length > 0 ? kinds.join(", ") : "no actions"} (decide ${dec.usage.completionTokens} tok)`);
        this.lastCycleActed = kinds.length > 0; // R72: an acted cycle keeps the next tick awake
        if (this.recentCycles.length > 5) this.recentCycles.splice(0, this.recentCycles.length - 5);
      }

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
            // SPEC-BUTLER §6: every spawned task carries an acceptance line —
            // a decide model that forgot one gets the prompt head plus the
            // verify mandate as the bar, so nothing settles unverified
            const acceptGiven = typeof a.accept === "string" && a.accept.length > 0;
            const acceptance = acceptGiven ? a.accept as string
              : `${(promptOk ? a.prompt : typeof a.title === "string" && a.title ? a.title : "task").toString().slice(0, 80)}（完成后 jex 须用只读工具 verify 并给出 verdict）`;
            const t = this.d.board.add({
              title: a.title ?? (promptOk ? a.prompt.slice(0, 60) : "(spawn without prompt)"),
              assignee: fwOk ? a.framework : String(a.framework),
              parentId, scheduledAt, dueAt, acceptance,
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
              this.d.outlet?.chatOut("jex", `已排程「${t.title}」（${relTime(scheduledAt as number)}开工，验收：${acceptance.slice(0, 40)}${acceptance.length > 40 ? "…" : ""}）`);
            } else {
            // R20 concurrency guard: the machine runs out of agents before
            // jex runs out of ideas — at 4 live sub-agents new work stays on
            // the board (todo) and the freed-slot pump re-wakes dispatch
            const live = this.d.board.list().filter((x) => x.status === "running").length;
            if (live >= 4) {
              console.log(`[ceo] spawn queued (${live} live): ${t.title}`);
              this.pendingSpawns.set(t.id, { framework: a.framework, prompt: a.prompt, title: t.title });
              this.push(`spawn_queued: ${t.title} (${live} sub-agents already live — dispatch resumes as they settle)`);
              this.d.outlet?.chatOut("jex", `「${t.title}」排队中（${live} 个子代理在跑，空出即派）`);
            } else {
            this.launchSpawn(t.id, a.framework, t.title, a.prompt,
              `已派发「${t.title}」给 ${a.framework}${dueAt ? `（预计 ${relTime(dueAt)}，` : "（"}验收：${acceptance.slice(0, 40)}${acceptance.length > 40 ? "…" : ""}）`, 1);
            }
            }
          } else if (a.type === "mission_update") {
            if (typeof a.text !== "string" || a.text.length === 0) throw new Error("invalid mission_update action: text must be a non-empty string");
            // snapshot the pre-edit docs first: git history keeps the old
            // mission recoverable, then jex's write-through lands on top
            this.d.auditor.snapshotRuntime();
            writeFileSync(join(this.d.runtimeDir, "MISSION.md"), a.text);
          } else if (a.type === "reflect") {
            // SPEC-BUTLER §5: append-only experience entry into MEMORY.md —
            // the butler's idle-cycle consolidation; the activity stream gets
            // a visible "jex is reflecting" card
            if (typeof a.text !== "string" || a.text.trim().length === 0) throw new Error("invalid reflect action: text must be a non-empty string");
            if (Buffer.byteLength(a.text, "utf8") > 4096) throw new Error("invalid reflect action: text must be at most 4KB");
            // R75 dedup: idle cycles re-banked the same lesson verbatim (three
            // near-identical "suppress empty cycles" entries in one soak
            // night) — an already-latest identical entry is refused; the
            // failure event tells decide to stop repeating itself
            {
              const key = (s: string): string => s.replace(/\s+/g, "").toLowerCase();
              const tail = (() => { try { return readFileSync(join(this.d.runtimeDir, "MEMORY.md"), "utf8"); } catch { return ""; } })();
              const lastEntry = tail.split(/\n(?=## )/).pop() ?? "";
              if (key(lastEntry).includes(key(a.text.trim()).slice(0, 80))) {
                throw new Error("invalid reflect action: this lesson is already the latest MEMORY entry — bank only NEW lessons");
              }
            }
            const p = join(this.d.runtimeDir, "MEMORY.md");
            if (!existsSync(p)) writeFileSync(p, "# MEMORY\n"); // missing file: recreate with the canonical header
            const d = new Date();
            const pad = (n: number): string => String(n).padStart(2, "0");
            const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
            appendFileSync(p, `\n## ${stamp}\n${a.text.trim()}\n`);
            // R43 memory rotation: the ledger only ever grows on disk — past
            // 100KB the head is years-stale lessons; keep the freshest half
            // (recent experience lives at the tail, same side the context
            // prune favors). Best-effort: a failed rotation never blocks the
            // reflect that earned it.
            try {
              const stat = statSync(p);
              if (stat.size > 100 * 1024) {
                const text = readFileSync(p, "utf8");
                const keep = text.slice(Math.floor(text.length / 2));
                const first = keep.indexOf("## ");
                writeFileSync(p, "# MEMORY\n(older entries pruned — recent lessons below)\n" + (first >= 0 ? keep.slice(first) : keep));
                console.log(`[loop] MEMORY rotated: ${stat.size} -> ${statSync(p).size} bytes`);
              }
            } catch { /* unreadable/unstatable: skip this rotation */ }
            this.push(`reflected: ${a.text.slice(0, 80)}`);
            // 管家小结 chat line only when the entry carries a real lesson:
            // short/no-op entries would chat-spam every idle cycle (double
            // guard next to the prompt's anti-busywork doctrine)
            if (a.text.trim().length > 30) this.d.outlet?.chatOut("jex", `管家小结：${a.text.slice(0, 60)}`);
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
          } else if (a.type === "plan") {
            // R9 decomposition: one epic + ordered child steps on the board.
            // plan only BUILDS the tree — dispatch stays a separate decision
            // on the next wake (plan_created event), so the model weighs
            // ordering and parallelism like a manager staffing a project.
            if (typeof a.goal !== "string" || a.goal.trim().length === 0) throw new Error("invalid plan action: goal must be a non-empty string");
            const steps = Array.isArray(a.steps) ? a.steps : [];
            if (steps.length < 1 || steps.length > 8) throw new Error("invalid plan action: steps must be an array of 1-8 steps");
            const registryNames = this.d.orchestrator.getRegistry()?.names() ?? [];
            const parsedSteps = steps.map((s: Record<string, unknown>, i: number) => {
              const title = typeof s.title === "string" && s.title ? s.title : `第${i + 1}步`;
              const prompt = typeof s.prompt === "string" && s.prompt ? s.prompt : "";
              const framework = typeof s.framework === "string" ? s.framework : (registryNames[0] ?? "hermes");
              if (!registryNames.includes(framework) && framework !== "hermes" && framework !== "claude-code") {
                throw new Error(`invalid plan action: step ${i + 1} framework must be a registered agent name (got ${JSON.stringify(framework)}). Available: ${registryNames.join(", ") || "hermes, claude-code"}`);
              }
              if (!prompt) throw new Error(`invalid plan action: step ${i + 1} prompt must be a non-empty string`);
              const acceptGiven = typeof s.accept === "string" && s.accept.length > 0;
              return {
                title, prompt, framework,
                scheduledAt: this.spawnTime(s.scheduledAt, "scheduledAt"),
                dueAt: this.spawnTime(s.dueAt, "dueAt"),
                acceptance: acceptGiven ? s.accept as string : `${title}（完成后 jex 须用只读工具 verify 并给出 verdict）`,
              };
            });
            const epic = this.d.board.add({
              title: a.goal.trim(), assignee: "jex",
              acceptance: `${a.goal.trim()}（全部子步骤验收通过后由 jex verify 收口）`,
            });
            for (const s of parsedSteps) {
              this.d.board.add({ title: s.title, assignee: s.framework, parentId: epic.id, scheduledAt: s.scheduledAt ?? null, dueAt: s.dueAt ?? null, acceptance: s.acceptance });
            }
            this.emitTasks();
            this.d.outlet?.chatOut("jex", `已制定计划「${a.goal.trim().slice(0, 40)}」：${parsedSteps.length} 步（首步：${parsedSteps[0]!.title.slice(0, 30)}）`);
            this.push(`plan_created: ${a.goal.trim().slice(0, 60)} (${parsedSteps.length} steps) — dispatch the ready steps now, respect the listed order when steps depend on each other`);
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
            // repeat guard: streak of identical (tool, args) across cycles
            const key = `${name}:${JSON.stringify(args)}`;
            const now = Date.now();
            if (this.toolRepeat.key !== key || now - this.toolRepeat.at > 10 * 60_000) this.toolRepeat = { key, n: 0, at: now };
            this.toolRepeat.n += 1;
            this.toolRepeat.at = now;
            const rep = this.toolRepeat.n;
            // fire-and-forget like tentacle_call: the result rides the log +
            // the next wake's event queue; the gate is the effective one
            // (gateForTools: observe with no takeover link degrades to assist),
            // non-internal writes under assist land in the approval queue
            void this.d.builtinTools.call(name, args, this.gateForTools()).then((r) => {
              console.log(`[ceo] tool ${name} -> ${r.slice(0, 200)}`);
              // escalation ladder rides inside the event the next decide
              // reads: a nudge at 3, a hard warning at 5 — never a veto (the
              // model may have a legitimate reason, it just has to see itself)
              const note = rep >= 5
                ? ` [WARNING: identical call #${rep} — this approach is stuck; stop repeating, reflect a lesson or change method]`
                : rep >= 3
                  ? ` [NOTE: identical call #${rep}; same result expected — change approach or move on]`
                  : "";
              this.push(`tool ${name} -> ${r}${note}`);
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
            // R7 evidence chain: a pass must cite what was actually checked —
            // a bare "pass" is a judgment without grounds and is refused (the
            // action-failed event teaches the model the bar for next time)
            if (verdict === "pass" && note.trim().length < 8) {
              throw new Error("invalid verify action: a pass verdict must carry an evidence note (one line citing the tool output you checked)");
            }
            this.d.board.update(card.id, { progress, verdict, resultSummary: [card.resultSummary, note].filter(Boolean).join(" | ") });
            // acceptance loop closes here: a pass on a task that finished
            // cleanly but was held blocked pending acceptance promotes it
            if (verdict === "pass" && card.status === "blocked" && card.resultSummary.includes("[awaiting acceptance")) {
              // strip the now-obsolete acceptance instructions from the done card
              const cleaned = [card.resultSummary, note].filter(Boolean).join(" | ").replace(/\s*\[awaiting acceptance[^\]]*\]/g, "");
              this.d.board.update(card.id, { status: "done", resultSummary: cleaned });
            }
            this.emitTasks();
            // butler briefing: the acceptance verdict is the line the user is
            // waiting for — one chat line per verdict, never per progress tweak
            const mark = verdict === "pass" ? "✓ 通过"
              : verdict === "fail" ? `✗ 未过——${note.slice(0, 40)}`
              : `◐ 部分通过——${note.slice(0, 40)}`;
            this.d.outlet?.chatOut("jex", `验收「${card.title}」：${mark}`);
            console.log(`[ceo] verify ${card.id.slice(0, 8)} -> ${verdict} ${progress}%${verdict === "pass" && card.status === "blocked" ? " -> done" : ""} ${note.slice(0, 80)}`);
            // R8 experience ledger: every verdict is one stat line — the
            // decide pass aggregates them into a per-agent track record, so
            // staffing starts learning who is good at what (a manager's gut
            // feeling, but written down and counted)
            this.appendStat(card.assignee, verdict, card.title);
            // R7 auto-retry: a failed acceptance is not a dead end — like a
            // human manager, jex re-dispatches once with the failure folded
            // into the prompt. Second failure (attempts >= 2) stays on the
            // board for the human; retrying forever would burn tokens on a
            // hopeless task.
            if (verdict === "fail" && card.status !== "done" && card.attempts < 2 && !card.parentId
              && !this.d.board.list().some((x) => x.parentId === card.id)) {
              const retried = this.d.board.add({
                title: `${card.title}（重派#2）`, assignee: card.assignee, parentId: card.id,
                acceptance: card.acceptance || `${card.title}（完成后 jex 须用只读工具 verify 并给出 verdict）`,
              });
              const corrective = `${card.acceptance ? `任务：${card.acceptance}\n` : ""}上一次尝试未通过验收，原因：${note}\n请修正这个问题后完成任务。`;
              this.launchSpawn(retried.id, card.assignee, retried.title, corrective,
                `已重派「${card.title}」（第2次尝试，修正：${note.slice(0, 40)}）`, 2);
            }
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
    } catch (e) {
      // R16: a failed cycle feeds the vitals the next decide pass reads —
      // recurring errors become visible to the model itself, not just the log
      this.vitals.errors++;
      this.vitals.lastError = e instanceof Error ? e.message : String(e);
      this.lastCycleActed = true; // R72: an errored cycle deserves a real retry next tick, not a quiet skip
      throw e; // the original contract (runOnceQueue logs it) is untouched
    } finally {
      // every cycle ends on the wire: the heartbeat frame plus the fresh budget line
      this.d.outlet?.frame({ t: "cycle", wake: this.wakeN, tickN: this.tickCount, cost, actions });
      // full snapshot (not just the line) so clients' progress bars advance
      // live; the line stays for one-line CLI summaries
      this.d.outlet?.frame({ t: "budget", line: this.d.budget.line(), budget: this.d.budget.snapshot() });
    }
  }

  /** R20 queue drain: promote the oldest queued spawn once a slot is free.
   *  Cards that settled some other way while queued are skipped. */
  private drainPendingSpawns(): void {
    for (;;) {
      const entry = this.pendingSpawns.entries().next();
      if (entry.done) return;
      const [id, next] = entry.value;
      const live = this.d.board.list().filter((x) => x.status === "running").length;
      if (live >= 4) return;
      this.pendingSpawns.delete(id);
      const card = this.d.board.list().find((x) => x.id === id);
      if (!card || card.status !== "todo") continue; // settled otherwise: skip
      this.launchSpawn(id, next.framework, next.title, next.prompt,
        `已派发「${next.title}」给 ${next.framework}（排队转正，验收：${card.acceptance.slice(0, 40)}${card.acceptance.length > 40 ? "…" : ""}）`, card.attempts || 1);
    }
  }

  /** R8 stat ledger: append `framework|verdict|title` to runtime/STATS.md.
   *  Append-only like MEMORY.md — aggregation happens at read time so the
   *  raw history always stays auditable by the human. Best-effort: a stats
   *  write failure must never break the verify that earned it. */
  private appendStat(framework: string, verdict: string, title: string): void {
    try {
      appendFileSync(join(this.d.runtimeDir, "STATS.md"), `${framework}|${verdict}|${title.slice(0, 60).replaceAll("|", "/")}\n`);
    } catch (e) {
      console.warn(`[loop] stats append failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** R8 aggregate: last 200 stat lines folded into a per-agent track record
   *  for the decide context. Empty ledger → empty string (nothing injected). */
  private statsBlock(): string {
    try {
      const raw = readFileSync(join(this.d.runtimeDir, "STATS.md"), "utf8");
      const lines = raw.split("\n").filter((l) => l.includes("|")).slice(-200);
      if (lines.length === 0) return "";
      const byAgent = new Map<string, { pass: number; fail: number; partial: number; titles: string[] }>();
      for (const l of lines) {
        const [fw, verdict, title] = l.split("|");
        if (!fw || !verdict) continue;
        const s = byAgent.get(fw) ?? { pass: 0, fail: 0, partial: 0, titles: [] };
        if (verdict === "pass") s.pass++;
        else if (verdict === "fail") s.fail++;
        else if (verdict === "partial") s.partial++;
        if (title && s.titles.length < 3) s.titles.push(title);
        byAgent.set(fw, s);
      }
      const rows = [...byAgent.entries()].map(([fw, s]) => {
        const total = s.pass + s.fail + s.partial;
        const pct = total > 0 ? Math.round((s.pass / total) * 100) : 0;
        return `- ${fw}: ${total} 次验收，通过率 ${pct}%（${s.pass}✓ ${s.partial}◐ ${s.fail}✗）${s.titles.length ? `，近期：${s.titles.join("、")}` : ""}`;
      });
      return `# AGENT STATS（各代理实测战绩——派活时优先选同类任务通过率高的）\n${rows.join("\n")}`;
    } catch {
      return ""; // no ledger yet: inject nothing
    }
  }

  /** Launch a spawned task in the background: mark running, brief the human,
   *  and settle the card when the sub-agent exits (done / blocked + briefing +
   *  re-wake). Shared by the spawn action and the acceptance-loop auto-retry
   *  (R7) — one settlement path, one briefing contract. */
  private launchSpawn(taskId: string, framework: string, title: string, rawPrompt: string, brief: string, attempt: number): void {
    this.d.board.update(taskId, { status: "running", attempts: attempt });
    this.emitTasks();
    // butler briefing: the user asked to be kept told — every dispatch earns
    // one chat line, no conditions (spawn itself is rare)
    this.d.outlet?.chatOut("jex", brief);
    // background: the cycle moves on to the next action; the card settles
    // when the sub-agent exits, and the completion re-wakes jex
    const prompt0 = this.withToolManuals(rawPrompt);
    // R30 contract honesty: the acceptance bar lives on the card, but the
    // sub-agent only ever sees the prompt — until now jex graded against a
    // ruler the worker never read. Ship the bar with the work.
    const card = this.d.board.list().find((x) => x.id === taskId);
    let prompt = card && card.acceptance
      ? `${prompt0}\n\n# 验收标准（完成后 jex 将按此判定）\n${card.acceptance}`
      : prompt0;
    prompt = this.withMemory(prompt, title); // R53: related lessons ride along
    // R66 output contract: a machine-greppable final line makes the summary
    // settle cleanly and gives verify a concrete artifact to check against
    prompt += "\n\n# 产出约定\n最后一行必须输出：RESULT: <一句话结果与关键事实>";
    void this.d.orchestrator.spawn(framework, prompt).then((r) => {
      if (r.summaryUsage) this.d.budget.spend(r.summaryUsage); // sub-agent summary cost belongs to this wake
      const card = this.d.board.list().find((x) => x.id === taskId);
      const hasAccept = (card?.acceptance ?? "") !== "";
      const verdictOk = !hasAccept || (card?.verdict === "pass");
      const ok = r.exitCode === 0 && !r.summary.startsWith("FAIL") && verdictOk;
      this.d.board.update(taskId, {
        status: ok ? "done" : "blocked",
        resultSummary: r.exitCode === 0 && !verdictOk ? `${r.summary} [awaiting acceptance: verify with tools, then {"type":"verify","task_id":"...","verdict":"pass",...}]` : r.summary,
      });
      this.emitTasks();
      this.d.outlet?.chatOut("jex", `「${title}」${ok ? "完成" : "阻塞"}：${r.summary.slice(0, 60)}`);
      this.push(`agent_done: ${title} -> ${r.summary}`);
      this.drainPendingSpawns(); // R20: a settled slot may promote a queued spawn
    }).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[ceo] action failed: ${reason}`);
      const summary = `action failed: ${reason}`;
      this.d.board.update(taskId, { status: "blocked", resultSummary: summary });
      this.emitTasks();
      this.d.outlet?.chatOut("jex", `「${title}」阻塞：${summary.slice(0, 60)}`);
      this.drainPendingSpawns(); // a failed launch frees a slot too
    }).catch((err: unknown) => {
      // terminal guard: a crash inside the settlement handlers above must
      // not escape as an unhandled rejection and take the process down
      console.error(`[ceo] spawn handler crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
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
  /** R53 institutional memory: scan MEMORY.md for entries whose tokens
   *  overlap the task title and inject the best few into the dispatch prompt
   *  — the butler's accumulated lessons reach the workers who can use them.
   *  Most-recent wins on ties (the ledger is appended chronologically). */
  private withMemory(prompt: string, title: string): string {
    try {
      const raw = readFileSync(join(this.d.runtimeDir, "MEMORY.md"), "utf8");
      const entries = raw.split(/\n(?=## )/).map((e) => e.trim()).filter((e) => e.startsWith("## "));
      if (entries.length === 0) return prompt;
      const tokens = overlapTokens(title); // CJK-safe: 2-gram windows match partial phrases
      if (tokens.size === 0) return prompt;
      let best: Array<{ score: number; text: string }> = [];
      for (const e of entries) {
        const score = overlapScore(e, tokens);
        if (score > 0) best.push({ score, text: e });
      }
      if (best.length === 0) return prompt;
      best = best.slice(-3); // keep the most recent hits…
      best.sort((a, b) => b.score - a.score); // …then surface the strongest
      const block = best.map((b) => b.text.slice(0, 400)).join("\n");
      return `${prompt}\n\n# 相关经验（jex 过往沉淀，供参考避免重蹈）\n${block}`;
    } catch {
      return prompt; // no ledger yet: nothing to recall
    }
  }

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

  start(tickMs?: number): void {
    this.stop();
    this.stopped = false;
    this.ticking = true;
    this.backoffMs = this.d.reconnectBaseMs ?? 1000;
    this.connectWs();
    if (tickMs !== undefined) this.tickMsNow = tickMs > 0 ? Math.floor(tickMs) : 0; // explicit override (cfg.tickMs) wins at boot
    if (this.tickMsNow > 0) {
      this.timer = setInterval(() => { this.pumpGantt(); this.push("tick"); }, this.tickMsNow);
      this.timer.unref();
    }
    this.lastTickSeen = { n: this.tickCount, at: Date.now() };
    this.watchdog = setInterval(() => this.checkStall(), 60_000);
    this.watchdog.unref();
  }
  stop(): void {
    this.stopped = true; // first: late socket events must not reschedule anything
    this.ticking = false;
    clearInterval(this.timer);
    this.timer = undefined;
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    clearTimeout(this.debounce);
    this.debounce = undefined;
  }

  /** R10 stall detector: tickN frozen past 3 tick periods (floor 3 min) with a
   *  live tick interval means the timer or the queue wedged — force one wake
   *  (the wake itself re-proves the machinery) and say so on the wire. */
  private checkStall(): void {
    if (this.stopped || this.tickMsNow === 0) { this.lastTickSeen = { n: this.tickCount, at: Date.now() }; return; }
    const now = Date.now();
    if (this.tickCount !== this.lastTickSeen.n) { this.lastTickSeen = { n: this.tickCount, at: now }; return; }
    const floor = this.d.watchdogFloorMs ?? 180_000;
    const stallMs = Math.max(3 * this.tickMsNow, floor);
    if (now - this.lastTickSeen.at < stallMs) return;
    const frozenFor = Math.round((now - this.lastTickSeen.at) / 1000);
    console.warn(`[loop] stalled: tickN=${this.tickCount} frozen for ${frozenFor}s — forcing a self-recovery wake`);
    this.lastTickSeen.at = now; // one forced wake per stall window
    this.push(`loop_stalled: tick frozen ${frozenFor}s — self-recovery wake (check timers, queue and the takeover link)`);
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
