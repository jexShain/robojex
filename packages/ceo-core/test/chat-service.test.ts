// packages/ceo-core/test/chat-service.test.ts
// Streaming direct chat against a scripted fake LLM: SSE frame sequence,
// persistence, first-round title generation, abort retention, regenerate
// semantics, per-conversation single-stream guard and usage aggregation.
import { ChatService } from "../src/chat-service.js";
import { ChatStore } from "../src/chat-store.js";
import { GearController } from "../src/gears.js";
import { BudgetGovernor } from "../src/budget.js";
import { Auditor } from "../src/auditor.js";
import type { LLMClient, Slot } from "../src/llm.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";

/* ───────────────────────── fakes ───────────────────────── */

class FakeRes {
  status = 0;
  headers: Record<string, unknown> = {};
  body = "";
  ended = false;
  writeHead(status: number, headers?: Record<string, unknown>): this { this.status = status; Object.assign(this.headers, headers ?? {}); return this; }
  write(chunk: string): boolean { this.body += chunk; return true; }
  end(chunk?: string): this { if (chunk) this.body += chunk; this.ended = true; return this; }
}

const fakeReq = (): IncomingMessage => new EventEmitter() as unknown as IncomingMessage;

function frames(res: FakeRes): Record<string, unknown>[] {
  return res.body.split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>);
}

interface Script {
  reasoning?: string[];
  content?: string[];
  usage?: { promptTokens: number; completionTokens: number };
  gate?: Promise<void>;          // park before any delta (409 test)
  failWith?: Error;              // throw mid-stream after deltas
  title?: string;                // what the non-stream title call returns
  slowDeltas?: boolean;          // emit over timers honoring the abort signal
}

// Scripted LLM: chatStream replays deltas through the same onReasoning/
// onContent callbacks the real client drives; chat serves the title pass.
function fakeLlm(script: Script) {
  const state = {
    streamCalls: 0,
    chatCalls: 0,
    lastMessages: [] as { role: string; content: string }[],
  };
  const llm = {
    state,
    modelName: (_slot: Slot, override?: string) => override ?? "deepseek-v4-flash",
    async chat(_slot: Slot, msgs: { role: string; content: string }[]) {
      state.chatCalls++;
      state.lastMessages = msgs;
      return { content: script.title ?? "自动标题", usage: { promptTokens: 3, completionTokens: 2 } };
    },
    async chatStream(_slot: Slot, messages: { role: string; content: string }[], opts: {
      signal?: AbortSignal; onReasoning?: (d: string) => void; onContent?: (d: string) => void;
    }) {
      state.streamCalls++;
      state.lastMessages = messages;
      if (script.gate) await script.gate;
      const abortNow = (): never => { const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e; };
      if (opts.signal?.aborted) abortNow();
      for (const d of script.reasoning ?? []) opts.onReasoning?.(d);
      for (const d of script.content ?? []) {
        if (script.slowDeltas) {
          await new Promise((r) => setTimeout(r, 15));
          if (opts.signal?.aborted) abortNow(); // stop lands between deltas
        }
        opts.onContent?.(d);
      }
      if (script.failWith) throw script.failWith;
      return {
        content: (script.content ?? []).join(""),
        reasoning: (script.reasoning ?? []).join(""),
        usage: script.usage ?? { promptTokens: 0, completionTokens: 0 },
      };
    },
  };
  return { llm: llm as unknown as LLMClient, state };
}

interface Rig {
  svc: ChatService; store: ChatStore; gear: GearController; budget: BudgetGovernor;
  runtimeDir: string; agentEvents: string[];
  llmState: { streamCalls: number; chatCalls: number; lastMessages: { role: string; content: string }[] };
}
function mkRig(script: Script, opts: { gear?: string } = {}): Rig {
  const runtimeDir = mkdtempSync(join(tmpdir(), "robojex-svc-"));
  const store = new ChatStore(join(runtimeDir, "chat.sqlite"));
  const gear = new GearController({ runtimeDir, initial: opts.gear ?? "balanced" });
  const budget = new BudgetGovernor("burn");
  const agentEvents: string[] = [];
  const { llm, state } = fakeLlm(script);
  const svc = new ChatService({
    store, llm, gear, budget, runtimeDir,
    onAgentEvent: (t) => agentEvents.push(t),
  });
  return { svc, store, gear, budget, runtimeDir, agentEvents, llmState: state };
}

/* ───────────────────────── tests ───────────────────────── */

test("happy path: meta → reasoning → content → usage → title → done; rows and budget persisted", async () => {
  const rig = mkRig({
    reasoning: ["思考A", "思考B"],
    content: ["你好", "，世界"],
    usage: { promptTokens: 11, completionTokens: 7 },
    title: "问候测试",
  });
  const conv = rig.store.create();
  const res = new FakeRes();
  await rig.svc.handleStream(fakeReq(), res as unknown as ServerResponse, { conversationId: conv.id, text: "打个招呼" });

  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toBe("text/event-stream");
  const f = frames(res);
  const types = f.map((e) => e.type);
  expect(types).toEqual(["meta", "reasoning", "reasoning", "content", "content", "usage", "title", "done"]);
  expect(f[0]).toMatchObject({ type: "meta", conversationId: conv.id, model: "deepseek-v4-flash" });
  expect(typeof f[0]!.userMsgId).toBe("string");
  expect(typeof f[0]!.assistantMsgId).toBe("string");
  expect(f[5]).toEqual({ type: "usage", tokensIn: 11, tokensOut: 7 });
  expect(f[6]).toEqual({ type: "title", title: "问候测试" });

  const msgs = rig.store.listMessages(conv.id);
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(msgs[0]!.content).toBe("打个招呼");
  expect(msgs[1]).toMatchObject({ content: "你好，世界", reasoning: "思考A思考B", tokensIn: 11, tokensOut: 7, model: "deepseek-v4-flash", error: "" });
  expect(rig.store.get(conv.id)!.title).toBe("问候测试");
  expect(rig.budget.snapshot().spentToday).toBe(11 + 7 + 3 + 2); // stream + title pass
});

test("system prompt carries the gear persona; history ends at the fresh user message", async () => {
  const rig = mkRig({ content: ["ok"] }, { gear: "eco" });
  const conv = rig.store.create();
  rig.store.appendMessage(conv.id, { role: "user", content: "旧问题" });
  rig.store.appendMessage(conv.id, { role: "assistant", content: "旧回答" });
  const res = new FakeRes();
  await rig.svc.handleStream(fakeReq(), res as unknown as ServerResponse, { conversationId: conv.id, text: "新问题" });
  const msgs = rig.llmState.lastMessages;
  expect(msgs[0]).toMatchObject({ role: "system" });           // persona first
  expect(msgs[0]!.content).toContain("省电");                   // the eco persona
  expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  expect(msgs.at(-1)!.content).toBe("新问题");                  // history ends at the fresh turn
});

test("title only on the first round: the second stream adds no title frame", async () => {
  const rig = mkRig({ content: ["一", "二"], usage: { promptTokens: 1, completionTokens: 1 }, title: "首标题" });
  const conv = rig.store.create();
  const r1 = new FakeRes();
  await rig.svc.handleStream(fakeReq(), r1 as unknown as ServerResponse, { conversationId: conv.id, text: "q1" });
  expect(frames(r1).some((e) => e.type === "title")).toBe(true);

  const r2 = new FakeRes();
  await rig.svc.handleStream(fakeReq(), r2 as unknown as ServerResponse, { conversationId: conv.id, text: "q2" });
  const f2 = frames(r2);
  expect(f2.some((e) => e.type === "title")).toBe(false);
  expect(f2.map((e) => e.type)).toEqual(["meta", "content", "content", "usage", "done"]);
});

test("abort mid-stream: partial content persists with error 'aborted', done still emitted", async () => {
  const rig = mkRig({ content: ["部分", "到达"], slowDeltas: true, usage: { promptTokens: 9, completionTokens: 9 } });
  const conv = rig.store.create();
  const req = fakeReq();
  const res = new FakeRes();
  const p = rig.svc.handleStream(req, res as unknown as ServerResponse, { conversationId: conv.id, text: "长答案" });
  await new Promise<void>((resolve) => {
    const t = setInterval(() => { if (res.body.includes("content")) { clearInterval(t); resolve(); } }, 5);
  });
  req.emit("close"); // client disconnects mid-stream
  await p;

  const f = frames(res);
  expect(f.some((e) => e.type === "content" && e.delta === "部分")).toBe(true);
  expect(f.some((e) => e.type === "done")).toBe(true);          // aborted streams still settle
  expect(f.some((e) => e.type === "usage")).toBe(false);        // usage never arrived
  const last = rig.store.listMessages(conv.id).at(-1)!;
  expect(last.content).toBe("部分");                             // partial retained
  expect(last.error).toBe("aborted");
});

test("regenerate (text ''): truncates after the last user message, no new user row", async () => {
  const rig = mkRig({ content: ["重新", "生成"], usage: { promptTokens: 2, completionTokens: 2 }, title: "标题" });
  const conv = rig.store.create();
  const r1 = new FakeRes();
  await rig.svc.handleStream(fakeReq(), r1 as unknown as ServerResponse, { conversationId: conv.id, text: "原问题" });
  const firstUser = rig.store.listMessages(conv.id)[0]!;

  const r2 = new FakeRes();
  await rig.svc.handleStream(fakeReq(), r2 as unknown as ServerResponse, { conversationId: conv.id, text: "" });
  const f2 = frames(r2);
  expect(f2[0]).toMatchObject({ type: "meta", userMsgId: firstUser.id }); // reuses the original user turn
  const msgs = rig.store.listMessages(conv.id);
  expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
  expect(msgs.at(-1)!.content).toBe("重新生成"); // fresh reply over truncated history
});

test("regenerate with no user message: 400", async () => {
  const rig = mkRig({ content: ["x"] });
  const conv = rig.store.create();
  const res = new FakeRes();
  await rig.svc.handleStream(fakeReq(), res as unknown as ServerResponse, { conversationId: conv.id, text: "" });
  expect(res.status).toBe(400);
});

test("concurrency: a second stream on the same conversation gets 409", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const rig = mkRig({ content: ["慢"], gate });
  const conv = rig.store.create();
  const first = rig.svc.handleStream(fakeReq(), new FakeRes() as unknown as ServerResponse, { conversationId: conv.id, text: "一" });
  await new Promise<void>((resolve) => {
    const t = setInterval(() => { if (rig.store.listMessages(conv.id).some((m) => m.role === "user")) { clearInterval(t); resolve(); } }, 5);
  });
  const res2 = new FakeRes();
  await rig.svc.handleStream(fakeReq(), res2 as unknown as ServerResponse, { conversationId: conv.id, text: "二" });
  expect(res2.status).toBe(409);
  release();
  await first;
  // after the first finishes the guard is released
  const res3 = new FakeRes();
  await rig.svc.handleStream(fakeReq(), res3 as unknown as ServerResponse, { conversationId: conv.id, text: "三" });
  expect(res3.status).toBe(200);
});

test("stop(): aborts the named stream or all of them", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const rig = mkRig({ content: ["流"], slowDeltas: false, gate });
  const conv = rig.store.create();
  const req = fakeReq();
  const p = rig.svc.handleStream(req, new FakeRes() as unknown as ServerResponse, { conversationId: conv.id, text: "q" });
  await new Promise<void>((resolve) => {
    const t = setInterval(() => { if (rig.store.listMessages(conv.id).some((m) => m.role === "user")) { clearInterval(t); resolve(); } }, 5);
  });
  expect(rig.svc.stop(conv.id)).toBe(1);     // named hit
  expect(rig.svc.stop("other")).toBe(0);     // nothing else active
  release();
  await p;
  const last = rig.store.listMessages(conv.id).at(-1)!;
  expect(last.error).toBe("aborted");        // the abort landed before the gate opened
});

test("llm failure: error frame, no done, row tagged with the message", async () => {
  const rig = mkRlmFail();
  const conv = rig.store.create();
  const res = new FakeRes();
  await rig.svc.handleStream(fakeReq(), res as unknown as ServerResponse, { conversationId: conv.id, text: "q" });
  const f = frames(res);
  expect(f.some((e) => e.type === "error" && String(e.message).includes("boom"))).toBe(true);
  expect(f.some((e) => e.type === "done")).toBe(false);
  const last = rig.store.listMessages(conv.id).at(-1)!;
  expect(last.role).toBe("assistant");
  expect(last.error).toContain("boom");
});

function mkRlmFail(): Rig {
  const runtimeDir = mkdtempSync(join(tmpdir(), "robojex-svc-"));
  const store = new ChatStore(join(runtimeDir, "chat.sqlite"));
  const gear = new GearController({ runtimeDir });
  const budget = new BudgetGovernor("burn");
  const { llm } = fakeLlm({ failWith: new Error("upstream boom") });
  return { svc: new ChatService({ store, llm, gear, budget, runtimeDir }), store, gear, budget, runtimeDir, agentEvents: [] };
}

test("mode agent: the text also reaches the orchestration loop", async () => {
  const rig = mkRig({ content: ["答"] });
  const conv = rig.store.create();
  const res = new FakeRes();
  await rig.svc.handleStream(fakeReq(), res as unknown as ServerResponse, { conversationId: conv.id, text: "派个活", mode: "agent" });
  expect(rig.agentEvents).toEqual(["chat: 派个活"]);
  expect(res.status).toBe(200); // still a streamed direct reply
});

test("unknown conversationId → 404; absent id auto-creates; empty text → 400", async () => {
  const rig = mkRig({ content: ["x"] });
  const r404 = new FakeRes();
  await rig.svc.handleStream(fakeReq(), r404 as unknown as ServerResponse, { conversationId: "nope", text: "hi" });
  expect(r404.status).toBe(404);

  const rNew = new FakeRes();
  await rig.svc.handleStream(fakeReq(), rNew as unknown as ServerResponse, { text: "新会话" });
  expect(rNew.status).toBe(200);
  expect(typeof (frames(rNew)[0] as { conversationId?: string }).conversationId).toBe("string");

  const r400 = new FakeRes();
  await rig.svc.handleStream(fakeReq(), r400 as unknown as ServerResponse, { text: "   " });
  expect(r400.status).toBe(400);
  const r400b = new FakeRes();
  await rig.svc.handleStream(fakeReq(), r400b as unknown as ServerResponse, { text: 42 as unknown as string });
  expect(r400b.status).toBe(400);
});

test("usage(): chat tokens merged with the loop's traces.sqlite cost, zero-days filled", async () => {
  const rig = mkRig({ content: ["ok"], usage: { promptTokens: 30, completionTokens: 20 } });
  const conv = rig.store.create();
  await rig.svc.handleStream(fakeReq(), new FakeRes() as unknown as ServerResponse, { conversationId: conv.id, text: "q" });
  // loop-side cost: two decision rows today via the real Auditor schema
  const auditor = new Auditor({ runtimeDir: rig.runtimeDir, reviewEvery: 9999 });
  auditor.record({ contextDigest: "wake#1", actions: [], cost: 500 });
  auditor.record({ contextDigest: "wake#2", actions: [], cost: 70 });

  const usage = rig.svc.usage(7);
  expect(usage).toHaveLength(7);
  const now = new Date();
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const today = usage.at(-1)!;
  expect(today.day).toBe(localToday);
  expect(today.tokensIn).toBe(30);            // chat stream in (title pass books only into budget)
  expect(today.tokensOut).toBe(20 + 570);     // chat stream out + 2 loop decision costs
  expect(today.calls).toBe(1 + 2);            // 1 chat stream + 2 decisions
  expect(usage[0]!.calls).toBe(0);            // six days back: zero-filled
});

test("model override flows into meta and the persisted row", async () => {
  const rig = mkRig({ content: ["x"], usage: { promptTokens: 1, completionTokens: 1 } });
  const conv = rig.store.create();
  const res = new FakeRes();
  await rig.svc.handleStream(fakeReq(), res as unknown as ServerResponse, { conversationId: conv.id, text: "q", model: "deepseek-reasoner" });
  expect(frames(res)[0]).toMatchObject({ type: "meta", model: "deepseek-reasoner" });
  expect(rig.store.listMessages(conv.id).at(-1)!.model).toBe("deepseek-reasoner");
});
