// packages/ceo-core/test/plan-action.test.ts
// R9 (PLAN-SUPERHUMAN): the plan action — one epic + ordered child steps,
// each with acceptance; invalid steps refuse the whole plan; the
// plan_created event tells the next wake to staff the steps.
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
  const dir = mkdtempSync(join(tmpdir(), "rjplan-"));
  writeFileSync(join(dir, "MISSION.md"), "m\n");
  writeFileSync(join(dir, "RUBRIC.md"), "# R\n");
  writeFileSync(join(dir, "MEMORY.md"), "# M\n");
  const board = new TaskBoard(join(dir, "board.sqlite"));
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 1, completionTokens: 1 } };
    return { content: '{"actions":[]}', usage: { promptTokens: 1, completionTokens: 1 } };
  });
  const outletChat: string[] = [];
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board, ctx: new ContextAssembler(),
    orchestrator: {
      spawn: vi.fn(async () => ({ exitCode: 0, summary: "stub" })),
      getRegistry: () => ({ names: () => ["hermes", "claude-code"], toPromptBlock: () => "" }),
    } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"),
    runtimeDir: dir, policy: "butler",
    outlet: { chatOut: (_f: string, text: string) => outletChat.push(text), frame: () => {} },
  });
  const events: string[] = [];
  const origPush = loop.push.bind(loop);
  loop.push = (e: string) => { events.push(e); origPush(e); };
  const decideWith = (actions: unknown): void => {
    chat.mockImplementation(async (slot: string) => {
      if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 1, completionTokens: 1 } };
      return { content: JSON.stringify({ actions }), usage: { promptTokens: 1, completionTokens: 1 } };
    });
  };
  return { loop, board, outletChat, events, decideWith };
}

describe("plan action", () => {
  it("decomposes a goal into an epic with ordered, acceptance-carrying child steps", async () => {
    const rig = makeRig();
    rig.decideWith([{ type: "plan", goal: "整理整个下载文件夹并生成报告", steps: [
      { title: "扫描下载文件夹", prompt: "扫描并列出文件", framework: "hermes", accept: "产出文件清单" },
      { title: "归档旧文件", prompt: "按类型归档", framework: "hermes" },
      { title: "生成报告", prompt: "汇总归档结果写报告", framework: "claude-code" },
    ] }]);
    await rig.loop.runOnce("plan");
    await until(() => rig.events.some((e) => e.startsWith("plan_created:")));
    const tasks = rig.board.list();
    const epic = tasks.find((t) => t.title === "整理整个下载文件夹并生成报告");
    expect(epic).toBeDefined();
    expect(epic!.assignee).toBe("jex");
    const kids = tasks.filter((t) => t.parentId === epic!.id);
    expect(kids).toHaveLength(3);
    expect(kids.map((k) => k.title)).toEqual(["扫描下载文件夹", "归档旧文件", "生成报告"]);
    expect(kids.every((k) => k.acceptance.length > 0)).toBe(true); // fallback acceptance filled the gap
    expect(kids.every((k) => k.status === "todo")).toBe(true);     // plan builds, dispatch decides
    expect(rig.outletChat.some((c) => c.includes("已制定计划") && c.includes("3 步"))).toBe(true);
    expect(rig.events.some((e) => e.includes("dispatch the ready steps"))).toBe(true);
    rig.loop.stop();
  });

  it("refuses a plan with a bad framework or an empty step prompt — nothing lands on the board", async () => {
    const rig = makeRig();
    rig.decideWith([{ type: "plan", goal: "坏计划", steps: [
      { title: "一步", prompt: "干活", framework: "nonexistent-agent" },
    ] }]);
    await rig.loop.runOnce("plan");
    await until(() => rig.events.some((e) => e.includes("action failed")));
    expect(rig.board.list().some((t) => t.title === "坏计划")).toBe(false);
    rig.decideWith([{ type: "plan", goal: "空步骤", steps: [{ title: "无提示" }] }]);
    await rig.loop.runOnce("plan2");
    expect(rig.board.list().some((t) => t.title === "空步骤")).toBe(false);
    rig.loop.stop();
  });
});
