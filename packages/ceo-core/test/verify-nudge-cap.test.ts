// packages/ceo-core/test/verify-nudge-cap.test.ts
// R73: an unchanged blocked-awaiting card earns at most 3 verify_due nudges
// per episode (each nudge is a full paid cycle); a card change resets the cap;
// settling releases the slot entirely.
import { describe, it, expect } from "vitest";
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

function makeRig() {
  const dir = mkdtempSync(join(tmpdir(), "rjnc-"));
  writeFileSync(join(dir, "MISSION.md"), "m\n");
  writeFileSync(join(dir, "RUBRIC.md"), "# R\n");
  writeFileSync(join(dir, "MEMORY.md"), "# M\n");
  const board = new TaskBoard(join(dir, "board.sqlite"));
  const loop = new SchedulerLoop({
    llm: { chat: async () => ({ content: "{}", usage: { promptTokens: 1, completionTokens: 1 } }) } as unknown as LLMClient,
    board, ctx: new ContextAssembler(),
    orchestrator: { spawn: async () => ({ exitCode: 0, summary: "s" }), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"),
    runtimeDir: dir, policy: "butler",
  });
  const events: string[] = [];
  const origPush = loop.push.bind(loop);
  loop.push = (e: string) => { events.push(e); origPush(e); };
  return { loop, board, events };
}

const MIN = 60_000;

describe("R73 verify_due nag cap", () => {
  it("an unchanged card gets 3 nudges then goes quiet until it changes", () => {
    const rig = makeRig();
    const chats: Array<[string, string]> = [];
    rig.loop.setOutlet({ chatOut: (from: string, text: string) => { chats.push([from, text]); } } as never);
    const t = rig.board.add({ title: "悬置卡", assignee: "hermes", acceptance: "产物核对" });
    rig.board.update(t.id, { status: "blocked", resultSummary: "done [awaiting acceptance: verify]", attempts: 1 });
    const verifyDue = (): number => rig.events.filter((e) => e.startsWith("verify_due:") && e.includes("悬置卡")).length;
    rig.loop.pumpGantt(Date.now()); expect(verifyDue()).toBe(1);
    expect(chats.length).toBe(0); // nudges 1-2 stay model-facing, no human spam
    rig.loop.pumpGantt(Date.now() + 6 * MIN); expect(verifyDue()).toBe(2);
    expect(chats.length).toBe(0);
    rig.loop.pumpGantt(Date.now() + 12 * MIN); expect(verifyDue()).toBe(3);
    // R77: the cap never parks silently — the third nudge tells the human
    expect(chats.length).toBe(1);
    expect(chats[0]![0]).toBe("jex");
    expect(chats[0]![1]).toContain("验收悬置");
    expect(chats[0]![1]).toContain("悬置卡");
    rig.loop.pumpGantt(Date.now() + 18 * MIN); expect(verifyDue()).toBe(3); // capped
    expect(chats.length).toBe(1); // ...and says it exactly once per episode
    rig.loop.pumpGantt(Date.now() + 24 * MIN); expect(verifyDue()).toBe(3); // still capped
    // the card moves (attempts bumped): the episode resets and nudge resumes
    rig.board.update(t.id, { status: "blocked", resultSummary: "retry [awaiting acceptance: verify]", attempts: 0 });
    rig.loop.pumpGantt(Date.now() + 30 * MIN);
    expect(verifyDue()).toBe(4);
    rig.loop.stop();
  });

  it("a settled card releases its nudge slot (re-block later starts fresh)", () => {
    const rig = makeRig();
    const t = rig.board.add({ title: "再悬置", assignee: "hermes", acceptance: "核对" });
    rig.board.update(t.id, { status: "blocked", resultSummary: "x [awaiting acceptance: verify]", attempts: 1 });
    rig.loop.pumpGantt(Date.now());
    expect(rig.events.filter((e) => e.startsWith("verify_due:") && e.includes("再悬置")).length).toBe(1);
    rig.board.update(t.id, { status: "done", resultSummary: "verified fine", verdict: "pass" });
    rig.loop.pumpGantt(Date.now() + 6 * MIN);
    // done: no more verify_due at all
    expect(rig.events.filter((e) => e.startsWith("verify_due:") && e.includes("再悬置")).length).toBe(1);
    rig.loop.stop();
  });
});
