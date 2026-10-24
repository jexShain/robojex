// packages/ceo-core/test/thinking-stream.test.ts — T7 wire contract:
// every cycle streams `think` frames as its phases happen (wake → patrol →
// decide plan → audit), each carrying a backend-authoritative monotonic id,
// the owning wake and that phase's token bill. The cycle frame ships the
// SAME steps as its trace (the client deduplicates on the shared ids), and
// recentThinking() replays the window for late joiners / reloaded tabs.
import { SchedulerLoop } from "../src/loop.js";
import { LLMClient } from "../src/llm.js";
import { TaskBoard } from "../src/board.js";
import { ContextAssembler } from "../src/context.js";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { Auditor } from "../src/auditor.js";
import { BudgetGovernor } from "../src/budget.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

function makeRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "robojex-think-"));
  writeFileSync(join(dir, "MISSION.md"), "Keep the demo repo healthy.\n");
  writeFileSync(join(dir, "RUBRIC.md"), "# RUBRIC\n- prefer cheap actions\n");
  writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n");
  return dir;
}

async function oneWake() {
  const runtimeDir = makeRuntime();
  const frames: Record<string, unknown>[] = [];
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return { content: JSON.stringify({ actions: [{ type: "reply", text: "checked the file" }] }), usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const llm = { chat } as unknown as LLMClient;
  const loop = new SchedulerLoop({
    llm, board: new TaskBoard(join(runtimeDir, "board.sqlite")), ctx: new ContextAssembler(),
    orchestrator: new AgentOrchestrator({ llm, runtimeDir, cmds: {} }),
    auditor: new Auditor({ runtimeDir, reviewEvery: 99 }),
    budget: new BudgetGovernor("burn"), runtimeDir,
    outlet: { chatOut: vi.fn(), frame: (f: Record<string, unknown>) => frames.push(f) },
  });
  await loop.runOnce("tool read_file -> 1|x");
  return { loop, frames };
}

test("a wake streams live think frames: wake → patrol → decide(plan) → audit", async () => {
  const { loop, frames } = await oneWake();
  const think = frames.filter((f) => f.t === "think").map((f) => f.step as Record<string, unknown>);
  const kinds = think.map((s) => s.kind);
  // every phase is its own step while the wake is still in flight —
  // the decide step names the planned actions BEFORE execution starts
  expect(kinds).toEqual(["wake", "patrol", "decide", "audit"]);

  const decide = think.find((s) => s.kind === "decide")!;
  expect(decide.actions).toEqual([{ type: "reply", title: "checked the file" }]);
  // requirement: per-step timestamp + token bill
  expect(typeof decide.ts).toBe("number");
  expect(decide.tokens).toBe(70); // prompt 50 + completion 20 of the decide pass
  const patrol = think.find((s) => s.kind === "patrol")!;
  expect(patrol.tokens).toBe(12);
  expect(patrol.verdict).toBe("act");

  // backend-authoritative ids: strictly increasing, shared vocabulary
  const ids = think.map((s) => s.id as number);
  expect(ids).toEqual([...ids].sort((a, b) => a - b));
  expect(new Set(ids).size).toBe(ids.length);
  // every step of this wake carries the owning wake number
  expect(new Set(think.map((s) => s.wake)).size).toBe(1);

  // the cycle frame ships the SAME steps as its trace (ids identical —
  // the client merge dedups against the live think frames)
  const cycle = frames.find((f) => f.t === "cycle")!;
  const trace = (cycle.trace as Record<string, unknown>[]) ?? [];
  expect(trace.map((s) => s.id)).toEqual(ids);

  // late joiners get the window back, oldest first
  expect(loop.recentThinking().map((s) => s.id)).toEqual(ids);

  loop.stop();
});

test("think ids never reset across wakes — reconnect replay can't double-append", async () => {
  const { loop, frames } = await oneWake();
  const firstMax = Math.max(...frames.filter((f) => f.t === "think").map((f) => (f.step as { id: number }).id));
  await loop.runOnce("tick");
  const later = frames.filter((f) => f.t === "think").map((f) => f.step as Record<string, unknown>);
  const newIds = later.map((s) => s.id as number).filter((id) => id > firstMax);
  expect(newIds.length).toBeGreaterThan(0);
  // the ring keeps one copy of every id (bounded window, no duplicates)
  const ring = loop.recentThinking().map((s) => s.id as number);
  expect(new Set(ring).size).toBe(ring.length);
  loop.stop();
});
