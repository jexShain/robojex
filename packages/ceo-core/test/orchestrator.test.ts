// packages/ceo-core/test/orchestrator.test.ts
// Integration tests against real OS subprocesses: fake timers cannot advance a
// real `sleep`, so short real-time polling (not fixed sleeps) is used throughout.
import { AgentOrchestrator } from "../src/orchestrator.js";
import type { LLMClient, ChatMsg, Slot } from "../src/llm.js";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

// Shared real-time polling step (single wait primitive for all process tests).
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// SIGKILLed pids may linger as zombies until init reaps them; poll until kill(pid,0) throws ESRCH.
async function waitForDeath(pid: number, tries = 50): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { process.kill(pid, 0); await tick(100); } catch { return true; }
  }
  return false;
}

test("spawn captures tail, writes full log, summarizes via llm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-orch-"));
  let llmInput = "";
  const llm = {
    chat: async (_slot: Slot, msgs: ChatMsg[]) => {
      llmInput = msgs[0].content;
      return { content: "stub task done", usage: { promptTokens: 1, completionTokens: 1 } };
    },
    // chat-only stub; LLMClient's private fields make the class nominal, so a structural cast is required
  } as unknown as LLMClient;
  const o = new AgentOrchestrator({ llm, runtimeDir: dir, cmds: { hermes: "packages/ceo-core/test/fixtures/stub-agent.sh" } });
  const r = await o.spawn("hermes", "do the thing");
  expect(r.exitCode).toBe(0);
  expect(r.summary).toBe("stub task done");
  expect(r.summaryUsage).toEqual({ promptTokens: 1, completionTokens: 1 }); // llm summary cost surfaced
  expect(existsSync(r.logPath)).toBe(true);
  expect(readFileSync(r.logPath, "utf8")).toContain("FINAL: stub completed");
  expect(readFileSync(r.logPath, "utf8")).toContain("line 1:"); // full log, not just tail
  expect(llmInput).toContain("FINAL: stub completed");          // llm sees the tail
});

test("timeout kills stuck agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-orch-"));
  const o = new AgentOrchestrator({ llm: null, runtimeDir: dir, cmds: { hermes: "sleep" } });
  const r = await o.spawn("hermes", "30", { timeoutMs: 500 });
  expect(r.exitCode).not.toBe(0);
  expect(r.summary).toContain("timeout");
  expect(r.summaryUsage).toBeNull(); // no llm attached -> no summary tokens
});

test("no llm -> raw tail truncated as summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-orch-"));
  const o = new AgentOrchestrator({ llm: null, runtimeDir: dir, cmds: { hermes: "packages/ceo-core/test/fixtures/stub-agent.sh" } });
  const r = await o.spawn("hermes", "x");
  expect(r.summary.length).toBeLessThanOrEqual(300);
  expect(r.summaryUsage).toBeNull();
});

test("timeout kills entire process group including grandchildren", async () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-orch-"));
  const pidFile = join(dir, "grandchild.pid");
  const o = new AgentOrchestrator({
    llm: null, runtimeDir: dir,
    cmds: { hermes: `bash -c 'sleep 30 & echo $! > ${pidFile}; wait'` },
  });
  const p = o.spawn("hermes", "x", { timeoutMs: 1500 });
  let gpid = -1;
  for (let i = 0; i < 100 && gpid < 0; i++) {
    if (existsSync(pidFile)) gpid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    else await tick(10);
  }
  expect(gpid).toBeGreaterThan(0);
  expect(() => process.kill(gpid, 0)).not.toThrow(); // grandchild alive under the agent
  const r = await p;
  expect(r.summary).toContain("timeout");
  expect(await waitForDeath(gpid)).toBe(true); // grandchild died with the group
});

test("pid ledger: crash leftovers are reaped by a fresh orchestrator", async () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-orch-"));
  const ledger = join(dir, "pids.json");
  const crashed = new AgentOrchestrator({ llm: null, runtimeDir: dir, cmds: { hermes: "sleep" } });
  const p = crashed.spawn("hermes", "30"); // simulate jex crash: no killAll, no cleanup
  let pid = -1;
  for (let i = 0; i < 200 && pid < 0; i++) {
    if (existsSync(ledger)) {
      try {
        const a = JSON.parse(readFileSync(ledger, "utf8"));
        if (Array.isArray(a) && a.length) pid = a[0];
      } catch { /* ledger not fully visible yet */ }
    }
    if (pid < 0) await tick(10);
  }
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).not.toThrow(); // orphan still alive after "crash"
  new AgentOrchestrator({ llm: null, runtimeDir: dir }).reapOrphans();
  expect(await waitForDeath(pid)).toBe(true);
  expect(JSON.parse(readFileSync(ledger, "utf8"))).toEqual([]); // ledger drained
  const r = await p; // close handler still resolves after external reap
  expect(r.exitCode).not.toBe(0);
});

test("maxConcurrent (default 2) queues excess spawns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-orch-"));
  const actDir = join(dir, "active");
  mkdirSync(actDir);
  const o = new AgentOrchestrator({
    llm: null, runtimeDir: dir,
    cmds: { hermes: `bash -c 'touch ${actDir}/$$; sleep 0.5; rm -f ${actDir}/$$'` },
  });
  let peak = 0;
  const iv = setInterval(() => { peak = Math.max(peak, readdirSync(actDir).length); }, 15);
  const rs = await Promise.all([o.spawn("hermes", "a"), o.spawn("hermes", "b"), o.spawn("hermes", "c")]);
  clearInterval(iv);
  expect(rs.map((x) => x.exitCode)).toEqual([0, 0, 0]);
  expect(peak).toBeGreaterThan(1);      // overlap was observed
  expect(peak).toBeLessThanOrEqual(2);  // cap held: never 3 concurrent
});

test("spawn of missing command resolves instead of hanging", async () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-orch-"));
  const o = new AgentOrchestrator({ llm: null, runtimeDir: dir, cmds: { hermes: "no-such-cmd-robojex-xyz" } });
  const r = await o.spawn("hermes", "x", { timeoutMs: 5000 });
  expect(r.exitCode).not.toBe(0);
  expect(r.summary.length).toBeGreaterThan(0);
});

test("default hermes path passes the prompt exactly once (no double append)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-orch-"));
  const argvFile = join(dir, "argv.txt");
  // fake `hermes` binary on PATH: records its argv, one argument per line
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "hermes"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${argvFile}\necho fake-hermes-ok\n`);
  chmodSync(join(binDir, "hermes"), 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}:${prevPath}`;
  try {
    const o = new AgentOrchestrator({ llm: null, runtimeDir: dir }); // no cmds override: DEFAULT_CMDS path
    const r = await o.spawn("hermes", "unique prompt marker zq7", { timeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    expect(argv).toEqual(["-z", "unique prompt marker zq7", "--yolo"]);
    expect(argv.filter((a) => a === "unique prompt marker zq7").length).toBe(1); // prompt appears once
  } finally {
    process.env.PATH = prevPath;
  }
});
