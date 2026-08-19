// packages/ceo-core/src/auditor.ts
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { LLMClient } from "./llm.js";

export interface DecisionTrace { contextDigest: string; actions: unknown[]; cost: number; }

export class Auditor {
  private traces: DecisionTrace[] = []; // in-memory batch, consumed by review()
  private db: Database.Database;        // durable log, survives CEO restarts
  constructor(private opts: { runtimeDir: string; reviewEvery?: number }) {
    this.db = new Database(join(opts.runtimeDir, "traces.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY, ts INTEGER, context_digest TEXT, actions TEXT, cost INTEGER)`);
  }

  record(d: DecisionTrace): void {
    this.traces.push(d);
    this.db.prepare("INSERT INTO decisions (id, ts, context_digest, actions, cost) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), Date.now(), d.contextDigest, JSON.stringify(d.actions), d.cost);
  }
  due(): boolean { return this.traces.length >= (this.opts.reviewEvery ?? 20); }

  async review(llm: LLMClient): Promise<{ rubricPatch: string; memoryPatch: string; missionNote: string; usage: { promptTokens: number; completionTokens: number } }> {
    const rubric = readFileSync(join(this.opts.runtimeDir, "RUBRIC.md"), "utf8");
    const dump = this.traces.map((t, i) => `## decision ${i + 1}\ncontext: ${t.contextDigest}\nactions: ${JSON.stringify(t.actions)}\ncost: ${t.cost}`).join("\n\n");
    const r = await llm.chat("decide", [
      { role: "system", content: "You are the meta-learning auditor. Score past decisions against the RUBRIC. Find recurring low-quality decision patterns. Output EXACTLY three sections:\nRUBRIC PATCH: <new/changed rubric lines to append>\nMEMORY PATCH: <durable facts to append>\nMISSION NOTE: <one line: mission drift observed, or 'none'>" },
      { role: "user", content: `# CURRENT RUBRIC\n${rubric}\n\n# DECISION TRACES\n${dump}` },
    ], { maxTokens: 1500 });
    const c = r.content;
    const grab = (tag: string) => { const m = c.match(new RegExp(`${tag}:\\s*([\\s\\S]*?)(?=\\n[A-Z]{3,} [A-Z]{3,}:|$)`)); return m ? m[1].trim() : ""; };
    this.traces = []; // batch consumed
    return { rubricPatch: grab("RUBRIC PATCH"), memoryPatch: grab("MEMORY PATCH"), missionNote: grab("MISSION NOTE"), usage: r.usage };
  }

  applyPatches(p: { rubricPatch: string; memoryPatch: string }): void {
    this.snapshotRuntime(); // commit BEFORE mutation — evolution history is recoverable
    if (p.rubricPatch) appendFileSync(join(this.opts.runtimeDir, "RUBRIC.md"), `\n${p.rubricPatch}\n`);
    if (p.memoryPatch) appendFileSync(join(this.opts.runtimeDir, "MEMORY.md"), `\n${p.memoryPatch}\n`);
  }

  private snapshotRuntime(): void {
    const d = this.opts.runtimeDir;
    const git = (args: string) => execSync(`git ${args}`, { cwd: d });
    if (!existsSync(join(d, ".git"))) git("init -q");
    const files = ["MISSION.md", "RUBRIC.md", "MEMORY.md"];
    files.forEach(f => {
      const p = join(d, f);
      if (existsSync(p)) {
        try { git(`add ${f}`); } catch {}
      }
    });
    git('-c user.email=ceo@robojex -c user.name=ceo-core commit -qm "audit snapshot" --allow-empty');
  }
}
