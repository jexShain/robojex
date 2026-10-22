#!/usr/bin/env node
// packages/ceo-core/src/index.ts
import { mkdirSync, existsSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { LLMClient } from "./llm.js";
import { TaskBoard } from "./board.js";
import { ContextAssembler } from "./context.js";
import { AgentOrchestrator } from "./orchestrator.js";
import { AgentRegistry, BUILTIN_AGENTS, loadCustomAgents } from "./agent-registry.js";
import { Auditor } from "./auditor.js";
import { BudgetGovernor, type BudgetMode } from "./budget.js";
import { SchedulerLoop, DEFAULT_SKILLS_DIR, resolvePolicy, type LoopDeps } from "./loop.js";
import { ToolScout } from "./toolscout.js";
import { AgentScout, type AgentWhichFn } from "./agent-scout.js";
import { TentacleManager } from "./tentacles.js";
import { ApiServer } from "./api.js";
import { ChatStore } from "./chat-store.js";
import { ChatService } from "./chat-service.js";
import { GearController, getGearDef } from "./gears.js";
import { ToolRegistry } from "./tools/registry.js";
import { ToolManager, P1_TOOLS } from "./tools/manager.js";

// runtime state that must never enter git history (config.json holds the API key)
export const RUNTIME_GITIGNORE = "config.json\nboard.sqlite*\ntraces.sqlite*\nchat.sqlite*\npids.json\nruns/\nshots/\nTOOLS.md\ntool-manuals/\nPENDING_INSTALLS.md\nTENTACLES.md\ntentacles/\ntentacle-manuals/\nAGENTS.md\nagent-manuals/\n";
const SEED_DOCS = ["MISSION.md", "RUBRIC.md", "MEMORY.md"] as const;

export function seedRuntimeFiles(runtimeDir: string): void {
  mkdirSync(join(runtimeDir, "runs"), { recursive: true });
  const seed = (f: string, content: string) => { const p = join(runtimeDir, f); if (!existsSync(p)) writeFileSync(p, content); };
  seed("MISSION.md", "# MISSION\n(Describe long-term goals here. Jex evolves this file.)\n");
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
  try {
    execSync("git --version", { stdio: "ignore" });
  } catch {
    // bare machines (binary distribution) may not ship git: run without the
    // embedded history; audit snapshots degrade the same way at runtime
    console.warn("[ceo] git not found — runtime evolution history disabled");
    return [];
  }
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
  api?: { close(): void },
): () => void {
  return () => {
    loop.stop();
    orchestrator.killAll(); // no detached sub-agent process group outlives jex
    api?.close();           // a lingering api port must not outlive jex either
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

interface Config {
  baseUrl?: string; apiKey?: string; patrolModel?: string; decideModel?: string;
  budgetMode?: "burn" | "budgeted"; dailyTokens?: number; tickMs?: number; takeoverUrl?: string;
  webhookPort?: number; apiPort?: number; apiHost?: string;
  autonomyGear?: string; // dormant|eco|balanced|focused|turbo (GearController validates)
  policy?: "butler" | "conservative"; // autonomy doctrine (SPEC-BUTLER §1); butler is the default
  thinking?: boolean; // thinking mode: OFF by default (absent = false); settings hot-applies
}

// The loop surface main() needs; SchedulerLoop satisfies it structurally and
// tests substitute a factory spy to assert the loop is not just built but
// actually started.
export interface StartableLoop {
  start(tickMs?: number): void;
  stop(): void;
  push(event: string): void;
}

export interface AssembleDeps {
  loopFactory?: (deps: LoopDeps) => StartableLoop; // test seam: spy on start()
  exit?: () => void;                               // test seam: no process.exit
  bootReconMs?: number;                            // test seam: boot-recon delay (default ~3s)
  agentWhichFn?: AgentWhichFn;                     // test seam: deterministic agent probing
}

export interface Assembled { loop: StartableLoop; api: ApiServer; stop: () => void; }

// Build every runtime component and START the scheduler loop. Extracted from
// main() so the regression test can assert loop.start() runs: a past refactor
// dropped that call and jex constructed everything yet never ticked.
// packages/ceo-core/{src,dist} -> packages/web/dist in the repo; under a pkg
// binary the release layout ships web/ beside the executable.
const DEFAULT_WEB_DIR = process.env.ROBOJEX_WEB_DIR
  ?? (import.meta.url ? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist") : join(dirname(process.execPath), "web"));

export function assembleAndStart(cfg: Config, runtimeDir: string, deps: AssembleDeps = {}): Assembled {
  const llm = new LLMClient({ baseUrl: cfg.baseUrl ?? "", apiKey: cfg.apiKey ?? "", patrolModel: cfg.patrolModel ?? "", decideModel: cfg.decideModel ?? "", thinking: cfg.thinking === true });
  const registry = new AgentRegistry(BUILTIN_AGENTS);
  // T5: human-declared custom agents (JSON specs under runtime/agents.json and
  // runtime/agents/*.json) join the fleet; malformed files warn and are skipped
  for (const spec of loadCustomAgents(runtimeDir).specs) registry.register(spec);
  const orchestrator = new AgentOrchestrator({ llm, runtimeDir, registry });
  orchestrator.reapOrphans(); // detached sub-agents of a crashed jex must die before new work starts
  const budgetCfg = resolveBudgetConfig(cfg);
  const budget = new BudgetGovernor(budgetCfg.budgetMode, budgetCfg.dailyTokens, undefined, runtimeDir);
  const scout = new ToolScout({ llm, runtimeDir, spend: (u) => budget.spend(u) }); // scout LLM calls are budget burn too
  const tentacles = new TentacleManager({ llm, runtimeDir, spend: (u) => budget.spend(u) }); // manual LLM calls likewise
  // agent recon (SPEC-BUTLER §2): probes known agent CLIs and wires the hits
  // into orchestrator + registry; fired below once the loop exists (it wakes
  // jex with the discovery), then refreshed by jex's own later actions
  const agentScout = new AgentScout({
    llm, runtimeDir, registry, orchestrator,
    // an injected whichFn owns discovery end to end (hermetic tests: pockets off)
    ...(deps.agentWhichFn ? { whichFn: deps.agentWhichFn, extraBins: [] } : {}),
    spend: (u) => budget.spend(u),
  });
  // first boot: build the verified tool inventory once, in the background —
  // later refreshes come from jex's own toolscout actions
  if (!existsSync(join(runtimeDir, "TOOLS.md"))) {
    void scout.run().then((r) => console.log(`[ceo] toolscout: ${r.verified.length} verified`))
      .catch((e: unknown) => console.error(`[ceo] toolscout failed: ${e instanceof Error ? e.message : String(e)}`));
  }
  const board = new TaskBoard(join(runtimeDir, "board.sqlite"));
  const auditor = new Auditor({ runtimeDir });
  // direct-chat surface + autonomy gears: one gear active process-wide; every
  // switch persists to config.json, retimes the loop and broadcasts on the WS
  const chatStore = new ChatStore(join(runtimeDir, "chat.sqlite"));
  const gearController = new GearController({
    runtimeDir,
    initial: cfg.autonomyGear,
    onApply: (g) => { loopRef?.setGear(g.id); }, // WS broadcast is the api layer's job (ApiServer.gearSwitch)
  });
  const chatService = new ChatService({
    store: chatStore, llm, gear: gearController, budget, runtimeDir,
    onAgentEvent: (text) => { loop.push(text); }, // mode:'agent' chats also reach the orchestration loop
    // live-lookup grounding: the direct chat runs builtin tools through the
    // sentinel protocol. Both close over objects built a few lines below (the
    // tool manager, the loop) — same deferred-reference pattern as onAgentEvent.
    tools: {
      call: (name, args, gate) => builtinTools.call(name, args, gate),
      schemasBlock: () => builtinTools.schemasBlock(),
    },
    gate: () => loopRef?.gateForTools() ?? "full",
  });
  // builtin capability layer: hermes-core tools bridged onto jex subsystems.
  // takeoverSend/chatOut need the loop/api objects while both of those need
  // this manager — mutable refs close the cycle, filled once they exist.
  let loopRef: SchedulerLoop | undefined;
  let apiRef: ApiServer | undefined;
  const toolRegistry = new ToolRegistry();
  for (const e of P1_TOOLS()) toolRegistry.register(e);
  const builtinTools = new ToolManager({
    registry: toolRegistry,
    ctx: {
      runtimeDir, board,
      spawn: (framework, prompt) => orchestrator.spawn(framework, prompt),
      skillsDir: DEFAULT_SKILLS_DIR,
      takeoverSend: (frame) => { loopRef?.sendCtrl(frame); },
      chatOut: (from, text) => { apiRef?.chatOut(from, text); },
    },
  });
  const loopDeps: LoopDeps = {
    llm, board, ctx: new ContextAssembler(),
    orchestrator, auditor,
    budget, runtimeDir,
    takeoverUrl: cfg.takeoverUrl ?? "ws://127.0.0.1:7600",
    scout,
    tentacles,
    builtinTools,
    policy: resolvePolicy(cfg.policy),
  };
  const loop = deps.loopFactory ? deps.loopFactory(loopDeps) : new SchedulerLoop(loopDeps);
  // operator surface: HTTP+WS api (default :7620); the web bundle is served
  // only when the dist tree exists (source checkout / release layout)
  const webDir = DEFAULT_WEB_DIR;
  const api = new ApiServer({
    port: cfg.apiPort ?? 7620, host: cfg.apiHost, board, budget, runtimeDir, loop,
    snapshotRuntime: () => auditor.snapshotRuntime(),
    rubricHistory: () => auditor.rubricHistory(), // T9: `git log -- RUBRIC.md` over HTTP
    chat: chatService, gear: gearController, llm,
    ...(existsSync(webDir) ? { webDir } : {}),
  });
  if (loop instanceof SchedulerLoop) { loopRef = loop; loop.setOutlet(api); loop.setGear(gearController.current()); } // jex replies + cycle/tasks/mode frames ride the api broadcast; gear retimes the tick
  apiRef = api;
  const apiHostLog = cfg.apiHost ?? "127.0.0.1";
  void api.start()
    .then(() => console.log(`[ceo] api on http://${apiHostLog}:${api.port}`))
    .catch((e: unknown) => console.error(`[ceo] api failed: ${e instanceof Error ? e.message : String(e)}`));
  // tentacles boot: load specs/plugins, hardware-scan on first boot, then one
  // probe + manual pass; the webhook sink is wired even when no webhook
  // tentacle exists yet, so one registered later lazily starts the server
  void (async () => {
    await tentacles.loadAll();
    if (!existsSync(join(runtimeDir, "TENTACLES.md"))) {
      const hw = await tentacles.scanHardware();
      if (hw > 0) console.log(`[ceo] hardware scout: ${hw} devices registered`);
    }
    await tentacles.probeAll();
    await tentacles.writeManuals();
    tentacles.setWebhookSink(cfg.webhookPort ?? 7610, (s) => loop.push(s));
    if (tentacles.list().some((t) => t.kind === "webhook")) {
      const srv = await tentacles.ensureWebhookServer();
      if (srv) console.log(`[ceo] tentacle webhook server on port ${srv.port}`);
    }
  })().catch((e: unknown) => console.error(`[ceo] tentacles failed: ${e instanceof Error ? e.message : String(e)}`));
  // jex must schedule: without this it never ticks. An explicit cfg.tickMs
  // wins at boot (operator override); otherwise the gear defines the cadence
  // (dormant = 0 = no interval, chat still answers).
  const gearTick = getGearDef(gearController.current())?.tickMs ?? 60_000;
  loop.start(Number(cfg.tickMs) > 0 ? Number(cfg.tickMs) : gearTick);
  // agent recon, parallel to the ToolScout first pass: register whatever is
  // installed, then wake jex — a butler's first asset is knowing its staff.
  // Runs on every boot (the installed set changes with the machine); AGENTS.md
  // reflects reality, an empty fleet is a valid finding.
  void agentScout.run()
    .then((r) => {
      loop.push(`agents discovered: ${r.discovered.length ? r.discovered.map((d) => d.agent.name).join(", ") : "(none)"}`);
      // butler briefing: a non-empty fleet earns one chat line (an empty one
      // stays silent — "no agents found" is activity-stream news, not chat)
      if (r.discovered.length) apiRef?.chatOut("jex", `收编代理：${r.discovered.map((d) => d.agent.name).join("、")} 可用`);
    })
    .catch((e: unknown) => console.error(`[ceo] agent-scout failed: ${e instanceof Error ? e.message : String(e)}`));
  // boot recon (SPEC-BUTLER §3): ~3s after start jex surveys the system and
  // its agents instead of waiting for the first full tick — desktop launch to
  // working butler in three seconds. Dormant stays asleep (checked at fire
  // time, so a hot gear switch within the window is honored).
  const bootRecon = setTimeout(() => {
    if ((getGearDef(gearController.current())?.tickMs ?? 60_000) === 0) return; // dormant: no work wake
    loop.push("boot: 刚启动——盘点系统与可用代理（读 TOOLS/AGENTS），更新环境认知；若无待办则建立或审视今日目标");
  }, deps.bootReconMs ?? 3000);
  bootRecon.unref();
  // the boot wake must not fire into a shut-down loop (embedded deployments
  // keep the process alive after stop)
  const shutdown = makeShutdownHandler(loop, orchestrator, deps.exit, api);
  return { loop, api, stop: () => { clearTimeout(bootRecon); shutdown(); } };
}

function main(): void {
  const runtimeDir = process.env.ROBOJEX_RUNTIME ?? join(process.cwd(), "runtime");
  seedRuntimeFiles(runtimeDir);
  initRuntimeGit(runtimeDir);

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

  const { stop } = assembleAndStart(cfg, runtimeDir);
  console.log("ceo-core running (Ctrl+C to stop)");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// run only when executed as the entry module (node dist/index.js), never on import;
// a pkg binary always runs as main (import.meta.url is unavailable there)
const isMain = (() => {
  if ((process as NodeJS.Process & { pkg?: unknown }).pkg) return true;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href; }
  catch { return false; }
})();
if (isMain) main();
