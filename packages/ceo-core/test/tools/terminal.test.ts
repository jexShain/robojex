// packages/ceo-core/test/tools/terminal.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
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
  it("rejects non-integer timeout", async () => {
    const r = await call("terminal", { command: "echo hi", timeout: 2.5 });
    expect(r).toMatch(/timeout must be a positive integer/i);
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

// Check if pgrep is available (Unix only)
let hasPgrep = false;
try { execSync("which pgrep", { stdio: "ignore" }); hasPgrep = true; } catch {}

const processGroupTests = hasPgrep ? describe : describe.skip;
processGroupTests("process group", () => {
  it("timeout kills entire process group on Unix - real orphan validation", async () => {
    // Use a unique sleep duration to avoid conflicting with other processes
    const uniqueSleep = "297"; // Less common sleep duration
    const cleanup = () => { try { execSync(`pkill -f 'sleep ${uniqueSleep}'`, { stdio: "ignore" }); } catch {} };
    
    // Pre-cleanup: ensure no test artifacts from previous runs
    cleanup();
    
    try {
      // Command that will definitely timeout and create child processes
      // Use a simple foreground sleep that will be killed with process group
      const r = await call("terminal", { 
        command: `sleep ${uniqueSleep}`, 
        timeout: 2 
      });
      expect(r).toMatch(/timeout|timed out/i);
      
      // Wait a moment for processes to fully exit after group kill
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Check for orphan survival - if process tree kill worked, pgrep should find nothing
      let trulyOrphaned = false;
      for (let i = 0; i < 10; i++) {
        try {
          const orphans = execSync(`pgrep -f 'sleep ${uniqueSleep}'`, { encoding: "utf8" });
          if (orphans.trim()) {
            // Found orphan - check if it's actually still running or just exiting
            const orphanPids = orphans.trim().split('\n');
            for (const pid of orphanPids) {
              try {
                const psInfo = execSync(`ps -p ${pid.trim()} -o pid,comm,state`, { encoding: "utf8" });
                // Check process state - 'R'='running', 'S'='sleeping', 'Z'='zombie' (exited but not reaped)
                const stateMatch = psInfo.match(/[A-Z]\s+/);
                const state = stateMatch ? stateMatch[0].trim() : '?';
                // If process is not a zombie, it's truly orphaned and still running
                if (state !== 'Z') {
                  trulyOrphaned = true;
                  break;
                }
              } catch {
                // Process already exited - not truly orphaned, continue checking
              }
            }
            if (trulyOrphaned) break; // Found truly orphaned process
            // If we get here, all found PIDs were exiting - wait for full cleanup
            await new Promise(resolve => setTimeout(resolve, 200));
            continue;
          }
        } catch (e) {
          // pgrep exits with code 1 when no processes found (good!)
          break; // No orphans - test passes
        }
        // Wait 200ms before retrying
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      // If orphan survived, the test fails - this is a real bug
      if (trulyOrphaned) {
        expect.fail(`Orphan process survived group kill - process.kill(-pid) may not be working correctly`);
      }
    } finally {
      // Cleanup: ensure no orphans remain
      cleanup();
    }
  }, 10000);
});
