// packages/ceo-core/test/board.test.ts
import { TaskBoard } from "../src/board.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

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
