// packages/ceo-core/test/chat-api.test.ts
// HTTP-layer wiring of the new desktop surface: conversations CRUD, the SSE
// chat route through a real fetch client, gear GET/PUT hot switch, models and
// usage proxies — all against a real ApiServer with a scripted ChatService.
import { ApiServer } from "../src/api.js";
import { ChatService } from "../src/chat-service.js";
import { ChatStore } from "../src/chat-store.js";
import { GearController } from "../src/gears.js";
import { BudgetGovernor } from "../src/budget.js";
import { LLMClient, type Slot } from "../src/llm.js";
import { TaskBoard } from "../src/board.js";
import { seedRuntimeFiles } from "../src/index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { expect, test, vi, afterEach } from "vitest";

const servers: ApiServer[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

function fakeLlm() {
  return {
    modelName: (_s: Slot, o?: string) => o ?? "deepseek-v4-flash",
    chat: async () => ({ content: "标题", usage: { promptTokens: 1, completionTokens: 1 } }),
    chatStream: async (_s: Slot, _m: unknown, opts: { onContent?: (d: string) => void }) => {
      opts.onContent?.("流式");
      opts.onContent?.("回答");
      return { content: "流式回答", reasoning: "", usage: { promptTokens: 5, completionTokens: 5 } };
    },
    listModels: async () => ["deepseek-v4-flash", "deepseek-reasoner"],
  } as unknown as LLMClient;
}

interface Rig { api: ApiServer; store: ChatStore; gear: GearController; applied: string[]; }
function mkRig(): Rig {
  const runtimeDir = mkdtempSync(join(tmpdir(), "robojex-chatapi-"));
  seedRuntimeFiles(runtimeDir);
  const store = new ChatStore(join(runtimeDir, "chat.sqlite"));
  const applied: string[] = [];
  const gear = new GearController({ runtimeDir, onApply: (g) => applied.push(g.id) });
  const svc = new ChatService({ store, llm: fakeLlm(), gear, budget: new BudgetGovernor("burn"), runtimeDir });
  const api = new ApiServer({
    port: 0, board: new TaskBoard(join(runtimeDir, "board.sqlite")), budget: new BudgetGovernor("burn"),
    runtimeDir, loop: { push: vi.fn() }, chat: svc, gear, llm: fakeLlm(),
  });
  servers.push(api);
  return { api, store, gear, applied };
}

const base = (api: ApiServer): string => `http://127.0.0.1:${api.port}`;

// consume an SSE POST body into parsed frames (same parsing the web client does)
async function ssePost(api: ApiServer, path: string, body: unknown): Promise<{ status: number; events: Record<string, unknown>[]; json?: Record<string, unknown> }> {
  const res = await fetch(`${base(api)}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) return { status: res.status, events: [], json: await res.json().catch(() => ({})) };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events: Record<string, unknown>[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const p = line.slice(5).trim();
        if (p) events.push(JSON.parse(p) as Record<string, unknown>);
      }
    }
  }
  return { status: res.status, events };
}

test("conversations CRUD over HTTP: create 201, list with counts, PATCH pin, DELETE cascade", async () => {
  const rig = mkRig();
  await rig.api.start();

  const empty = await (await fetch(`${base(rig.api)}/api/conversations`)).json() as { conversations: unknown[] };
  expect(empty.conversations).toEqual([]);

  const created = await (await fetch(`${base(rig.api)}/api/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "工作" }) })).json() as { id: string; title: string };
  expect(created.title).toBe("工作");

  const { status, events } = await ssePost(rig.api, "/api/chat/stream", { conversationId: created.id, text: "问题" });
  expect(status).toBe(200);
  expect(events.map((e) => e.type)).toEqual(["meta", "content", "content", "usage", "title", "done"]);

  const list = await (await fetch(`${base(rig.api)}/api/conversations`)).json() as { conversations: { id: string; messageCount: number; preview: string; pinned: number }[] };
  expect(list.conversations[0]).toMatchObject({ id: created.id, messageCount: 2, preview: "流式回答", pinned: 0 });

  const patched = await (await fetch(`${base(rig.api)}/api/conversations/${created.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: true }) })).json() as { pinned: number };
  expect(patched.pinned).toBe(1);

  const msgs = await (await fetch(`${base(rig.api)}/api/conversations/${created.id}/messages`)).json() as { messages: { id: string; role: string }[] };
  expect(msgs.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  const del = await (await fetch(`${base(rig.api)}/api/messages/${msgs.messages[0]!.id}`, { method: "DELETE" })).json() as { ok: boolean };
  expect(del.ok).toBe(true);
  expect((await (await fetch(`${base(rig.api)}/api/conversations/${created.id}/messages`)).json() as { messages: unknown[] }).messages).toHaveLength(1);

  const gone = await (await fetch(`${base(rig.api)}/api/conversations/${created.id}`, { method: "DELETE" })).json() as { ok: boolean };
  expect(gone.ok).toBe(true);
  expect((await (await fetch(`${base(rig.api)}/api/conversations`)).json() as { conversations: unknown[] }).conversations).toEqual([]);
  const missing = await fetch(`${base(rig.api)}/api/conversations/nope/messages`);
  expect(missing.status).toBe(404);
});

test("POST /api/chat/stream without an id auto-creates the conversation; stop answers 200", async () => {
  const rig = mkRig();
  await rig.api.start();
  const { events } = await ssePost(rig.api, "/api/chat/stream", { text: "新话题" });
  const meta = events[0] as { conversationId: string };
  expect(typeof meta.conversationId).toBe("string");
  const stop = await (await fetch(`${base(rig.api)}/api/chat/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json() as { ok: boolean; stopped: number };
  expect(stop).toEqual({ ok: true, stopped: 0 }); // nothing in flight
});

test("GET/PUT /api/gear: shape, hot switch fires onApply, invalid 400, WS broadcasts", async () => {
  const rig = mkRig();
  await rig.api.start();
  const ws = new WebSocket(`ws://127.0.0.1:${rig.api.port}/api/events`);
  const wsFrames: Record<string, unknown>[] = [];
  ws.on("message", (raw: unknown) => { try { wsFrames.push(JSON.parse(String(raw)) as Record<string, unknown>); } catch { /* ignore */ } });
  await new Promise<void>((r) => ws.once("open", () => r()));
  await new Promise<void>((r) => { const t = setInterval(() => { if (wsFrames.some((f) => f.t === "hello")) { clearInterval(t); r(); } }, 5); });

  const hello = wsFrames.find((f) => f.t === "hello") as { state?: { gear?: string } };
  expect(hello?.state?.gear).toBe("balanced");

  const g0 = await (await fetch(`${base(rig.api)}/api/gear`)).json() as { gear: string; gears: unknown[]; appliedTickMs: number };
  expect(g0).toMatchObject({ gear: "balanced", appliedTickMs: 60_000 });
  expect(g0.gears).toHaveLength(5);

  const g1 = await (await fetch(`${base(rig.api)}/api/gear`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ gear: "turbo" }) })).json() as { gear: string; appliedTickMs: number };
  expect(g1).toMatchObject({ gear: "turbo", appliedTickMs: 15_000 });
  expect(rig.applied).toEqual(["turbo"]);
  await new Promise((r) => setTimeout(r, 50));
  expect(wsFrames.some((f) => f.t === "gear" && f.gear === "turbo")).toBe(true);

  const bad = await fetch(`${base(rig.api)}/api/gear`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ gear: "warp" }) });
  expect(bad.status).toBe(400);
  ws.close();
});

test("GET /api/models and /api/usage proxies", async () => {
  const rig = mkRig();
  await rig.api.start();
  const models = await (await fetch(`${base(rig.api)}/api/models`)).json() as { models: string[] };
  expect(models.models).toEqual(["deepseek-v4-flash", "deepseek-reasoner"]);

  await ssePost(rig.api, "/api/chat/stream", { text: "问" });
  const usage = await (await fetch(`${base(rig.api)}/api/usage?days=3`)).json() as { usage: { day: string; calls: number; tokensIn: number }[] };
  expect(usage.usage).toHaveLength(3);
  expect(usage.usage.at(-1)!.calls).toBe(1);
  expect(usage.usage.at(-1)!.tokensIn).toBe(5);
});

test("PUT /api/settings accepts autonomyGear and hot-applies it", async () => {
  const rig = mkRig();
  await rig.api.start();
  const res = await fetch(`${base(rig.api)}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ autonomyGear: "eco" }) });
  expect(res.status).toBe(200);
  const body = await res.json() as { ok: boolean; note: string };
  expect(body.note).toContain("eco");
  expect(rig.applied).toEqual(["eco"]);
  expect(rig.gear.current()).toBe("eco");

  const bad = await fetch(`${base(rig.api)}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ autonomyGear: "fast" }) });
  expect(bad.status).toBe(400);
  const settings = await (await fetch(`${base(rig.api)}/api/settings`)).json() as Record<string, unknown>;
  expect(settings.autonomyGear).toBe("eco");
});

test("unwired routes answer 503 instead of crashing", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "robojex-chatapi-"));
  seedRuntimeFiles(runtimeDir);
  const api = new ApiServer({
    port: 0, board: new TaskBoard(join(runtimeDir, "board.sqlite")), budget: new BudgetGovernor("burn"),
    runtimeDir, loop: { push: vi.fn() },
  });
  servers.push(api);
  await api.start();
  for (const p of ["/api/conversations", "/api/gear", "/api/models", "/api/usage"]) {
    expect((await fetch(`${base(api)}${p}`)).status).toBe(503);
  }
  expect((await fetch(`${base(api)}/api/chat/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(503);
});
