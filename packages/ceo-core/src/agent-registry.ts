// packages/ceo-core/src/agent-registry.ts
// Registry of spawnable coding agents (T5). Specs are plain data — they can
// come from the built-in table, the agent-scout's verified discoveries, or
// human-written JSON under runtime/agents.json + runtime/agents/*.json, so
// jex supports arbitrary coding CLIs without a code change.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export interface AgentSpec {
  name: string;
  cmd: string; // template with {prompt} placeholder
  env?: Record<string, string>;
  timeoutMs?: number;
  capabilities?: string[];
  description?: string;
}

export const BUILTIN_AGENTS: AgentSpec[] = [
  {
    name: "hermes",
    cmd: "hermes -z {prompt} --yolo",
    capabilities: ["general", "coding", "web"],
    description: "Hermes Agent — general-purpose AI assistant with tool use",
  },
  {
    name: "claude-code",
    cmd: "claude -p {prompt} --dangerously-skip-permissions",
    capabilities: ["coding", "review", "git"],
    description: "Claude Code — Anthropic's coding agent",
  },
  {
    name: "codex",
    cmd: "codex --quiet --full-auto {prompt}",
    capabilities: ["coding", "review"],
    description: "OpenAI Codex CLI — autonomous coding agent",
  },
  {
    name: "opencode",
    cmd: "opencode --quiet -p {prompt}",
    capabilities: ["coding"],
    description: "OpenCode — open-source coding agent",
  },
  {
    name: "aider",
    cmd: "aider --yes-always --no-auto-commits --message {prompt}",
    capabilities: ["coding", "refactor"],
    description: "Aider — AI pair programming assistant",
  },
  {
    name: "cursor",
    cmd: "cursor-agent -p {prompt}",
    capabilities: ["coding", "review"],
    description: "Cursor CLI — headless agent of the Cursor editor",
  },
];

const AGENT_SPEC_KEYS = new Set(["name", "cmd", "env", "timeoutMs", "capabilities", "description"]);

/** Validate one untrusted JSON object into an AgentSpec. Throws with a
 *  file-scoped message; a typo'd key (e.g. "capabilites") is refused rather
 *  than silently dropped, so config mistakes surface at load time. */
export function parseAgentSpec(raw: unknown, where = "agent spec"): AgentSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: expected an object, got ${Array.isArray(raw) ? "array" : typeof raw}`);
  const o = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(o).filter((k) => !AGENT_SPEC_KEYS.has(k));
  if (unknownKeys.length) throw new Error(`${where}: unknown key(s) ${unknownKeys.join(", ")} (allowed: ${[...AGENT_SPEC_KEYS].join(", ")})`);
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) throw new Error(`${where}: name must be a non-empty string`);
  const cmd = typeof o.cmd === "string" ? o.cmd.trim() : "";
  if (!cmd) throw new Error(`${where} (${name}): cmd must be a non-empty string`);
  if (!cmd.includes("{prompt}")) throw new Error(`${where} (${name}): cmd must contain the {prompt} placeholder`);
  const spec: AgentSpec = { name, cmd };
  if (o.env !== undefined) {
    if (!o.env || typeof o.env !== "object" || Array.isArray(o.env) || Object.values(o.env as Record<string, unknown>).some((v) => typeof v !== "string")) {
      throw new Error(`${where} (${name}): env must be an object of string values`);
    }
    spec.env = { ...(o.env as Record<string, string>) };
  }
  if (o.timeoutMs !== undefined) {
    if (typeof o.timeoutMs !== "number" || !Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) {
      throw new Error(`${where} (${name}): timeoutMs must be a positive finite number`);
    }
    spec.timeoutMs = o.timeoutMs;
  }
  if (o.capabilities !== undefined) {
    if (!Array.isArray(o.capabilities) || !o.capabilities.every((c) => typeof c === "string")) {
      throw new Error(`${where} (${name}): capabilities must be an array of strings`);
    }
    spec.capabilities = [...(o.capabilities as string[])];
  }
  if (typeof o.description === "string") spec.description = o.description;
  return spec;
}

/** Accepts both shapes: a bare array of specs, or { "agents": [...] }. */
export function parseAgentSpecList(raw: unknown, where = "agents file"): AgentSpec[] {
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === "object" && Array.isArray((raw as { agents?: unknown }).agents) ? (raw as { agents: unknown[] }).agents : null);
  if (!arr) throw new Error(`${where}: expected an array of agent specs or an { "agents": [...] } object`);
  return arr.map((e, i) => parseAgentSpec(e, `${where}[${i}]`));
}

/** Load human-declared custom agents: runtime/agents.json plus every
 *  runtime/agents/*.json. A malformed file is skipped with a warning —
 *  hand-edited config must never crash jex at boot or on hot-load. */
export function loadCustomAgents(runtimeDir: string): { specs: AgentSpec[]; errors: string[] } {
  const specs: AgentSpec[] = [];
  const errors: string[] = [];
  const files: string[] = [];
  const rootFile = join(runtimeDir, "agents.json");
  if (existsSync(rootFile)) files.push(rootFile);
  const dir = join(runtimeDir, "agents");
  try { for (const f of readdirSync(dir).sort()) if (f.endsWith(".json")) files.push(join(dir, f)); } catch { /* no agents dir yet — fine */ }
  for (const f of files) {
    try {
      // where="spec": the file name is prepended by the catch below, giving every
      // error (JSON parse or validation) one single file-scoped prefix
      specs.push(...parseAgentSpecList(JSON.parse(readFileSync(f, "utf8")), "spec"));
    } catch (e) {
      const msg = `${basename(f)}: ${e instanceof Error ? e.message : String(e)}`;
      errors.push(msg);
      console.warn(`[agent-registry] skipping ${f}: ${msg}`);
    }
  }
  return { specs, errors };
}

export class AgentRegistry {
  private agents = new Map<string, AgentSpec>();

  constructor(initial?: AgentSpec[]) {
    for (const a of initial ?? []) this.register(a);
  }

  register(spec: AgentSpec): void {
    this.agents.set(spec.name, spec);
  }

  get(name: string): AgentSpec | undefined {
    return this.agents.get(name);
  }

  list(): AgentSpec[] {
    return Array.from(this.agents.values());
  }

  names(): string[] {
    return Array.from(this.agents.keys());
  }

  /** Match a spawn token to an agent the way the decide model would name it:
   *  exact name > case-insensitive name > unique prefix > capability tag.
   *  A capability hit (e.g. "refactor") selects the agent declaring the most
   *  of the requested capabilities, first-registered wins ties — this is how
   *  spawn picks the best tool for a job when the model answers with a
   *  capability instead of a concrete CLI. */
  resolve(token: string): AgentSpec | undefined {
    const exact = this.agents.get(token);
    if (exact) return exact;
    const t = token.toLowerCase();
    const ci = this.list().find((a) => a.name.toLowerCase() === t);
    if (ci) return ci;
    const prefix = this.list().filter((a) => a.name.toLowerCase().startsWith(t));
    if (prefix.length === 1) return prefix[0];
    return this.bestFor([t]);
  }

  /** Best agent for a set of capability tags (case-insensitive); undefined
   *  when nothing declares any of them. */
  bestFor(capabilities: string[]): AgentSpec | undefined {
    const wanted = capabilities.map((c) => c.toLowerCase());
    let best: AgentSpec | undefined;
    let bestScore = 0;
    for (const a of this.list()) {
      const caps = new Set((a.capabilities ?? []).map((c) => c.toLowerCase()));
      const score = wanted.filter((c) => caps.has(c)).length;
      if (score > bestScore) { best = a; bestScore = score; }
    }
    return best;
  }

  /** Formatted block for the LLM decide prompt listing all available agents. */
  toPromptBlock(): string {
    const lines = this.list().map((a) => {
      const caps = a.capabilities?.join(", ") ?? "";
      const desc = a.description ?? "";
      return `- ${a.name}${caps ? ` [${caps}]` : ""}: ${desc}`;
    });
    return lines.length ? `# AVAILABLE AGENTS
${lines.join("\n")}` : "";
  }
}
