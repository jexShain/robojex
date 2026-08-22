// packages/ceo-core/test/tools/manager.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, type ToolCtx, type ToolEntry } from "../../src/tools/registry.js";
import { ToolManager, P1_TOOLS, commandHead } from "../../src/tools/manager.js";

let dir: string; let reg: ToolRegistry; let mgr: ToolManager; let ctx: ToolCtx;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rjmgr-"));
  reg = new ToolRegistry();
  ctx = { runtimeDir: dir, board: {} as never, spawn: async () => ({ exitCode: 0, summary: "" }), skillsDir: dir, takeoverSend: () => {}, chatOut: () => {} };
});

describe("registration", () => {
  it("P1_TOOLS registers 31 entries with unique names", () => {
    for (const e of P1_TOOLS()) reg.register(e);
    expect(reg.names()).toHaveLength(31);
    expect(new Set(reg.names()).size).toBe(31);
  });
  it("jex-own state tools are internal; system-touching tools are not", () => {
    for (const e of P1_TOOLS()) reg.register(e);
    // board / todo / memory: reversible, touch no user system
    for (const n of ["todo", "memory", "kanban_create", "kanban_list", "kanban_show", "kanban_complete",
      "kanban_block", "kanban_unblock", "kanban_comment", "kanban_heartbeat", "kanban_request_review",
      "kanban_request_changes", "kanban_link", "kanban_attach", "kanban_attach_url", "kanban_attachments"]) {
      expect(reg.get(n)!.internal, `${n} should be internal`).toBe(true);
    }
    // file / terminal / delegation / desktop: the user's system, gated hard
    for (const n of ["read_file", "write_file", "patch", "search_files", "terminal", "process", "delegate_task", "computer_use"]) {
      expect(reg.get(n)!.internal, `${n} must not be internal`).toBeUndefined();
    }
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
  const tool = (writes: boolean, internal = false): ToolEntry => ({
    name: "t", toolset: "x", writes, ...(internal ? { internal: true } : {}), handler: async () => "did it",
    schema: { name: "t", description: "t", parameters: { type: "object", properties: {} } },
  });
  it("observe mode refuses non-internal write-class tools", async () => {
    reg.register(tool(true));
    mgr = new ToolManager({ registry: reg, ctx });
    const r = await mgr.call("t", {}, "observe");
    expect(r).toMatch(/observe mode/i);
    expect(r).toMatch(/switch to assist\/full/i);
    expect(mgr.pendingApprovals()).toHaveLength(0); // refused, never queued
  });
  it("observe mode executes read-class tools", async () => {
    reg.register(tool(false));
    mgr = new ToolManager({ registry: reg, ctx });
    expect(await mgr.call("t", {}, "observe")).toBe("did it");
  });
  it("observe mode executes internal tools directly (jex-own state, no approval)", async () => {
    reg.register(tool(true, true));
    mgr = new ToolManager({ registry: reg, ctx });
    expect(await mgr.call("t", {}, "observe")).toBe("did it");
    expect(mgr.pendingApprovals()).toHaveLength(0);
  });
  it("full mode executes reads and writes", async () => {
    reg.register(tool(true));
    mgr = new ToolManager({ registry: reg, ctx });
    expect(await mgr.call("t", {}, "full")).toBe("did it");
  });
  it("assist mode defers non-internal writes into pending approvals", async () => {
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
  it("identical re-requests reuse the pending approval instead of stacking clones", async () => {
    reg.register(tool(true));
    mgr = new ToolManager({ registry: reg, ctx });
    const r1 = await mgr.call("t", { k: 1 }, "assist");
    const r2 = await mgr.call("t", { k: 1 }, "assist");
    expect(r1).toMatch(/needs-approval/i);
    expect(r2).toMatch(/already pending/i);
    expect(mgr.pendingApprovals()).toHaveLength(1);
    // different args still get their own slot
    await mgr.call("t", { k: 2 }, "assist");
    expect(mgr.pendingApprovals()).toHaveLength(2);
  });
  it("assist mode executes internal writes without an approval round", async () => {
    reg.register(tool(true, true));
    mgr = new ToolManager({ registry: reg, ctx });
    expect(await mgr.call("t", {}, "assist")).toBe("did it");
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

describe("hard blacklist (SPEC-BUTLER §1: every gate, every policy)", () => {
  beforeEach(() => {
    for (const e of P1_TOOLS()) reg.register(e); // the real terminal + file tools
    mgr = new ToolManager({ registry: reg, ctx });
  });
  it("commandHead: absolute path basenames, case and .exe folded away", () => {
    expect(commandHead("rm -rf /")).toBe("rm");
    expect(commandHead("/bin/rm -rf /")).toBe("rm");
    expect(commandHead("C:\\tools\\RM.EXE -rf x")).toBe("rm");
    expect(commandHead("  Remove-Item -Recurse x ")).toBe("remove-item");
    expect(commandHead("grep -c foo bar")).toBe("grep");
  });
  it("terminal refuses deletion-class heads under full (butler's gate)", async () => {
    for (const cmd of ["rm -rf /tmp/x", "rmdir /tmp/x", "del x.txt", "erase x.txt", "shred secret.txt", "unlink link", "Remove-Item -Recurse dir", "/bin/rm -f x"]) {
      const r = await mgr.call("terminal", { command: cmd, timeout: 5 }, "full");
      expect(r, cmd).toMatch(/error: blocked destructive command/);
    }
    expect(mgr.pendingApprovals()).toHaveLength(0); // refused, never queued
  });
  it("terminal runs ordinary commands untouched", async () => {
    const r = await mgr.call("terminal", { command: "echo hello-blacklist", timeout: 10 }, "full");
    expect(r).toContain("hello-blacklist");
    expect(r).not.toMatch(/blocked/);
  });
  it("write_file/patch refuse targets inside system directories (posix + windows forms, case-insensitive)", async () => {
    for (const p of ["/etc/passwd", "/usr/local/bin/tool", "/bin/ls-hack", "/sbin/x", "/boot/grub/x", "/sys/x", "/proc/x", "/dev/x",
      "C:\\Windows\\System32\\drivers\\etc\\hosts", "c:/windows/system32/x", "C:\\Program Files\\App\\config.ini", "c:\\PROGRAM FILES (x86)\\App\\x"]) {
      const w = await mgr.call("write_file", { path: p, content: "x" }, "full");
      expect(w, p).toMatch(/error: blocked system path/);
      const pt = await mgr.call("patch", { mode: "replace", path: p, old_string: "a", new_string: "b" }, "full");
      expect(pt, p).toMatch(/error: blocked system path/);
    }
  });
  it("write_file to user paths stays open (a project 'etc-notes' dir is not /etc)", async () => {
    const target = join(dir, "etc-notes", "x.txt");
    const r = await mgr.call("write_file", { path: target, content: "fine" }, "full");
    expect(r).toMatch(/^wrote \d+ bytes to /);
    expect(readFileSync(target, "utf8")).toBe("fine");
  });
  it("reads of system paths are NOT blocked (looking is always allowed; only writes are)", async () => {
    const r = await mgr.call("read_file", { path: "/etc/hostname" }, "full");
    expect(r).not.toMatch(/blocked system path/); // may be file-not-found on exotic hosts, never blacklisted
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
describe("path normalization", () => {
  it("blocks relative and tilde-prefixed sensitive paths after normalization", async () => {
    reg.register({ name: "read_file", toolset: "file", handler: async (a) => `read ${String(a.path)}`, schema: { name: "read_file", description: "r", parameters: { type: "object", properties: {} } } });
    mgr = new ToolManager({ registry: reg, ctx });
    // Test .envrc and other .env* variants are blocked
    expect(await mgr.call("read_file", { path: join(dir, "sub/.envrc") }, "full")).toMatch(/blocked.*sensitive/i);
    expect(await mgr.call("read_file", { path: join(dir, ".env-old") }, "full")).toMatch(/blocked.*sensitive/i);
    expect(await mgr.call("read_file", { path: join(dir, ".env.local") }, "full")).toMatch(/blocked.*sensitive/i);
  });
  it("blocks .ssh paths when cwd is home directory", async () => {
    const { chdir } = await import("node:process");
    const { existsSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const originalCwd = process.cwd();
    const homeDir = homedir();
    const sshDir = join(homeDir, ".ssh");
    // Skip test if .ssh directory doesn't exist
    if (!existsSync(sshDir)) {
      console.log("Skipping .ssh test - directory does not exist");
      return;
    }
    try {
      chdir(homeDir);
      reg.register({ name: "read_file", toolset: "file", handler: async (a) => `read ${String(a.path)}`, schema: { name: "read_file", description: "r", parameters: { type: "object", properties: {} } } });
      mgr = new ToolManager({ registry: reg, ctx });
      const r = await mgr.call("read_file", { path: ".ssh/id_rsa" }, "full");
      expect(r).toMatch(/blocked.*sensitive/i);
    } finally {
      chdir(originalCwd);
    }
  });
});

describe("approval re-check", () => {
  it("approval re-check denies observe mode even if initially queued in assist", async () => {
    const tool: ToolEntry = { name: "write", toolset: "x", writes: true, handler: async () => "wrote", schema: { name: "write", description: "w", parameters: { type: "object", properties: {} } } };
    reg.register(tool);
    mgr = new ToolManager({ registry: reg, ctx });
    const r = await mgr.call("write", {}, "assist");
    expect(r).toMatch(/needs-approval/i);
    const id = mgr.pendingApprovals()[0];
    // Re-check with observe mode should deny
    const result = await mgr.resolveApproval(id, true, "observe");
    expect(result).toMatch(/denied.*observe mode re-checked/i);
    // Handler should not have executed
    expect(result).not.toContain("wrote");
  });
  it("approval returns error if tool becomes unavailable", async () => {
    let available = true;
    const tool: ToolEntry = { 
      name: "write", 
      toolset: "x", 
      writes: true, 
      handler: async () => "wrote", 
      checkFn: () => available,
      schema: { name: "write", description: "w", parameters: { type: "object", properties: {} } } 
    };
    reg.register(tool);
    mgr = new ToolManager({ registry: reg, ctx });
    const r = await mgr.call("write", {}, "assist");
    expect(r).toMatch(/needs-approval/i);
    const id = mgr.pendingApprovals()[0];
    // Make tool unavailable
    available = false;
    const result = await mgr.resolveApproval(id, true);
    expect(result).toMatch(/error: tool no longer available/i);
    expect(result).not.toContain("wrote");
  });
});

describe("pending cap", () => {
  it("pending approvals capped at 50 entries, evicting oldest", async () => {
    const tool: ToolEntry = { name: "write", toolset: "x", writes: true, handler: async () => "wrote", schema: { name: "write", description: "w", parameters: { type: "object", properties: {} } } };
    reg.register(tool);
    mgr = new ToolManager({ registry: reg, ctx });
    // Queue 51 approvals
    for (let i = 0; i < 51; i++) {
      await mgr.call("write", { idx: i }, "assist");
    }
    // Should have exactly 50 pending
    expect(mgr.pendingApprovals()).toHaveLength(50);
    // First approval should have been evicted (oldest)
    const firstId = mgr.pendingApprovals()[0];
    expect(firstId).not.toBe(""); // Sanity check
  });
});

describe("checkFn exceptions", () => {
  it("checkFn exceptions are treated as unavailable", async () => {
    const tool: ToolEntry = {
      name: "bad",
      toolset: "x",
      handler: async () => "should not run",
      checkFn: () => { throw new Error("check failed"); },
      schema: { name: "bad", description: "b", parameters: { type: "object", properties: {} } }
    };
    reg.register(tool);
    mgr = new ToolManager({ registry: reg, ctx });
    const r = await mgr.call("bad", {}, "full");
    expect(r).toMatch(/not available in this environment/i);
  });
});
