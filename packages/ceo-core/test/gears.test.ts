// packages/ceo-core/test/gears.test.ts
// The 5-gear contract (wire shape + numbers), prompt differentiation, the
// controller's persistence/hot-switch, and the loop's gear-awareness
// (dormant stop, eco patrol thinning, decide budget).
import { GEARS, GEAR_IDS, DEFAULT_GEAR, getGearDef, isGearId, loopPrompt, chatPrompt, GearController, type GearId } from "../src/gears.js";
import { SchedulerLoop } from "../src/loop.js";
import { LLMClient } from "../src/llm.js";
import { TaskBoard } from "../src/board.js";
import { ContextAssembler } from "../src/context.js";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { Auditor } from "../src/auditor.js";
import { BudgetGovernor } from "../src/budget.js";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

/* ───────────────── definitions ───────────────── */

test("GEARS: five entries, ids/order match the frontend GEAR_LEVELS, numbers per spec", () => {
  expect(GEAR_IDS).toEqual(["dormant", "eco", "balanced", "focused", "turbo"]);
  expect(GEARS).toHaveLength(5);
  expect(GEARS.map((g) => g.id)).toEqual(GEAR_IDS);
  const byId = Object.fromEntries(GEARS.map((g) => [g.id, g]));
  expect(byId.dormant).toMatchObject({ level: 0, tickMs: 0, decideMaxTokens: 0, patrolEvery: 0, name: "休眠", emoji: "😴" });
  expect(byId.eco).toMatchObject({ level: 1, tickMs: 300_000, decideMaxTokens: 2048, patrolEvery: 5 });
  expect(byId.balanced).toMatchObject({ level: 2, tickMs: 60_000, decideMaxTokens: 4096, patrolEvery: 1 });
  expect(byId.focused).toMatchObject({ level: 3, tickMs: 30_000, decideMaxTokens: 8192, patrolEvery: 1 });
  expect(byId.turbo).toMatchObject({ level: 4, tickMs: 15_000, decideMaxTokens: 16384, patrolEvery: 1 });
  for (const g of GEARS) {
    expect(typeof g.desc).toBe("string");
    expect(g.cost.length).toBeGreaterThan(0);
    expect(getGearDef(g.id)!.id).toBe(g.id);
  }
});

test("isGearId: accepts the five ids, rejects anything else", () => {
  for (const id of GEAR_IDS) expect(isGearId(id)).toBe(true);
  expect(isGearId("Balanced")).toBe(false);
  expect(isGearId("turbo1")).toBe(false);
  expect(isGearId(42)).toBe(false);
  expect(isGearId(undefined)).toBe(false);
});

test("loopPrompt: five distinct profiles; dormant empty; eco/turbo carry real doctrine", () => {
  const prompts = GEAR_IDS.map((g) => loopPrompt(g));
  expect(new Set(prompts).size).toBe(5);
  expect(prompts[0]).toBe(""); // dormant never reaches the loop prompts
  expect(prompts[1]).toContain("省电");
  expect(prompts[1]).toContain("none");
  expect(prompts[4]).toContain("全速");
  expect(prompts[4]).toContain("MISSION");
});

test("loopPrompt: butler doctrine in every live gear — delegate, accept, verify, reflect", () => {
  for (const g of ["eco", "balanced", "focused", "turbo"] as GearId[]) {
    const p = loopPrompt(g);
    expect(p, `${g} delegates`).toContain("spawn");
    expect(p, `${g} demands acceptance`).toMatch(/accept/i);
    expect(p, `${g} verifies`).toContain("verify");
    expect(p, `${g} starts with the gear prefix`).toMatch(/^【自主挡位：/);
  }
  // idle-cycle menu is spelled out at balanced: reflect / catch-up / MISSION
  const b = loopPrompt("balanced");
  expect(b).toContain("reflect");
  expect(b).toContain("甘特图");
});

test("chatPrompt: five distinct butler personas, low gears terse / high gears proactive", () => {
  const prompts = GEAR_IDS.map((g) => chatPrompt(g));
  expect(new Set(prompts).size).toBe(5);
  for (const p of prompts) expect(p.length).toBeGreaterThan(20);
  expect(chatPrompt("dormant")).toContain("克制");
  expect(chatPrompt("balanced")).toContain("友好");
  expect(chatPrompt("turbo")).toContain("管家");
  expect(chatPrompt("turbo")).not.toContain("/jex"); // the butler takes the errand, never coaches syntax
});

test("chatPrompt: every gear opens with the butler positioning — no command prefix, auto delegation, language follows the user", () => {
  for (const g of GEAR_IDS) {
    const p = chatPrompt(g);
    expect(p, `${g} no-prefix promise`).toContain("无需任何命令前缀");
    expect(p, `${g} auto-delegation promise`).toContain("自动建任务派发");
    expect(p, `${g} language follows the user`).toContain("回复语言跟随用户");
  }
});

test("loopPrompt: every live gear prioritizes chat errands — take, delegate, brief", () => {
  expect(loopPrompt("dormant")).not.toContain("chat: 委托"); // asleep: no doctrine at all
  for (const g of ["eco", "balanced", "focused", "turbo"] as GearId[]) {
    expect(loopPrompt(g), `${g} chat-errand priority`).toContain("chat: 委托事件优先处理");
    expect(loopPrompt(g), `${g} brief mandate`).toContain("简报");
  }
});

/* ───────────────── controller ───────────────── */

test("GearController: default balanced, load() honors valid input, invalid falls back with warn", () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-gear-"));
  expect(new GearController({ runtimeDir: dir }).current()).toBe(DEFAULT_GEAR);
  expect(new GearController({ runtimeDir: dir, initial: "turbo" }).current()).toBe("turbo");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const gc = new GearController({ runtimeDir: dir, initial: "ludicrous" });
    expect(gc.current()).toBe("balanced");
    expect(warn).toHaveBeenCalledTimes(1);
  } finally { warn.mockRestore(); }
});

test("GearController.set: persists autonomyGear to config.json, fires onApply, rejects unknown ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-gear-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ apiKey: "sk-x", tickMs: 1234 }, null, 2));
  const applied: string[] = [];
  const gc = new GearController({ runtimeDir: dir, onApply: (g) => applied.push(g.id) });
  gc.set("focused");
  gc.set("focused"); // same gear: no duplicate apply
  expect(applied).toEqual(["focused"]);
  const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
  expect(cfg.autonomyGear).toBe("focused");
  expect(cfg.apiKey).toBe("sk-x"); // read-modify-write keeps the rest
  expect(cfg.tickMs).toBe(1234);
  expect(() => gc.set("warp")).toThrow(/dormant\|eco/);
  expect(gc.appliedTickMs()).toBe(30_000);
  expect(gc.list()).toHaveLength(5);
});

/* ───────────────── loop gear-awareness ───────────────── */

function makeRuntime(): string {
  const dir = mkdtempSync(join(tmpdir(), "robojex-gearloop-"));
  writeFileSync(join(dir, "MISSION.md"), "m\n");
  writeFileSync(join(dir, "RUBRIC.md"), "r\n");
  writeFileSync(join(dir, "MEMORY.md"), "h\n");
  return dir;
}

function mkLoop(dir: string, chat: ReturnType<typeof vi.fn>): SchedulerLoop {
  const llm = { chat } as unknown as LLMClient;
  return new SchedulerLoop({
    llm, board: new TaskBoard(join(dir, "board.sqlite")), ctx: new ContextAssembler(),
    orchestrator: new AgentOrchestrator({ llm, runtimeDir: dir, cmds: {} }),
    auditor: new Auditor({ runtimeDir: dir, reviewEvery: 9999 }),
    budget: new BudgetGovernor("burn"), runtimeDir: dir,
  });
}

test("loop.setGear('dormant') hot-updates: setTickMs(0) stops the interval, a later gear revives it", () => {
  const dir = makeRuntime();
  const loop = mkLoop(dir, vi.fn(async () => ({ content: '{"action":"none"}', usage: { promptTokens: 0, completionTokens: 0 } })));
  const tickSpy = vi.spyOn(loop, "setTickMs");
  loop.start(60_000);
  expect(loop.currentTickMs()).toBe(60_000);

  loop.setGear("dormant");
  expect(tickSpy).toHaveBeenLastCalledWith(0); // the hot-stop the task demands
  expect(loop.currentTickMs()).toBe(0);
  expect(loop.gear()).toBe("dormant");

  loop.setGear("turbo");
  expect(loop.currentTickMs()).toBe(15_000); // revived at the turbo cadence
  expect(tickSpy).toHaveBeenLastCalledWith(15_000);
  loop.stop();

  loop.setGear("eco"); // while stopped: recorded, no timer built
  expect(loop.currentTickMs()).toBe(300_000);
  loop.stop();
});

test("dormant cycle: returns before any LLM call; still emits the heartbeat frame", async () => {
  const dir = makeRuntime();
  const chat = vi.fn();
  const frames: Record<string, unknown>[] = [];
  const loop = mkLoop(dir, chat);
  loop.setGear("dormant");
  loop.setOutlet({ chatOut: () => {}, frame: (f) => frames.push(f), hud: () => {} });
  await loop.runOnce("chat: 喂");
  expect(chat).not.toHaveBeenCalled();
  expect(frames.some((f) => f.t === "cycle")).toBe(true); // heartbeat continues
  loop.stop();
});

test("eco patrol thinning: pure tick wakes skip patrol 4 of 5; real events always pass", async () => {
  const dir = makeRuntime();
  const calls: string[] = [];
  const chat = vi.fn(async (slot: string) => { calls.push(slot); return { content: '{"action":"none"}', usage: { promptTokens: 1, completionTokens: 1 } }; });
  const loop = mkLoop(dir, chat);
  loop.setGear("eco");
  // tickCount is 1..5 across these wakes: only the 5th (tickCount % 5 === 0) patrols
  await loop.runOnce("tick"); await loop.runOnce("tick"); await loop.runOnce("tick"); await loop.runOnce("tick");
  expect(calls).toEqual([]); // ticks 1-4: skipped before the patrol LLM call
  await loop.runOnce("tick");
  expect(calls).toEqual(["patrol"]); // tick 5: patrols
  await loop.runOnce("chat: 有人说话");
  expect(calls).toEqual(["patrol", "patrol"]); // events bypass the throttle
  loop.stop();
});

test("decide budget follows the gear: focused passes 8192 as maxTokens", async () => {
  const dir = makeRuntime();
  const budgets: (number | undefined)[] = [];
  const chat = vi.fn(async (slot: string, _m: unknown, opts?: { maxTokens?: number }) => {
    if (slot === "patrol") return { content: '{"action":"act"}', usage: { promptTokens: 1, completionTokens: 1 } };
    budgets.push(opts?.maxTokens);
    return { content: '{"actions":[]}', usage: { promptTokens: 1, completionTokens: 1 } };
  });
  const loop = mkLoop(dir, chat);
  loop.setGear("focused");
  await loop.runOnce("chat: 干活");
  expect(budgets).toEqual([8192]);
  loop.stop();
});

test("patrol/decide system prompts carry the gear prefix", async () => {
  const dir = makeRuntime();
  const systems: { slot: string; content: string }[] = [];
  const chat = vi.fn(async (slot: string, msgs: { role: string; content: string }[]) => {
    if (msgs[0]) systems.push({ slot, content: String(msgs[0].content) });
    return slot === "patrol"
      ? { content: '{"action":"act"}', usage: { promptTokens: 1, completionTokens: 1 } }
      : { content: '{"actions":[]}', usage: { promptTokens: 1, completionTokens: 1 } };
  });
  const loop = mkLoop(dir, chat);
  loop.setGear("turbo");
  await loop.runOnce("chat: hi");
  const patrol = systems.find((s) => s.slot === "patrol")!.content;
  const decide = systems.find((s) => s.slot === "decide")!.content;
  expect(patrol.startsWith("【自主挡位：狂暴🚀】")).toBe(true);
  expect(decide.startsWith("【自主挡位：狂暴🚀】")).toBe(true);
  expect(patrol).toContain("You triage events"); // the original doctrine survives below the prefix
  loop.stop();
});
