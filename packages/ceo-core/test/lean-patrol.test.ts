// packages/ceo-core/test/lean-patrol.test.ts
// R138: a patrol-only wake buys a house LOOK, not a staffing decision —
// the decide prompt drops the spawn-oriented tail (agent registry/docs,
// stats, manuals, scout inventory, tentacles) and keeps the LOOKING surface
// (builtin tool schemas, times, recent cycles, vitals). The live soak
// measured that tail at ~4-5k tok on wakes whose entire output was nothing
// or an R137-suppressed all-clear.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchedulerLoop } from "../src/loop.js";
import type { LLMClient, ChatMsg } from "../src/llm.js";
import { TaskBoard } from "../src/board.js";
import { ContextAssembler } from "../src/context.js";
import type { AgentOrchestrator } from "../src/orchestrator.js";
import { Auditor } from "../src/auditor.js";
import { BudgetGovernor } from "../src/budget.js";
import { ToolManager, P1_TOOLS } from "../src/tools/manager.js";
import { ToolRegistry } from "../src/tools/registry.js";

function makeRig() {
  const dir = mkdtempSync(join(tmpdir(), "rjlean-"));
  writeFileSync(join(dir, "MISSION.md"), "Stay alive.\n");
  writeFileSync(join(dir, "RUBRIC.md"), "# RUBRIC\n");
  writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n");
  // a verified-agents doc big enough to be worth dropping on patrol wakes
  writeFileSync(join(dir, "AGENTS.md"), "## hermes\nverified on this system, long manual follows...");
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
  const decideCalls: ChatMsg[][] = [];
  const chat = vi.fn(async (slot: string, msgs: ChatMsg[]) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 1, completionTokens: 1 } };
    decideCalls.push(msgs);
    return { content: JSON.stringify({ actions: [] }), usage: { promptTokens: 1, completionTokens: 1 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board, ctx: new ContextAssembler(),
    orchestrator: {
      spawn: vi.fn(async () => ({ exitCode: 0, summary: "" })),
      getRegistry: () => ({ toPromptBlock: () => "# AVAILABLE AGENTS\n- hermes (verified)" }) as any,
    } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"),
    runtimeDir: dir, builtinTools: mgr, policy: "butler",
  });
  return { loop, decideCalls };
}

describe("R138 lean patrol decide", () => {
  it("patrol-only wake: no agent/stats/manuals tail, builtin LOOK surface kept", async () => {
    const { loop, decideCalls } = makeRig();
    await loop.runOnce("patrol_walk: quick health round");
    expect(decideCalls.length).toBe(1);
    const user = String(decideCalls[0][1].content);
    expect(user).not.toContain("# AVAILABLE AGENTS");       // registry block dropped
    expect(user).not.toContain("# AGENTS (verified on this system)"); // verified docs dropped
    expect(user).not.toContain("# AVAILABLE TOOLS");        // scout inventory dropped
    expect(user).toContain("# BUILTIN TOOLS");              // but the LOOK surface stays
    expect(user).toContain("# NOW:");                       // clock stays (anomaly judgment)
    expect(user).toContain("patrol_walk:");                 // the wake itself
  });

  it("non-patrol wake keeps the full staffing tail", async () => {
    const { loop, decideCalls } = makeRig();
    await loop.runOnce("chat: 帮我查一下磁盘");
    expect(decideCalls.length).toBe(1);
    const user = String(decideCalls[0][1].content);
    expect(user).toContain("# AVAILABLE AGENTS");
    expect(user).toContain("# AGENTS (verified on this system)");
    expect(user).toContain("# BUILTIN TOOLS");
  });

  it("patrol mixed with a real event is NOT patrol-only", async () => {
    const { loop, decideCalls } = makeRig();
    await loop.runOnce("patrol_walk: quick health round;chat: 顺便看看负载");
    const user = String(decideCalls[0][1].content);
    expect(user).toContain("# AVAILABLE AGENTS"); // errand present → full context
  });

  it("patrol + tick (the production pairing) IS patrol-only", async () => {
    // the tick interval and pumpGantt fire in the same instant, so real
    // patrol wakes always arrive as "patrol_walk: ...;tick" — the lean tail
    // must survive the zero-information tick riding along
    const { loop, decideCalls } = makeRig();
    await loop.runOnce("patrol_walk: quick health round;tick");
    const user = String(decideCalls[0][1].content);
    expect(user).not.toContain("# AVAILABLE AGENTS");
    expect(user).toContain("# BUILTIN TOOLS");
  });

  it("the PRODUCTION patrol event (body embeds ';') stays patrol-only", async () => {
    // R138c regression: the real patrol_walk body carries "tools; stay
    // silent…" — runOnceQueue used to join events with "; " and cycle
    // re-split the string, so every production patrol wake split mid-event
    // and patrolOnly was never true (both the lean tail and the R137 gate
    // silently no-oped). The queue now passes the event ARRAY through.
    const patrol = "patrol_walk: quick health round — check disk space, load, and anything unusual with LOOKING tools; stay silent unless something genuinely needs the human (then reply once, concisely). A CLEAN round (all normal) replies NOTHING: an 'everything is fine' report is noise, not a need — silence is the healthy outcome";
    const { loop, decideCalls } = makeRig();
    await loop.runOnce(`tick; ${patrol}`, ["tick", patrol]);
    expect(decideCalls.length).toBe(1);
    const user = String(decideCalls[0][1].content);
    expect(user).not.toContain("# AVAILABLE AGENTS");
    expect(user).toContain("# BUILTIN TOOLS");
  });
});
