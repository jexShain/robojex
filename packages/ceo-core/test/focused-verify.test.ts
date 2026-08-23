// packages/ceo-core/test/focused-verify.test.ts
// R78: the focused micro-judge settles an awaiting card in two rounds (check
// tool_call → verify with evidence) without the big decide prompt; a drifting
// model falls back to the regular verify_due event. R79: a duplicate live
// card earns a duplicate_spawn event, never a block.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchedulerLoop } from "../src/loop.js";
import type { LLMClient, ChatMsg } from "../src/llm.js";
import { TaskBoard } from "../src/board.js";
import { ContextAssembler } from "../src/context.js";
import type { AgentOrchestrator } from "../src/orchestrator.js";
import { Auditor } from "../src/auditor.js";
import { BudgetGovernor } from "../src/budget.js";
import { until } from "./helpers.js";

function fakeTools(results: string[]) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let n = 0;
  return {
    calls,
    tools: {
      async call(name: string, args: Record<string, unknown>): Promise<string> {
        calls.push([name, args]);
        return results[Math.min(n++, results.length - 1)]!;
      },
      schemasBlock: (): string => "# BUILTIN TOOLS\nterminal(command:string) — Run a shell command\nread_file(path:string) — Read a file",
    },
  };
}

function makeRig(opts: {
  llmScript: (slot: string, msgs: ChatMsg[], call: number) => string;
  tools?: ReturnType<typeof fakeTools>["tools"];
}) {
  const dir = mkdtempSync(join(tmpdir(), "rjfv-"));
  writeFileSync(join(dir, "MISSION.md"), "m\n");
  writeFileSync(join(dir, "RUBRIC.md"), "# R\n");
  writeFileSync(join(dir, "MEMORY.md"), "# M\n");
  const board = new TaskBoard(join(dir, "board.sqlite"));
  const chat = vi.fn(async (slot: string, msgs: ChatMsg[]) => {
    return { content: opts.llmScript(slot, msgs, chat.mock.calls.length), usage: { promptTokens: 10, completionTokens: 5 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board, ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(async () => ({ exitCode: 0, summary: "s" })), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"),
    runtimeDir: dir, policy: "butler",
    ...(opts.tools ? { builtinTools: opts.tools } : {}),
  });
  const events: string[] = [];
  const origPush = loop.push.bind(loop);
  loop.push = (e: string) => { events.push(e); origPush(e); };
  return { loop, board, events, dir, chat };
}

function seedAwaiting(board: TaskBoard): string {
  const t = board.add({ title: "整理桌面文件夹", assignee: "hermes", acceptance: "桌面无散落文件" });
  board.update(t.id, { status: "blocked", resultSummary: "done [awaiting acceptance: verify with tools]", attempts: 1 });
  return t.id;
}

// pumpGantt is sync; cycles debounce 500ms — wait for the queue to drain.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 900));

describe("R78 focused acceptance judge", () => {
  it("round 1 runs the check tool, round 2 lands the verified pass", async () => {
    const { tools, calls } = fakeTools(["$ ls ~/Desktop\nfile1.txt file2.txt  (整理完成)"]);
    const verifyJson = (id: string): string => JSON.stringify({ verify: { task_id: id, progress: 100, verdict: "pass", note: "ls 输出桌面仅余 file1/file2，整理完成" } });
    const rig = makeRig({
      tools,
      // route by prompt CONTENT, not call order — debounce timing must not matter
      llmScript: (slot, msgs) => {
        if (slot === "patrol") return '{"action":"act"}';
        const sys = String(msgs[0]?.content ?? "");
        const last = String(msgs.at(-1)?.content ?? "");
        if (sys.includes("acceptance judge")) {
          return last.includes("# TOOL RESULT")
            ? verifyJson(rigBoardId())
            : '{"tool_call":{"tool":"terminal","args":{"command":"ls ~/Desktop"}}}';
        }
        return '{"actions":[]}'; // the big decide always declines (today's live behavior)
      },
    });
    const id = seedAwaiting(rig.board);
    const rigBoardId = (): string => id;
    const t0 = Date.now();
    rig.loop.pumpGantt(t0);              // nudge 1: regular verify_due event (big decide gets one shot)
    await settle();
    rig.loop.pumpGantt(t0 + 6 * 60_000); // nudge 2: focused judge
    await until(() => rig.board.list().find((x) => x.id === id)?.status === "done" || calls.length > 0);
    await until(() => rig.board.list().find((x) => x.id === id)?.verdict !== "unchecked");
    const card = rig.board.list().find((x) => x.id === id)!;
    expect(calls.length).toBe(1);                 // the check ran exactly once
    expect(calls[0]![0]).toBe("terminal");
    expect(card.verdict).toBe("pass");            // evidence-backed verdict applied
    expect(card.status).toBe("done");             // awaiting-acceptance card promoted
    rig.loop.stop();
  });

  it("a drifting model falls back to the regular verify_due event", async () => {
    const rig = makeRig({
      llmScript: (slot) => slot === "patrol" ? '{"action":"act"}' : "我无法判断", // junk on every pass
    });
    const id = seedAwaiting(rig.board);
    const t0 = Date.now();
    rig.loop.pumpGantt(t0);
    rig.loop.pumpGantt(t0 + 6 * 60_000); // nudge 2: focused judge drifts…
    await until(() => rig.events.some((e) => e.includes("focused judge could not rule")));
    expect(rig.board.list().find((x) => x.id === id)?.verdict).toBe("unchecked"); // nothing falsely applied
    rig.loop.stop();
  });
});

describe("R79 duplicate spawn guard", () => {
  it("a second live card with the same title earns a duplicate_spawn event; the spawn still lands", async () => {
    let spawnedOnce = false;
    const rig = makeRig({
      llmScript: (slot) => {
        if (slot === "patrol") return '{"action":"act"}';
        if (!spawnedOnce) {
          spawnedOnce = true;
          return JSON.stringify({ actions: [{ type: "spawn", framework: "hermes", title: "整理下载文件夹", prompt: "整理" }] });
        }
        return '{"actions":[]}';
      },
    });
    // pre-existing live card with the same title
    rig.board.add({ title: "整理下载文件夹", assignee: "hermes", acceptance: "done" });
    await rig.loop.runOnce("chat: 再整理一次下载文件夹");
    await settle();
    await until(() => rig.events.some((e) => e.startsWith("duplicate_spawn:")));
    expect(rig.events.some((e) => e.includes("整理下载文件夹") && e.includes("two live cards"))).toBe(true);
    // the new card still landed (guard notifies, never blocks)
    expect(rig.board.list().filter((t) => t.title === "整理下载文件夹").length).toBe(2);
    rig.loop.stop();
  });
});
