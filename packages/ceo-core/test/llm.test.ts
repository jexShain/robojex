// packages/ceo-core/test/llm.test.ts
import { LLMClient, LLMError, llmErrorMessage } from "../src/llm.js";
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

/* ───────────────── error codes & retry policy ───────────────── */

// Catches the rejection and hands the thrown value back for inspection.
const rejectsWith = async (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

test("401 → LLMError AUTH and never retries", async () => {
  const f = vi.fn(async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const err = await rejectsWith(c.chat("patrol", [{ role: "user", content: "hi" }]));
  expect(err).toBeInstanceOf(LLMError);
  expect((err as LLMError).code).toBe("AUTH");
  expect((err as LLMError).status).toBe(401);
  expect(f).toHaveBeenCalledTimes(1);
});

test("402 → LLMError QUOTA and never retries", async () => {
  const f = vi.fn(async () => new Response("insufficient balance", { status: 402 })) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const err = await rejectsWith(c.chat("patrol", [{ role: "user", content: "hi" }]));
  expect((err as LLMError).code).toBe("QUOTA");
  expect(f).toHaveBeenCalledTimes(1);
});

test("429 whose body says quota is QUOTA (exhaustion beats rate limit)", async () => {
  const f = vi.fn(async () => new Response("You exceeded your quota", { status: 429 })) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const err = await rejectsWith(c.chat("patrol", [{ role: "user", content: "hi" }]));
  expect((err as LLMError).code).toBe("QUOTA");
  expect(f).toHaveBeenCalledTimes(1);
});

test("400 with context-window body → LLMError CONTEXT_WINDOW and never retries", async () => {
  const f = vi.fn(async () => new Response("maximum context length exceeded", { status: 400 })) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const err = await rejectsWith(c.chat("patrol", [{ role: "user", content: "hi" }]));
  expect((err as LLMError).code).toBe("CONTEXT_WINDOW");
  expect(f).toHaveBeenCalledTimes(1);
});

test("persistent 5xx exhausts retries and throws LLMError SERVER", async () => {
  const f = vi.fn(async () => new Response("boom", { status: 503 })) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const err = await rejectsWith(c.chat("patrol", [{ role: "user", content: "hi" }]));
  expect((err as LLMError).code).toBe("SERVER");
  expect(f).toHaveBeenCalledTimes(3);
});

test("429 with Retry-After waits out the header delay (not raw backoff), then succeeds", async () => {
  // Fake only what the retry loop needs: backoff sleeps and the clock the
  // assertion reads — real promise scheduling stays untouched.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      return n === 1
        ? new Response("rate limited", { status: 429, headers: { "retry-after": "2" } })
        : new Response(okBody, { status: 200 });
    }) as unknown as typeof fetch;
    const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
    const t0 = Date.now();
    const p = c.chat("patrol", [{ role: "user", content: "hi" }]);
    await vi.advanceTimersByTimeAsync(1999); // past the 200ms backoff, short of Retry-After
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r.content).toBe("hello");
    expect(f).toHaveBeenCalledTimes(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2000); // Retry-After governed the wait
  } finally {
    vi.useRealTimers();
  }
});

const emptyBody = JSON.stringify({ choices: [], usage: {} });

test("empty choices: one re-ask, still empty → LLMError EMPTY", async () => {
  const f = vi.fn(async () => new Response(emptyBody, { status: 200 })) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const err = await rejectsWith(c.chat("patrol", [{ role: "user", content: "hi" }]));
  expect(err).toBeInstanceOf(LLMError);
  expect((err as LLMError).code).toBe("EMPTY");
  expect(f).toHaveBeenCalledTimes(2); // initial + exactly one re-ask
});

test("null content: one re-ask recovers when the retry answers", async () => {
  let n = 0;
  const f = vi.fn(async () => {
    n++;
    return n === 1
      ? new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: null } }] }), { status: 200 })
      : new Response(okBody, { status: 200 });
  }) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const r = await c.chat("decide", [{ role: "user", content: "hi" }]);
  expect(r.content).toBe("hello");
  expect(f).toHaveBeenCalledTimes(2);
});

test("null content with tool finish_reason passes through (not treated as empty)", async () => {
  const toolBody = JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { content: null } }] });
  const f = vi.fn(async () => new Response(toolBody, { status: 200 })) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const r = await c.chat("patrol", [{ role: "user", content: "hi" }]);
  expect(r.content).toBe("");
  expect(f).toHaveBeenCalledTimes(1); // tool finish is legitimate: no re-ask
});

test("fetch TypeError → NETWORK, retried, then succeeds", async () => {
  let n = 0;
  const f = vi.fn(async () => {
    n++;
    if (n === 1) throw new TypeError("fetch failed");
    return new Response(okBody, { status: 200 });
  }) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const r = await c.chat("patrol", [{ role: "user", content: "hi" }]);
  expect(r.content).toBe("hello");
  expect(f).toHaveBeenCalledTimes(2);
});

test("persistent network failure exhausts retries and throws LLMError NETWORK", async () => {
  const f = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const err = await rejectsWith(c.chat("patrol", [{ role: "user", content: "hi" }]));
  expect(err).toBeInstanceOf(LLMError);
  expect((err as LLMError).code).toBe("NETWORK");
  expect(f).toHaveBeenCalledTimes(3);
});

test("hostile non-Error throw surfaces as a safe message", async () => {
  const f = vi.fn(async () => { throw { weird: 1 }; }) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const err = await rejectsWith(c.chat("patrol", [{ role: "user", content: "hi" }]));
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe("[object Object]"); // llmErrorMessage, not a crash
});

test("llmErrorMessage normalizes hostile throws safely", () => {
  expect(llmErrorMessage(new Error("boom"))).toBe("boom");
  expect(llmErrorMessage("plain string")).toBe("plain string");
  expect(llmErrorMessage({ weird: 1 })).toBe("[object Object]");
  expect(llmErrorMessage("")).toBe("unknown llm error");
  expect(llmErrorMessage("   ")).toBe("unknown llm error");
  expect(llmErrorMessage({ toString() { throw new Error("hostile"); } })).toBe("unknown llm error");
  expect(llmErrorMessage("x".repeat(400))).toHaveLength(300); // truncated at 300 chars
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

test("chatStream: 429 is retryable and honors Retry-After before streaming", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      return n === 1
        ? new Response("rate limited", { status: 429, headers: { "retry-after": "1" } })
        : sseResponse([frame({ choices: [{ delta: { content: "ok" } }] }), "data: [DONE]\n\n"]);
    }) as unknown as typeof fetch;
    const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
    const p = c.chatStream("patrol", []);
    await vi.advanceTimersByTimeAsync(999); // before the header delay: no second call yet
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r.content).toBe("ok");
    expect(f).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
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

test("chatStream: stream that stalls mid-answer is cut by the idle watchdog → TIMEOUT, no retry", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    // one delta, then the body goes silent forever (never closes, never errors)
    const f = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(enc.encode(frame({ choices: [{ delta: { content: "部分" } }] }))); },
    }), { status: 200 })) as unknown as typeof fetch;
    const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
    const got: string[] = [];
    const p = c.chatStream("patrol", [], { onContent: (d) => got.push(d) });
    const outcome = rejectsWith(p); // handler attached up front: the rejection fires during timer advancement
    await vi.advanceTimersByTimeAsync(0); // flush: the delta is read and the watchdog arms at t=0
    expect(got).toEqual(["部分"]);
    await vi.advanceTimersByTimeAsync(119_999); // silent, but under the wire
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 120s of silence (STREAM_IDLE_MS): watchdog cancels the reader
    const err = await outcome;
    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).code).toBe("TIMEOUT");
    expect((err as LLMError).message).toMatch(/idle 120s/);
    expect(f).toHaveBeenCalledTimes(1); // frames were already delivered: mid-stream, never retried
    expect(got).toEqual(["部分"]);
  } finally {
    vi.useRealTimers();
  }
});

test("chatStream: fetch that never settles is cut by the attempt deadline; TIMEOUT retries pre-start", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let n = 0;
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      n++;
      if (n === 1) return new Promise<Response>((resolve, reject) => {
        void resolve; // never resolves: the only way out is the fetch signal aborting
        init.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      });
      return sseResponse([frame({ choices: [{ delta: { content: "ok" } }] }), "data: [DONE]\n\n"]);
    }) as unknown as typeof fetch;
    const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
    const p = c.chatStream("patrol", []);
    await vi.advanceTimersByTimeAsync(0); // attempt 1 launched, fetch pending forever
    await vi.advanceTimersByTimeAsync(180_000); // ATTEMPT_DEADLINE_MS: deadline aborts → fetch rejects → TIMEOUT (no frames yet) → backoff armed
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400); // backoff (200ms) elapses → attempt 2 streams a full answer
    const r = await p;
    expect(r.content).toBe("ok");
    expect(f).toHaveBeenCalledTimes(2); // TIMEOUT before any frame is retryable, like NETWORK/5xx
  } finally {
    vi.useRealTimers();
  }
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

test("thinking mode: default OFF, config flag enables, setThinking hot-flips, noThinking overrides", async () => {
  const bodyAt = (f: ReturnType<typeof vi.fn>): Record<string, unknown> =>
    JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
  // 1) absent config = disabled (the product default beats the provider default)
  const f1 = vi.fn(async () => new Response(okBody, { status: 200 })) as unknown as typeof fetch;
  const c1 = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f1 as never);
  await c1.chat("patrol", [{ role: "user", content: "hi" }]);
  expect(bodyAt(f1 as ReturnType<typeof vi.fn>).thinking).toEqual({ type: "disabled" });
  // 2) thinking: true = enabled on both chat and stream
  const f2 = vi.fn(async () => new Response(okBody, { status: 200 })) as unknown as typeof fetch;
  const c2 = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d", thinking: true }, f2 as never);
  await c2.chat("patrol", [{ role: "user", content: "hi" }]);
  expect(bodyAt(f2 as ReturnType<typeof vi.fn>).thinking).toEqual({ type: "enabled" });
  // 3) settings hot-flip takes effect on the next request
  c2.setThinking(false);
  (f2 as ReturnType<typeof vi.fn>).mockClear();
  await c2.chat("patrol", [{ role: "user", content: "hi" }]);
  expect(bodyAt(f2 as ReturnType<typeof vi.fn>).thinking).toEqual({ type: "disabled" });
  // 4) noThinking beats an enabled global (title generation never reasons)
  c2.setThinking(true);
  (f2 as ReturnType<typeof vi.fn>).mockClear();
  await c2.chat("patrol", [{ role: "user", content: "hi" }], { noThinking: true });
  expect(bodyAt(f2 as ReturnType<typeof vi.fn>).thinking).toEqual({ type: "disabled" });
});
