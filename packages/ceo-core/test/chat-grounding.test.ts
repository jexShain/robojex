// packages/ceo-core/test/chat-grounding.test.ts
// Live-lookup grounding on the direct-chat stream: sentinel detection over
// streamed deltas, one tool round with the real result fed back, refusal
// pass-through, the 3-round cap, abort-on-sentinel, and the tools-unwired
// passthrough. The LLM stub replays per-round scripts and snapshots every
// round's messages, so the feed-back shape is asserted, not just the SSE.
import { ChatService } from "../src/chat-service.js";
import { ChatStore } from "../src/chat-store.js";
import { GearController } from "../src/gears.js";
import { BudgetGovernor } from "../src/budget.js";
import type { LLMClient, Slot, ChatMsg } from "../src/llm.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { expect, test } from "vitest";

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

type Gate = "observe" | "assist" | "full";

interface Round {
  reasoning?: string[];
  content?: string[];
  usage?: { promptTokens: number; completionTokens: number };
  failWith?: Error;
  park?: Promise<void>; // awaited before the deltas (abort-on-sentinel seam)
}

// Scripted multi-round LLM: chatStream serves rounds[i] (the last script
// repeats when the stream runs past it) and records each round's messages.
function fakeLlm(rounds: Round[]) {
  const state = {
    streamCalls: 0,
    roundMessages: [] as { role: string; content: string }[][],
  };
  const llm = {
    state,
    modelName: (_slot: Slot, override?: string) => override ?? "deepseek-v4-flash",
    async chat() { return { content: "标题", usage: { promptTokens: 1, completionTokens: 1 } }; },
    async chatStream(_slot: Slot, messages: ChatMsg[], opts: {
      signal?: AbortSignal; onReasoning?: (d: string) => void; onContent?: (d: string) => void;
    }) {
      const i = state.streamCalls++;
      state.roundMessages.push(messages.map((m) => ({ role: m.role, content: m.content })));
      const r = rounds[Math.min(i, rounds.length - 1)]!;
      if (r.park) await r.park;
      for (const d of r.reasoning ?? []) opts.onReasoning?.(d);
      for (const d of r.content ?? []) opts.onContent?.(d);
      if (r.failWith) throw r.failWith;
      return {
        content: (r.content ?? []).join(""),
        reasoning: (r.reasoning ?? []).join(""),
        usage: r.usage ?? { promptTokens: 0, completionTokens: 0 },
      };
    },
  };
  return { llm: llm as unknown as LLMClient, state };
}

// Stub tool layer: records (name, args, gate) per call and serves scripted
// results in order (the last one repeats).
function fakeTools(results: string | string[]) {
  const calls: Array<[string, Record<string, unknown>, Gate]> = [];
  let n = 0;
  const tools = {
    calls,
    async call(name: string, args: Record<string, unknown>, gate: Gate): Promise<string> {
      calls.push([name, args, gate]);
      return Array.isArray(results) ? results[Math.min(n++, results.length - 1)]! : results;
    },
    schemasBlock: (): string => "# BUILTIN TOOLS\ninvoke via {\"type\":\"tool_call\",...}\nterminal(command:string, timeout?:integer) — Run a shell command\nprocess(action:string, pid?:integer) — List processes or kill one",
  };
  return { tools, calls };
}

interface Rig {
  svc: ChatService; store: ChatStore; agentEvents: string[];
  llmState: { streamCalls: number; roundMessages: { role: string; content: string }[][] };
}
function mkRig(rounds: Round[], opts: { tools?: ReturnType<typeof fakeTools>["tools"]; gate?: () => Gate } = {}): Rig {
  const runtimeDir = mkdtempSync(join(tmpdir(), "robojex-ground-"));
  const store = new ChatStore(join(runtimeDir, "chat.sqlite"));
  const gear = new GearController({ runtimeDir });
  const agentEvents: string[] = [];
  const { llm, state } = fakeLlm(rounds);
  const svc = new ChatService({
    store, llm, gear, budget: new BudgetGovernor("burn"), runtimeDir,
    onAgentEvent: (t) => agentEvents.push(t),
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.gate ? { gate: opts.gate } : {}),
  });
  return { svc, store, agentEvents, llmState: state };
}

const run = (rig: Rig, body: Record<string, unknown>): Promise<FakeRes> => {
  const res = new FakeRes();
  return rig.svc.handleStream(fakeReq(), res as unknown as ServerResponse, body).then(() => res);
};

/* ───────────────────────── tests ───────────────────────── */

test("sentinel round: tool runs under the injected gate, the real result feeds back, the final content is grounded", async () => {
  const { tools, calls } = fakeTools("$ nvidia-smi\nexit=0\nNVIDIA GeForce RTX 5080");
  const rig = mkRig([
    { reasoning: ["想想"], content: ["<<tool:termi", 'nal>> {"command":"nvidia-smi"}'], usage: { promptTokens: 10, completionTokens: 4 } },
    { reasoning: ["看到了"], content: ["你的显卡是 ", "NVIDIA GeForce RTX 5080"], usage: { promptTokens: 20, completionTokens: 6 } },
  ], { tools, gate: () => "observe" });
  const conv = rig.store.create();
  const res = await run(rig, { conversationId: conv.id, text: "我现在机器显卡是啥啊" });

  // exact frame order: the sentinel line never reaches the client; the tool
  // frames ride after meta and before the final content. The final round
  // streams under a marker-length lag, so its two deltas land as two content
  // frames (the lag tail flushes at stream end)
  expect(frames(res).map((e) => e.type)).toEqual(
    ["meta", "reasoning", "tool", "tool", "reasoning", "content", "content", "usage", "title", "done"]);
  const [running, done] = frames(res).filter((e) => e.type === "tool");
  expect(running).toEqual({ type: "tool", name: "terminal", args: '{"command":"nvidia-smi"}', state: "running" });
  expect(done).toMatchObject({ type: "tool", name: "terminal", state: "done" });
  expect(String(done!.preview)).toContain("NVIDIA GeForce RTX 5080");
  expect(frames(res).filter((e) => e.type === "content").map((e) => e.delta).join("")).toBe("你的显卡是 NVIDIA GeForce RTX 5080");
  expect(calls).toEqual([["terminal", { command: "nvidia-smi" }, "observe"]]); // gate forwarded
  // reasoning streams from every round; usage sums across rounds
  expect(frames(res).filter((e) => e.type === "reasoning").map((e) => e.delta).join("")).toBe("想想看到了");
  expect(frames(res).find((e) => e.type === "usage")).toEqual({ type: "usage", tokensIn: 30, tokensOut: 10 });
  // one assistant row persisted: final text, both rounds' reasoning, summed tokens
  const msgs = rig.store.listMessages(conv.id);
  expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(1);
  expect(msgs.at(-1)).toMatchObject({ content: "你的显卡是 NVIDIA GeForce RTX 5080", reasoning: "想想看到了", tokensIn: 30, tokensOut: 10, error: "" });
  // round 1 saw the sentinel verbatim as assistant + the real result as a user turn
  const round1 = rig.llmState.roundMessages[1]!;
  expect(round1.at(-2)).toEqual({ role: "assistant", content: '<<tool:terminal>> {"command":"nvidia-smi"}' });
  expect(round1.at(-1)!.role).toBe("user");
  expect(round1.at(-1)!.content.startsWith("# TOOL RESULT (terminal)\n")).toBe(true);
  expect(round1.at(-1)!.content).toContain("NVIDIA GeForce RTX 5080");
  // the system prompt carries the grounding section and the tool list
  expect(rig.llmState.roundMessages[0]![0]!.content).toContain("# LIVE LOOKUP (grounding)");
  expect(rig.llmState.roundMessages[0]![0]!.content).toContain("Allowed tools:\n# BUILTIN TOOLS");
  // dual-channel push and single delegation survive the extra rounds
  expect(rig.agentEvents).toEqual(["chat: 我现在机器显卡是啥啊"]);
});

test("normal reply with tools wired: no sentinel → no tool frames, buffered deltas flush in order", async () => {
  const { tools, calls } = fakeTools("should-never-run");
  const rig = mkRig([{ content: ["你好", "，世界 很高兴见到你", "！"] }], { tools });
  const conv = rig.store.create();
  const res = await run(rig, { conversationId: conv.id, text: "打个招呼" });

  const f = frames(res);
  expect(f.some((e) => e.type === "tool")).toBe(false);
  expect(calls).toEqual([]);
  expect(rig.llmState.streamCalls).toBe(1);
  // deltas forward under a marker-length lag (a sentinel split across deltas
  // must stay catchable), so frame boundaries differ from the model's deltas —
  // what matters: nothing lost, nothing duplicated, order intact
  const deltas = f.filter((e) => e.type === "content").map((e) => e.delta);
  const whole = "你好，世界 很高兴见到你！";
  expect(deltas.join("")).toBe(whole);
  let at = 0;
  for (const d of deltas) { expect(whole.slice(at).startsWith(d)).toBe(true); at += d.length; }
});

test("mid-reply sentinel (live bug): narration first, sentinel after a newline — captured anyway, narration stays visible", async () => {
  const { tools, calls } = fakeTools("00:02.0 VGA compatible controller: NVIDIA Corporation GA104");
  const rig = mkRig([
    { content: ["检测到是 Linux，我换命令。", "\n\n<<tool:", 'terminal>> {"command":"lspci | grep -i vga"}'] },
    { content: ["真实显卡：NVIDIA GA104（lspci 实测）"] },
  ], { tools });
  const conv = rig.store.create();
  const res = await run(rig, { conversationId: conv.id, text: "显卡是啥" });

  const text = frames(res).filter((e) => e.type === "content").map((e) => e.delta).join("");
  expect(text).toContain("检测到是 Linux，我换命令。"); // narration before the sentinel stays visible
  expect(text).not.toContain("<<tool:");               // the sentinel itself never leaks
  expect(text).toContain("真实显卡：NVIDIA GA104（lspci 实测）"); // the grounded answer streams
  expect(calls).toEqual([["terminal", { command: "lspci | grep -i vga" }, "full"]]); // default gate
  const [running, done] = frames(res).filter((e) => e.type === "tool");
  expect(running).toMatchObject({ type: "tool", name: "terminal", state: "running" });
  expect(String(done!.preview)).toContain("GA104");
  // persisted content = what the client saw: narration + final answer
  expect(rig.store.listMessages(conv.id).at(-1)).toMatchObject({ content: "检测到是 Linux，我换命令。\n\n真实显卡：NVIDIA GA104（lspci 实测）" });
  // round 2's context carries the sentinel line verbatim + the real result
  const round2 = rig.llmState.roundMessages[1]!;
  expect(round2.at(-2)).toEqual({ role: "assistant", content: '<<tool:terminal>> {"command":"lspci | grep -i vga"}' });
  expect(round2.at(-1)!.content).toContain("GA104");
});

test("blocked tool result feeds back as the TOOL RESULT — the model answers on the refusal", async () => {
  const { tools } = fakeTools("error: blocked destructive command: rm (tool terminal refused; deletions are off-limits — delegate cleanup to the human)");
  const rig = mkRig([
    { content: ['<<tool:terminal>> {"command":"rm -rf /"}'] },
    { content: ["这台机器上我不能执行删除命令"] },
  ], { tools });
  const conv = rig.store.create();
  const res = await run(rig, { conversationId: conv.id, text: "删掉那个目录" });

  expect(frames(res).at(-1)).toMatchObject({ type: "done" });
  expect(frames(res).filter((e) => e.type === "content").map((e) => e.delta).join("")).toBe("这台机器上我不能执行删除命令");
  const fed = rig.llmState.roundMessages[1]!.find((m) => m.role === "user" && m.content.startsWith("# TOOL RESULT (terminal)"));
  expect(fed!.content).toContain("blocked destructive command");
});

test("round cap: a model that always sentinels is cut off after 3 tool rounds", async () => {
  const { tools, calls } = fakeTools("exit=0");
  const rig = mkRig([
    { content: ['<<tool:terminal>> {"command":"echo 1"}'] },
    { content: ['<<tool:terminal>> {"command":"echo 2"}'] },
    { content: ['<<tool:terminal>> {"command":"echo 3"}'] },
    { content: ["好吧，直接回答"] },
  ], { tools });
  const conv = rig.store.create();
  const res = await run(rig, { conversationId: conv.id, text: "查一下" });

  expect(rig.llmState.streamCalls).toBe(4); // 3 tool rounds + 1 forced direct round
  expect(calls.map((c) => c[1])).toEqual([{ command: "echo 1" }, { command: "echo 2" }, { command: "echo 3" }]);
  const toolFrames = frames(res).filter((e) => e.type === "tool");
  expect(toolFrames).toHaveLength(6); // running + done per execution
  expect(toolFrames.filter((e) => e.state === "running").map((e) => e.args)).toEqual(['{"command":"echo 1"}', '{"command":"echo 2"}', '{"command":"echo 3"}']);
  // the capped round carries the stop note and streams without detection
  const last = rig.llmState.roundMessages[3]!;
  expect(last.some((m) => m.role === "system" && m.content.includes("No more tool calls allowed"))).toBe(true);
  expect(frames(res).filter((e) => e.type === "content").map((e) => e.delta).join("")).toBe("好吧，直接回答");
});

test("tools unwired: no LIVE LOOKUP section, sentinel-shaped text streams through verbatim", async () => {
  const rig = mkRig([{ content: ['<<tool:terminal>> {"command":"ls"}', "（以上只是普通文本）"] }]);
  const conv = rig.store.create();
  const res = await run(rig, { conversationId: conv.id, text: "随便说说" });

  expect(rig.llmState.roundMessages[0]![0]!.content).not.toContain("# LIVE LOOKUP");
  expect(rig.llmState.streamCalls).toBe(1);
  const f = frames(res);
  expect(f.some((e) => e.type === "tool")).toBe(false);
  expect(f.filter((e) => e.type === "content").map((e) => e.delta).join("")).toBe('<<tool:terminal>> {"command":"ls"}（以上只是普通文本）');
});

test("malformed sentinel args: the first {...} fallback parses; a hopeless line feeds an error text back", async () => {
  // args wrapped in prose: the strict group fails, the brace-blob fallback parses
  const { tools, calls } = fakeTools("exit=0\nok");
  const rig = mkRig([
    { content: ['<<tool:terminal>> command=nvidia-smi {"command":"nvidia-smi"}'] },
    { content: ["查到了"] },
  ], { tools });
  const conv = rig.store.create();
  await run(rig, { conversationId: conv.id, text: "显卡" });
  expect(calls).toEqual([["terminal", { command: "nvidia-smi" }, "full"]]); // gate defaults to full

  // a line with no JSON at all: the error text becomes the TOOL RESULT
  const { tools: t2, calls: c2 } = fakeTools("never");
  const rig2 = mkRig([
    { content: ["<<tool:terminal>>"] },
    { content: ["那我直接回答"] },
  ], { tools: t2 });
  const conv2 = rig2.store.create();
  const res2 = await run(rig2, { conversationId: conv2.id, text: "显卡" });
  expect(c2).toEqual([]);
  const fed = rig2.llmState.roundMessages[1]!.find((m) => m.role === "user" && m.content.startsWith("# TOOL RESULT"));
  expect(fed!.content).toContain("# TOOL RESULT (terminal)");
  expect(fed!.content).toContain("error: unparseable arguments");
  expect(frames(res2).filter((e) => e.type === "content").map((e) => e.delta).join("")).toBe("那我直接回答");
});

test("abort lands on the sentinel line: no tool executes, the row settles as aborted", async () => {
  const { tools, calls } = fakeTools("never");
  let release: () => void = () => {};
  const park = new Promise<void>((r) => { release = r; });
  const rig = mkRig([
    { content: ['<<tool:terminal>> {"command":"nvidia-smi"}'], park },
    { content: ["unused"] },
  ], { tools });
  const req = fakeReq();
  const res = new FakeRes();
  const conv = rig.store.create();
  const p = rig.svc.handleStream(req, res as unknown as ServerResponse, { conversationId: conv.id, text: "显卡" });
  await new Promise((r) => setTimeout(r, 15)); // sentinel deltas consumed, stream parked
  req.emit("close"); // client stops exactly before the tool would run
  release();
  await p;

  expect(calls).toEqual([]); // the abort guard skipped execution
  const f = frames(res);
  expect(f.some((e) => e.type === "tool")).toBe(false);
  expect(f.some((e) => e.type === "done")).toBe(true);
  expect(rig.store.listMessages(conv.id).at(-1)!.error).toBe("aborted");
  expect(rig.llmState.streamCalls).toBe(1); // no fed-back second round
});
