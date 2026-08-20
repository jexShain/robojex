// packages/cli/test/render.test.ts
// Snapshot tests for the pure board/agenda renderers (board-plan.md CLI
// spec): tree glyphs, ANSI status colors, sched/due clock formats, the root
// summary line, agenda hour rows and the spinner frame constants. All inputs
// are explicit epochs built from local Date constructors, so expectations are
// timezone-independent and deterministic.
import { expect, test } from "vitest";
import {
  fmtClock,
  parseAgendaDate,
  renderAgenda,
  renderBoard,
  spinnerFrames,
  SPINNER_INTERVAL_MS,
  type BoardTask,
} from "../src/render.js";

const P = (s: string, code: string): string => `\x1b[${code}m${s}\x1b[0m`;

// 2026-08-20 12:00 local — "today" for every assertion below.
const NOW = new Date(2026, 7, 20, 12, 0).getTime();
const at = (day: number, h: number, m: number): number => new Date(2026, 7, day, h, m).getTime();

// ------------------------------------------------------------------- /board

test("renderBoard: summary line, tree glyphs, status colors and clock formats", () => {
  const tasks: BoardTask[] = [
    { id: "epic", title: "Ship v2", status: "running", parentId: null },
    { id: "scrape", title: "Scrape docs", status: "done", parentId: "epic", scheduledAt: at(20, 9, 30), dueAt: at(20, 10, 30) },
    { id: "parse", title: "Parse pages", status: "todo", parentId: "scrape", dueAt: at(21, 12, 0) },
    { id: "deploy", title: "Deploy", status: "blocked", parentId: "epic" },
    { id: "loose", title: "Loose end", status: "todo", parentId: "ghost" }, // dead parent → root
  ];
  expect(renderBoard(tasks, NOW)).toBe([
    `${P("5 tasks", "90")} · ${P("1 done", "32")} · ${P("1 running", "94")}`,
    "",
    // running root carries the ⚠ warning: a blocked task bubbles up from Deploy
    `${P("●", "94")} Ship v2 ${P("⚠", "31")}`,
    `├─ ${P("●", "32")} Scrape docs ${P("⏱09:30", "90")} ${P("⏳10:30", "90")}`,
    `│  └─ ${P("●", "90")} Parse pages ${P("⏳08-21 12:00", "90")}`,
    `└─ ${P("●", "31")} Deploy`,
    `${P("●", "90")} Loose end`,
  ].join("\n"));
});

test("renderBoard: empty board is just the summary line", () => {
  expect(renderBoard([], NOW))
    .toBe(`${P("0 tasks", "90")} · ${P("0 done", "32")} · ${P("0 running", "94")}`);
});

test("renderBoard: parent cycles are adopted as roots instead of looping", () => {
  const tasks: BoardTask[] = [
    { id: "a", title: "Alpha", status: "todo", parentId: "b" },
    { id: "b", title: "Beta", status: "todo", parentId: "a" },
  ];
  const out = renderBoard(tasks, NOW);
  expect(out).toContain("Alpha");
  expect(out).toContain("Beta");
});

// ------------------------------------------------------------------ /agenda

test("renderAgenda: hour rows, task lines, cross-day ends and unscheduled tail", () => {
  const tasks: BoardTask[] = [
    { id: "fix", title: "Fix login", status: "running", scheduledAt: at(20, 9, 30), dueAt: at(20, 10, 30) },
    { id: "sync", title: "Standup", status: "todo", scheduledAt: at(20, 9, 0) }, // no due → start time only
    { id: "cross", title: "Cross-midnight", status: "done", scheduledAt: at(20, 14, 0), dueAt: at(21, 12, 0) },
    { id: "docs", title: "Write docs", status: "todo" }, // unscheduled → lower section
    { id: "tmr", title: "Tomorrow", status: "todo", scheduledAt: at(21, 8, 0) }, // other day → hidden
  ];
  const out = renderAgenda(tasks, NOW).split("\n");
  expect(out[0]).toBe(P("agenda 2026-08-20 · today", "90"));
  expect(out[1]).toBe(P("00 ─", "90"));
  expect(out[9]).toBe(P("08 ─", "90"));
  // hour 09: two tasks ordered by scheduledAt
  expect(out[10]).toBe(`${P("09:00", "94")} ${P("│", "90")} Standup ${P("[todo]", "90")}`);
  expect(out[11]).toBe(`${P("09:30─10:30", "94")} ${P("│", "90")} Fix login ${P("[running]", "94")}`);
  expect(out[12]).toBe(P("10 ─", "90"));
  // due on another day renders as MM-DD HH:MM
  expect(out[16]).toBe(`${P("14:00─08-21 12:00", "94")} ${P("│", "90")} Cross-midnight ${P("[done]", "32")}`);
  // 1 header + 24 hour rows + 2 extra task lines + blank + section head + 1 item
  expect(out.length).toBe(29);
  expect(out.slice(-3)).toEqual(["", P("unscheduled", "90"), `  - Write docs ${P("[todo]", "90")}`]);
  expect(out.join("\n")).not.toContain("Tomorrow");
});

test("renderAgenda: explicit YYYY-MM-DD targets that day and drops the today mark", () => {
  const tasks: BoardTask[] = [
    { id: "fix", title: "Fix login", status: "running", scheduledAt: at(20, 9, 30) },
    { id: "tmr", title: "Tomorrow", status: "todo", scheduledAt: at(21, 8, 0) },
  ];
  const out = renderAgenda(tasks, NOW, "2026-08-21").split("\n");
  expect(out[0]).toBe(P("agenda 2026-08-21", "90"));
  expect(out[9]).toBe(`${P("08:00", "94")} ${P("│", "90")} Tomorrow ${P("[todo]", "90")}`);
  expect(out.join("\n")).not.toContain("Fix login");
});

// ------------------------------------------------------- clocks and spinner

test("fmtClock: HH:MM on now's day, MM-DD HH:MM otherwise (local time)", () => {
  expect(fmtClock(at(20, 9, 5), NOW)).toBe("09:05");
  expect(fmtClock(at(21, 8, 0), NOW)).toBe("08-21 08:00");
});

test("spinnerFrames: the braille sequence at the 120ms cadence", () => {
  expect(spinnerFrames).toEqual(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"]);
  expect(SPINNER_INTERVAL_MS).toBe(120);
});

test("parseAgendaDate: strict YYYY-MM-DD validation via round-trip", () => {
  expect(parseAgendaDate("2026-08-20")).toBe(new Date(2026, 7, 20).getTime());
  expect(parseAgendaDate("2026-02-30")).toBeNull(); // no such day
  expect(parseAgendaDate("2026-13-01")).toBeNull(); // no such month
  expect(parseAgendaDate("20260820")).toBeNull();
  expect(parseAgendaDate("26-08-20")).toBeNull();
  expect(parseAgendaDate("")).toBeNull();
});
