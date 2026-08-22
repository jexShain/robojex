// packages/ceo-core/test/repeat-guard.test.ts
// R4 (PLAN-SUPERHUMAN): the repeat tool-call guard — identical (tool, args)
// across consecutive cycles escalates a visible note inside the tool-result
// event (nudge at 3, warning at 5), a different call resets the streak. The
// note rides the event queue into the next decide context, so the model sees
// itself looping without the guard ever vetoing a call.
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
import { ToolManager, P1_TOOLS } from "../src/tools/manager.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { until } from "./helpers.js";

// idempotent tool (memory append with fixed content) so N identical decide
// cycles are safe to actually execute through the real ToolManager
const SAME = { type: "tool_call", tool: "memory", args: { action: "append", content: "repeat-guard probe" } };

function makeRig(): { loop: SchedulerLoop; events: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "rjrep-"));
  writeFileSync(join(dir, "MISSION.md"), "Stay alive.\n");
  writeFileSync(join(dir, "RUBRIC.md"), "# RUBRIC\n");
  writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n");
  const board = new TaskBoard(join(dir, "board.sqlite"));
  const registry = new ToolRegistry();
  for (const e of P1_TOOLS()) registry.register(e);
  const mgr = new ToolManager({
    registry,
    ctx: {
      runtimeDir: dir, board,
      spawn: async () => ({ exitCode: 0, summary: "stub" }),
      skillsDir: dir, takeoverSend: () => {}, chatOut: () => {},
    },
  });
  let next = SAME; // the decide stub replays whatever the test queued
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 1, completionTokens: 1 } };
    return { content: JSON.stringify({ actions: [next] }), usage: { promptTokens: 1, completionTokens: 1 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board, ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(async () => ({ exitCode: 0, summary: "" })), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"),
    runtimeDir: dir, builtinTools: mgr, policy: "butler",
  });
  const events: string[] = [];
  const origPush = loop.push.bind(loop);
  loop.push = (e: string) => { events.push(e); origPush(e); };
  return { loop, events, setNext: (a: unknown) => { next = a as typeof SAME; } } as ReturnType<typeof makeRig>;
}

describe("repeat tool-call guard", () => {
  it("escalates a note at #3 and a warning at #5; a different call resets the streak", async () => {
    const rig = makeRig();
    // cycles 1..2: plain result events, no note
    await rig.loop.runOnce("boot");
    await until(() => rig.events.filter((e) => e.startsWith("tool memory ->")).length >= 1);
    await rig.loop.runOnce("tick");
    await until(() => rig.events.filter((e) => e.startsWith("tool memory ->")).length >= 2);
    expect(rig.events.some((e) => e.includes("[NOTE:"))).toBe(false);
    // cycle 3: the nudge appears inside the result event
    await rig.loop.runOnce("tick");
    await until(() => rig.events.filter((e) => e.startsWith("tool memory ->")).length >= 3);
    expect(rig.events.some((e) => e.includes("[NOTE: identical call #3"))).toBe(true);
    expect(rig.events.some((e) => e.includes("[WARNING:"))).toBe(false);
    // cycles 4..5: ladder climbs to the warning
    await rig.loop.runOnce("tick");
    await until(() => rig.events.filter((e) => e.startsWith("tool memory ->")).length >= 4);
    await rig.loop.runOnce("tick");
    await until(() => rig.events.some((e) => e.includes("[WARNING: identical call #5")));
    // a different args payload resets the streak: no note on the next result
    (rig as unknown as { setNext: (a: unknown) => void }).setNext({ type: "tool_call", tool: "memory", args: { action: "append", content: "different errand" } });
    await rig.loop.runOnce("tick");
    const after = rig.events.filter((e) => e.startsWith("tool memory ->")).length;
    await until(() => rig.events.filter((e) => e.startsWith("tool memory ->")).length >= after + 1);
    const last = [...rig.events].reverse().find((e) => e.startsWith("tool memory ->"))!;
    expect(last).not.toContain("[NOTE:");
    expect(last).not.toContain("[WARNING:");
    rig.loop.stop();
  }, 30_000);
});
