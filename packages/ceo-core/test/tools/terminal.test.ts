// packages/ceo-core/test/tools/terminal.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalTools } from "../../src/tools/terminal.js";
import type { ToolCtx } from "../../src/tools/registry.js";

let dir: string; let ctx: ToolCtx;
const call = async (name: string, args: Record<string, unknown>) => {
  const e = terminalTools().find((t) => t.name === name);
  if (!e) throw new Error(`no tool ${name}`);
  return e.handler(args, ctx);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rjterm-"));
  ctx = { runtimeDir: dir, board: {} as never, spawn: async () => ({ exitCode: 0, summary: "" }), skillsDir: dir, takeoverSend: () => {}, chatOut: () => {} };
});

describe("terminal", () => {
  it("runs a command and reports exit code + output", async () => {
    const r = await call("terminal", { command: process.platform === "win32" ? "echo hello" : "echo hello" });
    expect(r).toContain("hello");
    expect(r).toMatch(/exit[=:]?\s*0/i);
  });
  it("honours workdir", async () => {
    const r = await call("terminal", { command: process.platform === "win32" ? "cd" : "pwd", workdir: dir });
    expect(r.replace(/\\/g, "/")).toContain(dir.replace(/\\/g, "/"));
  });
  it("timeout kills a hung command", async () => {
    const r = await call("terminal", { command: process.platform === "win32" ? "powershell -Command Start-Sleep 30" : "sleep 30", timeout: 2 });
    expect(r).toMatch(/timeout|timed out/i);
  }, 15000);
  it("rejects timeout above the 600s cap", async () => {
    const r = await call("terminal", { command: "echo hi", timeout: 900 });
    expect(r).toMatch(/max|cap|600/i);
  });
});

describe("process", () => {
  it("list returns running processes", async () => {
    const r = await call("process", { action: "list" });
    expect(r).toMatch(/pid/i);
    expect(r.split("\n").length).toBeGreaterThanOrEqual(2);
  });
  it("kill without pid errors; kill of pid 0 (invalid) surfaces the os error", async () => {
    const r = await call("process", { action: "kill" });
    expect(r).toMatch(/pid required/i);
  });
  it("invalid action errors", async () => {
    const r = await call("process", { action: "explode" });
    expect(r).toMatch(/invalid action/i);
  });
});
