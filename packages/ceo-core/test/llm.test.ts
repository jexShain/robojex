// packages/ceo-core/test/llm.test.ts
import { LLMClient } from "../src/llm.js";
import { expect, test, vi } from "vitest";

const okBody = JSON.stringify({
  choices: [{ message: { content: "hello" } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

test("chat parses content and usage", async () => {
  const f = vi.fn(async () => new Response(okBody, { status: 200 })) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const r = await c.chat("patrol", [{ role: "user", content: "hi" }]);
  expect(r.content).toBe("hello");
  expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
});

test("retries on 5xx then succeeds", async () => {
  let n = 0;
  const f = vi.fn(async () => { if (++n < 3) return new Response("err", { status: 500 }); return new Response(okBody, { status: 200 }); }) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const r = await c.chat("decide", [{ role: "user", content: "hi" }]);
  expect(r.content).toBe("hello");
  expect(f).toHaveBeenCalledTimes(3);
});

test("throws after 3 consecutive failures", async () => {
  const f = vi.fn(async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  await expect(c.chat("patrol", [{ role: "user", content: "hi" }])).rejects.toThrow();
});

test("4xx does not retry - fetch called once", async () => {
  const f = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  await expect(c.chat("patrol", [{ role: "user", content: "hi" }])).rejects.toThrow();
  expect(f).toHaveBeenCalledTimes(1);
});

test("opts.json true includes response_format in request body", async () => {
  let requestBody = "";
  const f = vi.fn(async (url: string, init: RequestInit) => {
    requestBody = init.body as string;
    return new Response(okBody, { status: 200 });
  }) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  await c.chat("patrol", [{ role: "user", content: "hi" }], { json: true });
  const body = JSON.parse(requestBody);
  expect(body.response_format).toEqual({ type: "json_object" });
});

test("maxTokens passed as max_tokens in request body", async () => {
  let requestBody = "";
  const f = vi.fn(async (url: string, init: RequestInit) => {
    requestBody = init.body as string;
    return new Response(okBody, { status: 200 });
  }) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  await c.chat("patrol", [{ role: "user", content: "hi" }], { maxTokens: 1234 });
  const body = JSON.parse(requestBody);
  expect(body.max_tokens).toBe(1234);
});

/* ───────────────── chatStream ───────────────── */

const frame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const enc = new TextEncoder();

// An SSE Response whose body enqueues the given chunks one by one.
function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

test("chatStream: parses reasoning + content deltas across split chunks, usage, [DONE]", async () => {
  const f = vi.fn(async () => sseResponse([
    frame({ choices: [{ delta: { reasoning_content: "先想" } }] }),
    `data: {"choices":[{"delta":{"conte`,          // frame split mid-JSON
    `nt":"你"}}]}\n\n`,
    frame({ choices: [{ delta: { content: "好" } }] }),
    `data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":6}}\n\n`,
    `data: [DONE]\n\n`,
    frame({ choices: [{ delta: { content: "AFTER DONE — must be ignored" } }] }), // cancelled at [DONE]
  ])) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const reasoning: string[] = [];
  const content: string[] = [];
  const r = await c.chatStream("patrol", [{ role: "user", content: "hi" }], {
    onReasoning: (d) => reasoning.push(d),
    onContent: (d) => content.push(d),
  });
  expect(reasoning).toEqual(["先想"]);
  expect(content).toEqual(["你", "好"]);
  expect(r).toEqual({ content: "你好", reasoning: "先想", usage: { promptTokens: 12, completionTokens: 6 } });
  const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
  expect(body.stream).toBe(true);
  expect(body.stream_options).toEqual({ include_usage: true });
});

test("chatStream: retries connection failures with backoff, succeeds on attempt 3", async () => {
  let n = 0;
  const f = vi.fn(async () => {
    n++;
    if (n < 3) throw new Error("ECONNREFUSED");
    return sseResponse([frame({ choices: [{ delta: { content: "ok" } }] }), "data: [DONE]\n\n"]);
  }) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const r = await c.chatStream("decide", [{ role: "user", content: "hi" }]);
  expect(r.content).toBe("ok");
  expect(f).toHaveBeenCalledTimes(3);
}, 10_000);

test("chatStream: 5xx retried, 4xx fails fast with one call", async () => {
  let n = 0;
  const f5 = vi.fn(async () => { n++; return n < 2 ? new Response("err", { status: 502 }) : sseResponse(["data: [DONE]\n\n"]); }) as unknown as typeof fetch;
  const c5 = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f5);
  await expect(c5.chatStream("patrol", [])).resolves.toMatchObject({ content: "" });
  expect(f5).toHaveBeenCalledTimes(2);

  const f4 = vi.fn(async () => new Response("no key", { status: 401 })) as unknown as typeof fetch;
  const c4 = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f4);
  await expect(c4.chatStream("patrol", [])).rejects.toThrow(/401/);
  expect(f4).toHaveBeenCalledTimes(1);
});

test("chatStream: once the stream started, a mid-stream failure never retries", async () => {
  const f = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(frame({ choices: [{ delta: { content: "部分" } }] })));
      setTimeout(() => { try { controller.error(new Error("socket reset")); } catch { /* already closed */ } }, 0); // after the delta is read
    },
  }), { status: 200 })) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const got: string[] = [];
  await expect(c.chatStream("patrol", [], { onContent: (d) => got.push(d) })).rejects.toThrow(/socket reset/);
  expect(f).toHaveBeenCalledTimes(1); // deltas already delivered: no second attempt
  expect(got).toEqual(["部分"]);
});

test("chatStream: AbortSignal rejects immediately, no retry", async () => {
  const f = vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(frame({ choices: [{ delta: { content: "片段" } }] })));
      init.signal?.addEventListener("abort", () => { try { controller.error(new Error("aborted")); } catch { /* already closed */ } });
    },
  }), { status: 200 })) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const ctl = new AbortController();
  const p = c.chatStream("patrol", [], { signal: ctl.signal });
  ctl.abort();
  await expect(p).rejects.toThrow();
  expect(f).toHaveBeenCalledTimes(1);
});

test("chatStream: model override replaces the slot default", async () => {
  let body = "";
  const f = vi.fn(async (_url: string, init: RequestInit) => {
    body = init.body as string;
    return sseResponse(["data: [DONE]\n\n"]);
  }) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  await c.chatStream("patrol", [], { model: "deepseek-reasoner" });
  expect(JSON.parse(body).model).toBe("deepseek-reasoner");
  expect(c.modelName("patrol")).toBe("p");
  expect(c.modelName("decide", "override")).toBe("override");
});

/* ───────────────── listModels ───────────────── */

test("listModels: success caches 10 minutes; failure falls back to the configured models", async () => {
  let calls = 0;
  const ok = vi.fn(async () => { calls++; return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 }); }) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, ok);
  expect(await c.listModels()).toEqual(["m1", "m2"]);
  expect(await c.listModels()).toEqual(["m1", "m2"]);
  expect(calls).toBe(1); // cache hit

  const fail = vi.fn(async () => { throw new Error("down"); }) as unknown as typeof fetch;
  const c2 = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "same", decideModel: "same" }, fail);
  expect(await c2.listModels()).toEqual(["same"]); // deduped fallback
  const fail4 = vi.fn(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
  const c3 = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "a", decideModel: "b" }, fail4);
  expect(await c3.listModels()).toEqual(["a", "b"]);
});

test("empty config models fall back per slot (decide needs non-thinking JSON)", () => {
  const f = vi.fn(async () => new Response(okBody, { status: 200 })) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "", decideModel: "" }, f);
  expect(c.modelName("patrol")).toBe("deepseek-v4-flash");
  expect(c.modelName("decide")).toBe("deepseek-chat");
  expect(c.modelName("decide", "override")).toBe("override");
});
