// packages/ceo-core/test/vitals.test.ts
// R16: the decide context carries a self-state line (uptime/cycles/errors),
// and a failed cycle feeds the error counter the next decide reads.
// R17: the gantt pump fires exactly one morning_briefing event per local day
// inside the 08:00–11:00 window.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchedulerLoop } from "../src/loop.js";
import type { LLMClient } from "../src/llm.js";
import { TaskBoard } from "../src/board.js";
import { ContextAssembler } from "../src/context.js";
import type { AgentOrchestrator } from "../src/orchestrator.js";
import { Auditor } from "../src/auditor.js";
import { BudgetGovernor } from "../src/budget.js";
import { until } from "./helpers.js";

function makeRig() {
  const dir = mkdtempSync(join(tmpdir(), "rjvit-"));
  writeFileSync(join(dir, "MISSION.md"), "m\n");
  writeFileSync(join(dir, "RUBRIC.md"), "# R\n");
  writeFileSync(join(dir, "MEMORY.md"), "# M\n");
  const board = new TaskBoard(join(dir, "board.sqlite"));
  const decideUser: string[] = [];
  let failNext = false;
  const chat = vi.fn(async (slot: string, msgs: Array<{ role: string; content: string }>) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 1, completionTokens: 1 } };
    decideUser.push(String(msgs[1]?.content));
    if (failNext) { failNext = false; throw new Error("llm 500: boom"); }
    return { content: '{"actions":[]}', usage: { promptTokens: 1, completionTokens: 1 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board, ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(async () => ({ exitCode: 0, summary: "stub" })), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"),
    runtimeDir: dir, policy: "butler",
  });
  const events: string[] = [];
  const origPush = loop.push.bind(loop);
  loop.push = (e: string) => { events.push(e); origPush(e); };
  const failOnce = (): void => { failNext = true; };
  return { loop, events, decideUser, failOnce, dir };
}

describe("vitals self-state", () => {
  it("the decide context carries uptime/cycles; a failed cycle counts and surfaces", async () => {
    const rig = makeRig();
    await rig.loop.runOnce("boot");
    await until(() => rig.decideUser.length >= 1);
    expect(rig.decideUser[0]).toContain("# VITALS（自我状态）");
    expect(rig.decideUser[0]).toContain("决策周期 1");
    expect(rig.decideUser[0]).toContain("近期错误 0 次");
    // a failing decide pass: the cycle throws (swallowed by runOnceQueue
    // logging) but the vitals remember it
    rig.failOnce();
    await rig.loop.runOnce("boom").catch(() => {});
    await rig.loop.runOnce("recover");
    await until(() => rig.decideUser.length >= 2);
    const ctx = rig.decideUser.at(-1)!;
    expect(ctx).toContain("近期错误 1 次");
    expect(ctx).toContain("llm 500: boom");
    rig.loop.stop();
  });
});

describe("morning briefing pump", () => {
  it("fires exactly once per day inside the 08:00–11:00 window", () => {
    const rig = makeRig();
    const at = (h: number, m = 0): number => new Date(2026, 7, 23, h, m).getTime(); // local 2026-08-23
    rig.loop.pumpGantt(at(7, 50));
    expect(rig.events.some((e) => e.startsWith("morning_briefing:"))).toBe(false); // before the window
    rig.loop.pumpGantt(at(8, 5));
    expect(rig.events.some((e) => e.startsWith("morning_briefing:"))).toBe(true);  // inside
    const n = rig.events.filter((e) => e.startsWith("morning_briefing:")).length;
    rig.loop.pumpGantt(at(9, 30));
    rig.loop.pumpGantt(at(10, 59));
    expect(rig.events.filter((e) => e.startsWith("morning_briefing:")).length).toBe(n); // once per day
    rig.loop.pumpGantt(new Date(2026, 7, 24, 8, 30).getTime()); // next day: fires again
    expect(rig.events.filter((e) => e.startsWith("morning_briefing:")).length).toBe(n + 1);
    rig.loop.stop();
  });

  it("past 11:00 the digest waits for the next morning (no late-day spam)", () => {
    const rig = makeRig();
    rig.loop.pumpGantt(new Date(2026, 7, 23, 14, 0).getTime());
    expect(rig.events.some((e) => e.startsWith("morning_briefing:"))).toBe(false);
    rig.loop.stop();
  });
});

describe("R18: blocked-awaiting tasks stay on the verify pump", () => {
  it("a task parked at [awaiting acceptance] earns verify_due nudges; a plain done task does not", async () => {
    const rig = makeRig();
    const t = rig.loop ? null : null; void t;
    // reach the board through the loop's own deps (the rig built it)
    const board = (rig.loop as unknown as { d: { board: TaskBoard } }).d.board;
    const parked = board.add({ title: "验收悬置", assignee: "hermes", acceptance: "产物核对" });
    board.update(parked.id, { status: "blocked", resultSummary: "done [awaiting acceptance: verify with tools]", attempts: 1 });
    const settled = board.add({ title: "已完结", assignee: "hermes", acceptance: "done" });
    board.update(settled.id, { status: "done", resultSummary: "fine" });
    rig.loop.pumpGantt(Date.now());
    expect(rig.events.some((e) => e.startsWith("verify_due:") && e.includes("验收悬置") && e.includes("awaiting acceptance since the agent finished"))).toBe(true);
    expect(rig.events.some((e) => e.startsWith("verify_due:") && e.includes("已完结"))).toBe(false);
    rig.loop.stop();
  });
});
