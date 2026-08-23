// packages/ceo-core/test/overdue-spawn.test.ts
// R76: a todo card past its scheduledAt that due_spawn failed to launch gets
// pump-enforced — overdue_spawn nudges every 5 min, max 3 per episode, third
// escalates to "tell the human"; leaving todo releases the slot. And the
// morning-briefing marker persists across restarts (no double briefing).
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

function makeRig(prepare?: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "rjos-"));
  writeFileSync(join(dir, "MISSION.md"), "m\n");
  writeFileSync(join(dir, "RUBRIC.md"), "# R\n");
  writeFileSync(join(dir, "MEMORY.md"), "# M\n");
  prepare?.(dir);
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
  return { loop, board, events, dir };
}

const MIN = 60_000;

describe("R76 overdue_spawn enforcement", () => {
  it("nags a missed schedule every 5 min, caps at 3, escalates on the third", () => {
    const rig = makeRig();
    const t0 = Date.now();
    const t = rig.board.add({ title: "该开工没开工", assignee: "hermes", scheduledAt: t0 - 10 * MIN, acceptance: "done" });
    const nudges = (): number => rig.events.filter((e) => e.startsWith("overdue_spawn:") && e.includes("该开工没开工")).length;
    rig.loop.pumpGantt(t0);            // fires due_spawn + first overdue nudge (grace passed: sched 10min ago)
    expect(rig.events.some((e) => e.startsWith("due_spawn:"))).toBe(true);
    expect(nudges()).toBe(1);
    rig.loop.pumpGantt(t0 + MIN);      // inside the 5-min throttle
    expect(nudges()).toBe(1);
    rig.loop.pumpGantt(t0 + 6 * MIN);  // nudge 2
    expect(nudges()).toBe(2);
    rig.loop.pumpGantt(t0 + 12 * MIN); // nudge 3 — the loop force-launches the card itself
    expect(nudges()).toBe(2);          // no third event: enforcement replaced the nag
    const card = rig.board.list().find((x) => x.id === t.id)!;
    expect(card.status).toBe("running"); // schedule enforced in code, not by the model's mood
    rig.loop.pumpGantt(t0 + 18 * MIN); // launched: the pump stays quiet
    expect(nudges()).toBe(2);
    rig.loop.stop();
  });

  it("grace window: a just-due card is not instantly nagged (due_spawn cycle gets 2 minutes)", () => {
    const rig = makeRig();
    const t0 = Date.now();
    rig.board.add({ title: "刚到点", assignee: "hermes", scheduledAt: t0 - 30_000, acceptance: "done" });
    rig.loop.pumpGantt(t0);
    expect(rig.events.some((e) => e.startsWith("overdue_spawn:"))).toBe(false);
    rig.loop.stop();
  });

  it("morning briefing marker persists: a restarted loop inside the window stays quiet", () => {
    const at = (h: number): number => new Date(2026, 7, 23, h, 5).getTime();
    const first = makeRig();
    first.loop.pumpGantt(at(8)); // briefs, marker file written
    expect(first.events.some((e) => e.startsWith("morning_briefing:"))).toBe(true);
    first.loop.stop();
    // simulate the restart: a fresh loop instance on the SAME runtime dir
    const second = makeRig((dir) => writeFileSync(join(dir, "morning-sent.txt"), "2026-08-23"));
    second.loop.pumpGantt(at(9)); // same day, inside the window, marker says sent
    expect(second.events.some((e) => e.startsWith("morning_briefing:"))).toBe(false);
    second.loop.stop();
  });
});
