// packages/ceo-core/test/index.test.ts
// Tests the entry script's extracted, testable pieces. index.ts only boots the
// app when executed as the main module, so importing it here is side-effect free.
import { seedRuntimeFiles, initRuntimeGit, makeShutdownHandler, resolveBudgetConfig, assembleAndStart } from "../src/index.js";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { expect, test, vi } from "vitest";

test("seedRuntimeFiles writes seed docs, runs dir, and the runtime .gitignore; never overwrites", () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-index-"));
  writeFileSync(join(dir, "MEMORY.md"), "custom memory\n"); // pre-existing content must survive
  seedRuntimeFiles(dir);
  expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("config.json\nboard.sqlite*\ntraces.sqlite*\npids.json\nruns/\nshots/\nTOOLS.md\ntool-manuals/\nPENDING_INSTALLS.md\nTENTACLES.md\ntentacles/\ntentacle-manuals/\n");
  expect(readFileSync(join(dir, "MISSION.md"), "utf8")).toContain("# MISSION");
  expect(readFileSync(join(dir, "RUBRIC.md"), "utf8")).toContain("# RUBRIC");
  expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toBe("custom memory\n");
  expect(statSync(join(dir, "runs")).isDirectory()).toBe(true);
});

test("initRuntimeGit: seed docs added per-file, never 'add -A', missing files tolerated", () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-index-"));
  const cmds: string[] = [];
  const out = initRuntimeGit(dir, (cmd) => {
    cmds.push(cmd);
    if (cmd.includes("RUBRIC.md")) throw new Error("simulated missing file"); // per-file tolerance
  });
  expect(cmds.some((c) => c.includes(" add -A") || c.endsWith(" add ."))).toBe(false);
  const adds = cmds.filter((c) => c.includes(" add "));
  expect(adds.map((c) => c.split(" add ")[1])).toEqual(["MISSION.md", "RUBRIC.md", "MEMORY.md"]);
  expect(cmds.some((c) => c.includes("commit"))).toBe(true); // commit still happens despite one failed add
  expect(out).toEqual(cmds);
});

test("initRuntimeGit (real git): history contains only the three seed docs — never config.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-index-"));
  seedRuntimeFiles(dir);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ apiKey: "sk-TEST-SECRET" }));
  initRuntimeGit(dir);
  const tracked = execSync("git ls-files", { cwd: dir }).toString().trim().split("\n").sort();
  expect(tracked).toEqual(["MEMORY.md", "MISSION.md", "RUBRIC.md"]); // .gitignore + config.json stay untracked
  // the API key must not appear anywhere in git history
  const blobs = execSync("git cat-file --batch-all-objects --batch-check", { cwd: dir }).toString()
    .trim().split("\n").filter((l) => l.split(" ")[1] === "blob").map((l) => l.split(" ")[0]);
  for (const sha of blobs) {
    expect(execSync(`git cat-file blob ${sha}`, { cwd: dir }).toString()).not.toContain("sk-TEST-SECRET");
  }
  expect(initRuntimeGit(dir)).toEqual([]); // idempotent: existing .git is left alone
});

test("shutdown handler: loop.stop() first, then orchestrator.killAll(), then exit", () => {
  const order: string[] = [];
  const handler = makeShutdownHandler(
    { stop: () => order.push("stop") },
    { killAll: () => order.push("killAll") },
    () => order.push("exit"),
  );
  handler();
  expect(order).toEqual(["stop", "killAll", "exit"]);
});

test("resolveBudgetConfig: bad mode and budgeted-without-cap warn and fall back to burn", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    // unknown mode string: fall back to burn, warn
    expect(resolveBudgetConfig({ budgetMode: "turbo" as unknown as "burn" })).toEqual({ budgetMode: "burn", dailyTokens: 0 });
    // budgeted without a usable dailyTokens cap: burn again (BudgetGovernor
    // would treat it as unlimited — exactly what the operator did not ask for)
    expect(resolveBudgetConfig({ budgetMode: "budgeted" })).toEqual({ budgetMode: "burn", dailyTokens: 0 });
    expect(resolveBudgetConfig({ budgetMode: "budgeted", dailyTokens: 0 })).toEqual({ budgetMode: "burn", dailyTokens: 0 });
    expect(warn).toHaveBeenCalledTimes(3);

    // valid configurations pass through untouched and never warn
    expect(resolveBudgetConfig({ budgetMode: "budgeted", dailyTokens: 5000 })).toEqual({ budgetMode: "budgeted", dailyTokens: 5000 });
    expect(resolveBudgetConfig({})).toEqual({ budgetMode: "burn", dailyTokens: 0 });
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("budgetMode"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dailyTokens"));
  } finally {
    warn.mockRestore();
  }
});

test("assembleAndStart: the loop is not just built but started — default 60s tick, cfg.tickMs honored, stop() runs shutdown", () => {
  const mkLoop = () => {
    const started: (number | undefined)[] = [];
    return { loop: { start: (t?: number) => started.push(t), stop: vi.fn(), push: vi.fn() }, started };
  };
  // TOOLS.md/TENTACLES.md seeded: skips the background scout + hardware pass
  const mkDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "robojex-asm-"));
    seedRuntimeFiles(dir);
    writeFileSync(join(dir, "TOOLS.md"), "- demo (demo) — demo tool [vd-1] verified 2026-01-01\n");
    writeFileSync(join(dir, "TENTACLES.md"), "\n");
    return dir;
  };

  const a = mkLoop();
  const assembled = assembleAndStart({ apiPort: 0 }, mkDir(), { loopFactory: () => a.loop, exit: () => {} });
  expect(assembled.loop).toBe(a.loop);
  expect(a.started).toEqual([60_000]); // a refactor that drops loop.start() must turn this red
  assembled.stop();
  expect(a.loop.stop).toHaveBeenCalledTimes(1);

  const b = mkLoop();
  const assembledB = assembleAndStart({ apiPort: 0, tickMs: 1234 }, mkDir(), { loopFactory: () => b.loop, exit: () => {} });
  expect(b.started).toEqual([1234]);
  assembledB.stop(); // also tears the api listener down: no port leaks between runs
});
