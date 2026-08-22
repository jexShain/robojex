// packages/ceo-core/test/acceptance.test.ts
// R7 (PLAN-SUPERHUMAN): the acceptance evidence chain —
//  - a pass verdict without an evidence note is refused (action failed)
//  - a fail verdict auto-re-dispatches once with the failure folded into the
//    corrective prompt; a second failure or an existing retry child stops it
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

type ChatMock = ReturnType<typeof vi.fn>;

function makeRig() {
  const dir = mkdtempSync(join(tmpdir(), "rjacc-"));
  writeFileSync(join(dir, "MISSION.md"), "m\n");
  writeFileSync(join(dir, "RUBRIC.md"), "# R\n");
  writeFileSync(join(dir, "MEMORY.md"), "# M\n");
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
  const spawns: Array<{ fw: string; prompt: string }> = [];
  const chat: ChatMock = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 1, completionTokens: 1 } };
    return { content: '{"actions":[]}', usage: { promptTokens: 1, completionTokens: 1 } };
  });
  const outletChat: string[] = [];
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board, ctx: new ContextAssembler(),
    orchestrator: {
      spawn: vi.fn(async (fw: string, prompt: string) => { spawns.push({ fw, prompt }); return { exitCode: 0, summary: "did it" }; }),
      getRegistry: () => null,
    } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"),
    runtimeDir: dir, builtinTools: mgr, policy: "butler",
    outlet: { chatOut: (_f: string, text: string) => outletChat.push(text), frame: () => {} },
  });
  const events: string[] = [];
  const origPush = loop.push.bind(loop);
  loop.push = (e: string) => { events.push(e); origPush(e); };
  // decide returns these actions on the next cycle (tests re-arm per cycle)
  const decideWith = (actions: unknown): void => {
    chat.mockImplementation(async (slot: string) => {
      if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 1, completionTokens: 1 } };
      return { content: JSON.stringify({ actions }), usage: { promptTokens: 1, completionTokens: 1 } };
    });
  };
  return { loop, board, spawns, outletChat, events, decideWith };
}

describe("acceptance evidence chain", () => {
  it("a bare pass is refused; an evidenced pass promotes the awaiting card", async () => {
    const rig = makeRig();
    const t = rig.board.add({ title: "整理下载", assignee: "hermes", acceptance: "文件归档完毕" });
    rig.board.update(t.id, { status: "blocked", resultSummary: "done [awaiting acceptance: verify with tools]", attempts: 1 });

    rig.decideWith([{ type: "verify", task_id: t.id, verdict: "pass", note: "ok" }]);
    await rig.loop.runOnce("verify");
    await until(() => rig.events.some((e) => e.includes("must carry an evidence note")));
    expect(rig.board.list().find((x) => x.id === t.id)?.status).toBe("blocked"); // refused: unchanged

    rig.decideWith([{ type: "verify", task_id: t.id, verdict: "pass", note: "read_file 确认归档目录 23 个文件就位" }]);
    await rig.loop.runOnce("verify again");
    await until(() => rig.board.list().find((x) => x.id === t.id)?.status === "done");
    const card = rig.board.list().find((x) => x.id === t.id)!;
    expect(card.resultSummary).not.toContain("[awaiting acceptance");
    expect(rig.outletChat.some((c) => c.includes("✓ 通过"))).toBe(true);
    rig.loop.stop();
  });

  it("a fail auto-re-dispatches once with a corrective prompt; a failing retry stops the ladder", async () => {
    const rig = makeRig();
    const t = rig.board.add({ title: "写周报", assignee: "claude-code", acceptance: "周报含三段结构" });
    rig.board.update(t.id, { status: "blocked", resultSummary: "draft v1 [awaiting acceptance: verify with tools]", attempts: 1 });

    rig.decideWith([{ type: "verify", task_id: t.id, verdict: "fail", note: "缺第三段风险与计划" }]);
    await rig.loop.runOnce("verify fail");
    await until(() => rig.spawns.length >= 1);
    expect(rig.spawns[0]!.fw).toBe("claude-code");
    expect(rig.spawns[0]!.prompt).toContain("缺第三段风险与计划"); // failure folded into the corrective prompt
    // the stub spawn settles instantly: the child carries the inherited
    // acceptance, so a clean exit still parks at blocked [awaiting acceptance]
    await until(() => {
      const child = rig.board.list().find((x) => x.parentId === t.id);
      return child !== undefined && child.status === "blocked" && child.attempts === 2;
    });
    expect(rig.outletChat.some((c) => c.includes("已重派"))).toBe(true);
    const child = rig.board.list().find((x) => x.parentId === t.id)!;
    expect(child.title).toBe("写周报（重派#2）");
    // a fail on the retry (attempts=2) must NOT spawn a third dispatch —
    // the ladder stops at one retry and the board tells the human
    rig.decideWith([{ type: "verify", task_id: child.id, verdict: "fail", note: "还是缺第三段" }]);
    await rig.loop.runOnce("verify child fail");
    await until(() => rig.outletChat.some((c) => c.includes("验收「写周报（重派#2）」")));
    expect(rig.spawns.length).toBe(1);
    rig.loop.stop();
  }, 30_000);
});
