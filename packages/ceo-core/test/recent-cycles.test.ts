// packages/ceo-core/test/recent-cycles.test.ts
// R71 short-term decision memory: every decide cycle banks a replay line and
// the NEXT cycle's decide context carries it — so an unchanged world reads as
// "already handled" instead of "fresh", and the ring never grows past 5.
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
  const dir = mkdtempSync(join(tmpdir(), "rjrc-"));
  writeFileSync(join(dir, "MISSION.md"), "m\n");
  writeFileSync(join(dir, "RUBRIC.md"), "# R\n");
  writeFileSync(join(dir, "MEMORY.md"), "# M\n");
  const board = new TaskBoard(join(dir, "board.sqlite"));
  const decideUser: string[] = [];
  const decideSystem: string[] = [];
  // first decide reports a reply so the replay line has real content
  let calls = 0;
  const chat = vi.fn(async (slot: string, msgs: Array<{ role: string; content: string }>) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 1, completionTokens: 1 } };
    decideSystem.push(String(msgs[0]?.content));
    decideUser.push(String(msgs[1]?.content));
    calls++;
    const actions = calls === 1 ? [{ type: "reply", text: "在做了" }] : [];
    return { content: JSON.stringify({ actions }), usage: { promptTokens: 1, completionTokens: 7 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board, ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(async () => ({ exitCode: 0, summary: "stub" })), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"),
    runtimeDir: dir, policy: "butler",
  });
  return { loop, decideUser, decideSystem, dir };
}

describe("R71 recent-cycles replay", () => {
  it("cycle 2's decide context replays cycle 1's actions; cycle 1 carries none", async () => {
    const rig = makeRig();
    await rig.loop.runOnce("chat: 帮我整理下载文件夹");
    await until(() => rig.decideUser.length >= 1);
    expect(rig.decideUser[0]).not.toContain("# RECENT CYCLES"); // nothing banked yet
    await rig.loop.runOnce("tick");
    await until(() => rig.decideUser.length >= 2);
    const ctx = rig.decideUser[1];
    expect(ctx).toContain("# RECENT CYCLES");
    expect(ctx).toContain("wake=chat: 帮我整理下载文件夹");
    expect(ctx).toContain("reply");
    rig.loop.stop();
  });

  it("the stability doctrine rides the decide system prompt", async () => {
    const rig = makeRig();
    await rig.loop.runOnce("boot");
    await until(() => rig.decideSystem.length >= 1);
    expect(rig.decideSystem[0]).toContain("RECENT CYCLES");
    expect(rig.decideSystem[0]).toContain("re-verifying a stable state");
    rig.loop.stop();
  });

  it("the replay ring caps at 5 lines", async () => {
    const rig = makeRig();
    for (let i = 0; i < 7; i++) await rig.loop.runOnce(`wake${i}`);
    await until(() => rig.decideUser.length >= 7);
    // cycle 7's context replays the 5 survivors of cycles 1-6 (its own line
    // banks only after its decide parse — a cycle never sees itself)
    const ctx = rig.decideUser.at(-1)!;
    const lines = ctx.split("\n").filter((l) => /^\[\d{2}:\d{2}\] wake=/.test(l.trim()));
    expect(lines.length).toBe(5);
    expect(lines.some((l) => l.includes("wake0"))).toBe(false); // oldest evicted
    expect(lines.some((l) => l.includes("wake1"))).toBe(true);  // 2nd oldest kept
    expect(lines.some((l) => l.includes("wake5"))).toBe(true);  // newest kept
    expect(lines.some((l) => l.includes("wake6"))).toBe(false); // banks after its prompt
    rig.loop.stop();
  });
});
