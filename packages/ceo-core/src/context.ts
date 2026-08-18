// packages/ceo-core/src/context.ts
import type { Task } from "./board.js";

const HARD_CHAR_CAP = 32_000; // ~8K tokens at 4 chars/token

export class ContextAssembler {
  build(parts: { mission: string; rubric: string; memory: string; board: Task[]; events: string[]; budgetLine?: string }): string {
    const sections: string[] = [];
    sections.push(`# MISSION\n${parts.mission}`);
    sections.push(`# RUBRIC (audit standards)\n${parts.rubric}`);
    sections.push(`# NEW EVENTS SINCE LAST WAKE\n${parts.events.length ? parts.events.join("\n") : "(none)"}`);
    const boardText = parts.board.map((t) => `- [${t.id.slice(0, 8)}] p${t.priority} ${t.status} (${t.assignee || "unassigned"}) ${t.title} :: ${t.resultSummary || "no result yet"}`).join("\n");
    sections.push(`# TASK BOARD\n${boardText || "(empty)"}`);
    if (parts.budgetLine) sections.push(`# BUDGET\n${parts.budgetLine}`);
    let out = sections.join("\n\n");
    // memory gets whatever room is left, then hard-truncate everything
    const left = HARD_CHAR_CAP - out.length - 64;
    if (left > 0) out += `\n\n# MEMORY (top)\n${parts.memory.slice(0, left)}`;
    return out.slice(0, HARD_CHAR_CAP);
  }
}
