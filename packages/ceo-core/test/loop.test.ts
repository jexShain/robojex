// packages/ceo-core/test/loop.test.ts
import { SchedulerLoop } from "../src/loop.js";
import type { WsLike } from "../src/loop.js";
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
import { EventEmitter } from "node:events";
import WebSocket from "ws";
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
  const budget = new BudgetGovernor("burn");
  const loop = new SchedulerLoop({
    llm, board, ctx: new ContextAssembler(), orchestrator, auditor, budget, runtimeDir,
  });

  await loop.runOnce("tick");       // patrol=act -> decide=spawn -> stub runs -> summary -> trace recorded
  await loop.runOnce("tick");       // patrol=none -> cheap exit; audit due -> review -> patches applied

  const tasks = board.list();
  expect(tasks.length).toBe(1);
  expect(tasks[0].status).toBe("done");
  expect(readFileSync(join(runtimeDir, "RUBRIC.md"), "utf8")).toContain("verify spawn results");
  expect(readFileSync(join(runtimeDir, "MEMORY.md"), "utf8")).toContain("stub agent reliable");
  // full token ledger: run1 = patrol 12 + decide 70 + sub-agent summary 12 + review#1 10;
  // run2 = patrol 12 + review#2 40 -> 156 total (summary + review usage must be booked)
  expect(budget.line()).toContain("spent 156 tokens");
}, 30_000);

test("invalid spawn action: task created and blocked, later actions still run", async () => {
  const runtimeDir = makeRuntime();
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return {
      content: JSON.stringify({ actions: [
        { type: "spawn", framework: "hermes", title: "no prompt job" }, // prompt missing -> invalid
        { type: "message", text: "one action failed but I carry on" },
      ] }),
      usage: { promptTokens: 50, completionTokens: 20 },
    };
  });
  const llm = { chat } as unknown as LLMClient;
  const spawnFn = vi.fn(async () => { throw new Error("spawn must not run for an invalid action"); });
  const orchestrator = { spawn: spawnFn } as unknown as AgentOrchestrator;
  const board = new TaskBoard(join(runtimeDir, "board.sqlite"));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const loop = new SchedulerLoop({
      llm, board, ctx: new ContextAssembler(), orchestrator,
      auditor: new Auditor({ runtimeDir }), budget: new BudgetGovernor("burn"), runtimeDir,
    });
    await loop.runOnce("tick");

    expect(spawnFn).not.toHaveBeenCalled();                 // invalid action never reaches the orchestrator
    const tasks = board.list();
    expect(tasks.length).toBe(1);                           // the failed action still leaves a visible task
    expect(tasks[0].status).toBe("blocked");
    expect(tasks[0].resultSummary).toContain("prompt");     // reason recorded
    expect(log).toHaveBeenCalledWith(expect.stringContaining("one action failed but I carry on"));
  } finally {
    log.mockRestore(); // restore only after the call-history assertions above
    err.mockRestore();
  }
});

test("patrol-only gate: patrol runs, decide never called", async () => {
  const runtimeDir = makeRuntime();
  const chat = vi.fn(async () => ({ content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } }));
  const llm = { chat } as unknown as LLMClient;
  const budget = new BudgetGovernor("budgeted", 1000);
  budget.spend({ promptTokens: 950, completionTokens: 0 }); // 95%: patrol-only window
  const loop = new SchedulerLoop({
    llm, board: new TaskBoard(join(runtimeDir, "board.sqlite")), ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn() } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir }), budget, runtimeDir,
  });
  await loop.runOnce("tick");
  expect(chat).toHaveBeenCalledTimes(1);                   // patrol only, no decide pass
  expect(chat.mock.calls[0]?.[0]).toBe("patrol");
});

test("in-flight guard: concurrent runOnce calls serialize", async () => {
  const runtimeDir = makeRuntime();
  const order: string[] = [];
  // deterministic "slow LLM": each chat call parks on a gate the test controls.
  // Real timers would only guess at latency; gates make in-flight-ness exact.
  const gates: { promise: Promise<void>; resolve: () => void }[] = [];
  const chat = vi.fn((slot: string) => {
    order.push(`start:${slot}`);
    let open: () => void = () => {};
    const promise = new Promise<void>((r) => { open = r; }); // Node 18: no Promise.withResolvers
    gates.push({ promise, resolve: open });
    return promise.then(() => {
      order.push(`end:${slot}`);
      return { content: '{"action":"none"}', usage: { promptTokens: 10, completionTokens: 2 } };
    });
  });
  const llm = { chat } as unknown as LLMClient;
  const loop = new SchedulerLoop({
    llm, board: new TaskBoard(join(runtimeDir, "board.sqlite")), ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn() } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir }), budget: new BudgetGovernor("burn"), runtimeDir,
  });
  // event-loop turns, not wall-clock sleeps: pending microtasks drain between checks
  const until = async (cond: () => boolean): Promise<void> => {
    while (!cond()) await new Promise((r) => setImmediate(r));
  };
  const first = loop.runOnce("e1");            // parks inside chat #1 (in flight)
  const second = loop.runOnce("e2");           // arrives while cycle 1 is running
  gates[0].resolve();                          // cycle 1 may finish
  await until(() => order.length === 3);       // cycle 2 starts only after cycle 1 ended
  gates[1].resolve();
  await Promise.all([first, second]);
  // cycles must not interleave: the second only starts after the first fully ends
  expect(order).toEqual(["start:patrol", "end:patrol", "start:patrol", "end:patrol"]);
});

// ---- WS resilience: error handling, reconnect backoff, listener re-attach ----

// Real OS sockets cannot be driven by fake timers (ECONNREFUSED arrives via the
// libuv loop), so poll event-loop turns — same convention as the in-flight guard test.
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setImmediate(r));
  }
}

function makeWsLoop(dir: string, extra: Record<string, unknown> = {}): SchedulerLoop {
  const llm = { chat: async () => ({ content: '{"action":"none"}', usage: { promptTokens: 0, completionTokens: 0 } }) } as unknown as LLMClient;
  return new SchedulerLoop({
    llm, board: new TaskBoard(join(dir, "board.sqlite")), ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn() } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"),
    runtimeDir: dir, ...extra,
  });
}

test("ws: unreachable takeoverd never crashes start(); a reconnect is scheduled", async () => {
  const dir = makeRuntime();
  let attempts = 0;
  const loop = makeWsLoop(dir, {
    takeoverUrl: "ws://127.0.0.1:1", // nothing listens on port 1: instant ECONNREFUSED
    reconnectBaseMs: 40,
    wsFactory: (url: string) => { attempts++; return new WebSocket(url); },
  });
  loop.start(60_000); // must neither throw now nor die on the async 'error' event
  await until(() => attempts >= 2); // first attempt refused, then the reconnect timer fired
  expect(attempts).toBeGreaterThanOrEqual(2);
  loop.stop(); // (timer teardown is proven deterministically by the fake-timer test below)
}, 10_000);

// Minimal fake socket: structurally what the loop needs from a WebSocket.
class FakeWs extends EventEmitter {
  readyState = 1; // OPEN
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
}

test("ws: error degrades to CLI, reconnect re-attaches listeners, backoff resets on success, stop cleans up", async () => {
  vi.useFakeTimers();
  try {
    const dir = makeRuntime();
    const sockets: FakeWs[] = [];
    const loop = makeWsLoop(dir, {
      takeoverUrl: "ws://fake.local",
      reconnectBaseMs: 1000,
      wsFactory: () => { const s = new FakeWs(); sockets.push(s); return s as unknown as WsLike; },
    });
    loop.start(60_000);
    expect(sockets.length).toBe(1);

    // 'error' must be handled exactly like 'close': degrade silently, schedule reconnect
    sockets[0].emit("error", new Error("connect ECONNREFUSED 127.0.0.1:7600"));
    sockets[0].emit("close");
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets.length).toBe(1); // base backoff honored: nothing before 1000ms
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets.length).toBe(2); // reconnect attempted after the base delay

    // reconnect "succeeds": listeners must be re-attached — a message must reach push()
    sockets[1].emit("open");
    sockets[1].emit("message", JSON.stringify({ t: "human", text: "hello ceo" }));
    await vi.advanceTimersByTimeAsync(700); // 500ms event debounce + cycle microtasks
    expect(loop.wakeCount()).toBe(1);

    // backoff reset on success: the next failure waits the base delay again, not 2x
    sockets[1].emit("close");
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets.length).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets.length).toBe(3);

    // stop() clears a pending reconnect timer: no socket is ever created afterwards
    sockets[2].emit("close");
    loop.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets.length).toBe(3);
  } finally {
    vi.useRealTimers();
  }
});
