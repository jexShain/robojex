// packages/ceo-core/test/tools/bridges-misc.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { miscBridges } from "../../src/tools/bridges.js";
import type { ToolCtx } from "../../src/tools/registry.js";

let dir: string; let skillsDir: string; let sent: unknown[]; let chats: string[]; let ctx: ToolCtx;
const call = async (name: string, args: Record<string, unknown>) => {
  const e = miscBridges().find((t) => t.name === name);
  if (!e) throw new Error(`no tool ${name}`);
  return e.handler(args, ctx);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rjmisc-"));
  skillsDir = join(dir, "skills");
  mkdirSync(skillsDir);
  writeFileSync(join(skillsDir, "hermes.md"), "# hermes — manual\nrun hermes -p\n");
  sent = []; chats = [];
  ctx = { runtimeDir: dir, board: { add: () => ({ id: "t1" }), update: () => {}, list: () => [] } as never,
    spawn: async (fw: string, p: string) => ({ exitCode: 0, summary: `ran ${fw} ${p.slice(0, 10)}` }),
    skillsDir, takeoverSend: (f) => sent.push(f), chatOut: (_f, t) => chats.push(t) };
});

describe("memory", () => {
  it("append then read round-trips MEMORY.md", async () => {
    await call("memory", { action: "append", content: "fact one" });
    await call("memory", { action: "append", content: "fact two" });
    const r = await call("memory", { action: "read" });
    expect(r).toContain("fact one");
    expect(r).toContain("fact two");
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("fact two");
  });
  it("append without content errors", async () => {
    const r = await call("memory", { action: "append" });
    expect(r).toMatch(/content required/i);
  });
});

describe("skills", () => {
  it("skills_list lists manual files", async () => {
    const r = await call("skills_list", {});
    expect(r).toContain("hermes");
  });
  it("skill_view returns the manual body", async () => {
    const r = await call("skill_view", { name: "hermes" });
    expect(r).toContain("hermes -p");
  });
  it("skill_view blocks path traversal", async () => {
    const r = await call("skill_view", { name: "../MEMORY" });
    expect(r).toMatch(/invalid name|not found/i);
  });
});

describe("delegate_task", () => {
  it("spawns a sub-agent through the orchestrator", async () => {
    const r = await call("delegate_task", { framework: "hermes", prompt: "do the thing" });
    expect(r).toContain("ran hermes");
  });
  it("empty prompt errors", async () => {
    const r = await call("delegate_task", { framework: "hermes", prompt: "" });
    expect(r).toMatch(/prompt required/i);
  });
});

describe("computer_use", () => {
  it("key action sends a takeover input frame", async () => {
    const r = await call("computer_use", { action: "key", key: "Return" });
    expect(r).toMatch(/sent|done/i);
    const frame = sent[0] as { t: string; op: string; action: { kind: string; key?: string } };
    expect(frame.t).toBe("ctrl"); expect(frame.op).toBe("input");
    expect(frame.action.kind).toBe("key"); expect(frame.action.key).toBe("Return");
  });
  it("screenshot action sends a screenshot frame", async () => {
    await call("computer_use", { action: "screenshot" });
    const frame = sent[0] as { op: string };
    expect(frame.op).toBe("screenshot");
  });
  it("invalid action errors", async () => {
    const r = await call("computer_use", { action: "teleport" });
    expect(r).toMatch(/invalid action/i);
  });
});
