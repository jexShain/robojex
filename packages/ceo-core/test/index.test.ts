// packages/ceo-core/test/index.test.ts
// Tests the entry script's extracted, testable pieces. index.ts only boots the
// app when executed as the main module, so importing it here is side-effect free.
import { seedRuntimeFiles, initRuntimeGit, makeShutdownHandler } from "../src/index.js";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { expect, test } from "vitest";

test("seedRuntimeFiles writes seed docs, runs dir, and the runtime .gitignore; never overwrites", () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-index-"));
  writeFileSync(join(dir, "MEMORY.md"), "custom memory\n"); // pre-existing content must survive
  seedRuntimeFiles(dir);
  expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("config.json\nboard.sqlite*\ntraces.sqlite*\npids.json\nruns/\nshots/\n");
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
