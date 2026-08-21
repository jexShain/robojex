// packages/ceo-core/src/tools/terminal.ts
// terminal + process — semantic port of hermes-agent terminal_tool.py /
// process handling, scoped to the local backend and the foreground path:
// jex's event back-fill loop has no interactive-PTY surface, so long jobs
// belong to spawn (sub-agents), not to background terminal sessions.
import { spawn } from "node:child_process";
import type { ToolEntry } from "./registry.js";

const OUT_BUDGET = 8192;
const TIMEOUT_CAP = 600;

function shellWrap(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  return { file: "/bin/bash", args: ["-lc", command] };
}

function run(file: string, args: string[], opts: { timeoutMs: number; workdir?: string }): Promise<{ out: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: opts.workdir, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let out = ""; let settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      if (process.platform === "win32") {
        child.kill("SIGKILL");
      } else {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
      resolve({ out, code: null, timedOut: true });
    }, opts.timeoutMs);
    const feed = (b: Buffer) => { if (out.length < OUT_BUDGET * 2) out += b.toString("utf8"); };
    child.stdout.on("data", feed); child.stderr.on("data", feed);
    child.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ out: `spawn error: ${e.message}`, code: null, timedOut: false }); } });
    child.on("close", (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ out, code, timedOut: false }); } });
  });
}

async function terminal(args: Record<string, unknown>): Promise<string> {
  const command = args.command;
  if (typeof command !== "string" || command.length === 0) return "error: command (string) required";
  const timeout = Number(args.timeout ?? 180);
  if (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout < 1) return "error: timeout must be a positive integer (seconds)";
  if (timeout > TIMEOUT_CAP) return `error: timeout ${timeout}s exceeds the ${TIMEOUT_CAP}s cap — delegate long jobs to a sub-agent (spawn) instead`;
  const workdir = typeof args.workdir === "string" && args.workdir ? args.workdir : undefined;
  const { file, args: sh } = shellWrap(command);
  const r = await run(file, sh, { timeoutMs: timeout * 1000, workdir });
  const out = r.out.length > OUT_BUDGET ? r.out.slice(0, OUT_BUDGET) + "\n...[truncated]" : r.out;
  const status = r.timedOut ? `timeout after ${timeout}s (killed)` : `exit=${r.code}`;
  return `$ ${command}\n${status}\n${out}`;
}

async function processTool(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action ?? "");
  if (action === "list") {
    const r = process.platform === "win32"
      ? await run("tasklist", ["/FO", "CSV", "/NH"], { timeoutMs: 10_000 })
      : await run("ps", ["-eo", "pid,ppid,pcpu,pmem,etime,args"], { timeoutMs: 10_000 });
    const lines = r.out.split("\n").filter(Boolean).slice(0, 30);
    return lines.join("\n") + `\n[${lines.length} of ${r.out.split("\n").filter(Boolean).length} rows]`;
  }
  if (action === "kill") {
    const pid = Number(args.pid);
    if (!Number.isInteger(pid) || pid <= 1) return "error: pid required (a positive integer; use process list to find it)";
    if (process.platform === "win32") {
      const r = await run("taskkill", ["/PID", String(pid), "/F", "/T"], { timeoutMs: 10_000 });
      return `kill ${pid}: ${r.out.trim() || `exit=${r.code}`}`;
    }
    try { process.kill(pid, "SIGTERM"); return `kill ${pid}: SIGTERM sent`; }
    catch (e) { return `error: kill ${pid} failed: ${e instanceof Error ? e.message : String(e)}`; }
  }
  return `error: invalid action '${action}' — supported: list, kill`;
}

export function terminalTools(): ToolEntry[] {
  return [
    { name: "terminal", toolset: "terminal", writes: true, handler: terminal,
      schema: { name: "terminal", description: "Run a shell command in the foreground and return exit code + output. Timeout caps at 600s; long jobs belong to delegate_task. Windows: PowerShell; unix: bash.", parameters: { type: "object", properties: { command: { type: "string", description: "The shell command to execute" }, timeout: { type: "integer", description: "Max seconds to wait (default 180, max 600)", default: 180 }, workdir: { type: "string", description: "Working directory (absolute path)" } }, required: ["command"] } } },
    { name: "process", toolset: "terminal", writes: true, handler: processTool,
      schema: { name: "process", description: "List running processes or kill one by pid.", parameters: { type: "object", properties: { action: { type: "string", description: "What to do", enum: ["list", "kill"] }, pid: { type: "integer", description: "Process id to kill (action='kill')" } }, required: ["action"] } } },
  ];
}
