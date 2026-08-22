// packages/ceo-core/test/policy.test.ts
// SPEC-BUTLER §1: the autonomy policy matrix — butler forces the builtin tool
// gate to full (takeover desktop semantics untouched), conservative keeps the
// mode-driven observe/assist/full gate; config resolution defaults to butler.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { SchedulerLoop, resolvePolicy, type WsLike } from "../src/loop.js";
import type { LLMClient } from "../src/llm.js";
import { TaskBoard } from "../src/board.js";
import { ContextAssembler } from "../src/context.js";
import type { AgentOrchestrator } from "../src/orchestrator.js";
import { Auditor } from "../src/auditor.js";
import { BudgetGovernor } from "../src/budget.js";

class FakeWs extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.emit("close"); }
}

function makeRuntime(): string {
  const dir = mkdtempSync(join(tmpdir(), "rjpolicy-"));
  writeFileSync(join(dir, "MISSION.md"), "m\n");
  writeFileSync(join(dir, "RUBRIC.md"), "r\n");
  writeFileSync(join(dir, "MEMORY.md"), "h\n");
  return dir;
}

function mkLoop(dir: string, opts: { policy?: "butler" | "conservative"; ws?: FakeWs } = {}): SchedulerLoop {
  const ws = opts.ws;
  return new SchedulerLoop({
    llm: { chat: vi.fn(async () => ({ content: '{"action":"none"}', usage: { promptTokens: 0, completionTokens: 0 } })) } as unknown as LLMClient,
    board: new TaskBoard(join(dir, "board.sqlite")), ctx: new ContextAssembler(),
    orchestrator: { spawn: vi.fn(), getRegistry: () => null } as unknown as AgentOrchestrator,
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 9999 }), budget: new BudgetGovernor("burn"),
    runtimeDir: dir, ...(opts.policy ? { policy: opts.policy } : {}),
    ...(ws ? { takeoverUrl: "ws://fake.local", wsFactory: () => ws as unknown as WsLike } : {}),
  });
}

describe("resolvePolicy", () => {
  it("defaults to butler; accepts both values; invalid warns and falls back", () => {
    expect(resolvePolicy(undefined)).toBe("butler");
    expect(resolvePolicy(null)).toBe("butler");
    expect(resolvePolicy("")).toBe("butler");
    expect(resolvePolicy("butler")).toBe("butler");
    expect(resolvePolicy("conservative")).toBe("conservative");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolvePolicy("yolo")).toBe("butler");
      expect(resolvePolicy(42)).toBe("butler");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  });
});

describe("gateForTools policy matrix", () => {
  it("butler: full in every mode/link combination; mode() itself stays observe", () => {
    const dir = makeRuntime();
    const ws = new FakeWs();
    const loop = mkLoop(dir, { policy: "butler", ws });
    loop.start(60_000);
    expect(loop.mode()).toBe("observe");
    expect(loop.gateForTools()).toBe("full");
    for (const m of ["full", "assist", "observe"] as const) {
      ws.emit("message", JSON.stringify({ t: "evt", type: "mode_changed", mode: m }));
      expect(loop.mode()).toBe(m); // takeover semantics untouched
      expect(loop.gateForTools()).toBe("full");
    }
    ws.readyState = 3;
    expect(loop.gateForTools()).toBe("full");
    loop.stop();
  });

  it("conservative: observe+no link degrades to assist; observe+live link guards; full passes", () => {
    const dir = makeRuntime();
    const bare = mkLoop(dir, { policy: "conservative" });
    expect(bare.gateForTools()).toBe("assist");
    bare.stop();

    const ws = new FakeWs();
    const loop = mkLoop(dir, { policy: "conservative", ws });
    loop.start(60_000);
    ws.emit("message", JSON.stringify({ t: "evt", type: "mode_changed", mode: "observe" }));
    expect(loop.gateForTools()).toBe("observe");
    ws.emit("message", JSON.stringify({ t: "evt", type: "mode_changed", mode: "full" }));
    expect(loop.gateForTools()).toBe("full");
    loop.stop();
  });

  it("default (no policy in deps): butler", () => {
    const loop = mkLoop(makeRuntime());
    expect(loop.policy()).toBe("butler");
    expect(loop.gateForTools()).toBe("full");
    loop.stop();
  });
});

describe("setPolicy hot switch", () => {
  it("flips the gate live, emits {t:'policy'} + wake event; unknown/same values are no-ops", () => {
    const dir = makeRuntime();
    const loop = mkLoop(dir, { policy: "conservative" });
    const frames: Record<string, unknown>[] = [];
    const events: string[] = [];
    const origPush = loop.push.bind(loop);
    loop.push = (e: string) => { events.push(e); origPush(e); };
    loop.setOutlet({ chatOut: () => {}, frame: (f) => frames.push(f) });

    loop.setPolicy("butler");
    expect(loop.policy()).toBe("butler");
    expect(loop.gateForTools()).toBe("full");
    expect(frames).toEqual([{ t: "policy", policy: "butler" }]);
    expect(events).toEqual(["policy_changed -> butler"]);

    loop.setPolicy("butler"); // same value: silent no-op
    loop.setPolicy("warp");   // unknown: ignored
    expect(frames).toHaveLength(1);
    expect(events).toHaveLength(1);

    loop.setPolicy("conservative");
    expect(loop.gateForTools()).toBe("assist"); // back to the mode-driven gate
    expect(frames.at(-1)).toEqual({ t: "policy", policy: "conservative" });
    loop.stop();
  });
});
