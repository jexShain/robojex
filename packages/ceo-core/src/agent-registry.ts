// packages/ceo-core/src/agent-registry.ts

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
];

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
