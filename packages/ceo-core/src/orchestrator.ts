// packages/ceo-core/src/orchestrator.ts
import { spawn as pspawn, type ChildProcess } from "node:child_process";
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

export class AgentOrchestrator {
  private running = new Map<string, ChildProcess>();
  constructor(private opts: { llm: LLMClient | null; runtimeDir: string; maxConcurrent?: number; cmds?: Partial<Record<Framework, string>> }) {
    mkdirSync(join(this.opts.runtimeDir, "runs"), { recursive: true });
  }

  async spawn(fw: Framework, prompt: string, o: { timeoutMs?: number } = {}): Promise<SpawnResult> {
    const id = randomUUID().slice(0, 8);
    const logPath = join(this.opts.runtimeDir, "runs", `${id}.log`);
    const cmd = this.opts.cmds?.[fw] ?? DEFAULT_CMDS[fw](prompt);
    const full = this.opts.cmds?.[fw] && cmd.includes(" ") ? cmd : `${cmd} ${shq(prompt)}`;
    return new Promise<SpawnResult>((resolve) => {
      const child = pspawn(full, { shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] });
      this.running.set(id, child);
      let out = "";
      child.stdout!.on("data", (d) => { out += d; });
      child.stderr!.on("data", (d) => { out += d; });
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, o.timeoutMs ?? 30 * 60_000);
      child.on("close", async (code) => {
        clearTimeout(timeout); this.running.delete(id);
        writeFileSync(logPath, out); // full output on disk, never into CEO context
        const tail = out.slice(-2048);
        let summary: string;
        if (timedOut) {
          summary = "timeout";
        } else if (this.opts.llm) {
          try {
            const r = await this.opts.llm.chat("patrol", [{ role: "user", content: `Summarize this sub-agent result in ONE line (<=140 chars). If failed, start with FAIL:. Output:\n${tail}` }], { maxTokens: 100 });
            summary = r.content.trim();
          } catch { summary = tail.slice(-140); }
        } else summary = tail.slice(-140);
        resolve({ exitCode: code ?? -1, summary, logPath });
      });
    });
  }

  killAll(): void { for (const [, c] of this.running) c.kill("SIGKILL"); this.running.clear(); }

  reapOrphans(): void {
    // pid ledger written before spawn; kill any whose process no longer has us as ancestor context
    const ledger = join(this.opts.runtimeDir, "pids.json");
    if (!existsSync(ledger)) return;
    let pids: number[] = [];
    try { pids = JSON.parse(readFileSync(ledger, "utf8")); } catch { return; }
    for (const pid of pids) { try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch { /* already dead */ } }
    writeFileSync(ledger, "[]");
  }
}
