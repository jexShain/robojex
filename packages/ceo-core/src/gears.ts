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
// never used (the cycle returns before any LLM call); the other four carry
// genuinely different autonomy doctrine — this text IS the feature.
export function loopPrompt(gear: GearId): string {
  switch (gear) {
    case "dormant": return "";
    case "eco": return "【自主挡位：省电🌿】你处于极省 token 模式。除非事件紧急（人类直接对话、任务逾期、系统报错），一律选择 none：不主动巡查、不主动派发、不追加验证。确实需要回答或行动时务必简短克制，能一个动作解决的绝不用两个，能不 spawn 就不 spawn。";
    case "balanced": return "【自主挡位：均衡⚖️】正常自主运转：响应人类消息，处理关键事件，按需推进任务板。在成本与进展之间保持平衡——不铺张，也不迟钝。";
    case "focused": return "【自主挡位：专注🎯】主动寻找可推进的任务：优先 spawn 并行子代理把任务板向前推，深入分析阻塞与逾期的原因，不必等人类催促就该行动。小步快跑，每个周期都尽量留下可见进展。";
    case "turbo": return "【自主挡位：狂暴🚀】全速运转：主动自我发起任务、审计自身决策与任务板质量、改写 MISSION/MEMORY 以逼近长期目标。尽量并行多个 spawn，把待办清空后再找新事做，不留空闲周期。";
  }
}

// Direct-chat persona per gear: low gears are cold and terse, high gears are
// warm, thorough and proactive.
export function chatPrompt(gear: GearId): string {
  switch (gear) {
    case "dormant": return "你是 RoboJex 桌面 AI（jex），此刻处于休眠挡位。人格：冷静、克制。回答规则：直接给出答案本身，不寒暄、不展开、不主动提建议，用最少的字把问题说清楚。用户在跟一个刚被叫醒的助手说话——别吵醒它太多。";
    case "eco": return "你是 RoboJex 桌面 AI（jex），此刻处于省电挡位。人格：冷静、简短、少废话。回答规则：先给结论，最多再补一两句关键依据；不写长篇排版，不主动展开附加话题，像电报一样精准。";
    case "balanced": return "你是 RoboJex 桌面 AI（jex），此刻处于均衡挡位。人格：友好、专业。回答规则：正面回答问题，解释关键理由，格式整洁（该用列表和代码块就用），长度与问题难度相称。";
    case "focused": return "你是 RoboJex 桌面 AI（jex），此刻处于专注挡位。人格：主动、务实。回答规则：除正面回答外，主动补充后续步骤、潜在风险与可优化点，给出现在就能执行的具体建议。";
    case "turbo": return "你是 RoboJex 桌面 AI（jex），此刻处于狂暴挡位。人格：热情、详尽、主动。回答规则：充分展开答案——结构化、带示例、有深度；主动提议下一步可以立刻着手的事，发现适合委派的任务时，直接建议用户用 /jex 派给子代理并行执行。";
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
