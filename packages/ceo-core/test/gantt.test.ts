// packages/ceo-core/test/gantt.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBoard } from "../src/board.js";
import { DatabaseSync } from "node:sqlite";
// Test helpers for pumpGantt suite (Task 2)
import { SchedulerLoop } from "../src/loop.js";
import { LLMClient } from "../src/llm.js";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { Auditor } from "../src/auditor.js";
import { BudgetGovernor } from "../src/budget.js";
import { ContextAssembler } from "../src/context.js";
import { vi } from "vitest";

let dir: string; let b: TaskBoard;
const NOW = 1_700_000_000_000;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rjgantt-"));
  b = new TaskBoard(join(dir, "b.sqlite"));
});

describe("new columns", () => {
  it("defaults: acceptance empty, progress 0, verdict unchecked, nag null", () => {
    const t = b.add({ title: "x" });
    expect(t.acceptance).toBe("");
    expect(t.progress).toBe(0);
    expect(t.verdict).toBe("unchecked");
    expect(t.overdueNaggedAt).toBeNull();
  });
  it("add carries acceptance; update persists progress/verdict/nag", () => {
    const t = b.add({ title: "y", acceptance: "tests green" });
    expect(b.list()[0].acceptance).toBe("tests green");
    b.update(t.id, { progress: 60, verdict: "partial" });
    const row = b.list().find((r) => r.id === t.id)!;
    expect(row.progress).toBe(60);
    expect(row.verdict).toBe("partial");
    b.update(t.id, { overdueNaggedAt: NOW });
    expect(b.list().find((r) => r.id === t.id)!.overdueNaggedAt).toBe(NOW);
  });
  it("old boards migrate in place (pre-column schema upgrades cleanly)", () => {
    const raw = new DatabaseSync(join(dir, "old.sqlite"));
    raw.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
      priority INTEGER NOT NULL DEFAULT 0, assignee TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
      resultSummary TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT, scheduled_at INTEGER, due_at INTEGER)`);
    raw.prepare("INSERT INTO tasks (id,title,createdAt) VALUES ('legacy','legacy',1)").run();
    raw.close();
    const upgraded = new TaskBoard(join(dir, "old.sqlite"));
    const row = upgraded.list()[0];
    expect(row.title).toBe("legacy");
    expect(row.acceptance).toBe("");
    expect(row.progress).toBe(0);
    expect(row.verdict).toBe("unchecked");
    expect(row.overdueNaggedAt).toBeNull();
  });
});

describe("dueSpawnTasks", () => {
  it("returns todo tasks whose scheduledAt has passed, earliest first", () => {
    b.add({ title: "past", scheduledAt: NOW - 1000 });
    b.add({ title: "future", scheduledAt: NOW + 60_000 });
    b.add({ title: "earlier", scheduledAt: NOW - 60_000 });
    b.add({ title: "running-past", scheduledAt: NOW - 60_000 });
    b.update(b.list().find((t) => t.title === "running-past")!.id, { status: "running" });
    const due = b.dueSpawnTasks(NOW);
    expect(due.map((t) => t.title)).toEqual(["earlier", "past"]);
  });
  it("ignores tasks without a schedule", () => {
    b.add({ title: "bare" });
    expect(b.dueSpawnTasks(NOW)).toHaveLength(0);
  });
});

describe("overdueTasks", () => {
  it("returns todo/running tasks past dueAt", () => {
    b.add({ title: "late-todo", dueAt: NOW - 1 });
    b.add({ title: "late-running", dueAt: NOW - 1 });
    b.add({ title: "late-done", dueAt: NOW - 1 });
    b.add({ title: "not-yet", dueAt: NOW + 60_000 });
    const ids = b.list();
    b.update(ids.find((t) => t.title === "late-running")!.id, { status: "running" });
    b.update(ids.find((t) => t.title === "late-done")!.id, { status: "done" });
    const od = b.overdueTasks(NOW);
    expect(od.map((t) => t.title).sort()).toEqual(["late-running", "late-todo"]);
  });
});

function ganttRig(board: TaskBoard, runtimeDir: string, events: string[]) {
  const chat = vi.fn(async (slot: string, msgs: Array<{ role: string; content: string }>) => {
    if (slot === "patrol") {
      const sys = String(msgs[0].content);
      const mustAct = /due_spawn|overdue|unlocked/.test(sys);
      return { content: mustAct ? '{"action":"act"}' : '{"action":"none"}', usage: { promptTokens: 10, completionTokens: 2 } };
    }
    return { content: JSON.stringify({ actions: [] }), usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const llm = { chat } as unknown as LLMClient;
  const loop = new SchedulerLoop({
    llm, board, ctx: new ContextAssembler(),
    orchestrator: new AgentOrchestrator({ llm, runtimeDir, cmds: {} }),
    auditor: new Auditor({ runtimeDir, reviewEvery: 99 }),
    budget: new BudgetGovernor("burn"), runtimeDir,
  });
  const origPush = loop.push.bind(loop);
  loop.push = (e: string) => { events.push(e); origPush(e); };
  return { loop, chat };
}

describe("pumpGantt", () => {
  it("emits due_spawn for a todo task past its scheduledAt exactly once", () => {
    const events: string[] = [];
    const b2 = new TaskBoard(join(dir, "p1.sqlite"));
    const t = b2.add({ title: "scan disk", scheduledAt: NOW - 1000 });
    const { loop } = ganttRig(b2, dir, events);
    loop.pumpGantt(NOW);
    loop.pumpGantt(NOW + 60_000); // second tick: same task must NOT re-emit
    const spawns = events.filter((e) => e.startsWith("due_spawn:"));
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toContain(t.id.slice(0, 8));
    expect(spawns[0]).toContain("scan disk");
  });

  it("a task that leaves todo and returns (kanban_unblock) re-earns due_spawn", () => {
    const events: string[] = [];
    const b2 = new TaskBoard(join(dir, "p5.sqlite"));
    const t = b2.add({ title: "flaky job", scheduledAt: NOW - 1000 });
    const { loop } = ganttRig(b2, dir, events);
    loop.pumpGantt(NOW); // emits once
    b2.update(t.id, { status: "running" });
    loop.pumpGantt(NOW + 60_000); // leaves todo: dispatch state reset
    b2.update(t.id, { status: "blocked" });
    b2.update(t.id, { status: "todo" }); // unblocked back to todo
    loop.pumpGantt(NOW + 120_000); // must emit again
    expect(events.filter((e) => e.startsWith("due_spawn:")).length).toBe(2);
  });

  it("emits overdue with 30-minute throttle and stamps overdueNaggedAt", () => {
    const events: string[] = [];
    const b2 = new TaskBoard(join(dir, "p2.sqlite"));
    const t = b2.add({ title: "late thing", dueAt: NOW - 1000 });
    const { loop } = ganttRig(b2, dir, events);
    loop.pumpGantt(NOW);
    loop.pumpGantt(NOW + 60_000); // inside the 30-min window: throttled
    expect(events.filter((e) => e.startsWith("overdue:")).length).toBe(1);
    expect(b2.list()[0].overdueNaggedAt).toBe(NOW);
    loop.pumpGantt(NOW + 31 * 60_000); // past the window: re-nag
    expect(events.filter((e) => e.startsWith("overdue:")).length).toBe(2);
  });

  it("emits unlocked when the parent is done and the child is todo without a future schedule", () => {
    const events: string[] = [];
    const b2 = new TaskBoard(join(dir, "p3.sqlite"));
    const parent = b2.add({ title: "parent" });
    b2.update(parent.id, { status: "done" });
    const child = b2.add({ title: "child step", parentId: parent.id });
    b2.add({ title: "scheduled child", parentId: parent.id, scheduledAt: NOW + 3_600_000 }); // future: stays queued
    const { loop } = ganttRig(b2, dir, events);
    loop.pumpGantt(NOW);
    const unl = events.filter((e) => e.startsWith("unlocked:"));
    expect(unl).toHaveLength(1);
    expect(unl[0]).toContain("child step");
    expect(child.id).toBeTruthy();
    loop.pumpGantt(NOW); // idempotent
    expect(events.filter((e) => e.startsWith("unlocked:"))).toHaveLength(1);
  });

  it("patrol prompt carries the gantt event rules (act mandate)", async () => {
    const events: string[] = [];
    const b2 = new TaskBoard(join(dir, "p4.sqlite"));
    const { loop, chat } = ganttRig(b2, dir, events);
    b2.add({ title: "x", scheduledAt: NOW - 1 });
    loop.pumpGantt(NOW); // pushes due_spawn -> debounce fires a cycle 500ms later
    await new Promise((r) => setTimeout(r, 900));
    const patrolSys = String((chat.mock.calls.find((c) => c[0] === "patrol")?.[1] as Array<{ role: string; content: string }>)?.[0]?.content ?? "");
    expect(patrolSys).toContain("due_spawn");
  });
});

// SPEC-BUTLER §6: the chase pump — live tasks past dueAt get a "task due:"
// nudge every >=60s (and at least one tick), settled tasks stop nudging.
describe("task_due pump", () => {
  it("nudges a running task past its dueAt once per debounce window", () => {
    const events: string[] = [];
    const b2 = new TaskBoard(join(dir, "td1.sqlite"));
    const t = b2.add({ title: "late job", dueAt: NOW - 1000 });
    b2.update(t.id, { status: "running" });
    const { loop } = ganttRig(b2, dir, events);
    loop.pumpGantt(NOW);
    loop.pumpGantt(NOW + 30_000); // inside the 60s window: throttled
    const nudges = events.filter((e) => e.startsWith("task due:"));
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain("late job");
    expect(nudges[0]).toContain("检查进度");
    loop.pumpGantt(NOW + 61_000); // past the window: chase again
    expect(events.filter((e) => e.startsWith("task due:"))).toHaveLength(2);
  });

  it("todo tasks past due are chased too; done/blocked and future-due tasks are not", () => {
    const events: string[] = [];
    const b2 = new TaskBoard(join(dir, "td2.sqlite"));
    const todo = b2.add({ title: "todo-late", dueAt: NOW - 1 });
    void todo;
    b2.add({ title: "done-late", dueAt: NOW - 1 });
    b2.add({ title: "blocked-late", dueAt: NOW - 1 });
    b2.add({ title: "future", dueAt: NOW + 60_000 });
    b2.add({ title: "no-due" });
    const ids = b2.list();
    b2.update(ids.find((t) => t.title === "done-late")!.id, { status: "done" });
    b2.update(ids.find((t) => t.title === "blocked-late")!.id, { status: "blocked" });
    const { loop } = ganttRig(b2, dir, events);
    loop.pumpGantt(NOW);
    const nudges = events.filter((e) => e.startsWith("task due:"));
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain("todo-late");
  });

  it("a settled task releases its debounce slot; a re-opened one is chased again", () => {
    const events: string[] = [];
    const b2 = new TaskBoard(join(dir, "td3.sqlite"));
    const t = b2.add({ title: "flappy", dueAt: NOW - 1 });
    b2.update(t.id, { status: "running" });
    const { loop } = ganttRig(b2, dir, events);
    loop.pumpGantt(NOW); // first nudge
    b2.update(t.id, { status: "done" });
    loop.pumpGantt(NOW + 1000); // settled: no nudge, slot released
    b2.update(t.id, { status: "todo" }); // re-opened
    loop.pumpGantt(NOW + 2000); // fresh slot: chased immediately even inside 60s
    const nudges = events.filter((e) => e.startsWith("task due:"));
    expect(nudges).toHaveLength(2);
  });

  it("the debounce floor is max(60s, one tick): a turbo tick cannot flood the queue", () => {
    const events: string[] = [];
    const b2 = new TaskBoard(join(dir, "td4.sqlite"));
    const t = b2.add({ title: "turbo job", dueAt: NOW - 1 });
    b2.update(t.id, { status: "running" });
    const { loop } = ganttRig(b2, dir, events);
    loop.setTickMs(15_000); // turbo cadence
    loop.pumpGantt(NOW);
    loop.pumpGantt(NOW + 15_000); // one turbo tick later: still inside the 60s floor
    loop.pumpGantt(NOW + 30_000);
    expect(events.filter((e) => e.startsWith("task due:"))).toHaveLength(1);
    loop.stop();
  });
});
