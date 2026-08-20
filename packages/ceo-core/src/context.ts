// packages/ceo-core/src/context.ts
import { nestTasks, type Task, type TaskNode } from "./board.js";

const HARD_CHAR_CAP = 32_000; // ~8K tokens at 4 chars/token

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
    sections.push(`# MISSION\n${parts.mission}`);
    sections.push(`# RUBRIC (audit standards)\n${parts.rubric}`);
    sections.push(`# NEW EVENTS SINCE LAST WAKE\n${parts.events.length ? parts.events.join("\n") : "(none)"}`);
    sections.push(`# TASK BOARD\n${this.boardBlock(parts.board) || "(empty)"}`);
    if (parts.budgetLine) sections.push(`# BUDGET\n${parts.budgetLine}`);
    let out = sections.join("\n\n");
    // memory gets whatever room is left, then hard-truncate everything
    const left = HARD_CHAR_CAP - out.length - 64;
    if (left > 0) out += `\n\n# MEMORY (top)\n${parts.memory.slice(0, left)}`;
    return out.slice(0, HARD_CHAR_CAP);
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
      const lead = depth === 0 ? "- " : `${"  ".repeat(Math.min(depth, 2))}↳ `;
      lines.push(`${lead}[${n.id.slice(0, 8)}] p${n.priority} ${n.status} (${n.assignee || "unassigned"}) ${n.title}${sched}${due} :: ${n.resultSummary || "no result yet"}`);
      for (const c of n.children) walk(c, depth + 1);
    };
    for (const root of nestTasks(board)) walk(root, 0);
    return lines.join("\n");
  }
}
