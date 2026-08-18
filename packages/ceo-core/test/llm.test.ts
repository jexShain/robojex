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
