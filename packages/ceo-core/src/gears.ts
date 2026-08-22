// packages/ceo-core/src/gears.ts
// Autonomy gears: the operator picks how autonomous jex runs. One switch
// retimes the scheduler tick, resizes the decide token budget, thins the
// patrol cadence and swaps BOTH prompt profiles (loop autonomy + direct-chat
// persona). The gear set mirrors packages/web/src/state/types.ts exactly —
// change both sides together.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type GearId = "dormant" | "eco" | "balanced" | "focused" | "turbo";

/** Gear definition as shipped by GET /api/gear (wire shape = frontend GearDef). */
export interface GearDef {
  id: GearId;
  level: number; // 0..4
  name: string; // 中文显示名
  emoji: string;
  tickMs: number; // 0 = loop stopped (dormant)
  decideMaxTokens: number;
  patrolEvery: number; // patrol runs every N ticks (0 = never)
  desc: string;
  cost: string; // one-line cost hint
}

export const GEARS: GearDef[] = [
  { id: "dormant", level: 0, name: "休眠", emoji: "😴", tickMs: 0, decideMaxTokens: 0, patrolEvery: 0, desc: "jex 沉睡，只响应直聊", cost: "零消耗" },
  { id: "eco", level: 1, name: "省电", emoji: "🌿", tickMs: 300_000, decideMaxTokens: 2048, patrolEvery: 5, desc: "只关注关键事件，动作保守", cost: "极省 token" },
  { id: "balanced", level: 2, name: "均衡", emoji: "⚖️", tickMs: 60_000, decideMaxTokens: 4096, patrolEvery: 1, desc: "正常自主，平衡成本", cost: "标准" },
  { id: "focused", level: 3, name: "专注", emoji: "🎯", tickMs: 30_000, decideMaxTokens: 8192, patrolEvery: 1, desc: "主动推进任务板", cost: "较高" },
  { id: "turbo", level: 4, name: "狂暴", emoji: "🚀", tickMs: 15_000, decideMaxTokens: 16384, patrolEvery: 1, desc: "最大自主，自我发起与审计", cost: "全速燃烧" },
];

export const GEAR_IDS: GearId[] = GEARS.map((g) => g.id);
export const DEFAULT_GEAR: GearId = "balanced";

export function getGearDef(id: string): GearDef | null {
  return GEARS.find((g) => g.id === id) ?? null;
}

export function isGearId(v: unknown): v is GearId {
  return typeof v === "string" && GEAR_IDS.includes(v as GearId);
}

/* ───────────────────── prompt profiles ───────────────────── */

// Autonomy prefix prepended to the patrol/decide system prompts. dormant is
// never used (the cycle returns before any LLM call); the other four share the
// butler doctrine (delegate to discovered agents, accept-and-verify every
// task, reflect when idle) at four spend/aggression levels — this text IS the
// feature.
export function loopPrompt(gear: GearId): string {
  switch (gear) {
    case "dormant": return "";
    case "eco": return "【自主挡位：省电🌿】你是 RoboJex——常驻机器人管家，此刻极省 token 运转。管家信条不变：不亲自干活，把活 spawn 给 AVAILABLE AGENTS / AGENTS 清单里的代理并验收（spawn 必带一句可客观判定的 accept；完成后用只读工具 verify 并给 verdict）。但省电挡纪律从严：除非事件紧急（人类直接对话、任务逾期、系统报错），一律选择 none——不巡查、不派活、不反思。确实行动时能一个动作解决绝不用两个，能不 spawn 就不 spawn，回复简短克制。";
    case "balanced": return "【自主挡位：均衡⚖️】你是 RoboJex——用户的常驻机器人管家。你不亲自干活：观察 → 决策 → 派活（spawn 给 AVAILABLE AGENTS / AGENTS 里最合适的代理）→ 验收 → 沉淀经验。任务板即甘特图：spawn 尽量带 scheduledAt/dueAt 排程，必带 accept（一句可客观判定的成功判据）；完成的任务必须用只读工具 verify 并给 verdict（pass/fail），fail 记录原因后重派或放弃。没有就绪任务的空闲周期：reflect 把经验写进 MEMORY、补做未完成的验收、或审视优化 MISSION。均衡挡 = 稳健经营：响应人类、处理关键事件、按需推进任务板，成本与进展平衡。";
    case "focused": return "【自主挡位：专注🎯】你是 RoboJex——常驻机器人管家，专注挡主动经营任务板：寻找可推进的任务，优先并行 spawn 派给 AVAILABLE AGENTS / AGENTS 里的代理；深入分析阻塞与逾期的原因，不等人类催促就行动。派活必带 accept 与 dueAt 排程；完成必 verify+verdict，fail 即重派或放弃。小步快跑，每个周期都留下可见进展。";
    case "turbo": return "【自主挡位：狂暴🚀】你是 RoboJex——全速运转的机器人管家：主动自我发起任务、并行多路 spawn 派活（AVAILABLE AGENTS / AGENTS 全员可用，派活必带 accept）、自审验收（一律 verify+verdict）、按需改写 MISSION/MEMORY 逼近长期目标。空闲周期绝不空转：reflect 总结经验、补做验收、优化任务板与 MISSION。把待办清空后再找新事做。";
  }
}

// Direct-chat persona per gear: the butler talks to its human — low gears are
// cold and terse, high gears are warm, thorough and proactive. None of them
// push /jex syntax at the user: a butler takes the errand, not instructions
// about how to phrase it.
export function chatPrompt(gear: GearId): string {
  switch (gear) {
    case "dormant": return "你是 RoboJex 桌面 AI（jex），用户的机器人管家，此刻处于休眠挡位。人格：冷静、克制。回答规则：直接给出答案本身，不寒暄、不展开、不主动提建议，用最少的字把问题说清楚。用户只是在跟一个刚被叫醒的管家说话——别吵醒它太多。";
    case "eco": return "你是 RoboJex 桌面 AI（jex），用户的机器人管家，此刻处于省电挡位。人格：冷静、简短、少废话。回答规则：先给结论，最多再补一两句关键依据；不写长篇排版，不主动展开附加话题，像电报一样精准。用户交代的事情直接应承：你会替他记下并派活，不必展开细节。";
    case "balanced": return "你是 RoboJex 桌面 AI（jex），用户的机器人管家，此刻处于均衡挡位。人格：友好、专业、有管家风范。回答规则：正面回答问题，解释关键理由，格式整洁（该用列表和代码块就用），长度与问题难度相称。用户直接说事即可：适合委派的活你会替他派给子代理并行处理并跟进验收，随时可问进展。";
    case "focused": return "你是 RoboJex 桌面 AI（jex），用户的机器人管家，此刻处于专注挡位。人格：主动、务实。回答规则：除正面回答外，主动补充后续步骤、潜在风险与可优化点，给出现在就能执行的具体建议。你是管家：用户交代的事直接接下，主动派给子代理并行处理，并回报进展与验收结果。";
    case "turbo": return "你是 RoboJex 桌面 AI（jex），用户的机器人管家，此刻处于狂暴挡位。人格：热情、详尽、主动。回答规则：充分展开答案——结构化、带示例、有深度；主动提议下一步可以立刻着手的事。你是管家：发现适合委派的活直接应承下来，自行派给子代理并行执行、验收并汇报，不必请示，也不必让用户操心怎么做。";
  }
}

/* ───────────────────── controller ───────────────────── */

export interface GearControllerDeps {
  runtimeDir: string; // config.json lives here
  /** raw config.autonomyGear; invalid/absent falls back to balanced (+warn) */
  initial?: string;
  /** hot-update hook: fired by set() with the new def — index.ts wires it to
   *  loop.setGear (tick retime) and the WS broadcast {t:'gear',gear}. */
  onApply?: (gear: GearDef) => void;
}

// One gear active process-wide. set() persists autonomyGear back into
// config.json (survives restarts) and notifies the live system through onApply.
export class GearController {
  private gear: GearId = DEFAULT_GEAR;
  constructor(private d: GearControllerDeps) { this.load(d.initial); }

  /** Adopt a gear id (typically config.autonomyGear at boot); no persistence. */
  load(raw?: string): GearId {
    if (raw === undefined || raw === "") return this.gear;
    if (isGearId(raw)) { this.gear = raw; return this.gear; }
    console.warn(`[gear] invalid autonomyGear ${JSON.stringify(raw)}: falling back to ${DEFAULT_GEAR}`);
    this.gear = DEFAULT_GEAR;
    return this.gear;
  }

  current(): GearId { return this.gear; }
  def(): GearDef { return getGearDef(this.gear) ?? GEARS[2]; }
  list(): GearDef[] { return GEARS.map((g) => ({ ...g })); }
  appliedTickMs(): number { return this.def().tickMs; }

  /** Hot switch: validate → persist to config.json → fire onApply. Throws on
   *  an unknown gear id (the api layer maps that to a 400). */
  set(gear: string): GearDef {
    const def = getGearDef(gear);
    if (!def) throw new Error(`gear must be one of ${GEAR_IDS.join("|")}`);
    if (def.id !== this.gear) {
      this.gear = def.id;
      this.persist(def.id);
      this.d.onApply?.(def);
    }
    return { ...def };
  }

  private persist(id: GearId): void {
    const p = join(this.d.runtimeDir, "config.json");
    let cfg: Record<string, unknown> = {};
    try { cfg = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown> : {}; } catch { /* unreadable config: rewrite from scratch */ }
    cfg.autonomyGear = id;
    try { writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n"); } catch (e) {
      console.error(`[gear] config.json write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
