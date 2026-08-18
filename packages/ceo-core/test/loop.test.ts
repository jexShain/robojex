// packages/ceo-core/test/loop.test.ts
import { SchedulerLoop } from "../src/loop.js";
import { LLMClient } from "../src/llm.js";
import { TaskBoard } from "../src/board.js";
import { ContextAssembler } from "../src/context.js";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { Auditor } from "../src/auditor.js";
import { BudgetGovernor } from "../src/budget.js";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { expect, test, vi } from "vitest";

function makeRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "robojex-loop-"));
  writeFileSync(join(dir, "MISSION.md"), "Keep the demo repo healthy: run checks, fix failures.\n");
  writeFileSync(join(dir, "RUBRIC.md"), "# RUBRIC\n- prefer cheap actions\n");
  writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n");
  return dir;
}

test("end to end: mission -> decide -> spawn -> audit -> rubric evolves", async () => {
  const runtimeDir = makeRuntime();
  execSync("git init -q", { cwd: runtimeDir });
  execSync("git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: runtimeDir });

  // scripted fake LLM: patrol says act; decide spawns; audit review returns patches
  let phase = 0;
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: phase === 0 ? '{"action":"act"}' : '{"action":"none"}', usage: { promptTokens: 10, completionTokens: 2 } };
    // decide slots: first is the decision, then sub-agent summary, then audit review
    phase++;
    if (phase === 1) return { content: JSON.stringify({ actions: [{ type: "spawn", framework: "hermes", title: "stub job", prompt: "run checks" }] }) , usage: { promptTokens: 50, completionTokens: 20 } };
    if (phase === 2) return { content: "stub job finished ok", usage: { promptTokens: 5, completionTokens: 5 } };
    return { content: "RUBRIC PATCH: - verify spawn results before new spawns\nMEMORY PATCH: + stub agent reliable\nMISSION NOTE: none", usage: { promptTokens: 30, completionTokens: 10 } };
  });
  const llm = { chat } as unknown as LLMClient;

  const board = new TaskBoard(join(runtimeDir, "board.sqlite"));
  const orchestrator = new AgentOrchestrator({ llm, runtimeDir, cmds: { hermes: "packages/ceo-core/test/fixtures/stub-agent.sh" } });
  const auditor = new Auditor({ runtimeDir, reviewEvery: 1 });
  const loop = new SchedulerLoop({
    llm, board, ctx: new ContextAssembler(), orchestrator, auditor,
    budget: new BudgetGovernor("burn"), runtimeDir,
  });

  await loop.runOnce("tick");       // patrol=act -> decide=spawn -> stub runs -> summary -> trace recorded
  await loop.runOnce("tick");       // patrol=none -> cheap exit; audit due -> review -> patches applied

  const tasks = board.list();
  expect(tasks.length).toBe(1);
  expect(tasks[0].status).toBe("done");
  expect(readFileSync(join(runtimeDir, "RUBRIC.md"), "utf8")).toContain("verify spawn results");
  expect(readFileSync(join(runtimeDir, "MEMORY.md"), "utf8")).toContain("stub agent reliable");
}, 30_000);
