// packages/ceo-core/test/orchestrator.test.ts
import { AgentOrchestrator } from "../src/orchestrator.js";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("spawn captures tail, writes full log, summarizes via llm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-orch-"));
  let llmInput = "";
  const llm = {
    chat: async (_s: any, msgs: any) => {
      llmInput = msgs[0].content;
      return { content: "stub task done", usage: { promptTokens: 1, completionTokens: 1 } };
    },
  } as any;
  const o = new AgentOrchestrator({ llm, runtimeDir: dir, cmds: { hermes: "packages/ceo-core/test/fixtures/stub-agent.sh" } });
  const r = await o.spawn("hermes", "do the thing");
  expect(r.exitCode).toBe(0);
  expect(r.summary).toBe("stub task done");
  expect(existsSync(r.logPath)).toBe(true);
  expect(readFileSync(r.logPath, "utf8")).toContain("FINAL: stub completed");
  expect(readFileSync(r.logPath, "utf8")).toContain("line 1:"); // full log, not just tail
  expect(llmInput).toContain("FINAL: stub completed");          // llm sees the tail
});

test("timeout kills stuck agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-orch-"));
  const o = new AgentOrchestrator({ llm: null, runtimeDir: dir, cmds: { hermes: "sleep 30" } });
  const r = await o.spawn("hermes", "x", { timeoutMs: 500 });
  expect(r.exitCode).not.toBe(0);
  expect(r.summary).toContain("timeout");
});

test("no llm -> raw tail truncated as summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-orch-"));
  const o = new AgentOrchestrator({ llm: null, runtimeDir: dir, cmds: { hermes: "packages/ceo-core/test/fixtures/stub-agent.sh" } });
  const r = await o.spawn("hermes", "x");
  expect(r.summary.length).toBeGreaterThan(0);
  expect(r.summary.length).toBeLessThanOrEqual(300);
});
