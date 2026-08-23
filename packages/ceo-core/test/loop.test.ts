// packages/ceo-core/test/loop.test.ts
import { SchedulerLoop } from "../src/loop.js";
import type { WsLike } from "../src/loop.js";
import { LLMClient } from "../src/llm.js";
import { TaskBoard } from "../src/board.js";
import { ContextAssembler } from "../src/context.js";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { ToolScout } from "../src/toolscout.js";
import { TentacleManager } from "../src/tentacles.js";
import { Auditor } from "../src/auditor.js";
import { BudgetGovernor } from "../src/budget.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

test("triage prompt mandates acting on tool result events (back-fill reaches decide)", async () => {
  const runtimeDir = makeRuntime();
  let patrolSystem = "";
  const chat = vi.fn(async (slot: string, msgs: Array<{ role: string; content: string }>) => {
    if (slot === "patrol") {
      patrolSystem = String(msgs[0].content);
      // a compliant triage model must answer act for tool events per the rule
      return { content: /tool <name> ->/.test(patrolSystem) ? '{"action":"act"}' : '{"action":"none"}', usage: { promptTokens: 10, completionTokens: 2 } };
    }
    return { content: JSON.stringify({ actions: [{ type: "reply", text: "done" }] }), usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const llm = { chat } as unknown as LLMClient;
  const loop = new SchedulerLoop({
    llm, board: new TaskBoard(join(runtimeDir, "board.sqlite")), ctx: new ContextAssembler(),
    orchestrator: new AgentOrchestrator({ llm, runtimeDir, cmds: {} }), auditor: new Auditor({ runtimeDir, reviewEvery: 99 }),
    budget: new BudgetGovernor("burn"), runtimeDir,
  });
  await loop.runOnce("tool read_file -> 1|xzx-PC");
  // the rule text is the contract: without it a patrol model buries tool results
  // and decide never wakes to continue the flow (found in live-model smoke)
  expect(patrolSystem).toContain("'tool <name> -> ...' event");
  // and with the rule, this wake reached the decide layer (reply action ran)
  expect(chat).toHaveBeenCalledWith("decide", expect.anything(), expect.anything());
});
test("end to end: mission -> decide -> spawn -> audit -> rubric evolves (acceptance loop closed by verify)", async () => {
  const runtimeDir = makeRuntime();
  execSync("git init -q", { cwd: runtimeDir });
  execSync("git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: runtimeDir });

  const board = new TaskBoard(join(runtimeDir, "board.sqlite"));
  // scripted fake LLM keyed on content, not call order: patrol acts on tick and
  // verify_due wakes (agent_done wakes cheap-exit); decide spawns once, then
  // verifies the settled card — SPEC-BUTLER §6 keeps unverified settles blocked
  let spawned = false;
  const chat = vi.fn(async (slot: string, msgs: Array<{ role: string; content: string }>) => {
    const user = String(msgs[1]?.content ?? "");
    if (slot === "patrol") {
      // the FIRST tick wakes the decide pass; later ticks cheap-exit (like the
      // original scripted rig) so the ledger below stays deterministic
      const mustAct = (!spawned && /NEW EVENTS SINCE LAST WAKE\ntick/.test(user)) || /NEW EVENTS SINCE LAST WAKE\nverify_due/.test(user);
      return { content: mustAct ? '{"action":"act"}' : '{"action":"none"}', usage: { promptTokens: 10, completionTokens: 2 } };
    }
    if (user.includes("verify_due")) {
      const card = board.list().find((t) => t.title === "stub job")!;
      return { content: JSON.stringify({ actions: [{ type: "verify", task_id: card.id, progress: 100, verdict: "pass", note: "checks green" }] }), usage: { promptTokens: 50, completionTokens: 20 } };
    }
    if (!spawned && user.includes("# TASK BOARD")) {
      spawned = true;
      return { content: JSON.stringify({ actions: [{ type: "spawn", framework: "hermes", title: "stub job", prompt: "run checks" }] }), usage: { promptTokens: 50, completionTokens: 20 } };
    }
    if (user.includes("# CURRENT RUBRIC")) {
      return { content: "RUBRIC PATCH: - verify spawn results before new spawns\nMEMORY PATCH: + stub agent reliable\nMISSION NOTE: none", usage: { promptTokens: 30, completionTokens: 10 } };
    }
    return { content: "stub job finished ok", usage: { promptTokens: 5, completionTokens: 5 } };
  });
  const llm = { chat } as unknown as LLMClient;

  const orchestrator = new AgentOrchestrator({ llm, runtimeDir, cmds: { hermes: "packages/ceo-core/test/fixtures/stub-agent.sh" } });
  const auditor = new Auditor({ runtimeDir, reviewEvery: 1 });
  const budget = new BudgetGovernor("burn");
  const loop = new SchedulerLoop({
    llm, board, ctx: new ContextAssembler(), orchestrator, auditor, budget, runtimeDir,
  });

  await loop.runOnce("tick");       // patrol=act -> decide=spawn (fired in background) -> trace + review#1
  await loop.runOnce("tick");       // patrol=none -> cheap exit; audit due -> review#2 applies patches
  // spawn is backgrounded: the card settles only when the sub-agent exits —
  // with the fallback acceptance line, a clean exit is held blocked
  await until(() => board.list()[0]?.status === "blocked");
  expect(board.list()[0]?.resultSummary).toMatch(/\[awaiting acceptance/);
  await loop.runOnce("verify_due: stub job"); // decide verifies -> verdict pass promotes the card
  await until(() => board.list()[0]?.status === "done");
  loop.stop();                      // cancels the agent_done debounce: no stray cycle may spend tokens

  const tasks = board.list();
  expect(tasks.length).toBe(1);
  expect(tasks[0].status).toBe("done");
  expect(tasks[0].verdict).toBe("pass");
  expect(readFileSync(join(runtimeDir, "RUBRIC.md"), "utf8")).toContain("verify spawn results");
  expect(readFileSync(join(runtimeDir, "MEMORY.md"), "utf8")).toContain("stub agent reliable");
  // full token ledger: run1 = patrol 12 + decide 70 + review#1 40; run2 = patrol 12
  // + review#2 40; run3(verify) = patrol 12 + decide 70 + review#3 40; sub-agent
  // summary 12 booked when the card settles -> 308 total
  expect(budget.line()).toContain("spent 308 tokens");
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
  const orchestrator = { spawn: spawnFn, getRegistry: () => null } as unknown as AgentOrchestrator;
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

test("steer action: intent noted, no kill attempted, cycle completes without errors", async () => {
  const runtimeDir = makeRuntime();
  const board = new TaskBoard(join(runtimeDir, "board.sqlite"));
  const t = board.add({ title: "long-running job", assignee: "hermes" });
  board.update(t.id, { status: "running" });
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return { content: JSON.stringify({ actions: [{ type: "steer", task_id: t.id, correction: "focus on tests first" }] }), usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const llm = { chat } as unknown as LLMClient;
  const spawnFn = vi.fn(async () => { throw new Error("steer must not spawn"); });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const loop = new SchedulerLoop({
      llm, board, ctx: new ContextAssembler(),
      orchestrator: { spawn: spawnFn, getRegistry: () => null } as unknown as AgentOrchestrator,
      auditor: new Auditor({ runtimeDir }), budget: new BudgetGovernor("burn"), runtimeDir,
    });
    await loop.runOnce("tick"); // must complete: steer neither throws nor kills

    expect(err).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("steer noted (kill+respawn deferred)"));
    expect(spawnFn).not.toHaveBeenCalled();
    expect(board.list()[0]?.status).toBe("running"); // card untouched
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
});

test("mission_update snapshots runtime git history before the write", async () => {
  const runtimeDir = makeRuntime();
  execSync("git init -q", { cwd: runtimeDir });
  execSync("git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: runtimeDir });
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return { content: JSON.stringify({ actions: [{ type: "mission_update", text: "# MISSION v2\nship it\n" }] }), usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const llm = { chat } as unknown as LLMClient;
  const loop = new SchedulerLoop({
    llm, board: new TaskBoard(join(runtimeDir, "board.sqlite")), ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir }), budget: new BudgetGovernor("burn"), runtimeDir,
  });
  await loop.runOnce("tick");

  expect(readFileSync(join(runtimeDir, "MISSION.md"), "utf8")).toContain("ship it");
  // exactly one new commit: the pre-edit snapshot
  expect(execSync("git rev-list --count HEAD", { cwd: runtimeDir }).toString().trim()).toBe("2");
  // ordering proven: HEAD still holds the pre-edit mission, the write landed after
  expect(execSync("git show HEAD:MISSION.md", { cwd: runtimeDir }).toString()).toContain("Keep the demo repo healthy");
});

test("patrol-only gate: patrol runs, decide never called", async () => {
  const runtimeDir = makeRuntime();
  const chat = vi.fn(async () => ({ content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } }));
  const llm = { chat } as unknown as LLMClient;
  const budget = new BudgetGovernor("budgeted", 1000);
  budget.spend({ promptTokens: 950, completionTokens: 0 }); // 95%: patrol-only window
  const loop = new SchedulerLoop({
    llm, board: new TaskBoard(join(runtimeDir, "board.sqlite")), ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir }), budget, runtimeDir,
  });
  await loop.runOnce("tick");
  expect(chat).toHaveBeenCalledTimes(1);                   // patrol only, no decide pass
  expect(chat.mock.calls[0]?.[0]).toBe("patrol");
});

test("decide prompt carries the framework manuals; patrol prompt stays lean", async () => {
  const runtimeDir = makeRuntime();
  const users: { slot: string; content: string }[] = [];
  const chat = vi.fn(async (slot: string, msgs: { role: string; content: string }[]) => {
    if (msgs[1]) users.push({ slot, content: String(msgs[1].content) });
    return slot === "patrol"
      ? { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } }
      : { content: '{"actions":[]}', usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const skillsDir = fileURLToPath(new URL("../../../skills/", import.meta.url)); // repo-root skills/
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")),
    ctx: new ContextAssembler(), orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir }), budget: new BudgetGovernor("burn"), runtimeDir, skillsDir,
  });
  await loop.runOnce("tick");

  const decideUser = users.find((u) => u.slot === "decide")!.content;
  expect(decideUser).toContain("# FRAMEWORK MANUALS");
  expect(decideUser).toContain("Hermes Agent");    // hermes.md full text
  expect(decideUser).toContain("Claude Code");     // claude-code.md full text
  // manuals ride only on the expensive decide pass, never on patrol
  expect(users.find((u) => u.slot === "patrol")!.content).not.toContain("FRAMEWORK MANUALS");
});

test("skills dir missing manuals: no manual block in the decide prompt, cycle still runs", async () => {
  const runtimeDir = makeRuntime();
  const users: { slot: string; content: string }[] = [];
  const chat = vi.fn(async (slot: string, msgs: { role: string; content: string }[]) => {
    if (msgs[1]) users.push({ slot, content: String(msgs[1].content) });
    return slot === "patrol"
      ? { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } }
      : { content: '{"actions":[]}', usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")),
    ctx: new ContextAssembler(), orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir }), budget: new BudgetGovernor("burn"),
    runtimeDir, skillsDir: join(runtimeDir, "no-such-skills"),
  });
  await loop.runOnce("tick"); // must not throw on the absent dir
  expect(users.find((u) => u.slot === "decide")!.content).not.toContain("# FRAMEWORK MANUALS");
});

test("spawn is backgrounded: the cycle returns immediately, the card settles later", async () => {
  const runtimeDir = makeRuntime();
  // gated sub-agent: the test decides when "execution" finishes
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const spawnFn = vi.fn(async () => {
    await gate;
    return { exitCode: 0, summary: "all good", logPath: "/dev/null", summaryUsage: null };
  });
  let decides = 0;
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    decides++;
    return {
      content: decides === 1
        ? JSON.stringify({ actions: [{ type: "spawn", framework: "hermes", title: "bg job", prompt: "work" }] })
        : '{"actions":[]}',
      usage: { promptTokens: 50, completionTokens: 20 },
    };
  });
  const board = new TaskBoard(join(runtimeDir, "board.sqlite"));
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board, ctx: new ContextAssembler(),
    orchestrator: { spawn: spawnFn, getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir,
  });

  await loop.runOnce("tick");   // returns even though the sub-agent gate is still closed
  expect(spawnFn).toHaveBeenCalledTimes(1);
  expect(board.list()[0]?.status).toBe("running"); // in flight, not settled
  expect(loop.wakeCount()).toBe(1);
  const second = loop.runOnce("tick"); // next cycle starts without waiting on the sub-agent
  expect(loop.wakeCount()).toBe(2);
  await second;
  expect(board.list().length).toBe(1);  // the second cycle spawned nothing new

  release();                     // sub-agent finishes -> card settles (held for acceptance), completion re-wakes jex
  await until(() => board.list()[0]?.status === "blocked");
  // SPEC-BUTLER §6: the spawn carried no accept, so the fallback acceptance
  // line holds the clean exit blocked until a verify lands
  expect(board.list()[0]?.resultSummary).toMatch(/^all good \[awaiting acceptance/);
  await until(() => loop.wakeCount() === 3); // agent_done event drove one more cycle
  loop.stop();
}, 10_000);

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
    orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
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

test("ws: cdp_result events are mapped to a push event", async () => {
  const dir = makeRuntime();
  const sockets: FakeWs[] = [];
  const loop = makeWsLoop(dir, {
    takeoverUrl: "ws://fake.local",
    wsFactory: () => { const s = new FakeWs(); sockets.push(s); return s as unknown as WsLike; },
  });
  loop.start(60_000);
  sockets[0].emit("message", JSON.stringify({ t: "evt", type: "cdp_result", op: "cdp_snapshot", result: "page text" }));
  await until(() => loop.wakeCount() === 1); // debounce + cycle driven by the cdp event
  loop.stop();
}, 10_000);

test("ws: screen_diff events include ocrText when available", async () => {
  const dir = makeRuntime();
  const sockets: FakeWs[] = [];
  const loop = makeWsLoop(dir, {
    takeoverUrl: "ws://fake.local",
    wsFactory: () => { const s = new FakeWs(); sockets.push(s); return s as unknown as WsLike; },
  });
  loop.start(60_000);
  sockets[0].emit("message", JSON.stringify({ t: "evt", type: "screen_diff", hamming: 42, ocrText: "hello world" }));
  await until(() => loop.wakeCount() === 1);
  loop.stop();
}, 10_000);




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
    orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
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
    wsFactory: (_url: string) => {
      attempts++;
      // Simulate ECONNREFUSED via FakeWs instead of real TCP:
      // port 1 may not fail instantly on all environments (e.g. WSL2).
      const s = new FakeWs();
      s.readyState = 3; // CLOSED
      setImmediate(() => { s.emit("error", new Error("connect ECONNREFUSED")); s.emit("close"); });
      return s as unknown as WsLike;
    },
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
}, 15_000); // the steps are fake-timer driven; the wall budget only absorbs
            // worker starvation when the whole suite runs in parallel

test("ws: cdp action from decide signals the socket; drop is logged when the link is down", async () => {
  const dir = makeRuntime();
  const sockets: FakeWs[] = [];
  const systems: { slot: string; content: string }[] = [];
  const chat = vi.fn(async (slot: string, msgs: { role: string; content: string }[]) => {
    if (msgs[0]) systems.push({ slot, content: String(msgs[0].content) });
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return { content: JSON.stringify({ actions: [{ type: "cdp", op: "cdp_open", url: "https://example.com" }] }), usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(dir, "board.sqlite")), ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"),
    runtimeDir: dir, takeoverUrl: "ws://fake.local",
    wsFactory: () => { const s = new FakeWs(); sockets.push(s); return s as unknown as WsLike; },
  });
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    loop.start(60_000);
    sockets[0].emit("open");
    sockets[0].emit("message", JSON.stringify({ t: "human", text: "browse" }));
    await until(() => sockets[0].sent.length === 1);
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ t: "ctrl", op: "cdp_open", url: "https://example.com" });

    // link down: the same decision again — logged and dropped, never sent
    sockets[0].readyState = 3;
    sockets[0].emit("message", JSON.stringify({ t: "human", text: "browse again" }));
    await until(() => err.mock.calls.some((c) => String(c[0]).includes("cdp action dropped")));
    expect(sockets[0].sent.length).toBe(1);

    // the decide system prompt advertises the new action type
    expect(systems.find((s) => s.slot === "decide")!.content).toContain("cdp_open");
  } finally {
    err.mockRestore();
    loop.stop();
  }
}, 10_000);

test("spawn settlement handlers that themselves throw stay contained: one log line, no unhandled rejection", async () => {
  const runtimeDir = makeRuntime();
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return { content: JSON.stringify({ actions: [{ type: "spawn", framework: "hermes", title: "doomed job", prompt: "work" }] }), usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const spawnFn = vi.fn(async () => { throw new Error("spawn boom"); });
  const board = new TaskBoard(join(runtimeDir, "board.sqlite"));
  const realUpdate = board.update.bind(board);
  let updates = 0;
  // update #2 is the settlement write: make the store blow up inside the
  // catch handler itself — its throw must not pierce the process
  board.update = (id, patch) => { if (++updates === 2) throw new Error("sqlite locked"); realUpdate(id, patch); };
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const loop = new SchedulerLoop({
      llm: { chat } as unknown as LLMClient, board, ctx: new ContextAssembler(),
      orchestrator: { spawn: spawnFn, getRegistry: () => null } as unknown as AgentOrchestrator,
      auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir,
    });
    await loop.runOnce("tick"); // fires the background settlement chain
    await until(() => err.mock.calls.some((c) => String(c[0]).includes("spawn handler crashed")));
  } finally {
    err.mockRestore();
  }
}, 10_000);


// ---- ToolScout wiring: tools block in decide, background scan, manual attachment ----

test("decide prompt carries the AVAILABLE TOOLS block at the tail; patrol stays lean", async () => {
  const runtimeDir = makeRuntime();
  const users: { slot: string; content: string }[] = [];
  const chat = vi.fn(async (slot: string, msgs: { role: string; content: string }[]) => {
    if (msgs[1]) users.push({ slot, content: String(msgs[1].content) });
    return slot === "patrol"
      ? { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } }
      : { content: '{"actions":[]}', usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")),
    ctx: new ContextAssembler(), orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir }), budget: new BudgetGovernor("burn"), runtimeDir,
    scout: { readToolsBlock: () => "- jq (data) — JSON processor [vjq-1.7] verified 2026-01-01" } as unknown as ToolScout,
  });
  await loop.runOnce("tick");

  const decideUser = users.find((u) => u.slot === "decide")!.content;
  expect(decideUser).toContain("# AVAILABLE TOOLS");
  expect(decideUser).toContain("[vjq-1.7] verified");
  // the tools block rides only on the decide pass, never on patrol
  expect(users.find((u) => u.slot === "patrol")!.content).not.toContain("AVAILABLE TOOLS");
});

test("toolscout action: scout.run fires in the background with the query; reentry suppression lives inside ToolScout", async () => {
  const runtimeDir = makeRuntime();
  // gated scan: the test decides when "verification" finishes
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const run = vi.fn(async () => {
    await gate;
    return { verified: [{ name: "jq", category: "data", version: "jq-1.7" }], manualsGenerated: 1, pendingInstalls: [] };
  });
  const scout = { run, readToolsBlock: () => "", verifiedNames: () => [], readManual: () => null };
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return {
      content: JSON.stringify({ actions: [
        { type: "toolscout", query: "pdf tooling" },
        { type: "toolscout", query: "again" }, // same cycle: both fire; ToolScout's own guard collapses them
      ] }),
      usage: { promptTokens: 50, completionTokens: 20 },
    };
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const loop = new SchedulerLoop({
      llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")),
      ctx: new ContextAssembler(), orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
      auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir,
      scout: scout as unknown as ToolScout,
    });
    await loop.runOnce("tick"); // returns although the scan gate is still closed
    expect(run).toHaveBeenCalledTimes(2);                    // the loop always fires run()
    expect(run).toHaveBeenNthCalledWith(1, "pdf tooling");   // and forwards the query verbatim
    expect(run).toHaveBeenNthCalledWith(2, "again");

    release();
    await until(() => log.mock.calls.some((c) => String(c[0]).includes("toolscout: 1 verified")));
    expect(log).toHaveBeenCalledWith("[ceo] toolscout: 1 verified");
    // scoped assertion: neighbouring tests fire async spawn settlements whose
    // console.error can land in this spy after they end (suite-order pollution);
    // this test only owns the toolscout error surface
    expect(err.mock.calls.filter((c) => String(c[0]).includes("toolscout"))).toEqual([]);
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}, 10_000);

test("spawn prompt: verified tool names in the prompt attach their manuals via word-boundary match", async () => {
  const runtimeDir = makeRuntime();
  // real scout over the runtime dir: TOOLS.md + manuals already on disk
  const scout = new ToolScout({ llm: null, runtimeDir, whichFn: async () => null, spawnFn: async () => ({ code: 0, stdout: "", stderr: "" }) });
  writeFileSync(join(runtimeDir, "TOOLS.md"),
    "- jq (data) — JSON processor [vjq-1.7] verified 2026-01-01\n- curl (network) — fetch URLs [v8.0] verified 2026-01-01\n");
  mkdirSync(join(runtimeDir, "tool-manuals"), { recursive: true });
  writeFileSync(join(runtimeDir, "tool-manuals", "jq.md"), "jq manual: filters JSON streams.");
  writeFileSync(join(runtimeDir, "tool-manuals", "curl.md"), "curl manual.");
  const spawnFn = vi.fn(async () => ({ exitCode: 0, summary: "ok", logPath: "/dev/null", summaryUsage: null }));
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return {
      content: JSON.stringify({ actions: [{ type: "spawn", framework: "hermes", title: "jq job", prompt: "summarize results.json with jq and report" }] }),
      usage: { promptTokens: 50, completionTokens: 20 },
    };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")),
    ctx: new ContextAssembler(), orchestrator: { spawn: spawnFn, getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir, scout,
  });
  await loop.runOnce("tick");

  const sent = spawnFn.mock.calls[0]?.[1] as string; // orchestrator.spawn(fw, prompt)
  expect(sent).toContain("summarize results.json with jq and report"); // original prompt intact
  expect(sent).toContain("# TOOL MANUALS");
  expect(sent).toContain("jq manual: filters JSON streams.");
  expect(sent).not.toContain("curl manual."); // curl is verified but never mentioned in the prompt
});

test("spawn prompt: a tool name inside a larger word does not match (jqx is not jq)", async () => {
  const runtimeDir = makeRuntime();
  const scout = new ToolScout({ llm: null, runtimeDir, whichFn: async () => null, spawnFn: async () => ({ code: 0, stdout: "", stderr: "" }) });
  writeFileSync(join(runtimeDir, "TOOLS.md"), "- jq (data) — JSON processor [vjq-1.7] verified 2026-01-01\n");
  mkdirSync(join(runtimeDir, "tool-manuals"), { recursive: true });
  writeFileSync(join(runtimeDir, "tool-manuals", "jq.md"), "jq manual.");
  const spawnFn = vi.fn(async () => ({ exitCode: 0, summary: "ok", logPath: "/dev/null", summaryUsage: null }));
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return {
      content: JSON.stringify({ actions: [{ type: "spawn", framework: "hermes", title: "jqx job", prompt: "check the jqx config file" }] }),
      usage: { promptTokens: 50, completionTokens: 20 },
    };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")),
    ctx: new ContextAssembler(), orchestrator: { spawn: spawnFn, getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir, scout,
  });
  await loop.runOnce("tick");
  const sent = spawnFn.mock.calls[0]?.[1] as string;

  expect(sent.startsWith("check the jqx config file")).toBe(true); // word boundary held: no manual block (acceptance block may follow)
});

test("spawn prompt: generic words (go/file/http) attach manuals only backticked or line-start; other names keep word-boundary match", async () => {
  const runtimeDir = makeRuntime();
  const scout = new ToolScout({ llm: null, runtimeDir, whichFn: async () => null, spawnFn: async () => ({ code: 0, stdout: "", stderr: "" }) });
  writeFileSync(join(runtimeDir, "TOOLS.md"),
    "- jq (data) — JSON processor [vjq-1.7] verified 2026-01-01\n" +
    "- go (dev) — Go toolchain [vgo1.21] verified 2026-01-01\n" +
    "- make (dev) — build automation [v4.3] verified 2026-01-01\n" +
    "- file (system) — file types [v5] verified 2026-01-01\n" +
    "- http (network) — HTTPie [v3] verified 2026-01-01\n");
  mkdirSync(join(runtimeDir, "tool-manuals"), { recursive: true });
  writeFileSync(join(runtimeDir, "tool-manuals", "jq.md"), "jq manual.");
  writeFileSync(join(runtimeDir, "tool-manuals", "go.md"), "go manual.");
  writeFileSync(join(runtimeDir, "tool-manuals", "make.md"), "make manual.");
  writeFileSync(join(runtimeDir, "tool-manuals", "file.md"), "file manual.");
  writeFileSync(join(runtimeDir, "tool-manuals", "http.md"), "http manual.");
  const spawnFn = vi.fn(async () => ({ exitCode: 0, summary: "ok", logPath: "/dev/null", summaryUsage: null }));
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return {
      content: JSON.stringify({ actions: [
        { type: "spawn", framework: "hermes", title: "prose", prompt: "go check the file at http://x" },
        { type: "spawn", framework: "hermes", title: "backtick jq", prompt: "use `jq` here" },
        { type: "spawn", framework: "hermes", title: "backtick go", prompt: "`go` version" },
        { type: "spawn", framework: "hermes", title: "command list", prompt: "run these steps:\ngo version\nmake it so" },
      ] }),
      usage: { promptTokens: 50, completionTokens: 20 },
    };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")),
    ctx: new ContextAssembler(), orchestrator: { spawn: spawnFn, getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir, scout,
  });
  await loop.runOnce("tick");

  const sent = spawnFn.mock.calls.map((c) => c[1] as string);
  expect(sent).toHaveLength(4);
  expect(sent[0]!.startsWith("go check the file at http://x")).toBe(true); // pure prose names no manual (acceptance block may follow)
  expect(sent[1]).toContain("jq manual.");               // jq is not generic: plain word match
  expect(sent[1]).not.toContain("go manual.");
  expect(sent[2]).toContain("go manual.");               // backticks make the generic name explicit
  expect(sent[2]).not.toContain("jq manual.");
  expect(sent[3]).toContain("go manual.");               // a generic name heading its own line is a command
  expect(sent[3]).toContain("make manual.");
});


// ---- Tentacles wiring: context block, tentacle actions, manual attachment ----

test("decide prompt carries the # TENTACLES block when listBlock is non-empty; patrol stays lean", async () => {
  const runtimeDir = makeRuntime();
  const users: { slot: string; content: string }[] = [];
  const chat = vi.fn(async (slot: string, msgs: { role: string; content: string }[]) => {
    if (msgs[1]) users.push({ slot, content: String(msgs[1].content) });
    return slot === "patrol"
      ? { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } }
      : { content: '{"actions":[]}', usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const tentacles = {
    listBlock: () => "- petstore (rest) — pets api [http:200]",
    list: () => [], manual: () => null, call: vi.fn(), register: vi.fn(),
  } as unknown as TentacleManager;
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")),
    ctx: new ContextAssembler(), orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir }), budget: new BudgetGovernor("burn"), runtimeDir, tentacles,
  });
  await loop.runOnce("tick");

  const decideUser = users.find((u) => u.slot === "decide")!.content;
  expect(decideUser).toContain("# TENTACLES");
  expect(decideUser).toContain("- petstore (rest) — pets api [http:200]");
  expect(users.find((u) => u.slot === "patrol")!.content).not.toContain("TENTACLES");
});

test("tentacle_call action: call fires in the background, result logged and pushed for the next wake; invalid args never reach the manager", async () => {
  const runtimeDir = makeRuntime();
  let release: () => void = () => {};
  const pending = new Promise<void>((r) => { release = r; });
  const call = vi.fn(async () => { await pending; return "big call result"; });
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return {
      content: JSON.stringify({ actions: [
        { type: "tentacle_call", tentacle: "users-api", op: "get-user", args: { id: 7 } },
        { type: "tentacle_call", tentacle: "x" }, // op missing -> invalid, must not reach the manager
      ] }),
      usage: { promptTokens: 50, completionTokens: 20 },
    };
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const tentacles = { call, listBlock: () => "", list: () => [], manual: () => null, register: vi.fn(), reload: vi.fn(async () => 0) } as unknown as TentacleManager;
    const loop = new SchedulerLoop({
      llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")),
      ctx: new ContextAssembler(), orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
      auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir, tentacles,
    });
    const pushes: string[] = [];
    const origPush = loop.push.bind(loop);
    loop.push = (s: string) => { pushes.push(s); origPush(s); }; // observe what the handler queues for the next wake
    const done = loop.runOnce("tick"); // a promise we can await to prove the cycle already returned
    await done; // cycle finished although the tentacle call is still hanging
    expect(call).toHaveBeenCalledTimes(1);                          // only the well-formed action fired
    expect(call).toHaveBeenCalledWith("users-api", "get-user", { id: 7 });
    expect(err.mock.calls.some((c) => String(c[0]).includes("tentacle_call"))).toBe(true); // the invalid one was logged

    release();
    await until(() => log.mock.calls.some((c) => String(c[0]).includes("[ceo] tentacle users-api.get-user -> big call result")));
    expect(pushes.some((s) => s.startsWith("tentacle users-api.get-user -> big call result".slice(0, 20)) && s.length <= "tentacle users-api.get-user -> ".length + 200)).toBe(true);
    loop.stop();
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}, 10_000);

test("tentacle_register action: a valid spec is saved through the manager and logged; the cycle survives a bad spec", async () => {
  const runtimeDir = makeRuntime();
  const register = vi.fn(async (spec: unknown) => {
    const def = spec as { name: string };
    return { def: { ...def, kind: "rest", ops: [], enabled: true, blurb: "" }, probe: { ok: true, status: "http:200" } };
  });
  let decideN = 0;
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    decideN++;
    return decideN === 1
      ? { content: JSON.stringify({ actions: [
          { type: "tentacle_register", spec: { name: "feature-api", kind: "rest", endpoint: "https://ok.example.com", ops: [], enabled: true, blurb: "features" } },
          { type: "tentacle_register", spec: "not-an-object" },
        ] }), usage: { promptTokens: 50, completionTokens: 20 } }
      : { content: '{"actions":[]}', usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const tentacles = { register, reload: vi.fn(async () => 0), listBlock: () => "", list: () => [], manual: () => null, call: vi.fn() } as unknown as TentacleManager;
    const loop = new SchedulerLoop({
      llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")),
      ctx: new ContextAssembler(), orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
      auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir, tentacles,
    });
    await loop.runOnce("tick"); // both actions handled inline: good one saved, bad one logged

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith({ name: "feature-api", kind: "rest", endpoint: "https://ok.example.com", ops: [], enabled: true, blurb: "features" });
    expect(log).toHaveBeenCalledWith("[ceo] tentacle registered: feature-api [http:200]");
    expect(err.mock.calls.some((c) => String(c[0]).includes("tentacle_register"))).toBe(true);
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
});

test("spawn prompt: a tentacle named in the prompt attaches its manual; manuals share the 2400 budget with tool manuals", async () => {
  const runtimeDir = makeRuntime();
  // tool side of the shared budget: jq verified with a near-800-char manual
  const scout = new ToolScout({ llm: null, runtimeDir, whichFn: async () => null, spawnFn: async () => ({ code: 0, stdout: "", stderr: "" }) });
  writeFileSync(join(runtimeDir, "TOOLS.md"), "- jq (data) — JSON processor [vjq-1.7] verified 2026-01-01\n");
  mkdirSync(join(runtimeDir, "tool-manuals"), { recursive: true });
  writeFileSync(join(runtimeDir, "tool-manuals", "jq.md"), `jq manual. ${"p".repeat(780)}`);
  // tentacle side: three tentacles, each with a near-800-char manual
  const tentacles = new TentacleManager({ llm: null, runtimeDir });
  mkdirSync(join(runtimeDir, "tentacles"), { recursive: true });
  const tentNames = ["feature-api", "billing-api", "search-api"];
  for (const n of tentNames) writeFileSync(join(runtimeDir, "tentacles", `${n}.json`), JSON.stringify({ name: n, kind: "rest", endpoint: "https://x.example.com", ops: [], enabled: true, blurb: "" }));
  mkdirSync(join(runtimeDir, "tentacle-manuals"), { recursive: true });
  for (const n of tentNames) writeFileSync(join(runtimeDir, "tentacle-manuals", `${n}.md`), `${n} manual. ${"q".repeat(780)}`);
  await tentacles.loadAll();

  const spawnFn = vi.fn(async () => ({ exitCode: 0, summary: "ok", logPath: "/dev/null", summaryUsage: null }));
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return {
      content: JSON.stringify({ actions: [{ type: "spawn", framework: "hermes", title: "check feature-api", prompt: "query feature-api, billing-api and search-api with jq" }] }),
      usage: { promptTokens: 50, completionTokens: 20 },
    };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")),
    ctx: new ContextAssembler(), orchestrator: { spawn: spawnFn, getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir, scout, tentacles,
  });
  await loop.runOnce("tick");
  const sent = spawnFn.mock.calls[0]?.[1] as string;
  expect(sent).toContain("# TOOL MANUALS");
  expect(sent).toContain("jq manual.");
  expect(sent).toContain("billing-api manual."); // first tentacle in load order fits the shared budget
  // jq (806) + billing-api (813) leave ~780 chars: neither remaining manual fits,
  // so exactly one tentacle manual rides along
  expect((sent.match(/^## /gm) ?? []).length).toBe(2);
  expect(sent).not.toContain("search-api manual.");
});

test("tentacle_register action: openapiContent imports a rest tentacle; specs written by spawned agents hot-load via reload", async () => {
  const runtimeDir = makeRuntime();
  // a sub-agent's spec file, present on disk but not loaded: the reload()
  // after the register action must pick it up
  mkdirSync(join(runtimeDir, "tentacles"), { recursive: true });
  writeFileSync(join(runtimeDir, "tentacles", "agent-api.json"), JSON.stringify({ name: "agent-api", kind: "rest", endpoint: "https://agent.example.com", ops: [], enabled: true, blurb: "written by a sub-agent" }));
  const doc = JSON.stringify({
    openapi: "3.0.0", info: { title: "Pets" }, servers: [{ url: "https://pets.example.com" }],
    paths: { "/pets": { get: { summary: "List pets" } } },
  });
  const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
  const tentacles = new TentacleManager({ llm: null, runtimeDir, fetchImpl: fetchImpl as unknown as typeof fetch });
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return {
      content: JSON.stringify({ actions: [{ type: "tentacle_register", spec: { name: "pets", openapiContent: doc } }] }),
      usage: { promptTokens: 50, completionTokens: 20 },
    };
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const loop = new SchedulerLoop({
      llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")),
      ctx: new ContextAssembler(), orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
      auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir, tentacles,
    });
    await loop.runOnce("tick");
    expect(tentacles.list().map((t) => t.name).sort()).toEqual(["agent-api", "pets"]); // imported + hot-loaded
    expect(existsSync(join(runtimeDir, "tentacles", "pets.json"))).toBe(true);
    expect(log).toHaveBeenCalledWith("[ceo] tentacle registered: pets [http:200]");
  } finally {
    log.mockRestore();
  }
});

test("spawn prompt: a tentacle named like a generic word (go) attaches its manual only backticked or line-start", async () => {
  const runtimeDir = makeRuntime();
  const tentacles = new TentacleManager({ llm: null, runtimeDir });
  mkdirSync(join(runtimeDir, "tentacles"), { recursive: true });
  writeFileSync(join(runtimeDir, "tentacles", "go.json"), JSON.stringify({ name: "go", kind: "rest", endpoint: "https://x.example.com", ops: [], enabled: true, blurb: "" }));
  mkdirSync(join(runtimeDir, "tentacle-manuals"), { recursive: true });
  writeFileSync(join(runtimeDir, "tentacle-manuals", "go.md"), "go connector manual.");
  await tentacles.loadAll();

  const spawnFn = vi.fn(async () => ({ exitCode: 0, summary: "ok", logPath: "/dev/null", summaryUsage: null }));
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    const first = spawnFn.mock.calls.length === 0; // cycle 1: prose, cycle 2: backticked
    return {
      content: JSON.stringify({ actions: [{ type: "spawn", framework: "hermes", title: "t", prompt: first ? "go check the weather" : "call `go` now" }] }),
      usage: { promptTokens: 50, completionTokens: 20 },
    };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")),
    ctx: new ContextAssembler(), orchestrator: { spawn: spawnFn, getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir, tentacles,
  });
  await loop.runOnce("tick");
  await loop.runOnce("tick");
  const prose = spawnFn.mock.calls[0]![1] as string;
  const backticked = spawnFn.mock.calls[1]![1] as string;
  expect(prose).not.toContain("# TOOL MANUALS"); // everyday English: not a tentacle reference
  expect(backticked).toContain("# TOOL MANUALS");
  expect(backticked).toContain("go connector manual.");
});

test("spawn parent/schedule parsing: valid fields reach the board; bad ISO or unknown parent is dropped with one warn, spawn continues", async () => {
  const runtimeDir = makeRuntime();
  const board = new TaskBoard(join(runtimeDir, "board.sqlite"));
  const epic = board.add({ title: "epic" });
  const spawnFn = vi.fn(async () => ({ exitCode: 0, summary: "ok", logPath: "/dev/null", summaryUsage: null }));
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return {
      content: JSON.stringify({ actions: [
        { type: "spawn", framework: "hermes", title: "good", prompt: "p", parent: epic.id, scheduledAt: "2026-08-21T09:30:00Z", dueAt: "2026-08-21T12:00:00Z" },
        { type: "spawn", framework: "hermes", title: "bad time", prompt: "p", scheduledAt: "not-a-date" },
        { type: "spawn", framework: "hermes", title: "bad parent", prompt: "p", parent: "no-such-task" },
      ] }),
      usage: { promptTokens: 50, completionTokens: 20 },
    };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board, ctx: new ContextAssembler(),
    orchestrator: { spawn: spawnFn, getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir,
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const startMs = Date.now();
    await loop.runOnce("tick");
    await until(() => board.list().length === 4); // epic + three spawned cards
    loop.stop();

    const byTitle = Object.fromEntries(board.list().map((t) => [t.title, t]));
    expect(byTitle.good).toMatchObject({ parentId: epic.id, scheduledAt: Date.parse("2026-08-21T09:30:00Z"), dueAt: Date.parse("2026-08-21T12:00:00Z") }); // Z-suffixed parses as UTC (Z is never stripped)
    expect(byTitle["bad time"].scheduledAt).toBe(null);   // unparseable time: dropped, spawn alive
    expect(byTitle["bad parent"].parentId).toBe(null);    // unknown parent: dropped, spawn alive
    // parse problems never block the action: the settle (if it landed) says
    // "awaiting acceptance", never "invalid spawn action"
    for (const t of [byTitle["bad time"], byTitle["bad parent"]]) {
      expect(t.resultSummary).not.toContain("invalid spawn");
      expect(t.acceptance.length).toBeGreaterThan(0); // SPEC-BUTLER §6 fallback line applied
    }
    // the good spawn's scheduledAt may sit in the future or past depending on
    // the test machine's timezone: future defers to the gantt pump (stays
    // todo, only 2 immediate launches), past launches now (3)
    const goodFuture = Date.parse("2026-08-21T09:30:00Z") > startMs;
    expect(spawnFn).toHaveBeenCalledTimes(goodFuture ? 2 : 3);
    if (goodFuture) expect(byTitle.good.status).toBe("todo");
    expect(warn).toHaveBeenCalledTimes(2);                 // exactly one line per dropped field
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/scheduledAt[\s\S]*parent/);
  } finally {
    warn.mockRestore();
  }
}, 10_000);

test("decide system prompt documents the optional spawn parent/scheduledAt/dueAt fields", async () => {
  const runtimeDir = makeRuntime();
  const prompts: { role: string; content: string }[] = [];
  const chat = vi.fn(async (slot: string, msgs?: { role: string; content: string }[]) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    prompts.push(...(msgs ?? []));
    return { content: '{"actions":[]}', usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")),
    ctx: new ContextAssembler(), orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir,
  });
  await loop.runOnce("tick");
  const system = prompts[0]?.content ?? "";
  expect(system).toContain('"parent"');
  expect(system).toContain('"scheduledAt"');
  expect(system).toContain('"dueAt"');
  expect(system).toContain("ISO 8601");
});

// ---- SPEC-BUTLER: reflect action, AGENTS.md injection, boot/delegation doctrine ----

test("reflect action appends a timestamped entry to MEMORY.md and pushes a reflected: event", async () => {
  const runtimeDir = makeRuntime();
  const events: string[] = [];
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return { content: JSON.stringify({ actions: [{ type: "reflect", text: "今日教训：派活前先看 AGENTS 清单，别把浏览器任务派给纯编码代理。" }] }), usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")), ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir,
  });
  const origPush = loop.push.bind(loop);
  loop.push = (e: string) => { events.push(e); origPush(e); };
  await loop.runOnce("tick");
  const memory = readFileSync(join(runtimeDir, "MEMORY.md"), "utf8");
  expect(memory).toMatch(/\n## \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n今日教训：派活前先看 AGENTS 清单，别把浏览器任务派给纯编码代理。\n$/);
  expect(memory.startsWith("# MEMORY\n")).toBe(true); // seed header intact
  expect(events.some((e) => e.startsWith("reflected: 今日教训"))).toBe(true);
  loop.stop();
});

test("reflect action: missing file is created with the header; invalid texts error but never kill the cycle", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "robojex-reflect2-"));
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const chat = vi.fn(async (slot: string) => {
      if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
      return { content: JSON.stringify({ actions: [
        { type: "reflect", text: "ok entry" },
        { type: "reflect", text: "" },            // empty: invalid
        { type: "reflect", text: "x".repeat(5000) }, // over 4KB: invalid
      ] }), usage: { promptTokens: 50, completionTokens: 20 } };
    });
    const loop = new SchedulerLoop({
      llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")), ctx: new ContextAssembler(),
      orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
      auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir,
    });
    await loop.runOnce("tick"); // no MEMORY.md existed: reflect creates it with the header
    const memory = readFileSync(join(runtimeDir, "MEMORY.md"), "utf8");
    expect(memory).toContain("# MEMORY");
    expect(memory).toContain("ok entry");
    expect(memory).not.toContain("xxxx");
    expect(err.mock.calls.filter((c) => String(c[0]).includes("reflect"))).toHaveLength(2); // both invalids logged, cycle lived
    loop.stop();
  } finally { err.mockRestore(); }
});

test("decide prompt carries the AGENTS.md inventory block; patrol stays lean; blank/missing injects nothing", async () => {
  const runtimeDir = makeRuntime();
  writeFileSync(join(runtimeDir, "AGENTS.md"), "claude-code — coding agent [verified]\ngoose — extensible agent [verified]\n");
  const users: { slot: string; content: string }[] = [];
  const chat = vi.fn(async (slot: string, msgs: { role: string; content: string }[]) => {
    if (msgs[1]) users.push({ slot, content: String(msgs[1].content) });
    return slot === "patrol"
      ? { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } }
      : { content: '{"actions":[]}', usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")), ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir,
  });
  await loop.runOnce("tick");
  const decide = users.find((u) => u.slot === "decide")!.content;
  expect(decide).toContain("# AGENTS (verified on this system)");
  expect(decide).toContain("claude-code — coding agent [verified]");
  expect(users.find((u) => u.slot === "patrol")!.content).not.toContain("# AGENTS");

  // blank inventory reads as absent: no empty AGENTS tail is ever served
  writeFileSync(join(runtimeDir, "AGENTS.md"), "\n");
  users.length = 0;
  // an agents_rescan wake (not a pure tick — those quiet-skip on an
  // unchanged idle board since R72) re-reads the now-blank inventory
  await loop.runOnce("agents_rescan: inventory may be stale");
  expect(users.find((u) => u.slot === "decide")!.content).not.toContain("# AGENTS (verified");
  loop.stop();
});

test("R75: a reflect identical to the latest MEMORY entry is refused (no duplicate lessons)", async () => {
  const runtimeDir = makeRuntime();
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const events: string[] = [];
  try {
    const chat = vi.fn(async (slot: string) => {
      if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
      return { content: JSON.stringify({ actions: [{ type: "reflect", text: "深夜稳定时不要空转，这是同一课。" }] }), usage: { promptTokens: 50, completionTokens: 20 } };
    });
    const loop = new SchedulerLoop({
      llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")), ctx: new ContextAssembler(),
      orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
      auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir,
    });
    const origPush = loop.push.bind(loop);
    loop.push = (e: string) => { events.push(e); origPush(e); };
    await loop.runOnce("tick"); // banks the lesson
    await loop.runOnce("agents_rescan: wake"); // same lesson again → refused
    const memory = readFileSync(join(runtimeDir, "MEMORY.md"), "utf8");
    expect(memory.match(/深夜稳定时不要空转/g)).toHaveLength(1); // banked exactly once
    expect(events.some((e) => e.includes("action failed") && e.includes("already the latest MEMORY entry"))).toBe(true);
    loop.stop();
  } finally { err.mockRestore(); }
});

test("R81 reschedule action moves a card's clock, re-arms the pump, and survives bad input", async () => {
  const runtimeDir = makeRuntime();
  const chats: string[] = [];
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return { content: JSON.stringify({ actions: [
      { type: "reschedule", task_id: "喝水", scheduledAt: "2026-08-24T10:00:00", dueAt: "2026-08-24T20:00:00" },
      { type: "reschedule", task_id: "no-such-card", scheduledAt: "2026-08-24T10:00:00" }, // invalid: unknown card
      { type: "reschedule", task_id: "喝水" }, // invalid: no timestamps
    ] }), usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: new TaskBoard(join(runtimeDir, "board.sqlite")), ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"), runtimeDir,
  });
  loop.setOutlet({ chatOut: (_f, text) => chats.push(text), frame: () => {}, hud: () => {} } as never);
  const board = (loop as unknown as { d: { board: TaskBoard } }).d.board;
  const t = board.add({ title: "提醒我喝水", assignee: "hermes", scheduledAt: Date.now() + 86_400_000, acceptance: "done" });
  await loop.runOnce("chat: 把提醒喝水改到明天上午10点");
  const card = board.list().find((x) => x.id === t.id)!;
  expect(card.scheduledAt).toBe(Date.parse("2026-08-24T10:00:00")); // moved exactly as parsed
  expect(card.dueAt).toBe(Date.parse("2026-08-24T20:00:00"));       // due moved too
  expect(chats.some((c) => c.includes("已改期") && c.includes("提醒我喝水"))).toBe(true);
  // the two invalid actions logged failures but the cycle lived
  loop.stop();
});
