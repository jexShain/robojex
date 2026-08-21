// packages/ceo-core/test/tools/bridges-board.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardTools } from "../../src/tools/bridges.js";
import type { ToolCtx } from "../../src/tools/registry.js";
import { TaskBoard } from "../../src/board.js";

let dir: string; let board: TaskBoard; let ctx: ToolCtx;
const call = async (name: string, args: Record<string, unknown>) => {
  const e = boardTools().find((t) => t.name === name);
  if (!e) throw new Error(`no tool ${name}`);
  return e.handler(args, ctx);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rjbridge-"));
  board = new TaskBoard(join(dir, "b.sqlite"));
  ctx = { runtimeDir: dir, board, spawn: async () => ({ exitCode: 0, summary: "" }), skillsDir: dir, takeoverSend: () => {}, chatOut: () => {} };
});

describe("todo", () => {
  it("add/list/complete lifecycle maps onto the board", async () => {
    const add = await call("todo", { action: "add", title: "ship it" });
    const id = (add.match(/([0-9a-f-]{8,})/) ?? [])[1];
    expect(id).toBeTruthy();
    const list = await call("todo", { action: "list" });
    expect(list).toContain("ship it");
    const done = await call("todo", { action: "complete", task_id: id });
    expect(done).toMatch(/done|complete/i);
    expect(board.list().find((t) => t.id === id)?.status).toBe("done");
  });
});

describe("kanban", () => {
  it("create then list shows the card in its column", async () => {
    const c = await call("kanban_create", { title: "card one", column: "todo" });
    const id = (c.match(/([0-9a-f-]{8,})/) ?? [])[1];
    expect(id).toBeTruthy();
    const l = await call("kanban_list", {});
    expect(l).toContain("card one");
    const s = await call("kanban_show", { card_id: id });
    expect(s).toContain("card one");
  });
  it("complete settles the card as done", async () => {
    const c = await call("kanban_create", { title: "card two", column: "todo" });
    const id = (c.match(/([0-9a-f-]{8,})/) ?? [])[1];
    await call("kanban_complete", { card_id: id });
    expect(board.list().find((t) => t.id === id)?.status).toBe("done");
  });
  it("block marks the card blocked, unblock reopens it", async () => {
    const c = await call("kanban_create", { title: "card three", column: "doing" });
    const id = (c.match(/([0-9a-f-]{8,})/) ?? [])[1];
    await call("kanban_block", { card_id: id, reason: "waiting on ci" });
    expect(board.list().find((t) => t.id === id)?.status).toBe("blocked");
    await call("kanban_unblock", { card_id: id });
    expect(board.list().find((t) => t.id === id)?.status).not.toBe("blocked");
  });
  it("comment appends to resultSummary", async () => {
    const c = await call("kanban_create", { title: "card four", column: "todo" });
    const id = (c.match(/([0-9a-f-]{8,})/) ?? [])[1];
    await call("kanban_comment", { card_id: id, text: "first note" });
    expect(board.list().find((t) => t.id === id)?.resultSummary).toContain("first note");
  });
  it("unknown card errors cleanly", async () => {
    const r = await call("kanban_show", { card_id: "nope" });
    expect(r).toMatch(/not found/i);
  });
});
