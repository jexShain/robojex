// packages/ceo-core/src/context.ts
import { nestTasks, type Task, type TaskNode } from "./board.js";

const HARD_CHAR_CAP = 32_000; // ~8K tokens at 4 chars/token

// ---- deterministic context governance -------------------------------------
// Section budgets prune oversized input BEFORE the hard cap ever bites, so cuts
// land at section boundaries with visible markers (the model can see something
// was omitted and can fetch the full text with tools) instead of silently
// beheading the assembled prompt. Every limit below is checked first: an
// under-limit section passes through byte-identical to the ungoverned build.

const DOC_LIMIT = 4_000;    // mission/rubric: charters read front-first -> head-heavy prune
const MEMORY_LIMIT = 6_000; // butler memory: newest lessons sit at the tail -> tail-heavy prune
const EVENTS_MAX = 12;      // beyond this keep only the latest 10, oldest dropped with a marker
const BOARD_LINES_MAX = 16; // beyond this fold the middle: 4 head + 8 tail survive

/**
 * Deterministic head/middle/tail text pruner. Slices by Unicode code point
 * (`Array.from`), so a retained boundary can never split a surrogate pair —
 * emoji and CJK stay whole. Pure function of its input: same string in, same
 * string out, replayable without state. Within budget the original string is
 * returned as-is (same reference).
 */
export function pruneText(s: string, headChars: number, tailChars: number): string {
  const pts = Array.from(s);
  if (pts.length <= headChars + tailChars) return s;
  const removed = pts.length - headChars - tailChars;
  return pts.slice(0, headChars).join("") +
    `\n…[中段裁剪 ${removed} 字符]…\n` +
    pts.slice(pts.length - tailChars).join(""); // not slice(-tailChars): tailChars 0 must mean "no tail"
}

// Human-readable wall clock for one timestamp: HH:MM when it falls on the
// current local day, MM-DD HH:MM otherwise — local time is what jex and the
// operator both live in.
function clock(ms: number, now: number): string {
  const d = new Date(ms), n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? hm : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

export class ContextAssembler {
  build(parts: { mission: string; rubric: string; memory: string; board: Task[]; events: string[]; budgetLine?: string }): string {
    const sections: string[] = [];
    sections.push(`# MISSION\n${this.doc(parts.mission)}`);
    sections.push(`# RUBRIC (audit standards)\n${this.doc(parts.rubric)}`);
    sections.push(`# NEW EVENTS SINCE LAST WAKE\n${this.eventsBlock(parts.events)}`);
    sections.push(`# TASK BOARD\n${this.boardBlock(parts.board) || "(empty)"}`);
    if (parts.budgetLine) sections.push(`# BUDGET\n${parts.budgetLine}`);
    // anchor clock: reasoning models default to UTC when emitting timestamps;
    // showing the local offset keeps scheduledAt/dueAt on the user's day
    const now = Date.now();
    const off = -new Date(now).getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const offStr = `${sign}${String(Math.floor(Math.abs(off) / 60)).padStart(2, "0")}:${String(Math.abs(off) % 60).padStart(2, "0")}`;
    sections.push(`# CLOCK\nnow = ${new Date(now).toISOString().replace("Z", offStr)} (local offset ${offStr}); emit timestamps WITH this offset, never Z`);
    let out = sections.join("\n\n");
    // memory gets whatever room is left, then hard-truncate everything;
    // an oversized memory is pruned first (tail-heavy: the butler's latest
    // lessons live at the end) so the marker lands inside the memory, not at
    // the hard cap where the tail would be lost
    const memory = parts.memory.length > MEMORY_LIMIT ? pruneText(parts.memory, 2_000, 3_000) : parts.memory;
    const left = HARD_CHAR_CAP - out.length - 64;
    if (left > 0) out += `\n\n# MEMORY (top)\n${memory.slice(0, left)}`;
    return out.slice(0, HARD_CHAR_CAP);
  }

  // mission/rubric: keep the charter's opening and a short tail, drop the middle
  private doc(text: string): string {
    return text.length > DOC_LIMIT ? pruneText(text, 2_500, 1_000) : text;
  }

  // event storms fold to the latest 10 with a visible omission count
  private eventsBlock(events: string[]): string {
    if (events.length <= EVENTS_MAX) return events.length ? events.join("\n") : "(none)";
    return `[...${events.length - 10} 条更早事件已省略]\n${events.slice(-10).join("\n")}`;
  }

  // Board as a tree the model can read: children indented under their parent
  // (indent capped at two levels), each line carrying [sched …][due …] clocks
  // so the tree shape and the time pressure are both visible at a glance.
  private boardBlock(board: Task[]): string {
    const now = Date.now();
    const lines: string[] = [];
    const walk = (n: TaskNode, depth: number): void => {
      const sched = n.scheduledAt != null ? ` [sched ${clock(n.scheduledAt, now)}]` : "";
      const due = n.dueAt != null ? ` [due ${clock(n.dueAt, now)}]` : "";
      // acceptance verdict rides the board line so overdue re-decisions see it
      const vf = n.verdict && n.verdict !== "unchecked" ? ` [${n.verdict}${n.progress ? ` ${n.progress}%` : ""}]` : "";
      const lead = depth === 0 ? "- " : `${"  ".repeat(Math.min(depth, 2))}↳ `;
      lines.push(`${lead}[${n.id.slice(0, 8)}] p${n.priority} ${n.status} (${n.assignee || "unassigned"}) ${n.title}${sched}${due}${vf} :: ${n.resultSummary || "no result yet"}`);
      for (const c of n.children) walk(c, depth + 1);
    };
    // R83: cancelled cards are dead weight — the whole point of archiving is
    // that decide stops paying context for them every cycle
    for (const root of nestTasks(board.filter((t) => t.status !== "cancelled"))) walk(root, 0);
    // board lines render priority DESC then insertion order, so the head
    // carries the highest-priority rows and the tail the newest — both ends
    // survive, only the cold middle folds
    const shown = lines.length > BOARD_LINES_MAX
      ? [...lines.slice(0, 4), `[...${lines.length - 12} 个任务已折叠，可用工具查看]`, ...lines.slice(lines.length - 8)]
      : lines;
    return shown.join("\n");
  }
}
