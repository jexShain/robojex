// packages/ceo-core/test/auto-rubric.test.ts — T9: the deterministic, zero-token
// self-learning layer. Ledger parsing must tolerate the pre-T9 3-field lines;
// the fingerprint merge must refresh in place, never re-append.
import { AUTO_MARK, computeTrends, extractPatterns, mergeRubric, normalizeKind, parseOutcomes, priorityAdvice, renderAdvice, renderRubricLines } from "../src/auto-rubric.js";
import type { Task } from "../src/board.js";
import { expect, test } from "vitest";

const DAY = 86_400_000;
const task = (t: Partial<Task>): Task => ({ id: "x", title: "t", status: "todo", priority: 0, assignee: "", attempts: 0, resultSummary: "", createdAt: 0, parentId: null, scheduledAt: null, dueAt: null, overdueNaggedAt: null, acceptance: "", progress: 0, verdict: "unchecked", milestone: false, ...t });
const day = (ts: number) => { const d = new Date(ts), p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

test("parseOutcomes: pre-T9 undated lines keep ts=0; dated lines parse; garbage verdicts and non-ledger lines are skipped", () => {
  const out = parseOutcomes([
    "# comment without pipe",
    "fw-a|pass|old undated line",
    `fw-b|fail|dated line|${1700000000000}`,
    "fw-c|maybe|wrong verdict|1",
    "|||",
    "|pass|missing framework",
  ].join("\n"));
  expect(out).toEqual([
    { framework: "fw-a", verdict: "pass", title: "old undated line", ts: 0 },
    { framework: "fw-b", verdict: "fail", title: "dated line", ts: 1700000000000 },
  ]);
});

test("normalizeKind: corrective-retry suffixes fold into the parent kind — the repetition IS the signal", () => {
  expect(normalizeKind("修登录（重派#2）")).toBe("修登录");
  expect(normalizeKind("修  登录   （重派#10）")).toBe("修 登录");
});

test("extractPatterns: weak staffing (<40% over >=3 tries), trusted performers (>=80% over >=5), kinds failing >=2", () => {
  const outcomes = parseOutcomes([
    "weakfw|fail|任务甲", "weakfw|pass|任务乙", "weakfw|fail|任务丙",       // 33% over 3 → weak
    "strongfw|pass|a|1", "strongfw|pass|b|1", "strongfw|pass|c|1", "strongfw|pass|d|1", "strongfw|fail|e|1", // 80% over 5 → strong
    "weakfw|fail|修登录", "fw-x|fail|修登录（重派#2）",                     // kind 修登录 fails 2x, two frameworks
    "fw-y|fail|一次性失败",                                                 // single fail: not a kind signal
  ].join("\n"));
  const p = extractPatterns(outcomes);
  expect(p.weak.map((w) => w.framework)).toEqual(["weakfw"]);
  expect(p.strong.map((s) => s.framework)).toEqual(["strongfw"]);
  expect(p.failureKinds).toEqual([{ kind: "修登录", fails: 2, frameworks: ["weakfw", "fw-x"] }]);
});

test("computeTrends: undated lines count in totals only; 7d/7d windows and the delta trend line", () => {
  const now = Date.now();
  const outcomes = parseOutcomes([
    `fw|pass|a|${now - DAY}`, `fw|fail|b|${now - DAY}`, `fw|pass|c|${now - 2 * DAY}`,   // last-7: 2/3 = 67
    `fw|pass|d|${now - 10 * DAY}`, `fw|partial|e|${now - 12 * DAY}`,                     // prev-7: 1/2 = 50
    "fw|fail|undated",                                                                   // total only
  ].join("\n"));
  const t = computeTrends(outcomes, now);
  expect(t.total).toBe(6);
  expect(t.completionRate).toBe(50);       // 3 pass of 6, whole ledger
  expect(t.last7Rate).toBe(67);
  expect(t.prev7Rate).toBe(50);
  expect(t.delta7).toBe(17);
  // buckets: dated rows only, oldest-first, exact day keys
  const dated = t.daily.reduce((n, b) => n + b.total, 0);
  expect(dated).toBe(5);
  const days = t.daily.map((b) => b.day);
  expect(days).toEqual([...days].sort((a, b) => a.localeCompare(b)));
  expect(t.daily[t.daily.length - 1].day).toBe(day(now - DAY));
  expect(t.daily[0].day).toBe(day(now - 12 * DAY));
  // no dated data at all → nulls, not fake zeroes
  const empty = computeTrends(parseOutcomes("fw|pass|undated"), now);
  expect(empty.last7Rate).toBeNull();
  expect(empty.prev7Rate).toBeNull();
  expect(empty.delta7).toBeNull();
});

test("renderRubricLines: weak staffing, trusted performers, failing kinds, and the >=10% trend trigger", () => {
  const now = Date.now();
  const outcomes = parseOutcomes([
    "weakfw|fail|a", "weakfw|pass|b", "weakfw|fail|c",
    "strongfw|pass|d|1", "strongfw|pass|e|1", "strongfw|pass|f|1", "strongfw|pass|g|1", "strongfw|pass|h|1",
    "fw|fail|修登录", "fw|fail|修登录",
  ].join("\n"));
  const lines = renderRubricLines(extractPatterns(outcomes), computeTrends(outcomes, now));
  expect(lines.some((l) => l.includes("[auto-rubric][weak:weakfw]") && l.includes("33%"))).toBe(true);
  expect(lines.some((l) => l.includes("[auto-rubric][strong:strongfw]") && l.includes("优先派给它"))).toBe(true);
  expect(lines.some((l) => l.includes("[auto-rubric][kind:修登录]") && l.includes("换策略或换框架"))).toBe(true);
  // sliding 7d windows: a hard drop emits the tightening rule…
  const drop = parseOutcomes(Array.from({ length: 10 }, (_, i) => `fw|pass|p${i}|${now - 8 * DAY - i}`).join("\n") + `\nfw|fail|r|${now - DAY}`);
  expect(renderRubricLines(extractPatterns(drop), computeTrends(drop, now)).some((l) => l.includes("收紧自动派发"))).toBe(true);
  // …a recovery emits the aggressive rule…
  const rise = parseOutcomes(Array.from({ length: 10 }, (_, i) => `fw|fail|f${i}|${now - 8 * DAY - i}`).join("\n") + `\nfw|pass|r|${now - DAY}`);
  expect(renderRubricLines(extractPatterns(rise), computeTrends(rise, now)).some((l) => l.includes("可恢复较激进的派发节奏"))).toBe(true);
  // …and a gentle change emits neither (the |delta|<10 band)
  const flat = parseOutcomes(Array.from({ length: 10 }, (_, i) => `fw|pass|p${i}|${now - 8 * DAY - i}`).join("\n") + Array.from({ length: 11 }, (_, i) => `fw|pass|q${i}|${now - DAY}`).join("\n") + `\nfw|fail|z|${now - DAY}`);
  expect(renderRubricLines(extractPatterns(flat), computeTrends(flat, now)).some((l) => l.includes("近7日"))).toBe(false);
});

test("mergeRubric: fingerprints refresh in place — no duplicate rules, no append-only ballooning, idempotent re-merge", () => {
  const seeded = "# RUBRIC\n- base rule\n";
  const now = Date.now();
  const outcomes = parseOutcomes("weakfw|fail|a|1\nweakfw|pass|b|1\nweakfw|fail|c|1");
  const lines = renderRubricLines(extractPatterns(outcomes), computeTrends(outcomes, now));
  const first = mergeRubric(seeded, lines);
  expect(first.added).toBe(lines.length);
  expect(first.updated).toBe(0);
  const second = mergeRubric(first.text, lines);
  expect(second.added).toBe(0);
  expect(second.updated).toBe(0);
  expect(second.text).toBe(first.text);
  // a re-learned number for the same fingerprint rewrites the ONE old line
  const moved = [`- ${AUTO_MARK}[weak:weakfw] weakfw 历史验收通过率仅 50%（3 次）——同类任务降低优先级，验收标准写成可检查的具体动作；连续失败后禁止原框架原样重发`];
  const third = mergeRubric(second.text, moved);
  expect(third.updated).toBe(1);
  expect(third.added).toBe(0);
  expect(third.text).toContain("50%");
  expect(third.text).not.toContain("33%");
  expect(third.text.split("\n").filter((l) => l.includes(AUTO_MARK)).length).toBe(lines.length);
});

test("priorityAdvice: todo cards only; failing-kind and weak-assignee notes compose; renderAdvice carries the header", () => {
  const outcomes = parseOutcomes([
    "weakfw|fail|任务甲", "weakfw|pass|任务乙", "weakfw|fail|任务丙",   // weak
    "weakfw|fail|修登录", "fw-x|fail|修登录（重派#2）",
  ].join("\n"));
  const p = extractPatterns(outcomes);
  const adv = priorityAdvice([
    task({ id: "1", title: "修登录（重派#3）", status: "todo", assignee: "weakfw" }),
    task({ id: "2", title: "修登录", status: "running", assignee: "weakfw" }),   // not todo: skipped
    task({ id: "3", title: "无关新任务", status: "todo", assignee: "freshfw" }), // clean card: no advice
  ], p);
  expect(adv).toHaveLength(1);
  expect(adv[0].advice).toContain("同类已失败 2 次");
  expect(adv[0].advice).toContain("框架 weakfw 历史通过率偏低");
  expect(renderAdvice([task({ id: "1", title: "修登录（重派#3）", status: "todo", assignee: "weakfw" })], p)).toContain("# 优先级建议");
  expect(renderAdvice([task({ id: "3", title: "无关新任务", status: "todo", assignee: "freshfw" })], p)).toBe("");
});
