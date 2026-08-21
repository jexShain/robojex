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
import { tmpdir, networkInterfaces } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
  wake?: unknown; cost?: unknown; actions?: unknown[]; tasks?: unknown[]; mode?: unknown; line?: unknown; budget?: unknown;
  kind?: unknown; taskId?: unknown;
}

// The GET /api/state payload as the tests read it (loose: all fields optional).
interface StateFrame {
  tasks?: { title?: string; status?: string; resultSummary?: string; createdAt?: number; parentId?: string | null; scheduledAt?: number | null; dueAt?: number | null }[];
  budget?: Record<string, unknown>;
  mode?: string;
  mission?: string; rubric?: string; memory?: string;
  chat?: unknown[];
  version?: string;
  now?: number;
  tickN?: number;
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
function makeApi(rig: Rig, loop: { push: (e: string) => void; sendCtrl?: (f: Record<string, unknown>) => boolean; mode?: () => string; tickN?: () => number }, extra: { webDir?: string } = {}): ApiServer {
  const api = new ApiServer({
    port: 0, board: rig.board, budget: rig.budget, runtimeDir: rig.runtimeDir, loop,
    ...(extra.webDir ? { webDir: extra.webDir } : {}),
  });
  servers.push(api);
  return api;
}

// The scripted-LLM seam: patrol decides act/none per wake, decide returns one action set.
type FakeLlm = (slot: string, msgs?: { role: string; content: string }[], opts?: { maxTokens?: number }) => Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } }>;
function fakeLlmChat(impl: FakeLlm): Mock {
  return vi.fn(async (slot: string, msgs?: { role: string; content: string }[], opts?: { maxTokens?: number }) => impl(slot, msgs, opts));
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
  // VERSION resolves one level above the module: src -> packages/ceo-core/package.json
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version?: string };
  expect(s.version).toBe(pkg.version);
});

test("GET /api/state v2: tasks carry parentId/scheduledAt/dueAt, top-level now for clock alignment", async () => {
  const rig = mkRig();
  const epic = rig.board.add({ title: "epic" });
  rig.board.add({ title: "child", parentId: epic.id, scheduledAt: 1_760_000_000_000, dueAt: 1_760_100_000_000 });
  const api = makeApi(rig, { push: vi.fn() });
  await api.start();

  const res = await fetch(`http://127.0.0.1:${api.port}/api/state`);
  const s = (await res.json()) as StateFrame;
  const byTitle = Object.fromEntries((s.tasks ?? []).map((t) => [t.title, t]));
  expect(byTitle.epic).toMatchObject({ parentId: null, scheduledAt: null, dueAt: null });
  expect(byTitle.child).toMatchObject({ parentId: epic.id, scheduledAt: 1_760_000_000_000, dueAt: 1_760_100_000_000 });
  expect(typeof s.now).toBe("number");
  expect(Math.abs((s.now ?? 0) - Date.now())).toBeLessThan(5_000); // server clock, not stale
});

test("POST /api/task: 202 creates a todo card with tree/schedule fields and broadcasts tasks; every invalid shape is a 400 with a reason", async () => {
  const rig = mkRig();
  const epic = rig.board.add({ title: "epic" });
  const loop = { push: vi.fn() };
  const api = makeApi(rig, loop);
  await api.start();
  const c = wsCollect(api);
  await c.opened;

  const scheduledAt = Date.now() + 3_600_000, dueAt = Date.now() + 7_200_000;
  const ok = await post(api, "/api/task", { title: "child job", parentId: epic.id, scheduledAt, dueAt });
  expect(ok.status).toBe(202);
  const created = rig.board.list().find((t) => t.title === "child job");
  expect(created).toMatchObject({ status: "todo", parentId: epic.id, scheduledAt, dueAt });
  await until(() => c.frames.some((f) => f.t === "tasks"));
  const frame = c.frames.find((f) => f.t === "tasks")!;
  const child = (frame.tasks as StateFrame["tasks"])!.find((t) => t.title === "child job");
  expect(child).toMatchObject({ status: "todo", parentId: epic.id, scheduledAt, dueAt }); // frames carry the new fields too

  const rejects: [unknown, string][] = [
    [{}, "title"],
    [{ title: "   " }, "title"],
    [{ title: "x".repeat(201) }, "200 bytes"],
    [{ title: "ok", scheduledAt: "tomorrow" }, "scheduledAt"],
    [{ title: "ok", dueAt: "2026-08-21" }, "dueAt"],
    [{ title: "ok", parentId: 42 }, "parentId"],
    [{ title: "ok", parentId: "missing-id" }, "parentId"],
  ];
  for (const [body, reason] of rejects) {
    const r = await post(api, "/api/task", body);
    expect(r.status, `body ${JSON.stringify(body)} should 400`).toBe(400);
    expect(((await r.json()) as { error?: string }).error).toContain(reason);
  }
  // 1e999 parses to Infinity: the finite-number gate must catch it
  const inf = await fetch(`http://127.0.0.1:${api.port}/api/task`, { method: "POST", headers: { "content-type": "application/json" }, body: `{"title":"ok","scheduledAt":1e999}` });
  expect(inf.status).toBe(400);
  expect(((await inf.json()) as { error?: string }).error).toContain("scheduledAt");

  expect(rig.board.list()).toHaveLength(2); // nothing above entered the board
  c.ws.close();
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

// -- Host/Origin gate (anti DNS-rebinding + cross-site drive-by) ------------
const rawGet = (api: ApiServer, headers: Record<string, string>, path = "/api/state") =>
  new Promise<{ status: number; cors: string | string[] | undefined }>((resolve, reject) => {
    // raw http: fetch refuses a forged Host header, the attack vector itself
    const req = httpGet({ host: "127.0.0.1", port: api.port, path, headers }, (res) => {
      res.resume(); // drain the body so 'end' fires; only status/headers matter here
      res.on("end", () => resolve({ status: res.statusCode ?? 0, cors: res.headers["access-control-allow-origin"] }));
    });
    req.on("error", reject);
  });

test("origin gate: forged Host 403, mismatched Origin 403; NIC-IP Host with same-origin Origin 200 and CORS echoes only the vetted origin", async () => {
  const rig = mkRig();
  const api = makeApi(rig, { push: vi.fn() });
  await api.start();

  // DNS rebinding: the connection is local but Host names the attacker domain
  expect((await rawGet(api, { host: "evil.com" })).status).toBe(403);

  // legitimate Host, but the browser page sending the request lives elsewhere
  expect((await rawGet(api, { host: `127.0.0.1:${api.port}`, origin: "http://evil.com" })).status).toBe(403);
  expect((await rawGet(api, { host: `127.0.0.1:${api.port}`, origin: "null" })).status).toBe(403); // sandboxed frame

  // no Origin header (curl, node fetch, the ws client): plain Host check only, no CORS header
  const plain = await rawGet(api, { host: `127.0.0.1:${api.port}` });
  expect(plain.status).toBe(200);
  expect(plain.cors).toBeUndefined();

  // remote operator: console served same-origin from a NIC address (http://10.x.x.x:7620)
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  expect(lan).toBeTruthy(); // every real deployment box has an external IPv4 NIC
  const remote = await rawGet(api, { host: `${lan}:${api.port}`, origin: `http://${lan}:${api.port}` });
  expect(remote.status).toBe(200);
  expect(remote.cors).toBe(`http://${lan}:${api.port}`);

  // vite dev server: loopback origin on any port against a loopback Host
  const dev = await rawGet(api, { host: `127.0.0.1:${api.port}`, origin: "http://localhost:5173" });
  expect(dev.status).toBe(200);
  expect(dev.cors).toBe("http://localhost:5173");
});

test("WS upgrade runs the same gate: forged Host or cross-origin upgrade destroyed; loopback upgrade proceeds", async () => {
  const rig = mkRig();
  const api = makeApi(rig, { push: vi.fn() });
  await api.start();

  const upgrade = (headers: Record<string, string>) =>
    new Promise<"upgraded" | "refused">((resolve) => {
      const req = httpGet({
        host: "127.0.0.1", port: api.port, path: "/api/events",
        headers: {
          connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13",
          "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
          ...headers,
        },
      });
      req.on("upgrade", () => { req.destroy(); resolve("upgraded"); }); // first event wins
      req.on("response", () => resolve("refused"));
      req.on("close", () => resolve("refused"));
      req.on("error", () => resolve("refused"));
    });

  expect(await upgrade({ host: "evil.com" })).toBe("refused");
  expect(await upgrade({ host: `127.0.0.1:${api.port}`, origin: "http://evil.com" })).toBe("refused");
  expect(await upgrade({ host: `127.0.0.1:${api.port}` })).toBe("upgraded"); // node ws clients send no Origin
});

test("WS chat frames share the POST validation; a frame past maxPayload closes the socket and never reaches the ring", async () => {
  const rig = mkRig();
  const loop = { push: vi.fn() };
  const api = makeApi(rig, loop);
  await api.start();
  const c = wsCollect(api);
  await c.opened;

  // blank and over-16KB texts are ignored exactly like POST /api/chat 400s
  c.ws.send(JSON.stringify({ t: "chat", text: "   " }));
  c.ws.send(JSON.stringify({ t: "chat", text: "x".repeat(16 * 1024 + 1) }));
  c.ws.send(JSON.stringify({ t: "chat", text: "ok" })); // ordered after the bad ones on one connection
  await until(() => c.frames.some((f) => f.t === "chat_out" && f.text === "ok"));
  expect(c.frames.filter((f) => f.t === "chat_out")).toHaveLength(1); // only the valid text echoed
  expect(loop.push).toHaveBeenCalledTimes(1);
  expect(loop.push).toHaveBeenCalledWith("chat: ok");

  // one frame past the 1MB cap: server closes with 1009, payload never lands
  const closed = new Promise<number>((resolve) => c.ws.once("close", (code: number) => resolve(code)));
  c.ws.send(JSON.stringify({ t: "chat", text: "x".repeat(1024 * 1024 + 64) }));
  expect(await closed).toBe(1009);
  const s = (await (await fetch(`http://127.0.0.1:${api.port}/api/state`)).json()) as StateFrame;
  expect(s.chat).toHaveLength(1); // ring still holds just "ok"
  expect(loop.push).toHaveBeenCalledTimes(1);
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
    orchestrator: { spawn, getRegistry: () => null } as unknown as AgentOrchestrator,
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
  await until(() => c.frames.some((f) => f.t === "cycle"));
  const cycle = c.frames.find((f) => f.t === "cycle")!;
  expect(cycle.wake).toBe(1);
  expect(cycle.cost).toBe(82); // patrol 12 + decide 70
  await until(() => c.frames.some((f) => f.t === "budget")); // budget frame follows every cycle
});

test("decide starvation: empty content at full completion budget retries once at double and applies the second answer", async () => {
  const rig = mkRig();
  const decideCalls: number[] = [];
  const chat = fakeLlmChat(async (slot, _msgs, opts) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    decideCalls.push(opts?.maxTokens ?? 0);
    if (decideCalls.length === 1)
      return { content: "", usage: { promptTokens: 900, completionTokens: 8192 } }; // starved: reasoning ate the budget
    return { content: JSON.stringify({ actions: [{ type: "reply", text: "recovered" }] }), usage: { promptTokens: 900, completionTokens: 1200 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: rig.board, ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: rig.runtimeDir, reviewEvery: 1000 }), budget: rig.budget, runtimeDir: rig.runtimeDir,
  });
  const api = makeApi(rig, loop);
  loop.setOutlet(api);
  await api.start();
  const c = wsCollect(api);
  await c.opened;

  await loop.runOnce("chat: heavy structural request");

  await until(() => c.frames.some((f) => f.t === "chat_out" && f.from === "jex"));
  expect(decideCalls).toEqual([4096, 8192]); // exactly one adaptive escalation (balanced gear: 4096 → 2x)
  expect(c.frames.find((f) => f.t === "chat_out" && f.from === "jex")!.text).toBe("recovered");
});

test("decide starvation: a short empty answer (api hiccup) does NOT trigger the budget escalation", async () => {
  const rig = mkRig();
  const decideCalls: number[] = [];
  const chat = fakeLlmChat(async (slot, _msgs, opts) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    decideCalls.push(opts?.maxTokens ?? 0);
    return { content: "", usage: { promptTokens: 100, completionTokens: 5 } }; // empty but not starved
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: rig.board, ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: rig.runtimeDir, reviewEvery: 1000 }), budget: rig.budget, runtimeDir: rig.runtimeDir,
  });
  const api = makeApi(rig, loop);
  loop.setOutlet(api);
  await loop.runOnce("chat: hi"); // decide calls are settled before runOnce resolves
  expect(decideCalls).toEqual([4096]); // no retry (balanced gear budget)
});


test("invalid reply action (empty text): logged, cycle still completes and broadcasts, nothing leaves as jex", async () => {
  const rig = mkRig();
  const chat = fakeLlmChat(async (slot) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 10, completionTokens: 2 } };
    return { content: JSON.stringify({ actions: [{ type: "reply", text: "" }] }), usage: { promptTokens: 50, completionTokens: 20 } };
  });
  const loop = new SchedulerLoop({
    llm: { chat } as unknown as LLMClient, board: rig.board, ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
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
    orchestrator: { spawn, getRegistry: () => null } as unknown as AgentOrchestrator,
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
    orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
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

test("hello carries tickN; hud frames broadcast to ws clients", async () => {
  const rig = mkRig();
  const api = makeApi(rig, { push: vi.fn(), tickN: () => 7 });
  await api.start();

  // hello.state mirrors GET /api/state: the loop stub's tick count rides both
  const c = wsCollect(api);
  await c.opened;
  await until(() => c.frames.some((f) => f.t === "hello"));
  expect(c.frames.find((f) => f.t === "hello")!.state).toMatchObject({ tickN: 7 });
  const s = await (await fetch(`http://127.0.0.1:${api.port}/api/state`)).json() as StateFrame;
  expect(s.tickN).toBe(7);

  // hud(): one broadcast frame per gantt event, kind+taskId+ts, to every ws client
  api.hud("due_spawn", "x");
  await until(() => c.frames.some((f) => f.t === "hud"));
  const hud = c.frames.find((f) => f.t === "hud")!;
  expect(hud).toMatchObject({ t: "hud", kind: "due_spawn", taskId: "x" });
  expect(typeof hud.ts).toBe("number");
});
