// packages/ceo-core/test/api.test.ts
// Covers the operator-facing HTTP+WS api: state snapshot, chat in (POST and
// WS frame), jex reply out, mode proxy over the takeover link, mission
// append, board/cycle frames, static serving, and index.ts assembly.
import { ApiServer } from "../src/api.js";
import { SchedulerLoop, type WsLike } from "../src/loop.js";
import { TaskBoard } from "../src/board.js";
import { ContextAssembler } from "../src/context.js";
import { BudgetGovernor } from "../src/budget.js";
import { Auditor } from "../src/auditor.js";
import { LLMClient } from "../src/llm.js";
import type { AgentOrchestrator } from "../src/orchestrator.js";
import { seedRuntimeFiles, assembleAndStart } from "../src/index.js";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get as httpGet } from "node:http";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { expect, test, vi, afterEach, type Mock } from "vitest";

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setImmediate(r));
  }
}

// The frames /api/events emits, as the tests read them: every field optional
// because each frame type only carries its own subset.
interface Frame {
  t: string; from?: unknown; text?: unknown; ts?: unknown; state?: unknown;
  wake?: unknown; cost?: unknown; actions?: unknown[]; tasks?: unknown[]; mode?: unknown; line?: unknown;
}

// The GET /api/state payload as the tests read it (loose: all fields optional).
interface StateFrame {
  tasks?: { title?: string; status?: string; resultSummary?: string; createdAt?: number }[];
  budget?: Record<string, unknown>;
  mode?: string;
  mission?: string; rubric?: string; memory?: string;
  chat?: unknown[];
  version?: string;
}

const servers: ApiServer[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

function makeRuntime(): string {
  const dir = mkdtempSync(join(tmpdir(), "robojex-api-"));
  seedRuntimeFiles(dir);
  return dir;
}

interface Rig { runtimeDir: string; board: TaskBoard; budget: BudgetGovernor; }
function mkRig(budget: { mode?: "burn" | "budgeted"; dailyTokens?: number } = {}): Rig {
  const runtimeDir = makeRuntime();
  return {
    runtimeDir,
    board: new TaskBoard(join(runtimeDir, "board.sqlite")),
    budget: new BudgetGovernor(budget.mode ?? "burn", budget.dailyTokens ?? 0),
  };
}

// ApiServer on an ephemeral port; every instance is closed in afterEach.
function makeApi(rig: Rig, loop: { push: (e: string) => void; sendCtrl?: (f: Record<string, unknown>) => boolean; mode?: () => string }, extra: { webDir?: string } = {}): ApiServer {
  const api = new ApiServer({
    port: 0, board: rig.board, budget: rig.budget, runtimeDir: rig.runtimeDir, loop,
    ...(extra.webDir ? { webDir: extra.webDir } : {}),
  });
  servers.push(api);
  return api;
}

// The scripted-LLM seam: patrol decides act/none per wake, decide returns one action set.
type FakeLlm = (slot: string, msgs?: { role: string; content: string }[]) => Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } }>;
function fakeLlmChat(impl: FakeLlm): Mock {
  return vi.fn(async (slot: string, msgs?: { role: string; content: string }[]) => impl(slot, msgs));
}

// WS client that records every parsed frame from /api/events.
function wsCollect(api: ApiServer) {
  const frames: Frame[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${api.port}/api/events`);
  ws.on("message", (raw: unknown) => { try { frames.push(JSON.parse(String(raw)) as Frame); } catch { /* ignore malformed */ } });
  const { promise: opened, resolve, reject } = Promise.withResolvers<void>();
  ws.once("open", () => resolve());
  ws.once("error", reject);
  return { frames, opened, ws };
}

const post = (api: ApiServer, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${api.port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("GET /api/state: tasks, budget snapshot, mode, three docs, chat ring, version", async () => {
  const rig = mkRig({ mode: "budgeted", dailyTokens: 1000 });
  const t = rig.board.add({ title: "watch site", assignee: "hermes" });
  rig.board.update(t.id, { status: "done", resultSummary: "no change 3d" });
  const api = makeApi(rig, { push: vi.fn() });
  await api.start();

  const res = await fetch(`http://127.0.0.1:${api.port}/api/state`);
  expect(res.status).toBe(200);
  const s = (await res.json()) as StateFrame;
  expect(s.tasks).toHaveLength(1);
  expect(s.tasks![0]).toMatchObject({ title: "watch site", status: "done", resultSummary: "no change 3d" });
  expect(typeof s.tasks![0]!.createdAt).toBe("number");
  expect(s.budget).toMatchObject({ mode: "budgeted", dailyTokens: 1000, spentToday: 0 });
  expect(String(s.budget?.line)).toContain("0/1000");
  expect(s.mode).toBe("observe");
  expect(s.mission).toContain("# MISSION");
  expect(s.rubric).toContain("# RUBRIC");
  expect(s.memory).toContain("# MEMORY");
  expect(s.chat).toEqual([]);
  expect(typeof s.version).toBe("string");
  expect(s.version!.length).toBeGreaterThan(0);
});

test("POST /api/chat: 202, enqueues 'chat: <text>', broadcasts chat_out(user); WS {t:'chat'} frame is equivalent; bad input 400", async () => {
  const rig = mkRig();
  const loop = { push: vi.fn() };
  const api = makeApi(rig, loop);
  await api.start();
  const c = wsCollect(api);
  await c.opened;
  await until(() => c.frames.some((f) => f.t === "hello"));
  expect(c.frames.find((f) => f.t === "hello")!.state).toMatchObject({ mode: "observe", tasks: [] });

  const res = await post(api, "/api/chat", { text: "hello jex" });
  expect(res.status).toBe(202);
  expect(loop.push).toHaveBeenCalledWith("chat: hello jex");
  await until(() => c.frames.some((f) => f.t === "chat_out" && f.from === "user"));
  const out = c.frames.find((f) => f.t === "chat_out" && f.from === "user")!;
  expect(out.text).toBe("hello jex");
  expect(typeof out.ts).toBe("number");

  // client→server chat frame ≡ POST /api/chat
  c.ws.send(JSON.stringify({ t: "chat", text: "via ws" }));
  await until(() => c.frames.some((f) => f.t === "chat_out" && f.text === "via ws"));
  expect(loop.push).toHaveBeenCalledWith("chat: via ws");

  for (const bad of [{}, { text: "   " }, { text: "x".repeat(16 * 1024 + 1) }, "not an object"]) {
    const r = await post(api, "/api/chat", bad);
    expect(r.status).toBe(400);
  }
  const ok16k = await post(api, "/api/chat", { text: "x".repeat(16 * 1024) }); // exactly 16KB passes
  expect(ok16k.status).toBe(202);

  const s = (await (await fetch(`http://127.0.0.1:${api.port}/api/state`)).json()) as StateFrame;
  expect(s.chat).toEqual([
    { from: "user", ts: expect.any(Number), text: "hello jex" },
    { from: "user", ts: expect.any(Number), text: "via ws" },
    { from: "user", ts: expect.any(Number), text: "x".repeat(16 * 1024) },
  ]);
});

test("chat ring holds the most recent 100 messages only", async () => {
  const rig = mkRig();
  const api = makeApi(rig, { push: vi.fn() });
  await api.start();
  for (let i = 0; i < 105; i++) api.chatOut("jex", `m${i}`);
  const s = (await (await fetch(`http://127.0.0.1:${api.port}/api/state`)).json()) as StateFrame;
  expect(s.chat).toHaveLength(100);
  expect(s.chat![0]).toMatchObject({ text: "m5" });   // oldest dropped
  expect(s.chat![99]).toMatchObject({ text: "m104" });
});

test("decide reply action: chat_out(from jex) broadcast + recorded, no spawn, no board card, counted in the cycle frame; patrol prompt says human chat always acts", async () => {
  const rig = mkRig();
  const chat = fakeLlmChat(async (slot) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return { content: JSON.stringify({ actions: [{ type: "reply", text: "on it — checking now" }] }), usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const spawn = vi.fn();
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: rig.board, ctx: new ContextAssembler(),
    orchestrator: { spawn } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: rig.runtimeDir, reviewEvery: 1000 }), budget: rig.budget, runtimeDir: rig.runtimeDir,
  });
  const api = makeApi(rig, loop);
  loop.setOutlet(api);
  await api.start();
  const c = wsCollect(api);
  await c.opened;

  await loop.runOnce("chat: status?");

  await until(() => c.frames.some((f) => f.t === "chat_out" && f.from === "jex"));
  expect(c.frames.find((f) => f.t === "chat_out" && f.from === "jex")!.text).toBe("on it — checking now");
  const cycle = c.frames.find((f) => f.t === "cycle")!;
  expect(cycle.wake).toBe(1);
  expect(cycle.cost).toBe(82); // patrol 12 + decide 70
  expect(cycle.actions).toEqual([{ type: "reply", text: "on it — checking now" }]);
  await until(() => c.frames.some((f) => f.t === "budget")); // budget frame follows every cycle
  expect(String(c.frames.find((f) => f.t === "budget")!.line)).toContain("82");
  expect(spawn).not.toHaveBeenCalled();   // reply spawns nothing
  expect(rig.board.list()).toEqual([]);   // and takes no board card
  const s = (await (await fetch(`http://127.0.0.1:${api.port}/api/state`)).json()) as StateFrame;
  expect(s.chat).toHaveLength(1);
  expect(s.chat![0]).toMatchObject({ from: "jex", text: "on it — checking now" });
  // the patrol system prompt must tell the triager that human chat always acts
  const patrol = chat.mock.calls.find((cx) => cx[0] === "patrol")!;
  const patrolSys = patrol[1]![0]!.content;
  expect(patrolSys.toLowerCase()).toContain("chat");
  expect(patrolSys.toLowerCase()).toContain("always");
});

test("invalid reply action (empty text): logged, cycle still completes and broadcasts, nothing leaves as jex", async () => {
  const rig = mkRig();
  const chat = fakeLlmChat(async (slot) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return { content: JSON.stringify({ actions: [{ type: "reply", text: "" }] }), usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: rig.board, ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn() } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: rig.runtimeDir, reviewEvery: 1000 }), budget: rig.budget, runtimeDir: rig.runtimeDir,
  });
  const api = makeApi(rig, loop);
  loop.setOutlet(api);
  await api.start();
  const c = wsCollect(api);
  await c.opened;
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await loop.runOnce("chat: hi");
    await until(() => c.frames.some((f) => f.t === "cycle"));
    expect(err.mock.calls.some((e) => String(e[0]).includes("invalid reply action"))).toBe(true);
    expect(c.frames.some((f) => f.t === "chat_out" && f.from === "jex")).toBe(false);
  } finally {
    err.mockRestore();
  }
});

test("cycle frame fires every decision cycle (even patrol-none); tasks frames follow board changes through settlement", async () => {
  const rig = mkRig();
  let wake = 0, decideN = 0;
  const chat = fakeLlmChat(async (slot) => {
    if (slot === "patrol") {
      wake++;
      return { content: wake === 1 ? '{"action":"none"}' : '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    }
    decideN++;
    return decideN === 1
      ? { content: JSON.stringify({ actions: [{ type: "spawn", framework: "hermes", title: "stub job", prompt: "run checks" }] }), usage: { promptTokens: 50, completionTokens: 20 } }
      : { content: '{"actions":[]}', usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const spawn = vi.fn(async () => ({ exitCode: 0, summary: "all good", logPath: "/dev/null", summaryUsage: null }));
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: rig.board, ctx: new ContextAssembler(),
    orchestrator: { spawn } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: rig.runtimeDir, reviewEvery: 1000 }), budget: rig.budget, runtimeDir: rig.runtimeDir,
  });
  const api = makeApi(rig, loop);
  loop.setOutlet(api);
  await api.start();
  const c = wsCollect(api);
  await c.opened;

  await loop.runOnce("tick"); // patrol says none: cheap exit, still one cycle frame
  await until(() => c.frames.some((f) => f.t === "cycle"));
  const first = c.frames.find((f) => f.t === "cycle")!;
  expect(first.actions).toEqual([]);
  expect(first.cost).toBe(12); // patrol only

  await loop.runOnce("tick"); // decide spawns; the card settles in the background
  await until(() => rig.board.list()[0]?.status === "done");
  await until(() => {
    const tf = c.frames.filter((f) => f.t === "tasks");
    return tf.length > 0 && Array.isArray(tf[tf.length - 1]!.tasks) && (tf[tf.length - 1]!.tasks![0] as { status?: string }).status === "done";
  });
  const cycles = c.frames.filter((f) => f.t === "cycle");
  expect(cycles.length).toBeGreaterThanOrEqual(2);
  expect(cycles[1]!.actions).toHaveLength(1);
  const tasksFrames = c.frames.filter((f) => f.t === "tasks");
  expect(tasksFrames.length).toBeGreaterThanOrEqual(2); // created/running + settled done
  expect(tasksFrames[tasksFrames.length - 1]!.tasks![0]).toMatchObject({ title: "stub job", status: "done", resultSummary: "all good" });
  loop.stop(); // cancels the agent_done debounce before it spends tokens
});

test("POST /api/mode: valid mode forwards ctrl/set_mode (202); invalid 400; takeover link down 503", async () => {
  const rig = mkRig();
  const sendCtrl = vi.fn(() => true);
  const api = makeApi(rig, { push: vi.fn(), sendCtrl });
  await api.start();

  const ok = await post(api, "/api/mode", { mode: "assist" });
  expect(ok.status).toBe(202);
  expect(sendCtrl).toHaveBeenCalledWith({ t: "ctrl", op: "set_mode", mode: "assist" });

  const bad = await post(api, "/api/mode", { mode: "yolo" });
  expect(bad.status).toBe(400);
  expect(sendCtrl).toHaveBeenCalledTimes(1); // invalid input never reaches the takeover link

  sendCtrl.mockReturnValue(false); // link down
  const down = await post(api, "/api/mode", { mode: "full" });
  expect(down.status).toBe(503);
});

test("POST /api/mission: appends MISSION.md (never overwrites), snapshots history, broadcasts chat_out(system); bad input 400", async () => {
  const rig = mkRig();
  const snapshot = vi.fn();
  const api = new ApiServer({ port: 0, board: rig.board, budget: rig.budget, runtimeDir: rig.runtimeDir, loop: { push: vi.fn() }, snapshotRuntime: snapshot });
  servers.push(api);
  await api.start();
  const before = readFileSync(join(rig.runtimeDir, "MISSION.md"), "utf8");
  const c = wsCollect(api);
  await c.opened;

  const res = await post(api, "/api/mission", { text: "- ship the api" });
  expect(res.status).toBe(202);
  const after = readFileSync(join(rig.runtimeDir, "MISSION.md"), "utf8");
  expect(after.startsWith(before)).toBe(true);
  expect(after).toContain("- ship the api");
  expect(snapshot).toHaveBeenCalledTimes(1); // pre-edit snapshot keeps history recoverable
  await until(() => c.frames.some((f) => f.t === "chat_out" && f.from === "system"));
  expect(c.frames.find((f) => f.t === "chat_out" && f.from === "system")!.text).toBe("- ship the api");

  for (const bad of [{}, { text: "" }]) {
    const r = await post(api, "/api/mission", bad);
    expect(r.status).toBe(400);
  }
});

test("mode_changed from takeoverd: state.mode updates and a {t:'mode'} frame broadcasts; sendCtrl rides the open takeover socket", async () => {
  const rig = mkRig();
  const chat = fakeLlmChat(async () => ({ content: '{"action":"none"}', usage: { promptTokens: 1, completionTokens: 1 } }));
  class FakeWs extends EventEmitter { readyState = 1; sent: string[] = []; send(data: string): void { this.sent.push(data); } close(): void { this.emit("close"); } }
  const fakeWs = new FakeWs();
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: rig.board, ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn() } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: rig.runtimeDir, reviewEvery: 1000 }), budget: rig.budget, runtimeDir: rig.runtimeDir,
    takeoverUrl: "ws://fake.local", wsFactory: () => fakeWs as unknown as WsLike,
  });
  const api = makeApi(rig, loop);
  loop.setOutlet(api);
  await api.start();
  const c = wsCollect(api);
  await c.opened;
  loop.start(60_000);

  fakeWs.emit("message", JSON.stringify({ t: "evt", type: "mode_changed", mode: "assist" }));
  await until(() => c.frames.some((f) => f.t === "mode"));
  expect(c.frames.find((f) => f.t === "mode")!.mode).toBe("assist");
  const s = (await (await fetch(`http://127.0.0.1:${api.port}/api/state`)).json()) as StateFrame;
  expect(s.mode).toBe("assist");

  const res = await post(api, "/api/mode", { mode: "full" }); // the api forwards over the loop's takeover socket
  expect(res.status).toBe(202);
  expect(fakeWs.sent[fakeWs.sent.length - 1]).toBe(JSON.stringify({ t: "ctrl", op: "set_mode", mode: "full" }));
  loop.stop();
});

test("static webDir: / serves index.html, assets by extension, SPA fallback for extension-less routes; traversal refused; no webDir -> 404", async () => {
  const rig = mkRig();
  const webDir = mkdtempSync(join(tmpdir(), "robojex-web-"));
  writeFileSync(join(webDir, "index.html"), "<html>jex web</html>");
  writeFileSync(join(webDir, "favicon.svg"), "<svg/>");
  const api = makeApi(rig, { push: vi.fn() }, { webDir });
  await api.start();

  const root = await fetch(`http://127.0.0.1:${api.port}/`);
  expect(root.status).toBe(200);
  expect(root.headers.get("content-type")).toContain("text/html");
  expect(await root.text()).toBe("<html>jex web</html>");

  const asset = await fetch(`http://127.0.0.1:${api.port}/favicon.svg`);
  expect(asset.status).toBe(200);
  expect(asset.headers.get("content-type")).toContain("svg");

  const spa = await fetch(`http://127.0.0.1:${api.port}/tasks/abc`); // no such file, no extension -> app shell
  expect(spa.status).toBe(200);
  expect(await spa.text()).toBe("<html>jex web</html>");

  const missing = await fetch(`http://127.0.0.1:${api.port}/nope.js`); // a missing asset is a real 404
  expect(missing.status).toBe(404);

  // encoded traversal must not escape webDir: %2f stays inside one opaque path
  // segment (the URL parser already collapses bare %2e%2e), so raw http here
  const { promise: travStatus, resolve: travDone } = Promise.withResolvers<number>();
  const travReq = httpGet({ host: "127.0.0.1", port: api.port, path: "/%2e%2e%2f..%2fMISSION.md" }, (x) => travDone(x.statusCode ?? 0));
  travReq.on("error", () => travDone(0));
  expect(await travStatus).toBe(403);

  const bare = makeApi(rig, { push: vi.fn() }); // no webDir: static serving off
  await bare.start();
  expect((await fetch(`http://127.0.0.1:${bare.port}/`)).status).toBe(404);
});

test("assembleAndStart wires the api server on cfg.apiPort (0 = ephemeral) and stop() closes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-asm-api-"));
  seedRuntimeFiles(dir);
  writeFileSync(join(dir, "TOOLS.md"), "- demo (demo) — demo tool [vd-1] verified 2026-01-01\n");
  writeFileSync(join(dir, "TENTACLES.md"), "\n");
  const fakeLoop = { start: vi.fn(), stop: vi.fn(), push: vi.fn() };
  const assembled = assembleAndStart({ apiPort: 0 }, dir, { loopFactory: () => fakeLoop, exit: () => {} });
  servers.push(assembled.api);
  await assembled.api.ready;
  expect(assembled.api.port).toBeGreaterThan(0);
  const res = await fetch(`http://127.0.0.1:${assembled.api.port}/api/state`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as StateFrame).mode).toBe("observe"); // fake loop exposes no mode: safe default

  const modeRes = await post(assembled.api, "/api/mode", { mode: "assist" }); // fake loop has no sendCtrl
  expect(modeRes.status).toBe(503);

  assembled.stop();
  await expect(fetch(`http://127.0.0.1:${assembled.api.port}/api/state`)).rejects.toThrow();
});
