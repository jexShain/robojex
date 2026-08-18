// packages/ceo-core/test/auditor.test.ts
import { Auditor } from "../src/auditor.js";
import type { LLMClient } from "../src/llm.js";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { expect, test } from "vitest";

function runtimeWithFiles() {
  const dir = mkdtempSync(join(tmpdir(), "robojex-audit-"));
  writeFileSync(join(dir, "RUBRIC.md"), "# RUBRIC\n- decide quickly\n");
  writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n");
  execSync("git init -q", { cwd: dir });
  execSync("git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: dir });
  return dir;
}

test("records traces, review due at N, patches committed before applied", async () => {
  const dir = runtimeWithFiles();
  const a = new Auditor({ runtimeDir: dir, reviewEvery: 3 });
  expect(a.due()).toBe(false);
  a.record({ contextDigest: "d1", actions: [{ a: 1 }], cost: 10 });
  a.record({ contextDigest: "d2", actions: [{ a: 2 }], cost: 20 });
  expect(a.due()).toBe(false);
  a.record({ contextDigest: "d3", actions: [{ a: 3 }], cost: 30 });
  expect(a.due()).toBe(true);
  const llm = {
    chat: async (_slot: unknown, _messages: unknown, _opts: unknown) => ({
      content: 'RUBRIC PATCH: - prefer cheap actions when idle\nMEMORY PATCH: + hermes stub works',
      usage: { promptTokens: 7, completionTokens: 3 }
    })
  } satisfies Pick<LLMClient, "chat">;
  const patches = await a.review(llm);
  expect(patches.rubricPatch).toContain("prefer cheap actions");
  expect(patches.usage).toEqual({ promptTokens: 7, completionTokens: 3 }); // review cost surfaced to the caller

  a.applyPatches(patches);
  const rubric = readFileSync(join(dir, "RUBRIC.md"), "utf8");
  expect(rubric).toContain("prefer cheap actions");
  const memory = readFileSync(join(dir, "MEMORY.md"), "utf8");
  expect(memory).toContain("hermes stub works");
  // snapshot committed before mutation — git history has 2+ commits
  const log = execSync("git rev-list --count HEAD", { cwd: dir }).toString().trim();
  expect(Number(log)).toBeGreaterThanOrEqual(2);
  // after review, counter resets
  expect(a.due()).toBe(false);
});

test("snapshotRuntime stages existing files even when some are missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-audit-"));
  // Only create RUBRIC.md and MEMORY.md, no MISSION.md
  writeFileSync(join(dir, "RUBRIC.md"), "# RUBRIC\n- decide quickly\n");
  writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n");
  // Create initial commit so snapshotRuntime has a parent
  execSync("git init -q", { cwd: dir });
  execSync("git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: dir });
  // No MISSION.md created — simulate partial runtime
  // Modify RUBRIC.md to create a change for snapshot to capture
  writeFileSync(join(dir, "RUBRIC.md"), "# RUBRIC\n- decide quickly\n- some change\n", { flag: "a" });
  writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n- some memory\n", { flag: "a" });
  const a = new Auditor({ runtimeDir: dir, reviewEvery: 3 });

  const llm = {
    chat: async (_slot: unknown, _messages: unknown, _opts: unknown) => ({
      content: 'RUBRIC PATCH: - prefer cheap actions\nMEMORY PATCH: + hermes stub works',
      usage: { promptTokens: 4, completionTokens: 2 }
    })
  } satisfies Pick<LLMClient, "chat">;

  a.record({ contextDigest: "d1", actions: [{ a: 1 }], cost: 10 });
  a.record({ contextDigest: "d2", actions: [{ a: 2 }], cost: 20 });
  a.record({ contextDigest: "d3", actions: [{ a: 3 }], cost: 30 });
  const patches = await a.review(llm);
  expect(patches.usage).toEqual({ promptTokens: 4, completionTokens: 2 });
  a.applyPatches(patches);

  // Verify snapshot commit contains RUBRIC.md
  const diffTree = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { cwd: dir }).toString();
  expect(diffTree).toContain("RUBRIC.md");
  // MEMORY.md should also be in snapshot
  expect(diffTree).toContain("MEMORY.md");
});
