// packages/ceo-core/src/auditor.ts
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { LLMClient } from "./llm.js";

export interface DecisionTrace { contextDigest: string; actions: unknown[]; cost: number; }

export class Auditor {
  private traces: DecisionTrace[] = []; // in-memory batch, consumed by review()
  private db: DatabaseSync;             // durable log, survives jex restarts
  constructor(private opts: { runtimeDir: string; reviewEvery?: number }) {
    this.db = new DatabaseSync(join(opts.runtimeDir, "traces.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL");
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
      { role: "system", content: "You are the meta-learning auditor. Score past decisions against the RUBRIC. Find recurring low-quality decision patterns. Output EXACTLY three sections:\nRUBRIC PATCH: <new/changed rubric lines to append>\nMEMORY PATCH: <durable facts to append>\nMISSION NOTE: <one line: mission drift observed, or 'none'>\n\n# COST FLOORS (design constants — a wake AT these costs is healthy, never a violation):\n- idle patrol wake, no action: ~2.0-2.1k tok (the triage call itself carries the context; this is the system's idle floor, not hidden work)\n- morning briefing (08:00-11:00 window, once daily): ~8k tok, MANDATED deliverable — never 'unrequested'\n- agents_rescan wake (every 6h): ~8k tok full-context scan mandate\nDo NOT write rubric rules demanding costs below these floors, and do NOT re-flag wakes that sit AT a floor — flag only deviations ABOVE them without new work to show for it." },
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

  // Public snapshot: jex self-edits (mission_update) commit runtime docs
  // BEFORE mutating them, so evolution history stays recoverable.
  snapshotRuntime(): void {
    const d = this.opts.runtimeDir;
    try {
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
    } catch {
      // git missing (bare binary distribution): patches still apply, history
      // tracking is unavailable — same degradation as first-boot
      if (!Auditor.gitWarned) {
        console.warn("[audit] git unavailable — snapshot history disabled");
        Auditor.gitWarned = true;
      }
    }
  }
  private static gitWarned = false;
}
