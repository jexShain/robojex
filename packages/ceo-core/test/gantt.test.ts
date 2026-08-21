// packages/ceo-core/test/gantt.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBoard } from "../src/board.js";
import { DatabaseSync } from "node:sqlite";

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
