// packages/ceo-core/test/agent-scout.test.ts
// SPEC-BUTLER §2: probing known agent CLIs, wiring hits into orchestrator +
// registry, LLM-written manuals (budgeted, idempotent), AGENTS.md inventory.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentScout, KNOWN_AGENTS, type AgentWhichFn } from "../src/agent-scout.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { LLMClient } from "../src/llm.js";

function mkRig(which: AgentWhichFn, llm: LLMClient | null = null) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "rjagscout-"));
  const registry = new AgentRegistry();
  const setCmd = vi.fn();
  const spend = vi.fn();
  const scout = new AgentScout({
    llm, runtimeDir, registry,
    orchestrator: { setCmd },
    whichFn: which,
    extraBins: [], // hermetic: never consult the host's ~/bin pockets
    spend,
  });
  return { scout, registry, setCmd, spend, runtimeDir };
}

describe("KNOWN_AGENTS", () => {
  it("carries the ten SPEC agents, each with a {prompt} template, aliases and blurb", () => {
    expect(KNOWN_AGENTS.map((a) => a.name)).toEqual([
      "claude-code", "hermes", "opencode", "omp", "codex", "aider", "gemini", "qwen", "goose", "crush",
    ]);
    for (const a of KNOWN_AGENTS) {
      expect(a.cmd).toContain("{prompt}");
      expect(a.aliases.length).toBeGreaterThan(0);
      expect(a.blurb.length).toBeGreaterThan(5);
    }
  });
});

describe("probe", () => {
  it("finds installed agents via any alias (real binary name first), skips the rest", async () => {
    const which: AgentWhichFn = async (name) => (name === "claude" || name === "goose" ? `/usr/bin/${name}` : null);
    const { scout } = mkRig(which);
    const found = await scout.probe();
    expect(found.map((f) => f.agent.name)).toEqual(["claude-code", "goose"]);
    expect(found[0].bin).toBe("/usr/bin/claude"); // alias hit, canonical name reported
  });
});

describe("run", () => {
  it("wires hits into orchestrator + registry and writes one-line AGENTS.md entries", async () => {
    const which: AgentWhichFn = async (name) => (name === "claude" ? "/usr/local/bin/claude" : null);
    const { scout, registry, setCmd, runtimeDir } = mkRig(which);
    const r = await scout.run();
    expect(r.discovered.map((d) => d.agent.name)).toEqual(["claude-code"]);
    expect(r.manualsGenerated).toBe(0); // no llm wired: nothing to generate
    expect(setCmd).toHaveBeenCalledWith("claude-code", "claude -p {prompt} --dangerously-skip-permissions");
    const spec = registry.get("claude-code")!;
    expect(spec.cmd).toContain("{prompt}");
    expect(spec.description).toBe(KNOWN_AGENTS[0].blurb);
    expect(registry.names()).toContain("claude-code");
    const agents = readFileSync(join(runtimeDir, "AGENTS.md"), "utf8");
    expect(agents).toBe("claude-code — Claude Code — Anthropic's coding agent, strong at repo-wide edits, tests and git [verified]\n");
  });

  it("empty fleet: AGENTS.md written empty, report carries zero finds, no manual dir churn", async () => {
    const { scout, runtimeDir } = mkRig(async () => null);
    const r = await scout.run();
    expect(r.discovered).toEqual([]);
    expect(readFileSync(join(runtimeDir, "AGENTS.md"), "utf8")).toBe("\n");
    expect(existsSync(join(runtimeDir, "agent-manuals"))).toBe(false); // nothing discovered: no manual pass at all
  });

  it("LLM manual generation: budgeted via spend, capped at 800 chars, idempotent on rerun", async () => {
    const which: AgentWhichFn = async (name) => (name === "hermes" ? "/usr/bin/hermes" : null);
    const chat = vi.fn(async () => ({ content: "H".repeat(2000), usage: { promptTokens: 11, completionTokens: 7 } }));
    const { scout, spend, runtimeDir } = mkRig(which, { chat } as unknown as LLMClient);
    const r1 = await scout.run();
    expect(r1.manualsGenerated).toBe(1);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(spend).toHaveBeenCalledWith({ promptTokens: 11, completionTokens: 7 });
    const manual = readFileSync(join(runtimeDir, "agent-manuals", "hermes.md"), "utf8");
    expect(manual).toHaveLength(800); // hard cap
    const r2 = await scout.run(); // second pass: existing file never regenerated
    expect(r2.manualsGenerated).toBe(0);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("manual LLM failure degrades to best-effort: no file, pass still completes", async () => {
    const which: AgentWhichFn = async (name) => (name === "crush" ? "/usr/bin/crush" : null);
    const chat = vi.fn(async () => { throw new Error("llm down"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { scout, runtimeDir } = mkRig(which, { chat } as unknown as LLMClient);
      const r = await scout.run();
      expect(r.discovered.map((d) => d.agent.name)).toEqual(["crush"]);
      expect(r.manualsGenerated).toBe(0);
      expect(existsSync(join(runtimeDir, "agent-manuals", "crush.md"))).toBe(false);
    } finally { warn.mockRestore(); }
  });

  it("re-entry while a pass is in flight returns an empty report instead of a second pass", async () => {
    const which: AgentWhichFn = async () => null;
    const { scout } = mkRig(which);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let releaseProbe: () => void = () => {};
      const probeGate = new Promise<void>((r) => { releaseProbe = r; });
      scout.probe = async () => { await probeGate; return []; };
      const first = scout.run();
      const second = await scout.run(); // re-enters while the first probes
      expect(second.discovered).toEqual([]);
      releaseProbe();
      expect((await first).discovered).toEqual([]);
    } finally { warn.mockRestore(); }
  });
});
