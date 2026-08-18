// packages/ceo-core/src/loop.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LLMClient } from "./llm.js";
import type { TaskBoard } from "./board.js";
import type { ContextAssembler } from "./context.js";
import type { AgentOrchestrator } from "./orchestrator.js";
import type { Auditor } from "./auditor.js";
import type { BudgetGovernor } from "./budget.js";
import WebSocket from "ws";

export interface LoopDeps {
  llm: LLMClient; board: TaskBoard; ctx: ContextAssembler;
  orchestrator: AgentOrchestrator; auditor: Auditor; budget: BudgetGovernor;
  runtimeDir: string; takeoverUrl?: string;
}

export class SchedulerLoop {
  private queue: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private wakeN = 0;
  private ws: WebSocket | null = null;
  private running = false;
  private idleWaiters: (() => void)[] = [];
  constructor(private d: LoopDeps) {}

  wakeCount(): number { return this.wakeN; }

  push(event: string): void {
    this.queue.push(event);
    // merge events inside a 500ms window into one decision cycle
    if (!this.debounce) {
      this.debounce = setTimeout(() => { this.debounce = null; this.runOnceQueue().catch(() => {}); }, 500);
    }
  }

  private async runOnceQueue(): Promise<void> {
    if (this.running) {
      // a cycle is in flight: leave the queued events in place, retry after it ends
      if (!this.debounce) this.debounce = setTimeout(() => { this.debounce = null; this.runOnceQueue().catch(() => {}); }, 500);
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
      { role: "system", content: "You triage events for an autonomous CEO agent. Reply ONLY JSON: {\"action\":\"none\"} if nothing needs a decision, {\"action\":\"act\"} otherwise." },
      { role: "user", content: context },
    ], { json: true, maxTokens: 20 });
    let triage: { action?: unknown } = {}; try { triage = JSON.parse(p.content); } catch { await this.maybeAudit(p.usage, []); return; } // patrol cost still booked on parse failure
    if (gate === "patrol-only") { await this.maybeAudit(p.usage, []); return; } // near the cap: no expensive decide pass
    if (triage.action !== "act") { await this.maybeAudit(p.usage, []); return; }

    // layer 2: strong decide pass
    const dec = await this.d.llm.chat("decide", [
      { role: "system", content: `You are the CEO of an autonomous agent fleet. Choose actions. Reply ONLY JSON: {"actions":[{"type":"spawn","framework":"hermes"|"claude-code","title":"...","prompt":"..."} | {"type":"message","text":"..."} | {"type":"mission_update","text":"..."} | {"type":"takeover","input":{"kind":"key"|"move"|"click"|"type",...}}]}. Take 0-3 actions. Prefer spawning sub-agents over doing work yourself.` },
      { role: "user", content: context },
    ], { json: true });
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
          const r = await this.d.orchestrator.spawn(a.framework, a.prompt);
          if (r.summaryUsage) this.d.budget.spend(r.summaryUsage); // sub-agent summary cost belongs to this wake
          this.d.board.update(t.id, {
            status: r.exitCode === 0 && !r.summary.startsWith("FAIL") ? "done" : "blocked",
            resultSummary: r.summary, attempts: 1,
          });
        } else if (a.type === "mission_update") {
          if (typeof a.text !== "string" || a.text.length === 0) throw new Error("invalid mission_update action: text must be a non-empty string");
          // audited later via snapshot; write-through allowed for CEO self-edit
          writeFileSync(join(this.d.runtimeDir, "MISSION.md"), a.text);
        } else if (a.type === "message") {
          console.log(`[ceo->human] ${a.text}`);
        } else if (a.type === "takeover") {
          if (typeof a.input !== "object" || a.input === null) throw new Error("invalid takeover action: input must be an object");
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ t: "ctrl", op: "input", id: crypto.randomUUID(), action: a.input }));
          }
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
    if (this.d.takeoverUrl) {
      this.ws = new WebSocket(this.d.takeoverUrl);
      this.ws.on("message", (raw) => {
        try {
          const m = JSON.parse(String(raw));
          if (m.t === "evt" && m.type === "screen_diff") this.push(`screen_diff hamming=${m.hamming}`);
          if (m.t === "evt" && m.type === "mode_changed") this.push(`mode_changed -> ${m.mode}`);
          if (m.t === "human") this.push(`human: ${m.text}`);
        } catch { /* ignore malformed */ }
      });
      this.ws.on("close", () => { this.ws = null; }); // degrade to pure CLI until reconnect
    }
    this.timer = setInterval(() => this.push("tick"), tickMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.ws?.close(); this.ws = null; if (this.debounce) clearTimeout(this.debounce); this.debounce = null; }
}
