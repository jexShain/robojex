// packages/ceo-core/test/tools/loop-integration.test.ts
// Task 7 wiring: the decide loop's tool_call action, the # BUILTIN TOOLS
// prompt block, chat-driven approval resolution, and the api approve/deny
// shorthand — the whole chain against the real ToolManager over P1_TOOLS.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { SchedulerLoop, type WsLike } from "../../src/loop.js";
import type { LLMClient } from "../../src/llm.js";
import { TaskBoard } from "../../src/board.js";
import { ContextAssembler } from "../../src/context.js";
import type { AgentOrchestrator } from "../../src/orchestrator.js";
import { Auditor } from "../../src/auditor.js";
import { BudgetGovernor } from "../../src/budget.js";
import { ToolManager, P1_TOOLS } from "../../src/tools/manager.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ApiServer } from "../../src/api.js";
import { until } from "../helpers.js";

// minimal takeover socket: enough for the loop's mode_changed handling
class FakeWs extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.emit("close"); }
}

function makeRuntime(): string {
  const dir = mkdtempSync(join(tmpdir(), "rjloopi-"));
  writeFileSync(join(dir, "MISSION.md"), "Keep the demo repo healthy.\n");
  writeFileSync(join(dir, "RUBRIC.md"), "# RUBRIC\n- prefer cheap actions\n");
  writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n");
  return dir;
}

interface Rig {
  loop: SchedulerLoop;
  mgr: ToolManager;
  dir: string;
  events: string[];
  ws: FakeWs | null;
  decideUser: string[]; // user-side content of every decide pass
  patrolUser: string[]; // user-side content of every patrol pass
}

// Full-chain rig: real board/auditor/budget/context assembler + real
// ToolManager over P1_TOOLS; only the LLM and the takeover socket are faked.
function makeRig(decide: unknown, opts: { ws?: boolean } = {}): Rig {
  const dir = makeRuntime();
  const board = new TaskBoard(join(dir, "board.sqlite"));
  const registry = new ToolRegistry();
  for (const e of P1_TOOLS()) registry.register(e);
  const mgr = new ToolManager({
    registry,
    ctx: {
      runtimeDir: dir, board,
      spawn: async () => ({ exitCode: 0, summary: "stub" }),
      skillsDir: dir, takeoverSend: () => {}, chatOut: () => {},
    },
  });
  const decideUser: string[] = [];
  const patrolUser: string[] = [];
  const chat = vi.fn(async (slot: string, msgs: Array<{ role: string; content: string }>) => {
    if (slot === "patrol") {
      if (msgs[1]) patrolUser.push(String(msgs[1].content));
      return { content: '{"action":"act"}', usage: { promptTokens: 1, completionTokens: 1 } };
    }
    if (msgs[1]) decideUser.push(String(msgs[1].content));
    return { content: JSON.stringify(decide), usage: { promptTokens: 1, completionTokens: 1 } };
  });
  const ws = opts.ws ? new FakeWs() : null;
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board, ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(async () => ({ exitCode: 0, summary: "" })), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 1000 }), budget: new BudgetGovernor("burn"),
    runtimeDir: dir, builtinTools: mgr,
    ...(ws ? { takeoverUrl: "ws://fake.local", wsFactory: () => ws as unknown as WsLike } : {}),
  });
  const events: string[] = [];
  const origPush = loop.push.bind(loop);
  loop.push = (e: string) => { events.push(e); origPush(e); };
  return { loop, mgr, dir, events, ws, decideUser, patrolUser };
}

const mode = (rig: Rig, m: "observe" | "assist" | "full"): void => {
  rig.loop.start(60_000); // start() wires the takeover socket handlers
  rig.ws!.emit("message", JSON.stringify({ t: "evt", type: "mode_changed", mode: m }));
};

describe("decide prompt", () => {
  it("carries the # BUILTIN TOOLS block; the patrol pass stays lean", async () => {
    const rig = makeRig({ actions: [] });
    await rig.loop.runOnce("tick");
    expect(rig.decideUser.length).toBeGreaterThan(0);
    const decide = rig.decideUser[0]!;
    expect(decide).toContain("# BUILTIN TOOLS");
    expect(decide).toContain("memory(action:string"); // schema line from P1_TOOLS

    // Patrol pass should not include the BUILTIN TOOLS block (stays lean)
    expect(rig.patrolUser.length).toBeGreaterThan(0);
    const patrol = rig.patrolUser[0]!;
    expect(patrol).not.toContain("# BUILTIN TOOLS");
  });
});

describe("tool_call action", () => {
  it("executes the builtin tool fire-and-forget and back-fills the next wake's event queue", async () => {
    const rig = makeRig({ actions: [{ type: "tool_call", tool: "memory", args: { action: "append", content: "p1 works" } }] }, { ws: true });
    mode(rig, "full");
    expect(rig.loop.mode()).toBe("full");
    await rig.loop.runOnce("boot");
    await until(() => rig.events.some((e) => e.startsWith("tool memory ->")));
    expect(rig.events.some((e) => e.startsWith("tool memory -> remembered: p1 works"))).toBe(true);
    expect(readFileSync(join(rig.dir, "MEMORY.md"), "utf8")).toContain("p1 works"); // the write really landed
    rig.loop.stop();
  });

  it("an unknown tool back-fills the manager's error event instead of crashing the cycle", async () => {
    const rig = makeRig({ actions: [{ type: "tool_call", tool: "nope", args: {} }] });
    await rig.loop.runOnce("boot");
    await until(() => rig.events.some((e) => e.startsWith("tool nope ->")));
    expect(rig.events.some((e) => e.includes("unknown tool") && e.includes("nope"))).toBe(true);
    rig.loop.stop();
  });

  it("assist mode queues non-internal writes (internal memory runs free); resolveToolApproval executes on yes and re-checks the current gate", async () => {
    const tmpA = join(tmpdir(), `rjloopi-${process.pid}-${Date.now()}-a.txt`);
    const tmpB = join(tmpdir(), `rjloopi-${process.pid}-${Date.now()}-b.txt`);
    const rig = makeRig({ actions: [
      { type: "tool_call", tool: "memory", args: { action: "append", content: "fact zero" } }, // internal: no approval round
      { type: "tool_call", tool: "write_file", args: { path: tmpA, content: "fact one" } },    // system write: approval round
      { type: "tool_call", tool: "write_file", args: { path: tmpB, content: "fact two" } },
    ] }, { ws: true });
    mode(rig, "assist");
    await rig.loop.runOnce("boot");
    // internal write executed immediately despite assist's approval queue
    await until(() => rig.events.some((e) => e.startsWith("tool memory -> remembered: fact zero")));
    expect(readFileSync(join(rig.dir, "MEMORY.md"), "utf8")).toContain("fact zero");
    await until(() => rig.events.filter((e) => e.includes("needs-approval")).length >= 2);
    const ids = rig.events
      .map((e) => /needs-approval ([0-9a-f]{8})/.exec(e)?.[1])
      .filter((x): x is string => Boolean(x))
      .slice(0, 2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(rig.mgr.pendingApprovals()).toContain(id);

    const r1 = await rig.loop.resolveToolApproval(ids[0]!, true);
    expect(r1).toMatch(/^wrote \d+ bytes to /);
    expect(readFileSync(tmpA, "utf8")).toBe("fact one");
    expect(rig.events.some((e) => e.startsWith(`tool approval ${ids[0]} approved: wrote `))).toBe(true);

    // a mode drop to observe between queueing and approving must refuse the
    // write even though the human said yes (Task 6 gate re-check semantics)
    rig.ws!.emit("message", JSON.stringify({ t: "evt", type: "mode_changed", mode: "observe" }));
    const r2 = await rig.loop.resolveToolApproval(ids[1]!, true);
    expect(r2).toBe(`denied ${ids[1]}: observe mode re-checked`);
    expect(existsSync(tmpB)).toBe(false);
    rig.loop.stop();
  });
});

describe("effective tool gate (gateForTools)", () => {
  it("no takeover link: observe degrades to assist for tools; a wired link follows modeNow; a dropped link degrades again", () => {
    const bare = makeRig({ actions: [] });
    expect(bare.loop.mode()).toBe("observe");        // desktop-less boot: modeNow stays observe
    expect(bare.loop.gateForTools()).toBe("assist"); // but the tool layer must not freeze

    const rig = makeRig({ actions: [] }, { ws: true });
    rig.loop.start(60_000); // start() wires the takeover socket handlers
    rig.ws!.emit("message", JSON.stringify({ t: "evt", type: "mode_changed", mode: "observe" }));
    expect(rig.loop.gateForTools()).toBe("observe"); // link up: observe guards the desktop
    rig.ws!.emit("message", JSON.stringify({ t: "evt", type: "mode_changed", mode: "full" }));
    expect(rig.loop.gateForTools()).toBe("full");    // raised modes pass through unchanged
    rig.ws!.readyState = 3;                          // link dropped mid-flight
    expect(rig.loop.gateForTools()).toBe("full");
    rig.ws!.emit("message", JSON.stringify({ t: "evt", type: "mode_changed", mode: "observe" }));
    expect(rig.loop.gateForTools()).toBe("assist");  // observe + dead link -> assist again
    rig.loop.stop();
    bare.loop.stop();
  });

  it("desktop-less observe: internal kanban_create runs, non-internal write_file queues for approval instead of executing", async () => {
    const tmpNote = join(tmpdir(), `rjloopi-${process.pid}-${Date.now()}-c.txt`);
    const rig = makeRig({ actions: [
      { type: "tool_call", tool: "kanban_create", args: { title: "ship the demo" } },
      { type: "tool_call", tool: "write_file", args: { path: tmpNote, content: "nope" } },
    ] });
    expect(rig.loop.mode()).toBe("observe"); // no takeover WS wired at all
    await rig.loop.runOnce("boot");
    await until(() => rig.events.some((e) => e.startsWith("tool kanban_create ->")));
    expect(rig.events.some((e) => e.includes("created") && e.includes("ship the demo"))).toBe(true);
    await until(() => rig.events.some((e) => e.includes("needs-approval"))); // effective assist: queued, not executed
    expect(existsSync(tmpNote)).toBe(false);
    rig.loop.stop();
  });
});

describe("POST /api/chat approval shorthand", () => {
  it("approve/deny <id> resolves through the loop instead of queueing as chat; other texts pass through", async () => {
    const dir = makeRuntime();
    const resolveToolApproval = vi.fn(async () => "remembered: approved fact");
    const push = vi.fn();
    const api = new ApiServer({
      port: 0, board: new TaskBoard(join(dir, "board.sqlite")), budget: new BudgetGovernor("burn"),
      runtimeDir: dir, loop: { push, resolveToolApproval },
    });
    await api.start();
    const post = (body: unknown) => fetch(`http://127.0.0.1:${api.port}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

    const ok = await post({ text: "APPROVE a1b2c3d4" }); // case-insensitive verb
    expect(ok.status).toBe(202);
    expect(resolveToolApproval).toHaveBeenCalledWith("a1b2c3d4", true);
    expect(push).not.toHaveBeenCalled(); // never queued as a chat event

    const no = await post({ text: "deny 00112233 please" }); // trailing words still match the 8-hex id
    expect(no.status).toBe(202);
    expect(resolveToolApproval).toHaveBeenLastCalledWith("00112233", false);

    const chat = await post({ text: "hello jex" });
    expect(chat.status).toBe(202);
    expect(push).toHaveBeenCalledWith("chat: hello jex");
    expect(resolveToolApproval).toHaveBeenCalledTimes(2); // plain chat never touches approvals

    const state = await (await fetch(`http://127.0.0.1:${api.port}/api/state`)).json() as { chat: Array<{ from: string; text: string }> };
    expect(state.chat.some((m) => m.from === "system" && m.text === "approval approved: a1b2c3d4")).toBe(true);
    expect(state.chat.some((m) => m.from === "user" && m.text === "hello jex")).toBe(true);
    api.close();
  });

  it("loops without resolveToolApproval keep queuing shorthand texts as ordinary chat", async () => {
    const dir = makeRuntime();
    const push = vi.fn();
    const api = new ApiServer({
      port: 0, board: new TaskBoard(join(dir, "board.sqlite")), budget: new BudgetGovernor("burn"),
      runtimeDir: dir, loop: { push },
    });
    await api.start();
    const res = await fetch(`http://127.0.0.1:${api.port}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "approve aabbccdd" }),
    });
    expect(res.status).toBe(202);
    expect(push).toHaveBeenCalledWith("chat: approve aabbccdd");
    api.close();
  });
});
