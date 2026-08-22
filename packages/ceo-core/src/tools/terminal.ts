// packages/ceo-core/src/tools/terminal.ts
// terminal + process — semantic port of hermes-agent terminal_tool.py /
// process handling, scoped to the local backend and the foreground path:
// jex's event back-fill loop has no interactive-PTY surface, so long jobs
// belong to spawn (sub-agents), not to background terminal sessions.
//
// Output collection and the model-facing render contract are ported from
// deepseek-harness (subprocess-local OutputCollector + tool-bash render.ts,
// MIT): keep a bounded tail in memory, spill the full stream to a private
// file for recovery, and always END the tool text with the exit-status line.
// dsh's incremental readFrom/lossy-delta API is omitted — the foreground tool
// reads each stream exactly once, at settlement.
import { spawn, execSync } from "node:child_process";
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolEntry } from "./registry.js";

// Model-friendly environment overrides (pattern borrowed from deepseek-harness
// bash-local): colors and pagers pollute tool output with ANSI/alt-screen
// escape sequences the LLM pays tokens for and misreads.
const ENV_OVERRIDES: Record<string, string> = { NO_COLOR: "1", TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" };

// In-memory tail window per stream. Errors and final results cluster at the
// END of command output (dsh rationale, via pi/OpenCode), so the window holds
// the LAST bytes; the spill file below covers the head.
const TAIL_BYTES = 8192;
// Spill ceiling: past this the spill file is deleted and only the tail
// survives (lossy) — a runaway `yes` must not fill the user's disk.
const MAX_SPILL_BYTES = 64 * 1024 * 1024;
// Grace between the SIGTERM and SIGKILL tiers (dsh escalation ladder): a
// process trapping SIGTERM gets this long to flush and exit before the hammer.
const GRACE_MS = 3000;
// Extra wait past the SIGKILL tier before forcing settlement: a descendant
// that escaped the group (setsid) can still hold the stdout pipe and pin the
// 'close' event open forever.
const DRAIN_MS = 1000;
// Foreground default (dsh bash-local default; was 180) — long jobs belong to spawn.
const DEFAULT_TIMEOUT = 120;
const TIMEOUT_CAP = 600;

function shellWrap(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  return { file: "/bin/bash", args: ["-lc", command] };
}

/**
 * Bounded per-stream collector (port of dsh subprocess-local OutputCollector,
 * MIT): keeps an exact tail of the last `tailBytes` in memory; on first
 * overflow opens a spill file so the full stream stays recoverable; past
 * `maxSpillBytes` (when spilling is enabled at all) the file is dropped and
 * only the tail remains. Module-private on purpose — callers reach output
 * through run().
 */
class OutputCollector {
  private chunks: Buffer[] = [];
  private bytes = 0;  // retained tail size
  private total = 0;  // everything ever pushed — drives the spill cap
  private dropped = false;
  private spillDropped = false;
  private spillFd: number | undefined;
  private spillFile: string | undefined;

  constructor(private readonly tailBytes: number, private readonly maxSpillBytes: number | undefined) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.maxSpillBytes !== undefined && !this.spillDropped && (this.spillFd !== undefined || this.bytes + chunk.length > this.tailBytes)) {
      if (this.total > this.maxSpillBytes) this.discardSpill();
      else this.spillAppend(chunk);
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    // Trim whole chunks from the head (or the head bytes of one over-cap
    // chunk) until the window is byte-exact: the tail must hold the LAST
    // tailBytes regardless of how the stream was chunked.
    while (this.bytes > this.tailBytes) {
      const head = this.chunks[0] as Buffer;
      const excess = this.bytes - this.tailBytes;
      if (head.length <= excess) { this.chunks.shift(); this.bytes -= head.length; }
      else { this.chunks[0] = head.subarray(excess); this.bytes -= excess; }
      this.dropped = true;
    }
  }

  // The spill must hold the COMPLETE stream: on first overflow the already
  // retained chunks are backfilled so the file starts at byte 0, then every
  // later chunk is appended in order.
  private spillAppend(chunk: Buffer): void {
    if (this.spillFd === undefined) {
      // Random name + 'wx' (O_EXCL — fails on ANY existing path, so a
      // pre-planted symlink cannot redirect the writes) + 0600: the shared
      // tmpdir is world-writable and other local users must not predict,
      // pre-create, or read the spilled command output.
      this.spillFile = join(tmpdir(), `robojex-spill-${randomUUID().slice(0, 8)}.log`);
      this.spillFd = openSync(this.spillFile, "wx", 0o600);
      for (const prior of this.chunks) writeSync(this.spillFd, prior);
    }
    writeSync(this.spillFd, chunk);
  }

  // Once the stream outgrew the cap the file can no longer hold all of it;
  // delete it instead of advertising a silently-incomplete "full output".
  private discardSpill(): void {
    const fd = this.spillFd; const file = this.spillFile;
    this.spillFd = undefined; this.spillFile = undefined; this.spillDropped = true;
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    if (file !== undefined) { try { unlinkSync(file); } catch { /* at most maxSpillBytes stays behind */ } }
  }

  // Seal at stream end so a reported spill path never points at an open file.
  seal(): void {
    if (this.spillFd === undefined) return;
    try { closeSync(this.spillFd); } catch { this.spillFile = undefined; /* failed close → the tail may be missing; stop advertising */ }
    this.spillFd = undefined;
  }

  text(): string { return Buffer.concat(this.chunks).toString("utf8"); }
  spillPath(): string | undefined { return this.spillFile; }
  truncated(): boolean { return this.dropped; }
}

interface RunResult {
  /** Combined tail (stdout, then a marked stderr section) — the pre-port shape processTool still reads. */
  out: string;
  stdout: string;
  stderr: string;
  stdoutSpillPath?: string;
  stderrSpillPath?: string;
  truncated: boolean;
  code: number | null;
  timedOut: boolean;
  spawnError?: string;
}

interface RunOpts { timeoutMs: number; workdir?: string; tailBytes?: number; spill?: boolean }

function run(file: string, args: string[], opts: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.workdir,
      env: { ...process.env, ...ENV_OVERRIDES },
      stdio: ["ignore", "pipe", "pipe"],
      // `detached` puts the child in its own POSIX process group so timeout
      // teardown can reach the whole tree with one kill(-pid); Windows
      // teardown goes through taskkill /T instead.
      detached: process.platform !== "win32",
    });
    const tailBytes = opts.tailBytes ?? TAIL_BYTES;
    const maxSpill = opts.spill === false ? undefined : MAX_SPILL_BYTES;
    const stdout = new OutputCollector(tailBytes, maxSpill);
    const stderr = new OutputCollector(tailBytes, maxSpill);
    child.stdout.on("data", (b: Buffer) => stdout.push(b));
    child.stderr.on("data", (b: Buffer) => stderr.push(b));

    let settled = false; let timedOut = false; let exitCode: number | null = null; let spawnError: string | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settled) return; settled = true;
      clearTimeout(timer); if (graceTimer !== undefined) clearTimeout(graceTimer); if (forceTimer !== undefined) clearTimeout(forceTimer);
      stdout.seal(); stderr.seal();
      const outText = stdout.text(); const errText = stderr.text();
      resolve({
        out: errText === "" ? outText : (outText !== "" && !outText.endsWith("\n") ? outText + "\n" : outText) + `[stderr]\n${errText}`,
        stdout: outText, stderr: errText,
        stdoutSpillPath: stdout.spillPath(), stderrSpillPath: stderr.spillPath(),
        truncated: stdout.truncated() || stderr.truncated(),
        code: timedOut ? null : exitCode, timedOut, spawnError,
      });
    };

    // Never throws: delivery races process exit, and a non-positive pid means
    // the spawn failed (nothing to signal). Falls back to the direct child
    // when the group is already gone, so teardown stays idempotent.
    const signalGroup = (sig: "SIGTERM" | "SIGKILL") => {
      if ((child.pid ?? 0) <= 0) return;
      try { process.kill(-child.pid!, sig); return; } catch { /* group already reaped (ESRCH) or EPERM */ }
      try { child.kill(sig); } catch { /* direct child already gone */ }
    };

    child.on("error", (e) => { spawnError = e.message; finish(); });
    // 'close' (not 'exit'): fires once the stdio pipes have drained, so the
    // collectors hold everything the child managed to write.
    child.on("close", (code) => { exitCode = code; finish(); });

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        // Windows has no group signals and no graceful tree-termination
        // equivalent; taskkill /T /F (force, whole tree) is the entire ladder.
        try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch { child.kill("SIGKILL"); }
        finish();
        return;
      }
      // POSIX escalation ladder (dsh): SIGTERM the group first so well-behaved
      // children can flush and exit, then SIGKILL the group after GRACE_MS.
      signalGroup("SIGTERM");
      graceTimer = setTimeout(() => signalGroup("SIGKILL"), GRACE_MS);
      // dsh additionally polls /proc for group survivors (observeTreeExit) to
      // re-probe liveness before each tier; omitted here — it exists to keep
      // signalling bound to real tree liveness across direct-child settlement,
      // and this close-event settlement plus this force bound covers the
      // foreground tool's cases without the /proc coupling.
      forceTimer = setTimeout(finish, GRACE_MS + DRAIN_MS);
    }, opts.timeoutMs);
  });
}

/**
 * Shape one finished run into the text the model sees (contract ported from
 * dsh tool-bash/render.ts): stdout tail, a marked stderr section, a
 * truncation notice pointing at the spill file, then the exit status on the
 * FINAL line — models read the end of tool output to judge success, so
 * nothing may ever follow the status marker. Non-zero exits are reported,
 * not errored: the model decides how to react.
 */
function renderRun(command: string, r: RunResult, timeoutS: number): string {
  let body = r.stdout;
  if (r.stderr !== "") {
    if (body !== "" && !body.endsWith("\n")) body += "\n";
    body += `[stderr]\n${r.stderr}`;
  }
  const lines = [`$ ${command}`];
  if (body !== "") lines.push(...(body.endsWith("\n") ? body.slice(0, -1) : body).split("\n"));
  const spills = [r.stdoutSpillPath, r.stderrSpillPath].filter((p): p is string => p !== undefined);
  // Advertised only while a spill file actually exists: the >MAX_SPILL lossy
  // case has no full output to point at, and the tail itself carries the run.
  if (spills.length > 0) lines.push(`[output truncated; full output: ${spills.join(", ")}]`);
  lines.push(r.timedOut ? `[timed out after ${timeoutS}s (killed)]` : `[exit code: ${r.code}]`);
  return lines.join("\n");
}

async function terminal(args: Record<string, unknown>): Promise<string> {
  const command = args.command;
  if (typeof command !== "string" || command.length === 0) return "error: command (string) required";
  const timeout = Number(args.timeout ?? DEFAULT_TIMEOUT);
  // Number.isInteger already implies Number.isFinite, redundant check removed
  if (!Number.isInteger(timeout) || timeout < 1) return "error: timeout must be a positive integer (seconds)";
  if (timeout > TIMEOUT_CAP) return `error: timeout ${timeout}s exceeds the ${TIMEOUT_CAP}s cap — delegate long jobs to a sub-agent (spawn) instead`;
  const workdir = typeof args.workdir === "string" && args.workdir ? args.workdir : undefined;
  const { file, args: sh } = shellWrap(command);
  const r = await run(file, sh, { timeoutMs: timeout * 1000, workdir });
  if (r.spawnError !== undefined) return `$ ${command}\nspawn error: ${r.spawnError}`;
  return renderRun(command, r, timeout);
}

async function processTool(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action ?? "");
  if (action === "list") {
    // Head rows matter here, so give the collector a wide tail and skip the
    // spill file — nothing renders a truncation notice for this caller, and
    // tmpdir would just accumulate unadvertised files.
    const r = process.platform === "win32"
      ? await run("tasklist", ["/FO", "CSV", "/NH"], { timeoutMs: 10_000, tailBytes: 64 * 1024, spill: false })
      : await run("ps", ["-eo", "pid,ppid,pcpu,pmem,etime,args"], { timeoutMs: 10_000, tailBytes: 64 * 1024, spill: false });
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
      schema: { name: "terminal", description: "Run a shell command in the foreground and return exit code + output. Output is tail-kept with the full stream spilled to a file when large; the last line always reports the exit status. Timeout caps at 600s; long jobs belong to delegate_task. Windows: PowerShell; unix: bash.", parameters: { type: "object", properties: { command: { type: "string", description: "The shell command to execute" }, timeout: { type: "integer", description: "Max seconds to wait (default 120, max 600); on expiry the process tree is terminated gracefully then forced", default: 120 }, workdir: { type: "string", description: "Working directory (absolute path)" } }, required: ["command"] } } },
    { name: "process", toolset: "terminal", writes: true, handler: processTool,
      schema: { name: "process", description: "List running processes or kill one by pid.", parameters: { type: "object", properties: { action: { type: "string", description: "What to do", enum: ["list", "kill"] }, pid: { type: "integer", description: "Process id to kill (action='kill')" } }, required: ["action"] } } },
  ];
}
