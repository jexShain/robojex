// packages/ceo-core/test/context.test.ts
import { ContextAssembler } from "../src/context.js";
import type { Task } from "../src/board.js";
import { expect, test, vi } from "vitest";

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

test("board block renders an indented tree (indent capped at 2) with human-readable sched/due clocks", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 20, 12, 0, 0)); // 2026-08-20 local, pins "today"
  try {
    const mk = (id: string, title: string, extra: Partial<Task> = {}): Task => ({
      id, title, status: "todo", priority: 1, assignee: "hermes", attempts: 0, resultSummary: "", createdAt: 0,
      parentId: null, scheduledAt: null, dueAt: null, overdueNaggedAt: null, acceptance: "", progress: 0, verdict: "unchecked", ...extra,
    });
    const today930 = new Date(2026, 7, 20, 9, 30).getTime();      // same day -> HH:MM
    const later = new Date(2026, 8, 4, 8, 5).getTime();           // another day -> MM-DD HH:MM
    const board = [
      mk("root0000-0000-0000-000000000000", "epic root", { scheduledAt: today930 }),
      mk("chil0000-0000-0000-000000000000", "child", { parentId: "root0000-0000-0000-000000000000", dueAt: later }),
      mk("gran0000-0000-0000-000000000000", "grandchild", { parentId: "chil0000-0000-0000-000000000000" }),
      mk("grea0000-0000-0000-000000000000", "great-grandchild", { parentId: "gran0000-0000-0000-000000000000" }),
    ];
    const ctx = new ContextAssembler().build({ mission: "M", rubric: "R", memory: "", board, events: [] });
    const lines = ctx.split("\n").filter((l) => /epic root|child/.test(l));
    // titles are matched space-delimited so "child" does not hit "grandchild"
    expect(lines.find((l) => l.includes(" epic root "))!.startsWith("- [root0000]")).toBe(true);
    expect(lines.find((l) => l.includes(" child "))!.startsWith("  ↳ [chil0000]")).toBe(true);
    expect(lines.find((l) => l.includes(" grandchild "))!.startsWith("    ↳ [gran0000]")).toBe(true);
    expect(lines.find((l) => l.includes(" great-grandchild "))!.startsWith("    ↳ [grea0000]")).toBe(true); // depth 3 clamps to indent 2
    expect(lines.find((l) => l.includes(" epic root "))).toContain("[sched 09:30]");
    expect(lines.find((l) => l.includes(" child "))).toContain("[due 09-04 08:05]");
    expect(lines.find((l) => l.includes(" grandchild "))).not.toContain("[sched"); // no time, no badge
  } finally {
    vi.useRealTimers();
  }
});
