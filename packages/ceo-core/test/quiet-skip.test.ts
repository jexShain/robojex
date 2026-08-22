// packages/ceo-core/test/quiet-skip.test.ts
// R72 quiet skip: a pure tick against an unchanged world (same board digest,
// nothing running, last cycle took no action) skips patrol+decide entirely;
// real events and board changes always wake the full cycle.
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
  const dir = mkdtempSync(join(tmpdir(), "rjqs-"));
  writeFileSync(join(dir, "MISSION.md"), "m\n");
  writeFileSync(join(dir, "RUBRIC.md"), "# R\n");
  writeFileSync(join(dir, "MEMORY.md"), "# M\n");
  const board = new TaskBoard(join(dir, "board.sqlite"));
  let decideCalls = 0;
  let patrolCalls = 0;
  const chat = vi.fn(async (slot: string, msgs: Array<{ role: string; content: string }>) => {
    if (slot === "patrol") { patrolCalls++; return { content: '{"action":"act"}', usage: { promptTokens: 1, completionTokens: 1 } }; }
    decideCalls++;
    return { content: '{"actions":[]}', usage: { promptTokens: 1, completionTokens: 1 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board, ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(async () => ({ exitCode: 0, summary: "stub" })), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"),
    runtimeDir: dir, policy: "butler",
  });
  return { loop, board, counts: () => ({ patrolCalls, decideCalls }) };
}

async function settle(): Promise<void> { await until(() => true); }

describe("R72 quiet skip", () => {
  it("a pure tick against an unchanged, idle, already-quiet world skips the whole cycle", async () => {
    const rig = makeRig();
    await rig.loop.runOnce("boot: recon"); // baseline cycle: decide runs, takes no action
    await rig.loop.runOnce("tick"); // first tick after a cycle: banks the digest, decides again
    await settle();
    expect(rig.counts().decideCalls).toBe(2);
    await rig.loop.runOnce("tick"); // same digest, nothing running, last cycle idle → skip
    await settle();
    expect(rig.counts().decideCalls).toBe(2); // no new decide
    expect(rig.counts().patrolCalls).toBe(2); // and no new patrol either
    rig.loop.stop();
  });

  it("a real event still wakes the full cycle after a skip", async () => {
    const rig = makeRig();
    await rig.loop.runOnce("boot: recon");
    await rig.loop.runOnce("tick"); // banks the digest
    await rig.loop.runOnce("tick"); // skipped
    await rig.loop.runOnce("chat: 帮我看看磁盘");
    await until(() => rig.counts().decideCalls >= 3);
    expect(rig.counts().decideCalls).toBe(3);
    rig.loop.stop();
  });

  it("a board change breaks the quiet state (new card → next tick decides)", async () => {
    const rig = makeRig();
    await rig.loop.runOnce("boot: recon");
    await rig.loop.runOnce("tick"); // banks the digest
    await rig.loop.runOnce("tick"); // skipped
    rig.board.add({ title: "新任务", assignee: "hermes", acceptance: "done" });
    await rig.loop.runOnce("tick");
    await until(() => rig.counts().decideCalls >= 3);
    expect(rig.counts().decideCalls).toBe(3);
    rig.loop.stop();
  });

  it("a running task keeps ticks awake (progress must be watched)", async () => {
    const rig = makeRig();
    await rig.loop.runOnce("boot: recon");
    const t = rig.board.add({ title: "跑着的", assignee: "hermes", acceptance: "done" });
    rig.board.update(t.id, { status: "running" });
    await rig.loop.runOnce("tick");
    await rig.loop.runOnce("tick"); // running work: never skipped
    await until(() => rig.counts().decideCalls >= 3);
    expect(rig.counts().decideCalls).toBe(3);
    rig.loop.stop();
  });
});
