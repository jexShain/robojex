// packages/ceo-core/src/agent-scout.ts
// Agent recon (SPEC-BUTLER §2): probe the system for known agent CLIs, and
// for each hit wire it into the delegation machinery — orchestrator override
// (a {prompt} template), agent registry entry, an LLM-written delegation
// manual — then summarize the fleet into runtime/AGENTS.md, the standing
// "who works for me" inventory the decide prompt carries next to TOOLS.md.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LLMClient } from "./llm.js";
import type { AgentRegistry, AgentSpec } from "./agent-registry.js";

export interface KnownAgent {
  name: string;       // canonical registry/spawn name
  aliases: string[];  // probe order: first hit wins (the real binary first)
  cmd: string;        // command template; {prompt} is shell-quoted at spawn
  blurb: string;      // one-line capability description for AGENTS.md
  capabilities?: string[];
  manual?: string;    // standing delegation manual (<=800 chars); LLM fills the rest
}

export const KNOWN_AGENTS: KnownAgent[] = [
  { name: "claude-code", aliases: ["claude"], cmd: "claude -p {prompt} --dangerously-skip-permissions", blurb: "Claude Code — Anthropic's coding agent, strong at repo-wide edits, tests and git", capabilities: ["coding", "review", "git"] },
  { name: "hermes", aliases: ["hermes"], cmd: "hermes -z {prompt} --yolo", blurb: "Hermes — general-purpose agent with tool use", capabilities: ["general", "coding", "web"] },
  { name: "opencode", aliases: ["opencode"], cmd: "opencode --quiet -p {prompt}", blurb: "OpenCode — open-source coding agent (TUI/CLI)", capabilities: ["coding"] },
  { name: "omp", aliases: ["omp"], cmd: "omp {prompt}", blurb: "omp — local agent CLI runner", capabilities: ["general"] },
  { name: "codex", aliases: ["codex"], cmd: "codex --quiet --full-auto {prompt}", blurb: "OpenAI Codex CLI — autonomous coding agent", capabilities: ["coding", "review"] },
  { name: "aider", aliases: ["aider"], cmd: "aider --yes-always --no-auto-commits --message {prompt}", blurb: "Aider — AI pair programmer working directly on git repos", capabilities: ["coding", "refactor"] },
  { name: "gemini", aliases: ["gemini"], cmd: "gemini -p {prompt}", blurb: "Gemini CLI — Google's coding agent with Google-context reach", capabilities: ["coding", "web"] },
  { name: "qwen", aliases: ["qwen"], cmd: "qwen -p {prompt}", blurb: "Qwen Code — Alibaba's coding agent CLI", capabilities: ["coding"] },
  { name: "goose", aliases: ["goose"], cmd: "goose run --text {prompt}", blurb: "Goose — Block's extensible agent, MCP-savvy", capabilities: ["general", "coding"] },
  { name: "crush", aliases: ["crush"], cmd: "crush -p {prompt}", blurb: "Crush — Charm's terminal coding agent", capabilities: ["coding"] },
];

export interface DiscoveredAgent { agent: KnownAgent; bin: string; }
export interface AgentScoutReport { discovered: DiscoveredAgent[]; manualsGenerated: number; }

// Test seam: the real probe shells out (which on unix, where on Windows).
export type AgentWhichFn = (name: string) => Promise<string | null>;

const defaultAgentWhich: AgentWhichFn = (name) => new Promise((resolve) => {
  const probe = process.platform === "win32" ? "where" : "which";
  execFile(probe, [name], (err, stdout) => resolve(err || !stdout.trim() ? null : stdout.trim()));
});

// Install pockets `which` misses when PATH is thin (agent CLIs love these).
const EXTRA_BINS = [".local/bin", "bin", ".opencode/bin", ".npm-global/bin"];

const MANUAL_MAX_CHARS = 800;

export class AgentScout {
  private which: AgentWhichFn;
  private extraBins: string[];
  private busy = false;

  constructor(private opts: {
    llm: LLMClient | null;
    runtimeDir: string;
    registry: AgentRegistry;
    orchestrator: { setCmd(framework: string, template: string): void };
    whichFn?: AgentWhichFn;
    extraBins?: string[]; // install pockets probed beyond PATH; [] disables (tests)
    spend?: (u: { promptTokens: number; completionTokens: number }) => void; // books manual LLM burn into the budget
  }) {
    this.which = opts.whichFn ?? defaultAgentWhich;
    this.extraBins = opts.extraBins ?? EXTRA_BINS;
  }

  /** Resolve one binary name to a path: PATH first, then the common pockets. */
  private async probeBin(name: string): Promise<string | null> {
    const hit = await this.which(name);
    if (hit) return hit;
    const home = homedir();
    for (const d of this.extraBins) {
      const p = join(home, d, name);
      if (existsSync(p)) return p;
    }
    return null;
  }

  /** Which known agents are installed right now (alias order decides the bin). */
  async probe(): Promise<DiscoveredAgent[]> {
    const found: DiscoveredAgent[] = [];
    for (const agent of KNOWN_AGENTS) {
      for (const alias of [...new Set([...agent.aliases, agent.name])]) {
        const bin = await this.probeBin(alias);
        if (bin) { found.push({ agent, bin }); break; }
      }
    }
    return found;
  }

  // Delegation manual for one agent. Standing table text wins; otherwise the
  // LLM writes one; failure degrades to no manual file, never a broken pass.
  private async writeManual(agent: KnownAgent): Promise<boolean> {
    const dir = join(this.opts.runtimeDir, "agent-manuals");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${agent.name}.md`);
    if (existsSync(p)) return false; // idempotent: an existing file is never regenerated
    let content = agent.manual ?? "";
    if (!content && this.opts.llm) {
      try {
        const r = await this.opts.llm.chat("patrol", [
          { role: "system", content: "You write terse English delegation manuals for AI agent CLIs. Plain text only, at most 800 characters total: one sentence on what the agent is best at, a '## Delegation tips' list with exactly 3 one-line pointers (prompt style, useful flags, output shape), and one 'Caution:' line naming the sharpest edge." },
          { role: "user", content: `Write the delegation manual for the agent CLI '${agent.name}', invoked as: ${agent.cmd}` },
        ], { maxTokens: 500 });
        this.opts.spend?.(r.usage); // manual generation burns tokens: book them
        content = r.content.trim();
      } catch (e) {
        console.warn(`[agent-scout] manual for ${agent.name} failed (best-effort skip): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!content) return false;
    writeFileSync(p, content.slice(0, MANUAL_MAX_CHARS));
    return true;
  }

  /** One recon pass: probe -> wire every hit into orchestrator + registry ->
   *  manuals -> AGENTS.md. The caller pushes the wake event. */
  async run(): Promise<AgentScoutReport> {
    if (this.busy) {
      console.warn("[agent-scout] recon pass already in flight: returning an empty report");
      return { discovered: [], manualsGenerated: 0 };
    }
    this.busy = true;
    try {
      const discovered = await this.probe();
      const lines: string[] = [];
      let manualsGenerated = 0;
      for (const { agent } of discovered) {
        this.opts.orchestrator.setCmd(agent.name, agent.cmd);
        const spec: AgentSpec = { name: agent.name, cmd: agent.cmd, description: agent.blurb, ...(agent.capabilities ? { capabilities: agent.capabilities } : {}) };
        this.opts.registry.register(spec);
        if (await this.writeManual(agent)) manualsGenerated++;
        lines.push(`${agent.name} — ${agent.blurb} [verified]`);
      }
      writeFileSync(join(this.opts.runtimeDir, "AGENTS.md"), `${lines.join("\n")}\n`);
      return { discovered, manualsGenerated };
    } finally {
      this.busy = false;
    }
  }
}
