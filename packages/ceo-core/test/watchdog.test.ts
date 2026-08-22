// packages/ceo-core/test/watchdog.test.ts
// R10 (PLAN-SUPERHUMAN): the heartbeat self-check — tickN frozen past
// max(3 tick periods, floor) with a live interval forces one self-recovery
// wake; a ticking loop never fires; dormant (tickMs 0) never fires.
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

function makeRig(floorMs: number) {
  const dir = mkdtempSync(join(tmpdir(), "rjwd-"));
  writeFileSync(join(dir, "MISSION.md"), "m\n");
  writeFileSync(join(dir, "RUBRIC.md"), "# R\n");
  writeFileSync(join(dir, "MEMORY.md"), "# M\n");
  const board = new TaskBoard(join(dir, "board.sqlite"));
  const chat = vi.fn(async () => ({ content: '{"action":"none"}', usage: { promptTokens: 1, completionTokens: 1 } }));
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board, ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(async () => ({ exitCode: 0, summary: "" })), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"),
    runtimeDir: dir, watchdogFloorMs: floorMs,
  });
  const events: string[] = [];
  const origPush = loop.push.bind(loop);
  loop.push = (e: string) => { events.push(e); origPush(e); };
  return { loop, events };
}

describe("heartbeat watchdog", () => {
  it("forces a self-recovery wake when tickN freezes past the stall window", async () => {
    const { loop, events } = makeRig(150);
    loop.start(10); // 10ms tick: 3×tick (30ms) < floor (150ms) → floor rules
    // stop the real timer machinery from ticking: freeze tickCount by pausing cycles
    (loop as unknown as { tickCount: number }).tickCount = 42;
    const wd = (loop as unknown as { checkStall: () => void });
    wd.checkStall(); // baseline recorded (tickCount 42, now)
    expect(events.some((e) => e.startsWith("loop_stalled:"))).toBe(false);
    await new Promise((r) => setTimeout(r, 200)); // past the 150ms floor, tickCount frozen
    // cycles may have advanced the counter: pin it back so the check sees a freeze
    (loop as unknown as { tickCount: number }).tickCount = 42;
    wd.checkStall();
    expect(events.some((e) => e.startsWith("loop_stalled:"))).toBe(true);
    // one forced wake per window: an immediate re-check stays quiet
    wd.checkStall();
    expect(events.filter((e) => e.startsWith("loop_stalled:")).length).toBe(1);
    loop.stop();
  });

  it("a ticking loop and a dormant loop never fire the watchdog", async () => {
    const { loop, events } = makeRig(150);
    loop.start(50); // fast tick: cycles run through the 500ms debounce
    await new Promise((r) => setTimeout(r, 700)); // ≥ one debounced cycle has run
    const before = (loop as unknown as { tickCount: number }).tickCount;
    expect(before).toBeGreaterThan(0); // the loop is genuinely alive
    (loop as unknown as { checkStall: () => void }).checkStall(); // refreshes the baseline
    (loop as unknown as { checkStall: () => void }).checkStall(); // inside the window
    expect(events.some((e) => e.startsWith("loop_stalled:"))).toBe(false);
    loop.stop();
    // dormant: tickMs 0 short-circuits
    loop.start(0);
    (loop as unknown as { lastTickSeen: { n: number; at: number } }).lastTickSeen.at = 0;
    await new Promise((r) => setTimeout(r, 200));
    (loop as unknown as { checkStall: () => void }).checkStall();
    expect(events.some((e) => e.startsWith("loop_stalled:"))).toBe(false);
    loop.stop();
  });
});
