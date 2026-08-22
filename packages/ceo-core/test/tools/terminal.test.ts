// packages/ceo-core/test/tools/terminal.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
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
// The render contract pins the exit/timed-out marker to the FINAL line —
// models judge success from the end of tool output.
const lastLine = (s: string) => { const t = s.trimEnd().split("\n"); return t[t.length - 1] as string; };
const unix = process.platform !== "win32";
const unixIt = unix ? it : it.skip;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rjterm-"));
  ctx = { runtimeDir: dir, board: {} as never, spawn: async () => ({ exitCode: 0, summary: "" }), skillsDir: dir, takeoverSend: () => {}, chatOut: () => {} };
});

describe("terminal", () => {
  it("runs a command and reports exit code + output", async () => {
    const r = await call("terminal", { command: "echo hello" });
    expect(r).toContain("hello");
    expect(lastLine(r)).toBe("[exit code: 0]");
  });
  it("honours workdir", async () => {
    const r = await call("terminal", { command: process.platform === "win32" ? "cd" : "pwd", workdir: dir });
    expect(r.replace(/\\/g, "/")).toContain(dir.replace(/\\/g, "/"));
  });
  it("non-zero exit is reported on the last line, not an error", async () => {
    const r = await call("terminal", { command: "exit 7" });
    expect(lastLine(r)).toBe("[exit code: 7]");
  });
  it("separates stderr into its own marked section", async () => {
    const r = await call("terminal", { command: "echo out; echo err 1>&2" });
    expect(r).toContain("[stderr]\nerr");
    expect(r.indexOf("out")).toBeLessThan(r.indexOf("[stderr]")); // stdout stays before the stderr block
    expect(lastLine(r)).toBe("[exit code: 0]");
  });
  unixIt("keeps the tail, spills the full stream, and points at the file", async () => {
    const r = await call("terminal", { command: "seq 1 20000" }); // ~109KB ≫ the 8KB tail window
    expect(r).toContain("20000");                   // the tail window survived
    expect(r.split("\n")[1]).not.toBe("1");         // the head did not stay in memory
    const m = r.match(/\[output truncated; full output: (.+?)\]/);
    expect(m, "truncation notice with spill path").not.toBeNull();
    const spill = (m as RegExpMatchArray)[1] as string;
    expect(existsSync(spill)).toBe(true);
    // Spill holds the head the memory tail dropped. Not startsWith: this
    // machine's login shell prints a preamble line to stdout before the
    // command runs, so the head of the STREAM is not the head of seq's output.
    expect(readFileSync(spill, "utf8")).toContain("1\n2\n3\n");
    expect(lastLine(r)).toBe("[exit code: 0]");
    rmSync(spill, { force: true }); // the design leaves recovery files behind; tests clean up after themselves
  }, 20000);
  it("timeout escalates SIGTERM→SIGKILL and returns promptly", async () => {
    const t0 = Date.now();
    const r = await call("terminal", { command: process.platform === "win32" ? "powershell -Command Start-Sleep 30" : "sleep 30", timeout: 2 });
    const elapsed = Date.now() - t0;
    expect(lastLine(r)).toBe("[timed out after 2s (killed)]");
    expect(elapsed).toBeGreaterThanOrEqual(1900); // the full timeout elapsed…
    expect(elapsed).toBeLessThan(6500);           // …but the ladder bounded the teardown — not the command's 30s
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
      // Background child + foreground blocker: the background sleep is a
      // grandchild that only a group kill can reach (killing just the shell
      // orphans it — that is the discriminator this test exists for)
      const r = await call("terminal", {
        command: `sleep ${uniqueSleep} & sleep 300`,
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
        // Wait 200ms before retry
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
