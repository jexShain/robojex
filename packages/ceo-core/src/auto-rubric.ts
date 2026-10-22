// packages/ceo-core/src/auto-rubric.ts — T9: the deterministic, self-learning
// layer of the audit system. auditor.ts already meta-learns from WAKE-DECISION
// traces via an LLM review (token-expensive); this module closes the other
// half — what the TASK OUTCOME ledger (runtime/STATS.md + the board) already
// knows. Everything here is pure and rule-based: zero tokens, runs at the same
// cadence as the audit review, and its output is fingerprinted so a stale rule
// is REFRESHED in place instead of re-appended forever (live soak: the
// append-only rubric bulk ballooned past every context budget).
import type { Task } from "./board.js";

// ── ledger parsing ──────────────────────────────────────────────────────────
// STATS.md line: `framework|verdict|title` (R8) — since T9 a 4th optional
// field carries the epoch-ms completion stamp. Readers must tolerate lines
// without it (every pre-T9 line): ts = 0, excluded from time buckets.
export interface Outcome {
  framework: string;
  verdict: "pass" | "partial" | "fail";
  title: string;
  ts: number; // 0 = undated (pre-T9 ledger line)
}

export function parseOutcomes(raw: string): Outcome[] {
  const out: Outcome[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes("|")) continue;
    const [fw, verdict, title, tsRaw] = line.split("|");
    const framework = (fw ?? "").trim();
    const v = (verdict ?? "").trim();
    if (!framework || (v !== "pass" && v !== "partial" && v !== "fail")) continue;
    const ts = Number.parseInt((tsRaw ?? "").trim(), 10);
    out.push({ framework, verdict: v, title: (title ?? "").trim(), ts: Number.isFinite(ts) ? ts : 0 });
  }
  return out;
}

// Task kinds collapse the R7 corrective-retry suffix so "修登录（重派#2）"
// folds into its parent kind: the repetition IS the failure signal.
export function normalizeKind(title: string): string {
  return title.replace(/（重派#\d+）/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

// ── patterns: success/failure signatures from the outcome history ──────────
export interface FrameworkRecord {
  framework: string; total: number; pass: number; partial: number; fail: number; passRate: number;
}
export interface FailureKind { kind: string; fails: number; frameworks: string[] }
export interface Patterns {
  frameworks: FrameworkRecord[];
  weak: FrameworkRecord[];    // ≥3 tries, pass rate < 40 — staffing liability
  strong: FrameworkRecord[];  // ≥5 tries, pass rate ≥ 80 — trusted performer
  failureKinds: FailureKind[]; // kind failed ≥2 times — retrying unchanged is a loop
}

export function extractPatterns(outcomes: Outcome[]): Patterns {
  const byFw = new Map<string, FrameworkRecord>();
  for (const o of outcomes) {
    const r = byFw.get(o.framework) ?? { framework: o.framework, total: 0, pass: 0, partial: 0, fail: 0, passRate: 0 };
    r.total++; // the swept-in T9 layer shipped without this — weak/strong could never fire
    if (o.verdict === "pass") r.pass++; else if (o.verdict === "partial") r.partial++; else r.fail++;
    byFw.set(o.framework, r);
  }
  const frameworks = [...byFw.values()]
    .map((r) => ({ ...r, passRate: r.total > 0 ? Math.round((r.pass / r.total) * 100) : 0 }))
    .sort((a, b) => b.total - a.total || a.framework.localeCompare(b.framework));
  const kinds = new Map<string, FailureKind>();
  for (const o of outcomes) {
    if (o.verdict !== "fail") continue;
    const kind = normalizeKind(o.title);
    if (!kind) continue;
    const k = kinds.get(kind) ?? { kind, fails: 0, frameworks: [] };
    k.fails++;
    if (!k.frameworks.includes(o.framework)) k.frameworks.push(o.framework);
    kinds.set(kind, k);
  }
  return {
    frameworks,
    weak: frameworks.filter((r) => r.total >= 3 && r.passRate < 40),
    strong: frameworks.filter((r) => r.total >= 5 && r.passRate >= 80),
    failureKinds: [...kinds.values()].filter((k) => k.fails >= 2)
      .sort((a, b) => b.fails - a.fails || a.kind.localeCompare(b.kind)),
  };
}

// ── completion-rate statistics and trend ────────────────────────────────────
export interface DayBucket { day: string; total: number; pass: number; partial: number; fail: number; completionRate: number }
export interface Trends {
  total: number;            // all outcomes (dated + undated)
  pass: number;
  completionRate: number;   // whole-ledger pass %, 0 when empty
  daily: DayBucket[];       // dated outcomes bucketed per local day, window tail, oldest first
  last7Rate: number | null; // pass % over the last 7 days (null = no dated data)
  prev7Rate: number | null; // the 7 days before that
  delta7: number | null;    // last7 − prev7; the trend line
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function rateOr(p: number, t: number): number | null {
  return t > 0 ? Math.round((p / t) * 100) : null;
}

export function computeTrends(outcomes: Outcome[], now: number, windowDays = 14): Trends {
  const pass = outcomes.filter((o) => o.verdict === "pass").length;
  const total = outcomes.length;
  const buckets = new Map<string, DayBucket>();
  for (const o of outcomes) {
    if (!o.ts) continue; // undated: totals count, buckets cannot
    const day = dayKey(o.ts);
    const b = buckets.get(day) ?? { day, total: 0, pass: 0, partial: 0, fail: 0, completionRate: 0 };
    b.total++;
    if (o.verdict === "pass") b.pass++; else if (o.verdict === "partial") b.partial++; else b.fail++;
    buckets.set(day, b);
  }
  const daily = [...buckets.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-windowDays)
    .map((b) => ({ ...b, completionRate: b.total > 0 ? Math.round((b.pass / b.total) * 100) : 0 }));
  const DAY = 86_400_000;
  const within = (from: number, to: number) => outcomes.filter((o) => o.ts > from && o.ts <= to);
  const l7 = within(now - 7 * DAY, now), p7 = within(now - 14 * DAY, now - 7 * DAY);
  const last7Rate = rateOr(l7.filter((o) => o.verdict === "pass").length, l7.length);
  const prev7Rate = rateOr(p7.filter((o) => o.verdict === "pass").length, p7.length);
  return {
    total, pass,
    completionRate: total > 0 ? Math.round((pass / total) * 100) : 0,
    daily, last7Rate, prev7Rate,
    delta7: last7Rate !== null && prev7Rate !== null ? last7Rate - prev7Rate : null,
  };
}

// ── rubric lines with refresh-in-place fingerprints ────────────────────────
// Every auto-learned line carries `[auto-rubric][<fp>]`; mergeRubric rewrites
// the line owning a fingerprint instead of appending a second copy, so the
// rubric stays a living standard, not an append-only log.
export const AUTO_MARK = "[auto-rubric]";

function fpOf(line: string): string | null {
  const m = line.match(/\[auto-rubric\]\[([^\]]+)\]/);
  return m ? m[1] : null;
}
const line = (fp: string, text: string) => `- ${AUTO_MARK}[${fp}] ${text}`;

export function renderRubricLines(p: Patterns, t: Trends): string[] {
  const lines: string[] = [];
  for (const w of p.weak.slice(0, 5))
    lines.push(line(`weak:${w.framework}`, `${w.framework} 历史验收通过率仅 ${w.passRate}%（${w.total} 次）——同类任务降低优先级，验收标准写成可检查的具体动作；连续失败后禁止原框架原样重发`));
  for (const s of p.strong.slice(0, 3))
    lines.push(line(`strong:${s.framework}`, `${s.framework} 是已验证的可靠执行者（通过率 ${s.passRate}%，${s.total} 次）——同类任务优先派给它`));
  for (const k of p.failureKinds.slice(0, 8))
    lines.push(line(`kind:${k.kind}`, `「${k.kind}」已验收失败 ${k.fails} 次（框架：${k.frameworks.join("、")}）——重派必须换策略或换框架，第三次起交人工裁决`));
  if (t.delta7 !== null && t.delta7 <= -10)
    lines.push(line("trend", `近7日通过率 ${t.prev7Rate}%→${t.last7Rate}%（跌 ${-t.delta7}）——收紧自动派发，小步验收，连续下滑须向用户示警`));
  else if (t.delta7 !== null && t.delta7 >= 10)
    lines.push(line("trend", `近7日通过率 ${t.prev7Rate}%→${t.last7Rate}%（升 ${t.delta7}）——可恢复较激进的派发节奏`));
  return lines;
}

export interface MergeResult { text: string; added: number; updated: number }

export function mergeRubric(existing: string, lines: string[]): MergeResult {
  if (lines.length === 0) return { text: existing, added: 0, updated: 0 };
  const arr = existing.split("\n");
  // normalize the tail ONCE up front: without this, a no-change re-merge
  // split a trailing newline into an empty element and re-emitted "\n\n"
  while (arr.length && arr[arr.length - 1] === "") arr.pop();
  const owner = new Map<string, number>(); // fingerprint -> line index of the current rule
  arr.forEach((l, i) => { const fp = fpOf(l); if (fp && !owner.has(fp)) owner.set(fp, i); });
  let added = 0, updated = 0;
  const fresh: string[] = [];
  for (const l of lines) {
    const fp = fpOf(l);
    if (!fp) { fresh.push(l); continue; }
    const at = owner.get(fp);
    if (at === undefined) fresh.push(l);
    else if (arr[at] !== l) { arr[at] = l; updated++; } // refresh in place: one rule per fingerprint
  }
  for (const l of fresh) arr.push(l);
  if (fresh.length) added = fresh.length;
  return { text: arr.join("\n") + "\n", added, updated };
}

// ── priority advice: history-weighted hints for the next dispatch ──────────
export interface Advice { taskId: string; title: string; advice: string }

export function priorityAdvice(tasks: Task[], p: Patterns): Advice[] {
  const kindFails = new Map(p.failureKinds.map((k) => [k.kind, k]));
  const weakFw = new Set(p.weak.map((w) => w.framework));
  const best = p.strong[0];
  const out: Advice[] = [];
  for (const t of tasks) {
    if (t.status !== "todo") continue;
    const notes: string[] = [];
    const k = kindFails.get(normalizeKind(t.title));
    if (k) notes.push(`同类已失败 ${k.fails} 次——先拆解或换策略再降优先级派发`);
    if (t.assignee && weakFw.has(t.assignee)) notes.push(`框架 ${t.assignee} 历史通过率偏低${best ? `，同类更稳的是 ${best.framework}` : ""}`);
    if (notes.length) out.push({ taskId: t.id, title: t.title, advice: notes.join("；") });
  }
  return out.slice(0, 8); // the decide prompt pays for this line — keep the top cases only
}

export function renderAdvice(tasks: Task[], p: Patterns): string {
  const adv = priorityAdvice(tasks, p);
  if (adv.length === 0) return "";
  return `# 优先级建议（auto-rubric：基于历史验收战绩）\n${adv.map((a) => `- 「${a.title}」: ${a.advice}`).join("\n")}`;
}
