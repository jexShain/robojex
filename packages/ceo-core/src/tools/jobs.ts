// packages/ceo-core/src/tools/jobs.ts
// jobs — background job registry, ported in spirit from deepseek-harness
// packages/jobs/jobs-local: long commands run detached while the loop keeps
// moving; the model harvests them minutes later via job_output (start-and-
// poll semantics instead of terminal's foreground block). Spawning follows
// terminal.ts: win32 powershell -NonInteractive / unix bash -lc, model-
// friendly ENV_OVERRIDES, detached posix process groups for cascade kills.
import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { ToolEntry } from "./registry.js";
import { commandBlackline } from "./manager.js";

const TAIL_BUDGET = 8192;        // per-stream in-memory tail window (dsh OutputCollector, spill dropped)
const MAX_LIVE = 6;              // concurrent live jobs (dsh per-owner cap)
const TIMEOUT_DEFAULT = 600;     // seconds
const TIMEOUT_CAP = 3600;        // seconds — hard ceiling for any background job
const RETAIN_MS = 10 * 60_000;   // finished jobs stay readable this long, then evicted
const KILL_GRACE_MS = 3_000;     // timeout ladder: SIGTERM → wait → SIGKILL
const REAP_EVERY_MS = 15_000;    // retention sweep cadence

const ENV_OVERRIDES: Record<string, string> = { NO_COLOR: "1", TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" };

function shellWrap(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  return { file: "/bin/bash", args: ["-lc", command] };
}

type JobState = "running" | "done" | "killed";

interface Job {
  id: string;
  command: string;
  child: ChildProcess;
  state: JobState;
  exitCode: number | null;   // -9 = we killed it; null = signaled away or spawn error
  timedOut: boolean;
  timeoutSec: number;
  startedAt: number;
  endedAt: number | null;
  closed: boolean;           // close event seen (ladder escalation keys off this, not state)
  outTail: string;
  errTail: string;
  timeoutTimer: NodeJS.Timeout | null;
  ladderTimer: NodeJS.Timeout | null;
}

class JobRegistry {
  private jobs = new Map<string, Job>();
  private reaper: NodeJS.Timeout | null = null;

  live(): Job[] { return [...this.jobs.values()].filter((j) => j.state === "running"); }

  start(command: string, workdir: string | undefined, timeoutSec: number): { ok: true; id: string; pid: number } | { ok: false; error: string } {
    if (this.live().length >= MAX_LIVE) {
      return { ok: false, error: `error: ${MAX_LIVE} live jobs already running — job_kill one (job_list shows ids) before starting more` };
    }
    const { file, args } = shellWrap(command);
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: workdir,
        env: { ...process.env, ...ENV_OVERRIDES },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (e) {
      return { ok: false, error: `error: spawn failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const job: Job = {
      id: randomUUID().slice(0, 8), command, child,
      state: "running", exitCode: null, timedOut: false, timeoutSec,
      startedAt: Date.now(), endedAt: null, closed: false,
      outTail: "", errTail: "", timeoutTimer: null, ladderTimer: null,
    };
    this.jobs.set(job.id, job);
    const feed = (key: "outTail" | "errTail", b: Buffer) => {
      // tail-only window: keep the last TAIL_BUDGET chars, drop the head —
      // background jobs stream far more than any model wants to re-read
      job[key] = (job[key] + b.toString("utf8")).slice(-TAIL_BUDGET);
    };
    child.stdout?.on("data", (b: Buffer) => feed("outTail", b));
    child.stderr?.on("data", (b: Buffer) => feed("errTail", b));
    child.on("error", (e) => {
      job.errTail = (job.errTail + `\nspawn error: ${e.message}`).slice(-TAIL_BUDGET);
      job.closed = true;
      this.finish(job, null);
    });
    child.on("close", (code) => { job.closed = true; this.finish(job, code); });
    // timeout ladder: at the deadline SIGTERM the whole group, escalate to
    // SIGKILL after the grace window (unix kills -pid; win taskkill /T /F)
    job.timeoutTimer = setTimeout(() => this.expire(job), timeoutSec * 1000);
    job.timeoutTimer.unref();
    this.ensureReaper();
    return { ok: true, id: job.id, pid: child.pid ?? 0 };
  }

  private finish(job: Job, code: number | null): void {
    if (job.state === "running") {
      job.state = "done";
      job.exitCode = code;
      job.endedAt = Date.now();
    }
    this.clearTimers(job);
  }

  private expire(job: Job): void {
    job.timeoutTimer = null;
    if (job.state !== "running" || job.closed) return;
    job.timedOut = true;
    this.stop(job, "SIGTERM");
    job.ladderTimer = setTimeout(() => {
      job.ladderTimer = null;
      if (!job.closed) this.stop(job, "SIGKILL");
    }, KILL_GRACE_MS);
    job.ladderTimer.unref();
    // claim the kill now: the concurrency slot frees and job_list stops
    // advertising a job that is already doomed — close may lag microseconds
    this.claimKilled(job);
  }

  private claimKilled(job: Job): void {
    if (job.state !== "running") return;
    job.state = "killed";
    job.exitCode = -9;
    job.endedAt = Date.now();
  }

  // cascade kill: the whole process group (bash + its children), not just the
  // shell — killing only the shell orphans the actual workload
  private stop(job: Job, signal: "SIGTERM" | "SIGKILL"): void {
    const pid = job.child.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); }
      catch { try { job.child.kill("SIGKILL"); } catch { /* already gone */ } }
    } else {
      try { process.kill(-pid, signal); } catch { try { job.child.kill(signal); } catch { /* already gone */ } }
    }
  }

  private clearTimers(job: Job): void {
    if (job.timeoutTimer) { clearTimeout(job.timeoutTimer); job.timeoutTimer = null; }
    if (job.ladderTimer) { clearTimeout(job.ladderTimer); job.ladderTimer = null; }
  }

  private lookup(raw: string): Job | "ambiguous" | undefined {
    const exact = this.jobs.get(raw);
    if (exact) return exact;
    const hits = [...this.jobs.keys()].filter((id) => id.startsWith(raw));
    if (hits.length === 1) return this.jobs.get(hits[0] as string);
    return hits.length > 1 ? "ambiguous" : undefined;
  }

  output(raw: string): string {
    const j = this.lookup(raw);
    if (typeof j === "string") return `error: '${raw}' matches several jobs — use the full id`;
    if (!j) return `error: no job '${raw}' — job_list shows ids`;
    const secs = (until: number) => Math.max(0, Math.round((until - j.startedAt) / 1000));
    let status: string;
    if (j.state === "running") status = `[still running, ${secs(Date.now())}s]`;
    else if (j.state === "killed") status = `[killed (exit -9)${j.timedOut ? `, timed out after ${j.timeoutSec}s` : ""}]`;
    else status = `[exit ${j.exitCode ?? "?"}] (took ${secs(j.endedAt ?? Date.now())}s)`;
    const out = j.outTail.trimEnd();
    const err = j.errTail.trimEnd();
    const body = err ? `${out}${out ? "\n" : ""}[stderr]\n${err}` : out;
    return `$ ${j.command}\n${status}\n${body || (j.state === "running" ? "(no output yet)" : "(no output)")}`;
  }

  kill(raw: string): string {
    const j = this.lookup(raw);
    if (typeof j === "string") return `error: '${raw}' matches several jobs — use the full id`;
    if (!j) return `error: no job '${raw}' — job_list shows ids`;
    if (j.state !== "running") return `job ${j.id} already exited (${j.exitCode ?? "?"})`;
    this.clearTimers(j);
    this.stop(j, "SIGKILL");
    this.claimKilled(j);
    return `job ${j.id} killed (exit -9)`;
  }

  list(): string {
    if (this.jobs.size === 0) return "(no jobs)";
    const secs = (j: Job) => Math.max(0, Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000));
    const line = (j: Job) => {
      const status = j.state === "running" ? "running" : j.state === "killed" ? "killed" : `done(${j.exitCode ?? "?"})`;
      return `${j.id}  ${status.padEnd(10)}${String(secs(j)).padStart(5)}s  ${j.command.slice(0, 60)}`;
    };
    // live jobs first (oldest first), finished behind (freshest first)
    const running = this.live().sort((a, b) => a.startedAt - b.startedAt).map(line);
    const rest = [...this.jobs.values()]
      .filter((j) => j.state !== "running")
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
      .map(line);
    return [...running, ...rest].join("\n");
  }

  /** R84 structured snapshot for /api/jobs — the UI strip shows what the
   *  butler is running in the background (no tails: ids, state and clocks
   *  only, so the payload stays a few hundred bytes). */
  snapshot(): Array<{ id: string; command: string; state: JobState; exitCode: number | null; timedOut: boolean; startedAt: number; endedAt: number | null }> {
    const one = (j: Job) => ({ id: j.id, command: j.command.slice(0, 80), state: j.state, exitCode: j.exitCode, timedOut: j.timedOut, startedAt: j.startedAt, endedAt: j.endedAt });
    const running = this.live().sort((a, b) => a.startedAt - b.startedAt).map(one);
    const rest = [...this.jobs.values()]
      .filter((j) => j.state !== "running")
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
      .slice(0, 6)
      .map(one);
    return [...running, ...rest];
  }

  // retention sweep: finished jobs stay readable RETAIN_MS, then go. The
  // interval is unref'd and self-destructs once the registry empties, so it
  // never holds the process open.
  private ensureReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      const now = Date.now();
      for (const [id, j] of this.jobs) {
        if (j.state !== "running" && j.endedAt !== null && now - j.endedAt > RETAIN_MS) this.jobs.delete(id);
      }
      if (this.jobs.size === 0) { clearInterval(this.reaper!); this.reaper = null; }
    }, REAP_EVERY_MS);
    this.reaper.unref();
  }
}

// Process-level singleton: tool handlers are pure functions over args and
// ToolManager instances come and go — the registry must outlive them all.
const registry = new JobRegistry();

/** The api layer's window into the singleton (R84 jobs observability). */
export function jobSnapshot(): ReturnType<JobRegistry["snapshot"]> { return registry.snapshot(); }

async function jobStart(args: Record<string, unknown>): Promise<string> {
  const command = args.command;
  if (typeof command !== "string" || command.length === 0) return "error: command (string) required";
  // one shared command blackline with the foreground terminal tool (manager's
  // hardBlacklist only watches the "terminal" tool name — jobs must not be a
  // side door for privileged deletions or system-dir rewrites either)
  const refusal = commandBlackline(command);
  if (refusal) return `${refusal} (tool job_start refused)`;
  const timeout = Number(args.timeout ?? TIMEOUT_DEFAULT);
  if (!Number.isInteger(timeout) || timeout < 1) return "error: timeout must be a positive integer (seconds)";
  if (timeout > TIMEOUT_CAP) return `error: timeout ${timeout}s exceeds the ${TIMEOUT_CAP}s cap for background jobs`;
  const workdir = typeof args.workdir === "string" && args.workdir ? args.workdir : undefined;
  const r = registry.start(command, workdir, timeout);
  return r.ok ? `job ${r.id} started (pid ${r.pid})` : r.error;
}

async function jobOutput(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id ?? "");
  if (!id) return "error: id (string) required";
  return registry.output(id);
}

async function jobKill(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id ?? "");
  if (!id) return "error: id (string) required";
  return registry.kill(id);
}

export function jobsTools(): ToolEntry[] {
  return [
    { name: "job_start", toolset: "jobs", writes: true, handler: jobStart,
      schema: { name: "job_start", description: "Start a long-running shell command in the background and return immediately with a job id. Never blocks the loop — poll job_output on later cycles (minutes apart is fine) to harvest status and output tail; job_kill cancels. Timeout caps at 3600s, 6 live jobs max.", parameters: { type: "object", properties: { command: { type: "string", description: "The shell command to run in the background" }, workdir: { type: "string", description: "Working directory (absolute path)" }, timeout: { type: "integer", description: "Kill the job after this many seconds (default 600, max 3600)", default: 600 } }, required: ["command"] } } },
    { name: "job_output", toolset: "jobs", writes: false, handler: jobOutput,
      schema: { name: "job_output", description: "Read a background job's status line ([still running, Ns] / [exit M] / killed) plus its recent output tail. Finished jobs stay readable for 10 minutes.", parameters: { type: "object", properties: { id: { type: "string", description: "Job id from job_start (unique prefix works)" } }, required: ["id"] } } },
    { name: "job_kill", toolset: "jobs", writes: true, handler: jobKill,
      schema: { name: "job_kill", description: "Terminate a running background job and its whole process group. Safe on finished jobs too (reports already exited).", parameters: { type: "object", properties: { id: { type: "string", description: "Job id from job_start (unique prefix works)" } }, required: ["id"] } } },
    { name: "job_list", toolset: "jobs", writes: false, handler: async () => registry.list(),
      schema: { name: "job_list", description: "List background jobs: id, running/done(exit)/killed status, elapsed seconds, command. Live jobs first.", parameters: { type: "object", properties: {} } } },
  ];
}
