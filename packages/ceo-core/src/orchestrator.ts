// packages/ceo-core/src/orchestrator.ts
import { spawn as pspawn, type ChildProcess } from "node:child_process";
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LLMClient } from "./llm.js";

export type Framework = "hermes" | "claude-code";
const DEFAULT_CMDS: Record<Framework, (p: string) => string> = {
  "hermes": (p) => `hermes -p ${shq(p)} --yolo`,
  "claude-code": (p) => `claude -p ${shq(p)} --dangerously-skip-permissions`,
};
function shq(s: string): string { return `'${s.replace(/'/g, "'\\''")}'`; }

export interface SpawnResult { exitCode: number; summary: string; logPath: string; }

const TAIL_CHARS = 2048;

export class AgentOrchestrator {
  private running = new Map<string, ChildProcess>();
  private waiters: (() => void)[] = [];
  private maxConcurrent: number;
  constructor(private opts: { llm: LLMClient | null; runtimeDir: string; maxConcurrent?: number; cmds?: Partial<Record<Framework, string>> }) {
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    mkdirSync(join(this.opts.runtimeDir, "runs"), { recursive: true });
  }

  // ---- pid ledger: survives a CEO crash on disk so a fresh CEO can reap orphans ----
  private ledgerPath(): string { return join(this.opts.runtimeDir, "pids.json"); }
  private updateLedger(fn: (pids: number[]) => number[]): void {
    const path = this.ledgerPath();
    let pids: number[] = [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) pids = parsed.filter((p) => typeof p === "number");
    } catch { /* absent or corrupt: start from an empty ledger */ }
    const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(fn(pids)));
    renameSync(tmp, path); // atomic swap: a concurrent reader sees old or new, never partial
  }

  async spawn(fw: Framework, prompt: string, o: { timeoutMs?: number } = {}): Promise<SpawnResult> {
    if (this.running.size >= this.maxConcurrent) {
      await new Promise<void>((release) => this.waiters.push(release)); // queued behind a slot
    }
    const id = randomUUID().slice(0, 8);
    const logPath = join(this.opts.runtimeDir, "runs", `${id}.log`);
    const cmd = this.opts.cmds?.[fw] ?? DEFAULT_CMDS[fw](prompt);
    const full = `${cmd} ${shq(prompt)}`; // overrides receive the prompt too, same as defaults
    return new Promise<SpawnResult>((resolve) => {
      // detached: child leads its own process group (pgid == pid) so the whole tree dies together
      const child = pspawn(full, { shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"], detached: true });
      const pid = child.pid;
      this.running.set(id, child);
      if (typeof pid === "number") this.updateLedger((pids) => [...pids, pid]);
      writeFileSync(logPath, ""); // created up front; chunks stream in below
      let out = ""; // tail only; the full log lives on disk
      const capture = (d: Buffer | string): void => {
        const s = d.toString();
        appendFileSync(logPath, s); // full log streamed to disk, never into CEO context
        out = (out + s).slice(-TAIL_CHARS);
      };
      child.stdout!.on("data", capture);
      child.stderr!.on("data", capture);
      const killTree = (): void => {
        if (typeof pid !== "number") return;
        try { process.kill(-pid, "SIGKILL"); } // signal the whole process group
        catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
      };
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; killTree(); }, o.timeoutMs ?? 30 * 60_000);
      let settled = false;
      const finish = async (code: number | null, errMsg?: string): Promise<void> => {
        if (settled) return; // 'error' and 'close' can both fire
        settled = true;
        clearTimeout(timeout);
        this.running.delete(id);
        if (typeof pid === "number") this.updateLedger((pids) => pids.filter((p) => p !== pid));
        this.waiters.shift()?.(); // one slot freed, one waiter admitted
        let summary: string;
        if (errMsg) {
          summary = `error: ${errMsg}`;
        } else if (timedOut) {
          summary = "timeout";
        } else if (this.opts.llm) {
          try {
            const r = await this.opts.llm.chat("patrol", [{ role: "user", content: `Summarize this sub-agent result in ONE line (<=140 chars). If failed, start with FAIL:. Output:\n${out}` }], { maxTokens: 100 });
            summary = r.content.trim();
          } catch { summary = out.slice(-140); }
        } else summary = out.slice(-140);
        resolve({ exitCode: code ?? -1, summary, logPath });
      };
      child.on("close", (code) => { void finish(code); });
      child.on("error", (err) => { void finish(-1, err.message); }); // e.g. ENOENT: resolve, never hang
    });
  }

  killAll(): void {
    for (const [, c] of this.running) {
      const pid = c.pid;
      if (typeof pid !== "number") continue;
      try { process.kill(-pid, "SIGKILL"); } // whole process group
      catch { try { c.kill("SIGKILL"); } catch { /* already gone */ } }
    }
    this.running.clear();
  }

  reapOrphans(): void {
    const ledger = this.ledgerPath();
    if (!existsSync(ledger)) return;
    let pids: unknown;
    try { pids = JSON.parse(readFileSync(ledger, "utf8")); } catch { return; }
    if (!Array.isArray(pids)) return;
    for (const pid of pids) {
      if (!Number.isInteger(pid)) continue; // never signal a bogus ledger entry
      try { process.kill(pid, 0); } catch { continue; } // already dead
      try { process.kill(-pid, "SIGKILL"); } // whole orphaned process group
      catch { try { process.kill(pid, "SIGKILL"); } catch { /* raced away */ } }
    }
    this.updateLedger(() => []);
  }
}
