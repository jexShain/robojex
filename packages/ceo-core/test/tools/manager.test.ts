// packages/ceo-core/test/tools/manager.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, type ToolCtx, type ToolEntry } from "../../src/tools/registry.js";
import { ToolManager, P1_TOOLS } from "../../src/tools/manager.js";

let dir: string; let reg: ToolRegistry; let mgr: ToolManager; let ctx: ToolCtx;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rjmgr-"));
  reg = new ToolRegistry();
  ctx = { runtimeDir: dir, board: {} as never, spawn: async () => ({ exitCode: 0, summary: "" }), skillsDir: dir, takeoverSend: () => {}, chatOut: () => {} };
});

describe("registration", () => {
  it("P1_TOOLS registers 27 entries with unique names", () => {
    for (const e of P1_TOOLS()) reg.register(e);
    expect(reg.names()).toHaveLength(27);
    expect(new Set(reg.names()).size).toBe(27);
  });
});

describe("schemasBlock", () => {
  it("lists available tools, hides checkFn-failing ones", () => {
    reg.register({ name: "always", toolset: "x", handler: async () => "", schema: { name: "always", description: "always here", parameters: { type: "object", properties: {} } } });
    reg.register({ name: "never", toolset: "x", handler: async () => "", checkFn: () => false, schema: { name: "never", description: "gated off", parameters: { type: "object", properties: {} } } });
    mgr = new ToolManager({ registry: reg, ctx });
    const block = mgr.schemasBlock();
    expect(block).toContain("# BUILTIN TOOLS");
    expect(block).toContain("always");
    expect(block).not.toContain("never");
  });
});

describe("gates", () => {
  const tool = (writes: boolean): ToolEntry => ({
    name: "t", toolset: "x", writes, handler: async () => "did it",
    schema: { name: "t", description: "t", parameters: { type: "object", properties: {} } },
  });
  it("observe mode refuses everything", async () => {
    reg.register(tool(false));
    mgr = new ToolManager({ registry: reg, ctx });
    const r = await mgr.call("t", {}, "observe");
    expect(r).toMatch(/observe mode/i);
  });
  it("full mode executes reads and writes", async () => {
    reg.register(tool(true));
    mgr = new ToolManager({ registry: reg, ctx });
    expect(await mgr.call("t", {}, "full")).toBe("did it");
  });
  it("assist mode defers writes into pending approvals", async () => {
    reg.register(tool(true));
    mgr = new ToolManager({ registry: reg, ctx });
    const r = await mgr.call("t", { k: 1 }, "assist");
    expect(r).toMatch(/needs-approval/i);
    expect(mgr.pendingApprovals()).toHaveLength(1);
    const id = mgr.pendingApprovals()[0];
    const done = await mgr.resolveApproval(id, true);
    expect(done).toBe("did it");
    expect(mgr.pendingApprovals()).toHaveLength(0);
  });
  it("deny drops the call", async () => {
    reg.register(tool(true));
    mgr = new ToolManager({ registry: reg, ctx });
    await mgr.call("t", {}, "assist");
    const id = mgr.pendingApprovals()[0];
    expect(await mgr.resolveApproval(id, false)).toMatch(/denied/i);
    expect(mgr.pendingApprovals()).toHaveLength(0);
  });
  it("assist executes read-class tools directly", async () => {
    reg.register(tool(false));
    mgr = new ToolManager({ registry: reg, ctx });
    expect(await mgr.call("t", {}, "assist")).toBe("did it");
  });
});

describe("sensitive paths", () => {
  it("blocks reads of runtime/config.json and ssh keys through any path arg", async () => {
    writeFileSync(join(dir, "config.json"), "{}");
    reg.register({ name: "read_file", toolset: "file", handler: async (a) => `read ${String(a.path)}`, schema: { name: "read_file", description: "r", parameters: { type: "object", properties: {} } } });
    mgr = new ToolManager({ registry: reg, ctx });
    const r = await mgr.call("read_file", { path: join(dir, "config.json") }, "full");
    expect(r).toMatch(/blocked.*sensitive/i);
  });
  it("blocks .env and .git-credentials patterns", async () => {
    reg.register({ name: "write_file", toolset: "file", writes: true, handler: async () => "wrote", schema: { name: "write_file", description: "w", parameters: { type: "object", properties: {} } } });
    mgr = new ToolManager({ registry: reg, ctx });
    for (const p of [join(dir, ".env"), "/home/u/.git-credentials", "/home/u/.ssh/id_rsa"]) {
      const r = await mgr.call("write_file", { path: p }, "full");
      expect(r).toMatch(/blocked.*sensitive/i);
    }
  });
});

describe("unknown tool + truncation", () => {
  it("unknown tool errors with the available names", async () => {
    mgr = new ToolManager({ registry: reg, ctx });
    const r = await mgr.call("nope", {}, "full");
    expect(r).toMatch(/unknown tool.*nope/i);
  });
  it("results longer than 8192 chars are truncated", async () => {
    reg.register({ name: "big", toolset: "x", handler: async () => "x".repeat(20000), schema: { name: "big", description: "b", parameters: { type: "object", properties: {} } } });
    mgr = new ToolManager({ registry: reg, ctx });
    const r = await mgr.call("big", {}, "full");
    expect(r.length).toBeLessThanOrEqual(8192 + 60);
    expect(r).toContain("truncated");
  });
});
