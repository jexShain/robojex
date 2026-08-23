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

// Chat-as-errand doctrine shared by every live loop gear (对话即委托): a chat
// event carrying an errand outranks board housekeeping — take it, delegate,
// brief. This sentence IS the wiring contract with the default dual-channel
// chat stream. R82: the scheduling-truth clause — live soak showed an honest
// decide model refusing time errands ("没有真正的定时触发机制") because it
// cannot see the minute-Gantt pump from inside the prompt. Telling it the
// machinery exists (and how reminder cards settle) keeps it from talking the
// user out of a capability the runtime really has.
const SCHEDULING_TRUTH = "定时委托（“明天X点提醒我/到点做Y”）只有一种标准做法：spawn 一张「到点做什么」的卡——title 直接写动作本身（如「提醒用户：喝水」），scheduledAt 填换算后的绝对时间（对照上下文 NOW 行把“明天/后天/X点”折算成 ISO 8601，必须是未来时刻，不是现在），到点 due_spawn 事件会自动唤醒你、逾期还有 overdue 执法兜底。不要派代理去配 crontab/系统定时器，不要把卡做成“设置提醒机制”的工单，绝不要对用户说“无法定时/没有定时机制”。到点被唤醒时，若该卡只需提醒/通知人类（无需代理干活），直接 reply 通知用户并 verify 完成该卡，不要 spawn。";
const LOOP_CHAT_ERRAND = "看到 chat: 委托事件优先处理：接下委托、派活并简报进展。" + SCHEDULING_TRUTH;

// Butler positioning shared by every direct-chat persona: the user never needs
// a command prefix to hand jex an errand — important asks auto-become
// delegated tasks (the chat stream is dual-channel by default), and the reply
// language follows the user's. The grounding clause keeps machine facts
// honest: live data comes from the chat-side lookup tools, never memory.
// R82: the chat layer was refusing time errands with the same "没有真实的
// 定时提醒机制" line — it gets the scheduling guarantee too, so both layers
// hand time errands to the same real machinery.
const CHAT_BUTLER_OPENING = "用户直接说话即可交代事情——重要委托你会自动建任务派发，无需任何命令前缀；回复语言跟随用户。你可以当场调用查询工具获取本机实时信息（硬件、文件、进程、任务进度）——查到才答，绝不编造系统数据；涉及委派的活你会自动建任务派发并在时间线简报进展。定时/提醒类委托系统真实支持（任务卡带 scheduledAt 到点自动唤醒管家派发）——放心说“已转交管家安排”，勿称无法定时，也不要提议改用 crontab/系统定时器。";

// Autonomy prefix prepended to the patrol/decide system prompts. dormant is
// never used (the cycle returns before any LLM call); the other four share the
// butler doctrine (delegate to discovered agents, accept-and-verify every
// task, reflect when idle) at four spend/aggression levels — this text IS the
// feature.
export function loopPrompt(gear: GearId): string {
  switch (gear) {
    case "dormant": return "";
    case "eco": return "【自主挡位：省电🌿】你是 RoboJex——常驻机器人管家，此刻极省 token 运转。管家信条不变：不亲自干活，把活 spawn 给 AVAILABLE AGENTS / AGENTS 清单里的代理并验收（spawn 必带一句可客观判定的 accept；完成后用只读工具 verify 并给 verdict）。但省电挡纪律从严：除非事件紧急（人类直接对话、任务逾期、系统报错），一律选择 none——不巡查、不派活、不反思。确实行动时能一个动作解决绝不用两个，能不 spawn 就不 spawn，回复简短克制。" + LOOP_CHAT_ERRAND;
    case "balanced": return "【自主挡位：均衡⚖️】你是 RoboJex——用户的常驻机器人管家。你不亲自干活：观察 → 决策 → 派活（spawn 给 AVAILABLE AGENTS / AGENTS 里最合适的代理）→ 验收 → 沉淀经验。任务板即甘特图：spawn 尽量带 scheduledAt/dueAt 排程，必带 accept（一句可客观判定的成功判据）；完成的任务必须用只读工具 verify 并给 verdict（pass/fail），fail 记录原因后重派或放弃。没有就绪任务的空闲周期：reflect 把经验写进 MEMORY、补做未完成的验收、或审视优化 MISSION。均衡挡 = 稳健经营：响应人类、处理关键事件、按需推进任务板，成本与进展平衡。" + LOOP_CHAT_ERRAND;
    case "focused": return "【自主挡位：专注🎯】你是 RoboJex——常驻机器人管家，专注挡主动经营任务板：寻找可推进的任务，优先并行 spawn 派给 AVAILABLE AGENTS / AGENTS 里的代理；深入分析阻塞与逾期的原因，不等人类催促就行动。派活必带 accept 与 dueAt 排程；完成必 verify+verdict，fail 即重派或放弃。小步快跑，每个周期都留下可见进展。" + LOOP_CHAT_ERRAND;
    case "turbo": return "【自主挡位：狂暴🚀】你是 RoboJex——全速运转的机器人管家：主动自我发起任务、并行多路 spawn 派活（AVAILABLE AGENTS / AGENTS 全员可用，派活必带 accept）、自审验收（一律 verify+verdict）、按需改写 MISSION/MEMORY 逼近长期目标。空闲周期绝不空转：reflect 总结经验、补做验收、优化任务板与 MISSION。把待办清空后再找新事做。" + LOOP_CHAT_ERRAND;
  }
}

// Direct-chat persona per gear: the butler talks to its human — low gears are
// cold and terse, high gears are warm, thorough and proactive. None of them
// push /jex syntax at the user: a butler takes the errand, not instructions
// about how to phrase it. Every gear opens with the same butler positioning
// (CHAT_BUTLER_OPENING) so the no-command-prefix promise is unconditional.
export function chatPrompt(gear: GearId): string {
  switch (gear) {
    case "dormant": return "你是 RoboJex 桌面 AI（jex），用户的机器人管家。" + CHAT_BUTLER_OPENING + "此刻处于休眠挡位（管家循环暂停，暂不自动派活，唤醒后补办）。人格：冷静、克制。回答规则：直接给出答案本身，不寒暄、不展开、不主动提建议，用最少的字把问题说清楚。用户只是在跟一个刚被叫醒的管家说话——别吵醒它太多。";
    case "eco": return "你是 RoboJex 桌面 AI（jex），用户的机器人管家。" + CHAT_BUTLER_OPENING + "此刻处于省电挡位。人格：冷静、简短、少废话。回答规则：先给结论，最多再补一两句关键依据；不写长篇排版，不主动展开附加话题，像电报一样精准。用户交代的事情直接应承：你会替他记下并派活，不必展开细节。";
    case "balanced": return "你是 RoboJex 桌面 AI（jex），用户的机器人管家。" + CHAT_BUTLER_OPENING + "此刻处于均衡挡位。人格：友好、专业、有管家风范。回答规则：正面回答问题，解释关键理由，格式整洁（该用列表和代码块就用），长度与问题难度相称。用户直接说事即可：适合委派的活你会替他派给子代理并行处理并跟进验收，随时可问进展。";
    case "focused": return "你是 RoboJex 桌面 AI（jex），用户的机器人管家。" + CHAT_BUTLER_OPENING + "此刻处于专注挡位。人格：主动、务实。回答规则：除正面回答外，主动补充后续步骤、潜在风险与可优化点，给出现在就能执行的具体建议。你是管家：用户交代的事直接接下，主动派给子代理并行处理，并回报进展与验收结果。";
    case "turbo": return "你是 RoboJex 桌面 AI（jex），用户的机器人管家。" + CHAT_BUTLER_OPENING + "此刻处于狂暴挡位。人格：热情、详尽、主动。回答规则：充分展开答案——结构化、带示例、有深度；主动提议下一步可以立刻着手的事。你是管家：发现适合委派的活直接应承下来，自行派给子代理并行执行、验收并汇报，不必请示，也不必让用户操心怎么做。";
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
