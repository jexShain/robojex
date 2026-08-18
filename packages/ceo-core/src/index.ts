#!/usr/bin/env node
// packages/ceo-core/src/index.ts
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { LLMClient } from "./llm.js";
import { TaskBoard } from "./board.js";
import { ContextAssembler } from "./context.js";
import { AgentOrchestrator } from "./orchestrator.js";
import { Auditor } from "./auditor.js";
import { BudgetGovernor } from "./budget.js";
import { SchedulerLoop } from "./loop.js";

const runtimeDir = process.env.ROBOJEX_RUNTIME ?? join(process.cwd(), "runtime");
mkdirSync(join(runtimeDir, "runs"), { recursive: true });

// seed files on first boot
const seed = (f: string, content: string) => { const p = join(runtimeDir, f); if (!existsSync(p)) writeFileSync(p, content); };
seed("MISSION.md", "# MISSION\n(Describe long-term goals here. The CEO evolves this file.)\n");
seed("RUBRIC.md", "# RUBRIC\n- prefer cheap patrol decisions\n- spawn sub-agents instead of doing work inline\n- verify results before marking tasks done\n");
seed("MEMORY.md", "# MEMORY\n");
if (!existsSync(join(runtimeDir, ".git"))) { execSync("git init -q", { cwd: runtimeDir }); execSync("git -c user.email=ceo@robojex -c user.name=ceo add -A && git -c user.email=ceo@robojex -c user.name=ceo commit -qm init", { cwd: runtimeDir }); }

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
const loop = new SchedulerLoop({
  llm, board: new TaskBoard(join(runtimeDir, "board.sqlite")), ctx: new ContextAssembler(),
  orchestrator: new AgentOrchestrator({ llm, runtimeDir }), auditor: new Auditor({ runtimeDir }),
  budget: new BudgetGovernor(cfg.budgetMode ?? "burn", cfg.dailyTokens), runtimeDir,
  takeoverUrl: cfg.takeoverUrl ?? "ws://127.0.0.1:7600",
});
loop.start(cfg.tickMs ?? 60_000);
console.log("ceo-core running (Ctrl+C to stop)");
process.on("SIGINT", () => { loop.stop(); process.exit(0); });
process.on("SIGTERM", () => { loop.stop(); process.exit(0); });
