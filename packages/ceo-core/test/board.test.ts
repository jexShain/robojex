// packages/ceo-core/test/board.test.ts
import { TaskBoard, type TaskNode } from "../src/board.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

// every title reachable from a tree: the "nothing dropped out" check shared
// by the dangling-parent and parent-cycle tests
function reachableTitles(roots: TaskNode[]): string[] {
  const stack = [...roots];
  const out: string[] = [];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n.title);
    stack.push(...n.children);
  }
  return out;
}

test("add/list/update roundtrip persists across instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-board-"));
  const b1 = new TaskBoard(join(dir, "board.sqlite"));
  const t = b1.add({ title: "watch site", priority: 5, assignee: "hermes" });
  expect(t.status).toBe("todo");
  b1.update(t.id, { status: "done", resultSummary: "no change 3d" });
  const b2 = new TaskBoard(join(dir, "board.sqlite")); // reopen: persistence
  const list = b2.list();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ status: "done", resultSummary: "no change 3d" });
});

test("v1 database migrates in place: old rows keep null parent/schedule, new fields writable", () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-board-"));
  const p = join(dir, "board.sqlite");
  // a pre-v2 board: the tasks table has no parent_id/scheduled_at/due_at yet
  const old = new DatabaseSync(p);
  old.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
    priority INTEGER NOT NULL DEFAULT 0, assignee TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0, resultSummary TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL DEFAULT 0)`);
  old.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)").run("legacy1", "old job", "done", 3, "hermes", 1, "ok", 123);
  old.close();

  const b = new TaskBoard(p); // reopen: the ALTERs land, old rows untouched
  const list = b.list();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ id: "legacy1", title: "old job", createdAt: 123, parentId: null, scheduledAt: null, dueAt: null });
  const t = b.add({ title: "new job", parentId: "legacy1", scheduledAt: 1_000, dueAt: 2_000 });
  expect(b.list().find((x) => x.id === t.id)).toMatchObject({ parentId: "legacy1", scheduledAt: 1_000, dueAt: 2_000 });
});

test("add persists parentId/scheduledAt/dueAt; list returns them as epoch ms numbers", () => {
  const b = new TaskBoard(join(mkdtempSync(join(tmpdir(), "robojex-board-")), "b.sqlite"));
  const epic = b.add({ title: "epic" });
  const child = b.add({ title: "child", parentId: epic.id, scheduledAt: 1_760_000_000_000, dueAt: 1_760_100_000_000 });
  const rows = b.list();
  expect(rows.find((t) => t.id === epic.id)).toMatchObject({ parentId: null, scheduledAt: null, dueAt: null });
  expect(rows.find((t) => t.id === child.id)).toMatchObject({ parentId: epic.id, scheduledAt: 1_760_000_000_000, dueAt: 1_760_100_000_000 });
});

test("tree nests children under roots, children ordered by createdAt", () => {
  const b = new TaskBoard(join(mkdtempSync(join(tmpdir(), "robojex-board-")), "b.sqlite"));
  const epic = b.add({ title: "epic" });
  const late = b.add({ title: "late child", parentId: epic.id });
  const early = b.add({ title: "early child", parentId: epic.id });
  b.update(late.id, { createdAt: 200 }); // createdAt drives sibling order
  b.update(early.id, { createdAt: 100 });
  const grand = b.add({ title: "grandchild", parentId: early.id });

  const tree = b.tree();
  expect(tree).toHaveLength(1); // one root
  expect(tree[0].title).toBe("epic");
  expect(tree[0].children.map((c) => c.title)).toEqual(["early child", "late child"]);
  expect(tree[0].children[0].children.map((c) => c.title)).toEqual(["grandchild"]);
  // every task stays reachable even with a dangling parent reference: a task
  // whose parent is gone surfaces as a root instead of vanishing from the tree
  b.update(grand.id, { parentId: "gone" });
  expect(reachableTitles(b.tree()).sort()).toEqual(["early child", "epic", "grandchild", "late child"]);
});

test("tree survives a parent cycle: members surface as roots, none drop out", () => {
  const b = new TaskBoard(join(mkdtempSync(join(tmpdir(), "robojex-board-")), "b.sqlite"));
  const a = b.add({ title: "cycle a" });
  const c = b.add({ title: "cycle b", parentId: a.id });
  b.update(a.id, { parentId: c.id }); // a→b→a: only self-reference is refused at write time
  expect(reachableTitles(b.tree()).sort()).toEqual(["cycle a", "cycle b"]); // broken once, not recursed forever
});

test("timeline returns only scheduled tasks, earliest first", () => {
  const b = new TaskBoard(join(mkdtempSync(join(tmpdir(), "robojex-board-")), "b.sqlite"));
  b.add({ title: "later", scheduledAt: 5_000 });
  b.add({ title: "unscheduled" });
  b.add({ title: "earlier", scheduledAt: 1_000, dueAt: 9_000 });
  expect(b.timeline().map((t) => t.title)).toEqual(["earlier", "later"]);
  expect(b.timeline().every((t) => typeof t.scheduledAt === "number")).toBe(true);
});

test("self-parent cycle never enters the store: update rejects it", () => {
  const b = new TaskBoard(join(mkdtempSync(join(tmpdir(), "robojex-board-")), "b.sqlite"));
  const t = b.add({ title: "solo" });
  expect(() => b.update(t.id, { parentId: t.id })).toThrow(/own parent/);
  expect(b.list()[0].parentId).toBe(null); // rejected before the write landed
  const other = b.add({ title: "other" });
  b.update(t.id, { parentId: other.id, status: "done" }); // legitimate reparent still works
  expect(b.list()[0]).toMatchObject({ parentId: other.id, status: "done" });
});
