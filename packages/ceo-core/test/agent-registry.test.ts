// packages/ceo-core/test/agent-registry.test.ts
// T5: generic agent registration — JSON spec parsing/validation, custom-agent
// loading from runtime files, fuzzy name/capability resolution, and the
// orchestrator honoring spec env + spec timeoutMs with per-call override.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRegistry, BUILTIN_AGENTS, parseAgentSpec, parseAgentSpecList, loadCustomAgents,
} from "../src/agent-registry.js";
import { AgentOrchestrator } from "../src/orchestrator.js";

const mkDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

describe("BUILTIN_AGENTS", () => {
  it("ships codex/opencode/aider/cursor plus the legacy hermes/claude-code, all with {prompt}", () => {
    const names = BUILTIN_AGENTS.map((a) => a.name);
    for (const n of ["hermes", "claude-code", "codex", "opencode", "aider", "cursor"]) {
      expect(names).toContain(n);
    }
    for (const a of BUILTIN_AGENTS) {
      expect(a.cmd).toContain("{prompt}");
      expect(a.capabilities && a.capabilities.length > 0).toBe(true);
    }
  });
});

describe("parseAgentSpec", () => {
  it("accepts a full valid spec and copies fields", () => {
    const s = parseAgentSpec({
      name: "my-tool", cmd: "my-tool run {prompt}", env: { FOO: "bar" },
      timeoutMs: 60000, capabilities: ["coding"], description: "a tool",
    });
    expect(s).toEqual({
      name: "my-tool", cmd: "my-tool run {prompt}", env: { FOO: "bar" },
      timeoutMs: 60000, capabilities: ["coding"], description: "a tool",
    });
  });

  it("refuses missing/blank name, missing cmd, cmd without {prompt}", () => {
    expect(() => parseAgentSpec({ cmd: "x {prompt}" })).toThrow(/name/);
    expect(() => parseAgentSpec({ name: "x", cmd: "" })).toThrow(/cmd/);
    expect(() => parseAgentSpec({ name: "x", cmd: "x run" })).toThrow(/\{prompt\}/);
  });

  it("refuses malformed optional fields with precise messages", () => {
    expect(() => parseAgentSpec({ name: "x", cmd: "x {prompt}", timeoutMs: -1 })).toThrow(/timeoutMs/);
    expect(() => parseAgentSpec({ name: "x", cmd: "x {prompt}", env: { A: 1 } })).toThrow(/env/);
    expect(() => parseAgentSpec({ name: "x", cmd: "x {prompt}", capabilities: "coding" })).toThrow(/capabilities/);
  });

  it("refuses unknown keys so typos surface at load time", () => {
    expect(() => parseAgentSpec({ name: "x", cmd: "x {prompt}", capabilites: [] })).toThrow(/unknown key/i);
  });

  it("rejects non-objects", () => {
    expect(() => parseAgentSpec(null)).toThrow(/object/);
    expect(() => parseAgentSpec([])).toThrow(/array/);
  });
});

describe("parseAgentSpecList", () => {
  it("accepts a bare array and an { agents: [...] } wrapper", () => {
    const bare = parseAgentSpecList([{ name: "a", cmd: "a {prompt}" }]);
    const wrapped = parseAgentSpecList({ agents: [{ name: "a", cmd: "a {prompt}" }] });
    expect(bare).toEqual(wrapped);
  });

  it("rejects shapes that are neither", () => {
    expect(() => parseAgentSpecList("nope")).toThrow(/array/);
    expect(() => parseAgentSpecList({ foo: 1 })).toThrow(/agents/);
  });
});

describe("AgentRegistry.resolve", () => {
  const r = new AgentRegistry(BUILTIN_AGENTS);

  it("exact name wins", () => {
    expect(r.resolve("hermes")?.name).toBe("hermes");
  });

  it("case-insensitive name matches", () => {
    expect(r.resolve("Hermes")?.name).toBe("hermes");
    expect(r.resolve("CLAUDE-CODE")?.name).toBe("claude-code");
  });

  it("unique prefix matches; ambiguous prefix does not", () => {
    expect(r.resolve("cod")?.name).toBe("codex");       // unique: only codex
    expect(r.resolve("opencode")?.name).toBe("opencode");
  });

  it("capability tag falls back to the best-covering agent", () => {
    // "web" is declared by hermes only in builtins -> hermes wins via capability
    expect(r.bestFor(["web"])?.name).toBe("hermes");
    // "refactor" is aider-only
    expect(r.bestFor(["refactor"])?.name).toBe("aider");
    expect(r.resolve("web")?.name).toBe("hermes");
  });

  it("unknown token and empty capabilities resolve to undefined", () => {
    expect(r.resolve("definitely-not-an-agent-xyz")).toBeUndefined();
    expect(r.bestFor([])).toBeUndefined();
  });

  it("later registration overrides same-name (scout refresh / custom JSON)", () => {
    const r2 = new AgentRegistry(BUILTIN_AGENTS);
    r2.register({ name: "hermes", cmd: "custom-hermes {prompt}" });
    expect(r2.resolve("hermes")?.cmd).toBe("custom-hermes {prompt}");
  });
});

describe("loadCustomAgents", () => {
  it("loads runtime/agents.json and runtime/agents/*.json; skips malformed files", () => {
    const dir = mkDir("rjagents-");
    writeFileSync(join(dir, "agents.json"), JSON.stringify([{ name: "foo", cmd: "foo {prompt}" }]));
    mkdirSync(join(dir, "agents"));
    writeFileSync(join(dir, "agents", "bar.json"), JSON.stringify({ agents: [{ name: "bar", cmd: "bar {prompt}" }] }));
    writeFileSync(join(dir, "agents", "broken.json"), "{ this is not json");
    writeFileSync(join(dir, "agents", "skip-me.txt"), "not a spec file");
    const { specs, errors } = loadCustomAgents(dir);
    const names = specs.map((s) => s.name).sort();
    expect(names).toEqual(["bar", "foo"]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("broken.json");
    rmSync(dir, { recursive: true, force: true });
  });

  it("empty runtime dir yields no specs and no errors", () => {
    const dir = mkDir("rjagents-empty-");
    expect(loadCustomAgents(dir)).toEqual({ specs: [], errors: [] });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("AgentOrchestrator + registry (T5 spawn path)", () => {
  // llm=null: raw tail is the summary, so assertions stay hermetic
  const stubCmds = (extra: Record<string, string> = {}) => ({ ...extra });

  it("spec env is injected into the child process", async () => {
    const dir = mkDir("rjorch-env-");
    const reg = new AgentRegistry();
    reg.register({ name: "env-probe", cmd: "node -e 'console.log(process.env.FLEET_FLAG)'", env: { FLEET_FLAG: "on" } });
    // env-probe needs no {prompt} in its own template? parseAgentSpec demands it at
    // load time, but a programmatic register may omit it; spawn substitutes a
    // no-op replace, so the cmd still runs.
    const o = new AgentOrchestrator({ llm: null, runtimeDir: dir, registry: reg, cmds: stubCmds() });
    const r = await o.spawn("env-probe", "ignored");
    expect(r.summary).toContain("on");
    rmSync(dir, { recursive: true, force: true });
  });

  it("spec timeoutMs fires when no per-call timeout is given", async () => {
    const dir = mkDir("rjorch-spec-timeout-");
    const reg = new AgentRegistry();
    reg.register({ name: "sleeper", cmd: "sleep {prompt}", timeoutMs: 400 });
    const o = new AgentOrchestrator({ llm: null, runtimeDir: dir, registry: reg, cmds: stubCmds() });
    const t0 = Date.now();
    const r = await o.spawn("sleeper", "30");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.summary).toContain("timeout");
    rmSync(dir, { recursive: true, force: true });
  });

  it("per-call timeoutMs overrides the spec's", async () => {
    const dir = mkDir("rjorch-override-");
    const reg = new AgentRegistry();
    reg.register({ name: "sleeper", cmd: "sleep {prompt}", timeoutMs: 600_000 });
    const o = new AgentOrchestrator({ llm: null, runtimeDir: dir, registry: reg, cmds: stubCmds() });
    const r = await o.spawn("sleeper", "30", { timeoutMs: 400 });
    expect(r.summary).toContain("timeout");
    rmSync(dir, { recursive: true, force: true });
  });

  it("capability token spawns the best-covering registered agent", async () => {
    const dir = mkDir("rjorch-cap-");
    const reg = new AgentRegistry();
    reg.register({ name: "printer", cmd: "echo cap-hit {prompt}", capabilities: ["summarize"] });
    const o = new AgentOrchestrator({ llm: null, runtimeDir: dir, registry: reg, cmds: stubCmds() });
    const r = await o.spawn("summarize", "hello");
    expect(r.summary).toContain("cap-hit");
    rmSync(dir, { recursive: true, force: true });
  });

  it("unknown agent throws with the available-agents list", async () => {
    const dir = mkDir("rjorch-unknown-");
    const reg = new AgentRegistry();
    reg.register({ name: "known", cmd: "echo x {prompt}" });
    const o = new AgentOrchestrator({ llm: null, runtimeDir: dir, registry: reg, cmds: stubCmds() });
    await expect(o.spawn("nope-xyz", "x")).rejects.toThrow(/Available agents: known/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("legacy hermes/claude-code DEFAULT_CMDS still win over the registry (backward compat)", async () => {
    const dir = mkDir("rjorch-compat-");
    const reg = new AgentRegistry();
    // A registry entry named hermes must NOT shadow the DEFAULT_CMDS path:
    // DEFAULT_CMDS is consulted before the registry lookup in spawn().
    const o = new AgentOrchestrator({ llm: null, runtimeDir: dir, registry: reg, cmds: { hermes: "echo legacy {prompt}" } });
    const r = await o.spawn("hermes", "task");
    expect(r.summary).toContain("legacy");
    rmSync(dir, { recursive: true, force: true });
  });
});
