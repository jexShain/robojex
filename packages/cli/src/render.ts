// packages/cli/src/render.ts
// Pure renderers for the board-v2 CLI views (board-plan.md): /board's ANSI
// task tree and /agenda's hourly day strip, plus the wait-spinner constants.
// No I/O and no clocks — every function takes the tasks and an explicit
// `now` epoch (state.now from the server), so output is deterministic and
// snapshot-testable. The REPL prints these strings verbatim.

/** Task card as the protocol ships it (state.tasks and tasks frames). */
export interface BoardTask {
  id: string;
  title: string;
  status: string;
  resultSummary?: string;
  createdAt?: number;
  parentId?: string | null;
  scheduledAt?: number | null;
  dueAt?: number | null;
}

const RESET = "\x1b[0m";
const paint = (s: string, code: string): string => `\x1b[${code}m${s}${RESET}`;

// Status palette: done green / running bright blue / blocked red / todo gray
// (unknown statuses fall back to the neutral gray).
const STATUS_COLOR: Record<string, string> = { done: "32", running: "94", blocked: "31", todo: "90" };
export const statusColor = (status: string): string => STATUS_COLOR[status] ?? "90";

const pad2 = (n: number): string => String(n).padStart(2, "0");

const sameLocalDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** HH:MM when `ms` falls on `now`'s local day, else MM-DD HH:MM (like core's context clock). */
export function fmtClock(ms: number, now: number): string {
  const d = new Date(ms);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return sameLocalDay(d, new Date(now)) ? hm : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}

const fmtDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

const DAY_MS = 86_400_000;
const localMidnight = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Local-midnight epoch for a strict YYYY-MM-DD, or null when malformed. */
export function parseAgendaDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [, ys, mos, ds] = m;
  const y = Number(ys);
  const mo = Number(mos);
  const d = Number(ds);
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.getTime();
}

// --------------------------------------------------------------------- board

interface TreeNode { task: BoardTask; children: TreeNode[]; }

/** Forest from a flat task list; dead parents and cycles are adopted as roots. */
function buildTree(tasks: BoardTask[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const t of tasks) nodes.set(t.id, { task: t, children: [] });
  const roots: TreeNode[] = [];
  for (const n of nodes.values()) {
    const p = n.task.parentId ? nodes.get(n.task.parentId) : undefined;
    if (p && p !== n) p.children.push(n);
    else roots.push(n);
  }
  // Orphan sweep (mirrors core's nestTasks): anything unreachable from a
  // root — a cycle A→B→A — is promoted to a root so no task is ever hidden.
  const seen = new Set<string>();
  const visit = (n: TreeNode): void => {
    seen.add(n.task.id);
    for (const c of n.children) visit(c);
  };
  for (const r of roots) visit(r);
  for (const n of nodes.values()) if (!seen.has(n.task.id)) roots.push(n);
  return roots;
}

/** /board: root summary line, then the ├─/└─ tree with colored status dots,
 *  sched (⏱) / due (⏳) clock suffixes and the ⚠ blocked-bubble-up warning. */
export function renderBoard(tasks: BoardTask[], now: number): string {
  const done = tasks.filter((t) => t.status === "done").length;
  const running = tasks.filter((t) => t.status === "running").length;
  const lines: string[] = [
    `${paint(`${tasks.length} tasks`, "90")} · ${paint(`${done} done`, "32")} · ${paint(`${running} running`, "94")}`,
  ];

  const roots = buildTree(tasks);
  if (!roots.length) return lines.join("\n");
  lines.push("");

  // blocked-bubble-up (display-layer only): a parent whose subtree holds a
  // blocked task gets the ⚠ warning. The provisional false breaks cycles.
  const blockedBelow = new Map<string, boolean>();
  const hasBlockedDescendant = (n: TreeNode): boolean => {
    const hit = blockedBelow.get(n.task.id);
    if (hit !== undefined) return hit;
    blockedBelow.set(n.task.id, false);
    const any = n.children.some((c) => c.task.status === "blocked" || hasBlockedDescendant(c));
    blockedBelow.set(n.task.id, any);
    return any;
  };

  const nodeLine = (n: TreeNode, prefix: string): string => {
    const t = n.task;
    const warn = t.status !== "blocked" && hasBlockedDescendant(n) ? ` ${paint("⚠", "31")}` : "";
    const sched = t.scheduledAt != null ? ` ${paint(`⏱${fmtClock(t.scheduledAt, now)}`, "90")}` : "";
    const due = t.dueAt != null ? ` ${paint(`⏳${fmtClock(t.dueAt, now)}`, "90")}` : "";
    return `${prefix}${paint("●", statusColor(t.status))} ${t.title}${warn}${sched}${due}`;
  };

  // Each node prints at most once: the cycle guard keeps adoption from looping.
  const rendered = new Set<string>();
  const emit = (n: TreeNode, cont: string): void => {
    for (let i = 0; i < n.children.length; i++) {
      const c = n.children[i]!;
      if (rendered.has(c.task.id)) continue;
      const last = i === n.children.length - 1;
      rendered.add(c.task.id);
      lines.push(nodeLine(c, cont + (last ? "└─ " : "├─ ")));
      emit(c, cont + (last ? "   " : "│  "));
    }
  };
  for (const r of roots) {
    if (rendered.has(r.task.id)) continue;
    rendered.add(r.task.id);
    lines.push(nodeLine(r, ""));
    emit(r, "");
  }
  return lines.join("\n");
}

// -------------------------------------------------------------------- agenda

/** /agenda: one row per hour for the target day — `HH ─` when empty, else the
 *  day's scheduled tasks as `HH:MM─HH:MM │ title [status]` (start only when
 *  no due; cross-day dues render MM-DD HH:MM) — then the unscheduled tail. */
export function renderAgenda(tasks: BoardTask[], now: number, date?: string): string {
  const start = (date !== undefined ? parseAgendaDate(date) : null) ?? localMidnight(now);
  const end = start + DAY_MS;
  const timed = tasks
    .filter((t) => t.scheduledAt != null && t.scheduledAt >= start && t.scheduledAt < end)
    .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));

  const today = sameLocalDay(new Date(start), new Date(now)) ? " · today" : "";
  const lines: string[] = [paint(`agenda ${fmtDay(start)}${today}`, "90")];
  for (let h = 0; h < 24; h++) {
    const hourTasks = timed.filter((t) => new Date(t.scheduledAt!).getHours() === h);
    if (!hourTasks.length) {
      lines.push(paint(`${pad2(h)} ─`, "90"));
      continue;
    }
    for (const t of hourTasks) {
      const s = new Date(t.scheduledAt!);
      const range = t.dueAt != null
        ? `${pad2(s.getHours())}:${pad2(s.getMinutes())}─${fmtClock(t.dueAt, t.scheduledAt!)}`
        : `${pad2(s.getHours())}:${pad2(s.getMinutes())}`;
      lines.push(`${paint(range, "94")} ${paint("│", "90")} ${t.title} ${paint(`[${t.status}]`, statusColor(t.status))}`);
    }
  }

  const loose = tasks.filter((t) => t.scheduledAt == null);
  if (loose.length) {
    lines.push("", paint("unscheduled", "90"));
    for (const t of loose) lines.push(`  - ${t.title} ${paint(`[${t.status}]`, statusColor(t.status))}`);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------- spinner

/** Braille wait-spinner frames, redrawn every SPINNER_INTERVAL_MS while a chat reply is pending. */
export const spinnerFrames: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
export const SPINNER_INTERVAL_MS = 120;
