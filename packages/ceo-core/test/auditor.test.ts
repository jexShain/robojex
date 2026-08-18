// packages/ceo-core/test/auditor.test.ts
import { Auditor } from "../src/auditor.js";
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
      usage: { promptTokens: 0, completionTokens: 0 }
    })
  } satisfies Pick<import("../src/llm.js").LLMClient, "chat">;
  const patches = await a.review(llm);
  expect(patches.rubricPatch).toContain("prefer cheap actions");

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
