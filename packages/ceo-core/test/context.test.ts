// packages/ceo-core/test/context.test.ts
import { ContextAssembler, pruneText } from "../src/context.js";
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

// minimal flat task factory for governance tests (full Task shape)
const mkTask = (id: string, title: string): Task => ({
  id, title, status: "todo", priority: 1, assignee: "hermes", attempts: 0, resultSummary: "",
  createdAt: 0, parentId: null, scheduledAt: null, dueAt: null, overdueNaggedAt: null,
  acceptance: "", progress: 0, verdict: "unchecked",
});

test("pruneText: within budget passes the original string through untouched", () => {
  const s = "hello";
  expect(pruneText(s, 3, 3)).toBe(s); // 5 <= 3+3, same reference
  const emoji = "🤖".repeat(2_500);   // 2500 code points fits 2000+3000
  expect(pruneText(emoji, 2_000, 3_000)).toBe(emoji);
});

test("pruneText: over budget keeps head+tail and marks the cut middle with its size", () => {
  expect(pruneText("abcdefg", 3, 3)).toBe("abc\n…[中段裁剪 1 字符]…\nefg");
  const s = Array.from({ length: 300 }, (_, i) => `${i};`).join(""); // "0;1;…;299;"
  const pts = Array.from(s);
  const out = pruneText(s, 10, 5);
  expect(out.startsWith(pts.slice(0, 10).join(""))).toBe(true);
  expect(out.endsWith(pts.slice(pts.length - 5).join(""))).toBe(true);
  expect(out).toContain(`[中段裁剪 ${pts.length - 15} 字符]`);
});

test("pruneText cuts by code point — emoji never split into half surrogate pairs", () => {
  const out = pruneText("🤖".repeat(5_000), 1_000, 1_000); // 3000 emoji removed
  expect(out).toContain("[中段裁剪 3000 字符]");
  expect(out).not.toContain("�");
  // strip the marker line: every remaining code point must be a whole emoji —
  // Array.from surfaces a split surrogate pair as a lone half, which !== "🤖"
  const body = out.split("\n").filter((l) => !l.startsWith("…[")).join("");
  expect(Array.from(body).length).toBe(2_000);
  for (const ch of Array.from(body)) expect(ch).toBe("🤖");
  // belt and braces: no unpaired surrogate code unit anywhere (slicing a pair
  // produces a lone half, never a literal U+FFFD, so scan the units directly)
  for (let i = 0; i < out.length; i++) {
    const cu = out.charCodeAt(i);
    if (cu >= 0xd800 && cu <= 0xdbff) { // a high half must be followed by its low half
      const lo = out.charCodeAt(i + 1);
      expect(lo >= 0xdc00 && lo <= 0xdfff).toBe(true);
      i++;
    } else {
      expect(cu < 0xdc00 || cu > 0xdfff).toBe(true); // no stray low half
    }
  }
});

test("build folds a 30-task board to 4 head + 8 tail with a visible fold marker", () => {
  const board = Array.from({ length: 30 }, (_, i) =>
    mkTask(`t${String(i).padStart(2, "0")}0000-0000-000000000000`, `task-${String(i).padStart(2, "0")}`));
  const ctx = new ContextAssembler().build({ mission: "M", rubric: "R", memory: "", board, events: [] });
  expect(ctx).toContain("[...18 个任务已折叠，可用工具查看]");
  for (let i = 0; i < 4; i++) expect(ctx).toContain(`task-${String(i).padStart(2, "0")}`);   // head survives
  for (let i = 22; i < 30; i++) expect(ctx).toContain(`task-${String(i).padStart(2, "0")}`); // tail survives
  for (let i = 4; i < 22; i++) expect(ctx).not.toContain(`task-${String(i).padStart(2, "0")}`); // middle folded
});

test("build trims event storms to the latest 10 with an omission count", () => {
  const events = Array.from({ length: 20 }, (_, i) => `ev-${String(i).padStart(2, "0")}`);
  const ctx = new ContextAssembler().build({ mission: "M", rubric: "R", memory: "", board: [], events });
  expect(ctx).toContain("[...10 条更早事件已省略]");
  for (let i = 10; i < 20; i++) expect(ctx).toContain(`ev-${String(i).padStart(2, "0")}`); // latest 10
  for (let i = 0; i < 10; i++) expect(ctx).not.toContain(`ev-${String(i).padStart(2, "0")}`); // oldest dropped
});

test("build prunes an 8K memory to head 2000 + tail 3000 with a middle-cut marker", () => {
  const memory = `${"H".repeat(2_000)}${"X".repeat(3_000)}${"T".repeat(3_000)}`; // 8000 chars, middle is the X run
  const ctx = new ContextAssembler().build({ mission: "M", rubric: "R", memory, board: [], events: [] });
  const mem = ctx.slice(ctx.indexOf("# MEMORY (top)"));
  expect(mem.startsWith(`# MEMORY (top)\n${"H".repeat(2_000)}\n…[中段裁剪 3000 字符]…\n`)).toBe(true);
  expect(mem.endsWith("T".repeat(3_000))).toBe(true); // tail (newest lessons) survives intact
  expect(mem).not.toContain("X");                     // only the middle was cut
});

test("build prunes oversized mission and rubric with visible middle-cut markers", () => {
  const mission = `${"m".repeat(2_500)}${"QQ".repeat(750)}${"e".repeat(1_000)}`; // 5000 chars
  const rubric = `${"r".repeat(2_500)}${"ZZ".repeat(750)}${"t".repeat(1_000)}`;  // 5000 chars
  const ctx = new ContextAssembler().build({ mission, rubric, memory: "", board: [], events: [] });
  expect(ctx).toContain("m".repeat(2_500));
  expect(ctx).toContain("e".repeat(1_000));
  expect(ctx).toContain("r".repeat(2_500));
  expect(ctx).toContain("t".repeat(1_000));
  expect(ctx).not.toContain("QQ"); // mission middle gone
  expect(ctx).not.toContain("ZZ"); // rubric middle gone
  expect(ctx.match(/中段裁剪 1500 字符/g)!.length).toBe(2); // both docs marked
});

test("at or under every limit the output carries no prune, fold, or omission markers", () => {
  const events = Array.from({ length: 12 }, (_, i) => `ok-ev-${i}`);
  const board = Array.from({ length: 16 }, (_, i) => mkTask(`u${String(i).padStart(2, "0")}0000-0000-000000000000`, `ok-task-${i}`));
  const ctx = new ContextAssembler().build({
    mission: "m".repeat(4_000), rubric: "r".repeat(4_000), memory: "x".repeat(6_000), board, events,
  });
  expect(ctx).not.toContain("中段裁剪");
  expect(ctx).not.toContain("已省略");
  expect(ctx).not.toContain("已折叠");
  expect(ctx).toContain("m".repeat(4_000));       // mission whole
  expect(ctx).toContain("x".repeat(6_000));       // memory whole
  expect(ctx).toContain("ok-task-0 ::");             // first board line present
  expect(ctx).toContain("ok-task-15");            // last board line present
  expect(ctx).toContain("ok-ev-11");              // newest event present
});
