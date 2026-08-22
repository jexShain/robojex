// packages/ceo-core/test/butler-brief.test.ts
// 对话即委托 + 管家节点简报: every key loop node reports one chat line through
// the outlet (a fake outlet here) — spawn dispatch, agent_done settlement,
// verify verdict, the task_due chase and the reflect digest — plus the patrol
// triage rule that separates chat errands from chatter.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBoard } from "../src/board.js";
import { SchedulerLoop } from "../src/loop.js";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { Auditor } from "../src/auditor.js";
import { BudgetGovernor } from "../src/budget.js";
import { ContextAssembler } from "../src/context.js";
import { LLMClient } from "../src/llm.js";
import { until } from "./helpers.js";

let dir: string; let board: TaskBoard;
let briefs: Array<{ from: string; text: string }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rjbrief-"));
  writeFileSync(join(dir, "MISSION.md"), "m\n");
  writeFileSync(join(dir, "RUBRIC.md"), "r\n");
  writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n");
  board = new TaskBoard(join(dir, "b.sqlite"));
  briefs = [];
});

type SpawnResult = { exitCode: number; summary: string; logPath: string; summaryUsage: null };

function rig(decideReply: () => string, spawnFn?: () => Promise<SpawnResult>) {
  const systems: { slot: string; content: string }[] = [];
  const chat = vi.fn(async (slot: string, msgs: Array<{ role: string; content: string }>) => {
    if (msgs[0]) systems.push({ slot, content: String(msgs[0].content) });
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return { content: decideReply(), usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const orchestrator = {
    spawn: spawnFn ?? vi.fn(async () => ({ exitCode: 0, summary: "ok", logPath: "/dev/null", summaryUsage: null })),
    getRegistry: () => null,
  } as unknown as AgentOrchestrator;
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board, ctx: new ContextAssembler(), orchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 9999 }), budget: new BudgetGovernor("burn"), runtimeDir: dir,
  });
  loop.setOutlet({
    chatOut: (from, text) => briefs.push({ from, text }),
    frame: () => {},
    hud: () => {},
  });
  return { loop, chat, systems };
}

describe("butler briefs (管家节点简报)", () => {
  it("spawn dispatch: one chat line with the assignee, the due window and the acceptance head", async () => {
    const { loop } = rig(() => JSON.stringify({
      actions: [{ type: "spawn", framework: "hermes", title: "报表任务", prompt: "汇总周报", accept: "报告包含三个数据源的行数统计", dueAt: new Date(Date.now() + 2 * 3_600_000).toISOString() }],
    }));
    await loop.runOnce("chat: 帮我出周报");
    const line = briefs.find((b) => b.text.includes("已派发"));
    expect(line).toBeTruthy();
    expect(line!.from).toBe("jex");
    expect(line!.text).toContain("「报表任务」");
    expect(line!.text).toContain("给 hermes");
    expect(line!.text).toContain("预计 2小时后");
    expect(line!.text).toContain("验收：报告包含三个数据源的行数统计");
    loop.stop();
  });

  it("deferred spawn briefs as scheduled work, not a dispatch", async () => {
    const { loop } = rig(() => JSON.stringify({
      actions: [{ type: "spawn", framework: "hermes", title: "夜巡", prompt: "p", scheduledAt: new Date(Date.now() + 30 * 60_000).toISOString() }],
    }));
    await loop.runOnce("tick");
    const line = briefs.find((b) => b.text.includes("已排程"));
    expect(line).toBeTruthy();
    expect(line!.text).toContain("「夜巡」");
    expect(line!.text).toContain("30分钟后");
    expect(briefs.some((b) => b.text.includes("已派发"))).toBe(false); // nothing was dispatched yet
    loop.stop();
  });

  it("agent_done: settlement briefs 完成/阻塞 with the result head", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const spawnFn = vi.fn(async () => { await gate; return { exitCode: 0, summary: "周报完成，共 3 张表", logPath: "/dev/null", summaryUsage: null }; });
    const { loop } = rig(() => JSON.stringify({
      actions: [{ type: "spawn", framework: "hermes", title: "周报", prompt: "汇总", accept: "三张表齐" }],
    }), spawnFn);
    await loop.runOnce("chat: 出周报");
    // acceptance satisfied before the sub-agent exits: the settle becomes done
    const card = board.list().find((t) => t.title === "周报")!;
    board.update(card.id, { verdict: "pass" });
    release();
    await until(() => briefs.some((b) => b.text.includes("完成")));
    const line = briefs.find((b) => b.text.includes("「周报」完成"));
    expect(line).toBeTruthy();
    expect(line!.text).toContain("周报完成，共 3 张表");
    loop.stop();
  });

  it("spawn failure: the blocked card still briefs one line", async () => {
    const spawnFn = vi.fn(async () => { throw new Error("no such agent"); });
    const { loop } = rig(() => JSON.stringify({
      actions: [{ type: "spawn", framework: "hermes", title: "失败任务", prompt: "p" }],
    }), spawnFn);
    await loop.runOnce("tick");
    await until(() => briefs.some((b) => b.text.includes("「失败任务」阻塞")));
    const line = briefs.find((b) => b.text.includes("「失败任务」阻塞"))!;
    expect(line.text).toContain("action failed: no such agent");
    loop.stop();
  });

  it("verify verdict: pass ✓, fail ✗ with note head, partial ◐", async () => {
    const pass = board.add({ title: "通过任务", acceptance: "ok" });
    const fail = board.add({ title: "未过任务", acceptance: "ok" });
    const partial = board.add({ title: "部分任务", acceptance: "ok" });
    const { loop } = rig(() => JSON.stringify({ actions: [
      { type: "verify", task_id: pass.id, progress: 100, verdict: "pass", note: "全绿" },
      { type: "verify", task_id: fail.id, progress: 20, verdict: "fail", note: "测试没跑通，缺两个用例且构建产物没有落盘" },
      { type: "verify", task_id: partial.id, progress: 60, verdict: "partial", note: "2/3 套件通过" },
    ] }));
    await loop.runOnce("verify_due: check");
    const texts = briefs.map((b) => b.text);
    expect(texts.some((t) => t === "验收「通过任务」：✓ 通过")).toBe(true);
    expect(texts.some((t) => t.startsWith("验收「未过任务」：✗ 未过——") && t.includes("测试没跑通"))).toBe(true);
    expect(texts.some((t) => t.startsWith("验收「部分任务」：◐ 部分通过——") && t.includes("2/3 套件"))).toBe(true);
    loop.stop();
  });

  it("task_due chase: the pump's nudge also briefs the chat stream", () => {
    const t = board.add({ title: "到期任务", dueAt: Date.now() - 1000 });
    board.update(t.id, { status: "running" });
    const { loop } = rig(() => '{"actions":[]}');
    loop.pumpGantt(Date.now());
    const line = briefs.find((b) => b.text.includes("提醒："));
    expect(line).toBeTruthy();
    expect(line!.text).toBe("提醒：「到期任务」已到检查时间，我去核验进度");
    loop.stop();
  });

  it("reflect: a real lesson (>30 chars) briefs 管家小结, short entries stay silent", async () => {
    const long = "今日教训：派活前先看 AGENTS 清单，别把浏览器任务派给纯编码代理，浪费时间还验收不过。";
    const short = "今天无事。";
    const { loop } = rig(() => JSON.stringify({ actions: [
      { type: "reflect", text: long },
      { type: "reflect", text: short },
    ] }));
    await loop.runOnce("tick");
    const lines = briefs.filter((b) => b.text.startsWith("管家小结："));
    expect(lines).toHaveLength(1); // the short entry earned no chat line
    expect(lines[0]!.text).toContain("派活前先看 AGENTS 清单");
    loop.stop();
  });
});

describe("patrol triage: chat errand rule", () => {
  it("the patrol system prompt separates chat errands from already-answered chatter", async () => {
    const { loop, systems } = rig(() => '{"actions":[]}');
    await loop.runOnce("chat: 你好");
    const patrol = systems.find((s) => s.slot === "patrol")!.content;
    expect(patrol).toContain("'chat:' event is the human talking to jex");
    expect(patrol).toContain("errand or delegation");
    expect(patrol).toContain("帮我/做/建/写/修/查/安排");
    expect(patrol).toContain("may be 'none'");
    expect(patrol).toContain("When unsure, act");
    loop.stop();
  });
});
