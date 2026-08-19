#!/usr/bin/env node
// packages/ceo-core/src/index.ts
import { mkdirSync, existsSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { LLMClient } from "./llm.js";
import { TaskBoard } from "./board.js";
import { ContextAssembler } from "./context.js";
import { AgentOrchestrator } from "./orchestrator.js";
import { Auditor } from "./auditor.js";
import { BudgetGovernor, type BudgetMode } from "./budget.js";
import { SchedulerLoop } from "./loop.js";

// runtime state that must never enter git history (config.json holds the API key)
export const RUNTIME_GITIGNORE = "config.json\nboard.sqlite*\ntraces.sqlite*\npids.json\nruns/\nshots/\n";
const SEED_DOCS = ["MISSION.md", "RUBRIC.md", "MEMORY.md"] as const;

export function seedRuntimeFiles(runtimeDir: string): void {
  mkdirSync(join(runtimeDir, "runs"), { recursive: true });
  const seed = (f: string, content: string) => { const p = join(runtimeDir, f); if (!existsSync(p)) writeFileSync(p, content); };
  seed("MISSION.md", "# MISSION\n(Describe long-term goals here. The CEO evolves this file.)\n");
  seed("RUBRIC.md", "# RUBRIC\n- prefer cheap patrol decisions\n- spawn sub-agents instead of doing work inline\n- verify results before marking tasks done\n");
  seed("MEMORY.md", "# MEMORY\n");
  // written before the init commit so no later sweep can pick secrets up
  seed(".gitignore", RUNTIME_GITIGNORE);
}

// First-boot git history for the runtime dir. Returns the git command strings
// executed (test seam: inject `run` to record instead of execute). Seed docs
// are added per-file, tolerantly — NEVER `add -A`, which would sweep config.json
// (API key) into history.
export function initRuntimeGit(runtimeDir: string, run: (cmd: string, cwd: string) => void = (cmd, cwd) => { execSync(cmd, { cwd }); }): string[] {
  if (existsSync(join(runtimeDir, ".git"))) return [];
  const cmds: string[] = [];
  const git = (sub: string): void => {
    const c = `git -c user.email=ceo@robojex -c user.name=ceo ${sub}`;
    cmds.push(c);
    run(c, runtimeDir);
  };
  git("init -q");
  const added: string[] = [];
  for (const f of SEED_DOCS) {
    try { git(`add ${f}`); added.push(f); } catch { /* seed doc absent: commit what exists */ }
  }
  if (added.length) git("commit -qm init");
  return cmds;
}

export function makeShutdownHandler(
  loop: { stop(): void }, orchestrator: { killAll(): void }, exit: () => void = () => process.exit(0),
): () => void {
  return () => {
    loop.stop();
    orchestrator.killAll(); // no detached sub-agent process group outlives the CEO
    exit();
  };
}

// Startup-time config validation: a typo'd budgetMode — or budgeted without
// a dailyTokens cap, which BudgetGovernor would silently treat as unlimited —
export function resolveBudgetConfig(cfg: { budgetMode?: string; dailyTokens?: number }): { budgetMode: BudgetMode; dailyTokens: number } {
  let mode: BudgetMode = "burn";
  if (cfg.budgetMode === "budgeted") mode = "budgeted";
  else if (cfg.budgetMode !== undefined && cfg.budgetMode !== "burn") {
    console.warn(`[ceo] invalid budgetMode ${JSON.stringify(cfg.budgetMode)}: falling back to burn`);
  }
  if (mode === "budgeted" && !(typeof cfg.dailyTokens === "number" && Number.isFinite(cfg.dailyTokens) && cfg.dailyTokens > 0)) {
    console.warn(`[ceo] budgeted mode requires dailyTokens > 0: falling back to burn`);
    mode = "burn";
  }
  return { budgetMode: mode, dailyTokens: cfg.dailyTokens ?? 0 };
}

function main(): void {
  const runtimeDir = process.env.ROBOJEX_RUNTIME ?? join(process.cwd(), "runtime");
  seedRuntimeFiles(runtimeDir);
  initRuntimeGit(runtimeDir);

  interface Config {
    baseUrl?: string; apiKey?: string; patrolModel?: string; decideModel?: string;
    budgetMode?: "burn" | "budgeted"; dailyTokens?: number; tickMs?: number; takeoverUrl?: string;
  }
  let cfg: Config = {};
  const cfgPath = join(runtimeDir, "config.json");
  if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Config;

  if (process.argv.includes("--install-service")) {
    const unit = (name: string, cmd: string) => `[Unit]\nDescription=robojex ${name}\nAfter=network.target\n\n[Service]\nExecStart=${cmd}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
    writeFileSync(join(runtimeDir, "robojex-ceo.service"), unit("ceo", `node ${process.cwd()}/packages/ceo-core/dist/index.js`));
    writeFileSync(join(runtimeDir, "robojex-takeoverd.service"), unit("takeoverd", `node ${process.cwd()}/packages/takeoverd/dist/index.js`));
    console.log(`systemd units written to ${runtimeDir} — copy to ~/.config/systemd/user/ and enable`);
    process.exit(0);
  }

  const llm = new LLMClient({ baseUrl: cfg.baseUrl ?? "", apiKey: cfg.apiKey ?? "", patrolModel: cfg.patrolModel ?? "", decideModel: cfg.decideModel ?? "" });
  const orchestrator = new AgentOrchestrator({ llm, runtimeDir });
  orchestrator.reapOrphans(); // a crashed CEO's detached sub-agents must die before new work starts
  const budgetCfg = resolveBudgetConfig(cfg);
  const loop = new SchedulerLoop({
    llm, board: new TaskBoard(join(runtimeDir, "board.sqlite")), ctx: new ContextAssembler(),
    orchestrator, auditor: new Auditor({ runtimeDir }),
    budget: new BudgetGovernor(budgetCfg.budgetMode, budgetCfg.dailyTokens), runtimeDir,
    takeoverUrl: cfg.takeoverUrl ?? "ws://127.0.0.1:7600",
  });
  loop.start(cfg.tickMs ?? 60_000);
  console.log("ceo-core running (Ctrl+C to stop)");
  const shutdown = makeShutdownHandler(loop, orchestrator);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// run only when executed as the entry module (node dist/index.js), never on import
const isMain = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href; }
  catch { return false; }
})();
if (isMain) main();
