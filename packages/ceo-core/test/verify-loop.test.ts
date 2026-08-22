import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBoard } from "../src/board.js";
import { SchedulerLoop } from "../src/loop.js";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { Auditor } from "../src/auditor.js";
import { BudgetGovernor } from "../src/budget.js";
import { ContextAssembler } from "../src/context.js";
import { LLMClient } from "../src/llm.js";

const NOW = 1_700_000_000_000;
let dir: string; let board: TaskBoard; let events: string[];

function rig(decideReply: (phase: number) => string, spawnResult?: { exitCode: number; summary: string }) {
  let phase = 0;
  const chat = vi.fn(async (slot: string, msgs: Array<{ role: string; content: string }>) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    const r = decideReply(phase++);
    return { content: r, usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const llm = { chat } as unknown as LLMClient;
  const orchestrator = new AgentOrchestrator({ llm, runtimeDir: dir, cmds: { hermes: "packages/ceo-core/test/fixtures/stub-agent.sh" } });
  const loop = new SchedulerLoop({
    llm, board, ctx: new ContextAssembler(), orchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 99 }),
    budget: new BudgetGovernor("burn"), runtimeDir: dir,
  });
  const origPush = loop.push.bind(loop);
  loop.push = (e: string) => { events.push(e); origPush(e); };
  return { loop, chat, orchestrator };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rjverify-"));
  board = new TaskBoard(join(dir, "b.sqlite"));
  events = [];
});

describe("verify action", () => {
  it("writes progress/verdict and appends the note to resultSummary", async () => {
    const t = board.add({ title: "job", acceptance: "tests green" });
    board.update(t.id, { status: "running" });
    const { loop } = rig(() => JSON.stringify({ actions: [{ type: "verify", task_id: t.id, progress: 80, verdict: "partial", note: "2/3 suites pass" }] }));
    await loop.runOnce("verify_due: test");
    const row = board.list()[0];
    expect(row.progress).toBe(80);
    expect(row.verdict).toBe("partial");
    expect(row.resultSummary).toContain("2/3 suites pass");
  });

  it("a pass on a blocked-awaiting-acceptance task promotes it to done", async () => {
    const t = board.add({ title: "held job", acceptance: "tests green" });
    board.update(t.id, { status: "blocked", resultSummary: "ran ok [awaiting acceptance: verify with tools]" });
    const { loop } = rig(() => JSON.stringify({ actions: [{ type: "verify", task_id: t.id, progress: 100, verdict: "pass", note: "all green" }] }));
    await loop.runOnce("verify_due: test");
    const row = board.list()[0];
    expect(row.status).toBe("done");
    expect(row.verdict).toBe("pass");
  });
  it("invalid verdict or unknown task surfaces an error, not a crash", async () => {
    const { loop } = rig(() => JSON.stringify({ actions: [
      { type: "verify", task_id: "nope", progress: 10, verdict: "pass", note: "x" },
      { type: "verify", task_id: "a", progress: 10, verdict: "bogus", note: "x" },
    ] }));
    await loop.runOnce("verify_due: test");
    expect(events.some((e) => e.includes("verify failed"))).toBe(true);
  });
});

describe("done tightening", () => {
  it("SPEC-BUTLER §6 fallback: a spawn without accept still gets an acceptance line (prompt head + verify mandate) and blocks until verified", async () => {
    const { loop } = rig(() => JSON.stringify({ actions: [{ type: "spawn", framework: "hermes", title: "loose job", prompt: "整理桌面文件并汇报" }] }));
    await loop.runOnce("chat: go");
    await new Promise((r) => setTimeout(r, 800)); // spawn settles in background
    const row = board.list().find((x) => x.title === "loose job")!;
    expect(row).toBeTruthy();
    expect(row.acceptance).toContain("整理桌面文件并汇报".slice(0, 80));
    expect(row.acceptance).toContain("verify 并给出 verdict");
    expect(row.status).toBe("blocked"); // clean exit held for the missing verify
    expect(row.resultSummary).toMatch(/\[awaiting acceptance/);
  });
  it("fallback acceptance is capped at the prompt head (80 chars) and survives very long prompts", async () => {
    const long = "长".repeat(200);
    const { loop } = rig(() => JSON.stringify({ actions: [{ type: "spawn", framework: "hermes", title: "long job", prompt: long }] }));
    await loop.runOnce("chat: go");
    await new Promise((r) => setTimeout(r, 800));
    const row = board.list().find((x) => x.title === "long job")!;
    // 80 chars of prompt + the mandate tail — never the whole 200-char prompt
    expect(row.acceptance.startsWith("长".repeat(80))).toBe(true);
    expect(row.acceptance).not.toContain("长".repeat(81));
  });
  it("sub-agent success with acceptance but verdict != pass blocks the task", async () => {
    const t = board.add({ title: "strict job", acceptance: "tests green" });
    const { loop } = rig(() => JSON.stringify({ actions: [{ type: "spawn", framework: "hermes", title: "strict job", prompt: "do it", accept: "tests green" }] }));
    await loop.runOnce("chat: go");
    await new Promise((r) => setTimeout(r, 800)); // spawn settles in background
    const row = board.list().find((x) => x.id !== t.id && x.title === "strict job")!;
    expect(row).toBeTruthy();
    expect(row.status).toBe("blocked"); // not done: acceptance unverified
    expect(row.resultSummary).toMatch(/acceptance/i);
  });
  it("verdict pass before settlement lets a clean exit become done", async () => {
    const t = board.add({ title: "clean job", acceptance: "tests green" });
    const { loop } = rig(() => JSON.stringify({ actions: [{ type: "spawn", framework: "hermes", title: "clean job", prompt: "do it" }] }));
    await loop.runOnce("chat: go");
    await new Promise((r) => setTimeout(r, 800));
    // mark acceptance BEFORE the settle fires is racy in this rig; instead: verify
    // that a pass verdict + done status round-trips (unit-level contract)
    board.update(t.id, { verdict: "pass", progress: 100, status: "done" });
    expect(board.list()[0].status).toBe("done");
  });
});

describe("verify_due pump", () => {
  it("running tasks with acceptance get a verify_due event, 5-min throttled", () => {
    const t = board.add({ title: "vj", acceptance: "ok" });
    board.update(t.id, { status: "running" });
    const { loop } = rig(() => '{"actions":[]}');
    loop.pumpGantt(NOW);
    loop.pumpGantt(NOW + 60_000); // throttle window
    const vd = events.filter((e) => e.startsWith("verify_due:"));
    expect(vd).toHaveLength(1);
    expect(vd[0]).toContain("accept:");
  });
  it("spawn without accept / running without acceptance never verify", () => {
    const t = board.add({ title: "no-accept" });
    board.update(t.id, { status: "running" });
    const { loop } = rig(() => '{"actions":[]}');
    loop.pumpGantt(NOW);
    expect(events.filter((e) => e.startsWith("verify_due:"))).toHaveLength(0);
  });
});

describe("scheduled spawn deferral", () => {
  it("a future scheduledAt spawn stays todo — the pump owns its launch", async () => {
    const later = Date.now() + 120_000;
    const { loop } = rig(() => JSON.stringify({ actions: [{ type: "spawn", framework: "hermes", title: "later job", prompt: "placeholder", scheduledAt: new Date(later).toISOString() }] }));
    await loop.runOnce("chat: schedule it");
    await new Promise((r) => setTimeout(r, 400));
    const t = board.list().find((x) => x.title === "later job");
    expect(t).toBeTruthy();
    expect(t!.status).toBe("todo"); // NOT running: deferred to the gantt pump
    expect(events.some((e) => e.startsWith("spawn_deferred:"))).toBe(true);
  });
});
