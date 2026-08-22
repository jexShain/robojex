// packages/ceo-core/test/agent-stats.test.ts
// R8 (PLAN-SUPERHUMAN): the experience ledger — every verify verdict appends
// `framework|verdict|title` to runtime/STATS.md, and the decide context
// carries the aggregated per-agent track record (pass rates + recent titles).
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "rjstat-"));
  writeFileSync(join(dir, "MISSION.md"), "m\n");
  writeFileSync(join(dir, "RUBRIC.md"), "# R\n");
  writeFileSync(join(dir, "MEMORY.md"), "# M\n");
  const board = new TaskBoard(join(dir, "board.sqlite"));
  const decideUser: string[] = [];
  let nextActions: unknown[] = [];
  const chat = vi.fn(async (slot: string, msgs: Array<{ role: string; content: string }>) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 1, completionTokens: 1 } };
    decideUser.push(String(msgs[1]?.content));
    return { content: JSON.stringify({ actions: nextActions }), usage: { promptTokens: 1, completionTokens: 1 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient,
    board, ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(async () => ({ exitCode: 0, summary: "stub" })), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"),
    runtimeDir: dir, policy: "butler",
  });
  const decideWith = (actions: unknown[]): void => { nextActions = actions; };
  return { loop, board, dir, decideUser, decideWith };
}

describe("agent stats ledger", () => {
  it("verdicts append to STATS.md and the next decide context carries the track record", async () => {
    const rig = makeRig();
    // two verdicts for hermes (1 pass 1 fail), one pass for claude-code
    const t1 = rig.board.add({ title: "整理下载文件夹", assignee: "hermes", acceptance: "归档完成" });
    const t2 = rig.board.add({ title: "修复构建脚本", assignee: "hermes", acceptance: "构建通过" });
    const t3 = rig.board.add({ title: "写周报", assignee: "claude-code", acceptance: "三段结构" });
    rig.decideWith([
      { type: "verify", task_id: t1.id, verdict: "pass", note: "ls 归档目录 23 个文件就位" },
      { type: "verify", task_id: t2.id, verdict: "fail", note: "构建仍红：缺依赖" },
      { type: "verify", task_id: t3.id, verdict: "pass", note: "读报告确认三段齐全" },
    ]);
    await rig.loop.runOnce("verify batch");
    await until(() => {
      try { return readFileSync(join(rig.dir, "STATS.md"), "utf8").split("\n").filter(Boolean).length >= 3; } catch { return false; }
    });
    const ledger = readFileSync(join(rig.dir, "STATS.md"), "utf8");
    expect(ledger).toContain("hermes|pass|整理下载文件夹");
    expect(ledger).toContain("hermes|fail|修复构建脚本");
    expect(ledger).toContain("claude-code|pass|写周报");
    // the NEXT decide pass sees the aggregated record
    rig.decideWith([]);
    await rig.loop.runOnce("next cycle");
    await until(() => rig.decideUser.length >= 1);
    const ctx = rig.decideUser.at(-1)!;
    expect(ctx).toContain("# AGENT STATS");
    expect(ctx).toContain("hermes: 2 次验收，通过率 50%（1✓ 0◐ 1✗）");
    expect(ctx).toContain("claude-code: 1 次验收，通过率 100%（1✓ 0◐ 0✗）");
    rig.loop.stop();
  });

  it("an empty ledger injects nothing", async () => {
    const rig = makeRig();
    await rig.loop.runOnce("boot");
    await until(() => rig.decideUser.length >= 1);
    expect(rig.decideUser[0]).not.toContain("# AGENT STATS");
    rig.loop.stop();
  });
});
