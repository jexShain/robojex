// packages/ceo-core/test/context.test.ts
import { ContextAssembler } from "../src/context.js";
import { expect, test } from "vitest";

test("assembles sections in order and truncates hard", () => {
  const a = new ContextAssembler();
  const ctx = a.build({
    mission: "MISSION-TEXT", rubric: "RUBRIC-TEXT", memory: "M".repeat(50_000),
    board: [{ id: "t1", title: "task one", status: "todo", priority: 1, assignee: "hermes", attempts: 0, resultSummary: "" }],
    events: ["screen_diff hamming=14", "agent_done t1"],
    budgetLine: "budget: 12000/50000 tokens",
  });
  expect(ctx).toContain("MISSION-TEXT");
  expect(ctx).toContain("RUBRIC-TEXT");
  expect(ctx).toContain("task one");
  expect(ctx).toContain("budget: 12000/50000 tokens");
  expect(ctx.length).toBeLessThanOrEqual(32_000 + 500); // hard cap ~8K tokens
  expect(ctx.indexOf("MISSION-TEXT")).toBeLessThan(ctx.indexOf("RUBRIC-TEXT"));
});
