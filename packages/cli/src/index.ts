#!/usr/bin/env node
// packages/cli/src/index.ts
// jex — terminal chat client for the robojex core API. Speaks the frozen
// protocol from .superpowers/dsh-plan.md: POST /api/chat (plus /api/mode,
// /api/mission and GET /api/state) over HTTP, and the /api/events WS frames.
// Interactive readline REPL by default; `--once` pipe mode reads one stdin
// line, posts it, prints the single jex reply (stdout only) and exits —
// 30s deadline (JEX_TIMEOUT_MS overrides), exit 1 on failure.

import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { parseAgendaDate, renderAgenda, renderBoard, spinnerFrames, SPINNER_INTERVAL_MS, statusColor, type BoardTask } from "./render.js";

export const DEFAULT_URL = "http://127.0.0.1:7620";
export const DEFAULT_TIMEOUT_MS = 30_000;

// Design tokens (DSH design platform): prompt blue-450, user echo neutral-500.
const BLUE_450 = "\x1b[38;2;86;134;254m";
const NEUTRAL_500 = "\x1b[38;2;127;130;135m";
const RESET = "\x1b[0m";
const PROMPT = `${BLUE_450}jex› ${RESET}`;

const dim = (line: string): string => `${NEUTRAL_500}${line}${RESET}`;
const youEcho = (line: string): string => `${NEUTRAL_500}you› ${RESET}${line}`;

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const HELP_TEXT = [
  "jex — terminal chat client for robojex",
  "",
  "  /mode [observe|assist|full]  show or switch the mode",
  "  /tasks                       list the task board",
  "  /board                       task tree view (status dots, ⏱/⏳ times)",
  "  /agenda [YYYY-MM-DD]         hourly schedule for today or a date",
  "  /mission <text>              append a line to MISSION",
  "  /budget                      show the budget line",
  "  /help                        this help",
  "",
  "  anything else is chat to jex.",
  "  Ctrl+C interrupts a pending reply (press twice to quit); Ctrl-D quits.",
].join("\n");

export type { BoardTask };

export type CliArgs = { url: string; once: boolean; help: boolean };

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { url: DEFAULT_URL, once: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--url") args.url = argv[++i] ?? DEFAULT_URL;
    else if (a.startsWith("--url=")) args.url = a.slice("--url=".length);
    else if (a === "--once") args.once = true;
    else if (a === "-h" || a === "--help") args.help = true;
  }
  return args;
}

/** Derive the /api/events WS endpoint from an http(s)/ws(s) base URL. */
export function wsEventsUrl(base: string): string {
  let u = base.trim().replace(/\/+$/, "");
  if (u.startsWith("https://")) u = `wss://${u.slice("https://".length)}`;
  else if (u.startsWith("http://")) u = `ws://${u.slice("http://".length)}`;
  else if (!u.startsWith("ws://") && !u.startsWith("wss://")) u = `ws://${u}`;
  return `${u}/api/events`;
}

// ------------------------------------------------------------------ protocol

export type Frame =
  | { t: "hello"; state: CoreState }
  | { t: "chat_out"; from: "user" | "jex" | "system"; text: string; ts?: number }
  | { t: "tasks"; tasks: BoardTask[] }
  | { t: "cycle"; wake?: number; cost?: number; actions?: unknown[] }
  | { t: "mode"; mode: string }
  | { t: "budget"; line: string };

export type CoreState = {
  now?: number; // server epoch ms: clock anchor for board/agenda rendering
  tasks?: BoardTask[];
  budget?: { mode?: string; dailyTokens?: number; spentToday?: number; line?: string };
  mode?: string;
  mission?: string;
  rubric?: string;
  memory?: string;
  chat?: { from: string; ts?: number; text: string }[];
  version?: string;
};

/** One-line summary for state frames; null for frames that are not summaries. */
export function summarizeFrame(f: Frame): string | null {
  if (f.t === "tasks") {
    const counts = new Map<string, number>();
    for (const t of f.tasks ?? []) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
    const parts = [...counts.entries()].sort().map(([status, n]) => `${n} ${status}`);
    return `tasks ${f.tasks?.length ?? 0}${parts.length ? ` (${parts.join(", ")})` : ""}`;
  }
  if (f.t === "cycle") return `cycle wake=${f.wake ?? "?"} cost=${f.cost ?? "?"} actions=${f.actions?.length ?? 0}`;
  if (f.t === "mode") return `mode ${f.mode}`;
  if (f.t === "budget") return `budget ${f.line}`;
  return null;
}

const httpBase = (base: string): string => base.trim().replace(/\/+$/, "");

async function postJson(base: string, path: string, body: unknown, timeoutMs: number): Promise<Response> {
  return fetch(httpBase(base) + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function getState(base: string, timeoutMs: number): Promise<CoreState> {
  const res = await fetch(httpBase(base) + "/api/state", { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET /api/state → HTTP ${res.status}`);
  return (await res.json()) as CoreState;
}

// ---------------------------------------------------- /api/events connection

interface ConnectionHandlers {
  /** A chat_out frame from jex arrived. */
  onJexReply: (text: string) => void;
  /** An informational line (frame summaries, connection notices). */
  onLine: (line: string) => void;
  /** Socket dropped after a successful open (once mode fails fast on this). */
  onDeath?: () => void;
  /** Every decoded frame, before dispatch routing (spinner stop, task toasts). */
  onFrame?: (f: Frame) => void;
}

// DSH ConnectionController logic: every dial bumps `generation`; frames from
// stale sockets are dropped, and reconnects back off exponentially 1s→16s,
// resetting after a clean open. Reconnect is disabled in --once mode.
class EventsConnection {
  private ws: WebSocket | null = null;
  private generation = 0;
  private backoffMs = 1_000;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly reconnect: boolean;
  private readonly h: ConnectionHandlers;
  readonly baseUrl: string;

  constructor(baseUrl: string, reconnect: boolean, h: ConnectionHandlers) {
    this.baseUrl = baseUrl;
    this.reconnect = reconnect;
    this.h = h;
  }

  connect(): Promise<void> {
    const gen = ++this.generation;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let settled = false;
    const ws = new WebSocket(wsEventsUrl(this.baseUrl));
    this.ws = ws;
    ws.on("open", () => {
      if (gen !== this.generation) { ws.close(); return; }
      this.backoffMs = 1_000;
      if (!settled) { settled = true; resolve(); }
    });
    ws.on("message", (raw) => {
      if (gen !== this.generation) return;
      try {
        this.dispatch(JSON.parse(String(raw)) as Frame);
      } catch { /* malformed frames are ignored */ }
    });
    ws.on("error", () => { /* surfaced via the close handler */ });
    ws.on("close", () => {
      if (gen !== this.generation) return;
      this.ws = null;
      if (!settled) {
        settled = true;
        reject(new Error(`cannot reach ${wsEventsUrl(this.baseUrl)}`));
      } else if (!this.stopped) {
        this.h.onDeath?.();
      }
      this.scheduleReconnect();
    });
    return promise;
  }

  private dispatch(f: Frame): void {
    this.h.onFrame?.(f);
    if (f.t === "chat_out") {
      if (f.from === "jex") this.h.onJexReply(f.text);
      else if (f.from === "system") this.h.onLine(`system› ${f.text}`);
      return; // "user" frames are our own chat, echoed locally already
    }
    const summary = summarizeFrame(f);
    if (summary) this.h.onLine(summary);
  }

  private scheduleReconnect(): void {
    if (!this.reconnect || this.stopped || this.retryTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 16_000);
    this.h.onLine(`·· connection lost, retrying in ${Math.round(delay / 1000)}s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect().catch(() => { /* the close handler reschedules */ });
    }, delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.generation++; // invalidate handlers on the live socket
    this.ws?.close();
    this.ws = null;
  }
}

// ------------------------------------------------------------------- --once

function readStdinLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const { promise, resolve } = Promise.withResolvers<string>();
  let settled = false;
  // resolve() must run before rl.close(): close() re-enters synchronously via
  // the 'close' event, and the first resolve() call wins the promise.
  const done = (v: string | null): void => {
    if (settled) return;
    settled = true;
    resolve(v ?? "");
    rl.close();
  };
  rl.once("line", (l) => done(l));
  rl.once("close", () => done(null));
  return promise;
}

type OnceOutcome = { kind: "reply"; text: string } | { kind: "timeout" } | { kind: "dead" };

async function runOnce(baseUrl: string, timeoutMs: number): Promise<number> {
  const err = (s: string): void => { process.stderr.write(`${s}\n`); };
  const text = (await readStdinLine()).trim();
  if (!text) {
    err("(no input line on stdin)");
    return 1;
  }

  let settleOutcome: ((o: OnceOutcome) => void) | null = null;
  const conn = new EventsConnection(baseUrl, false, {
    onJexReply: (t) => settleOutcome?.({ kind: "reply", text: t }),
    onLine: (s) => process.stderr.write(`${dim(s)}\n`), // summaries never pollute stdout
    onDeath: () => settleOutcome?.({ kind: "dead" }),
  });
  try {
    await conn.connect();
    const res = await postJson(baseUrl, "/api/chat", { text }, timeoutMs);
    if (!res.ok) {
      err(`(chat rejected: HTTP ${res.status})`);
      return 1;
    }
    const { promise, resolve } = Promise.withResolvers<OnceOutcome>();
    const timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    settleOutcome = resolve;
    const outcome = await promise;
    clearTimeout(timer);
    if (outcome.kind !== "reply") {
      err(outcome.kind === "timeout"
        ? `(timeout) no reply from jex within ${timeoutMs}ms`
        : "(error) connection lost before jex replied");
      return 1;
    }
    const flushed = Promise.withResolvers<void>();
    process.stdout.write(`${outcome.text}\n`, () => flushed.resolve());
    await flushed.promise; // exit only after the reply left the pipe
    return 0;
  } catch (e) {
    err(`(error) ${errMessage(e)}`);
    return 1;
  } finally {
    conn.stop();
  }
}

// -------------------------------------------------------------- interactive

type ChatOutcome = { kind: "reply"; text: string } | { kind: "timeout" } | { kind: "interrupt" };

async function runInteractive(baseUrl: string, timeoutMs: number): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT });
  const notice = (line: string): void => { process.stdout.write(`${dim(line)}\n`); };

  // Wait spinner (board-plan.md): braille frames redrawn in place while a
  // chat reply is pending; any chat_out/cycle frame — or the wait settling —
  // stops it and erases the line. No-op without a TTY (piped output).
  const spin = {
    timer: null as NodeJS.Timeout | null,
    frame: 0,
    active: false,
    draw(): void {
      process.stdout.write(`\r\x1b[2K${BLUE_450}${spinnerFrames[this.frame]} waiting for jex…${RESET}`);
    },
    start(): void {
      if (!rl.terminal) return; // no redraw-in-place without a real terminal
      this.active = true;
      this.frame = 0;
      this.draw();
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % spinnerFrames.length;
        this.draw();
      }, SPINNER_INTERVAL_MS);
    },
    stop(): void {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (this.active) { this.active = false; process.stdout.write("\r\x1b[2K"); }
    },
  };

  // Async frame lines land mid-typing: newline + redraw so live input survives
  // — while the spinner owns the current line, clear it first (the next tick
  // reclaims the fresh line) and skip the prompt redraw.
  const print = (line: string): void => {
    if (spin.active) process.stdout.write("\r\x1b[2K");
    process.stdout.write(`${line}\n`);
    if (!spin.active) rl.prompt(true);
  };

  let jexSink: ((t: string) => void) | null = null;
  let waiting: { interrupt: () => void } | null = null;
  let sigintArmed = false;
  let exiting = false;
  let opens = 0;

  // Task toasts: a tasks frame while NOT waiting for a reply prints one
  // status-change line (`✓ task <status>: <title>`), throttled to one per
  // second so bursts never flood the transcript. hello seeds the baseline so
  // the first broadcast after connecting does not toast the whole board.
  let seen = new Map<string, string>();
  let lastToast = 0;
  const onTasks = (list: BoardTask[]): void => {
    const changed = list.filter((t) => seen.get(t.id) !== t.status);
    seen = new Map(list.map((t) => [t.id, t.status]));
    if (!changed.length || waiting) return;
    if (Date.now() - lastToast < 1_000) return;
    lastToast = Date.now();
    const pick = changed.find((t) => t.status === "done") ?? changed[0]!;
    print(`\x1b[${statusColor(pick.status)}m✓${RESET} task ${pick.status}: ${pick.title}`);
  };

  const conn = new EventsConnection(baseUrl, true, {
    onJexReply: (t) => jexSink?.(t),
    onLine: print,
    onFrame: (f) => {
      if (f.t === "chat_out" || f.t === "cycle") spin.stop();
      else if (f.t === "hello") seen = new Map((f.state.tasks ?? []).map((t) => [t.id, t.status]));
      else if (f.t === "tasks") onTasks(f.tasks);
    },
  });
  void conn.connect().then(() => {
    opens++;
    notice(opens === 1 ? `·· connected to ${baseUrl} — /help for commands` : "·· reconnected");
    rl.prompt(true);
  }).catch(() => { /* the connection reschedules itself */ });

  const sendChat = async (text: string): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<ChatOutcome>();
    waiting = { interrupt: () => resolve({ kind: "interrupt" }) };
    jexSink = (t) => resolve({ kind: "reply", text: t });
    try {
      const res = await postJson(baseUrl, "/api/chat", { text }, timeoutMs);
      if (!res.ok) {
        notice(`·· chat rejected: HTTP ${res.status}`);
        return;
      }
    } catch (e) {
      notice(`·· ${errMessage(e)}`);
      return;
    }
    const timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    spin.start();
    const outcome = await promise;
    clearTimeout(timer);
    spin.stop();
    if (outcome.kind === "reply") print(outcome.text);
    else if (outcome.kind === "timeout") notice(`·· no reply from jex within ${timeoutMs}ms`);
    else notice("·· interrupted");
  };

  const runCommand = async (line: string): Promise<void> => {
    const write = (s: string): void => { process.stdout.write(`${s}\n`); };
    const sp = line.indexOf(" ");
    const cmd = (sp === -1 ? line : line.slice(0, sp)).toLowerCase();
    const arg = sp === -1 ? "" : line.slice(sp + 1).trim();
    try {
      if (cmd === "/help") { write(HELP_TEXT); return; }
      if (cmd === "/mode") {
        if (!arg) {
          write(`mode ${(await getState(baseUrl, timeoutMs)).mode ?? "?"}`);
          return;
        }
        const res = await postJson(baseUrl, "/api/mode", { mode: arg }, timeoutMs);
        write(res.ok ? `mode → ${arg}` : `mode: rejected (HTTP ${res.status})`);
        return;
      }
      if (cmd === "/tasks") {
        const tasks = (await getState(baseUrl, timeoutMs)).tasks ?? [];
        if (!tasks.length) { write("(no tasks)"); return; }
        for (const t of tasks) write(`${t.status.padEnd(8)} ${t.title} (${t.id})`);
        return;
      }
      if (cmd === "/board") {
        const st = await getState(baseUrl, timeoutMs);
        const tasks = st.tasks ?? [];
        if (!tasks.length) { write("(no tasks)"); return; }
        write(renderBoard(tasks, st.now ?? Date.now()));
        return;
      }
      if (cmd === "/agenda") {
        if (arg && parseAgendaDate(arg) === null) { write("usage: /agenda [YYYY-MM-DD]"); return; }
        const st = await getState(baseUrl, timeoutMs);
        write(renderAgenda(st.tasks ?? [], st.now ?? Date.now(), arg || undefined));
        return;
      }
      if (cmd === "/mission") {
        if (!arg) { write("usage: /mission <text>"); return; }
        const res = await postJson(baseUrl, "/api/mission", { text: arg }, timeoutMs);
        write(res.ok ? "mission appended" : `mission: rejected (HTTP ${res.status})`);
        return;
      }
      if (cmd === "/budget") {
        write(`budget ${(await getState(baseUrl, timeoutMs)).budget?.line ?? "?"}`);
        return;
      }
      write(`unknown command: ${cmd} — try /help`);
    } catch (e) {
      write(`(error) ${errMessage(e)}`);
    }
  };

  const handleLine = async (raw: string): Promise<void> => {
    sigintArmed = false;
    const line = raw.trim();
    // Terminal readline already echoed "jex› <raw>"; rewrite it as you› <raw>.
    const echo = youEcho(raw);
    if (rl.terminal) process.stdout.write(`\r\x1b[2K${echo}\n`);
    else process.stdout.write(`${echo}\n`);
    if (!line) return;
    if (line.startsWith("/")) {
      await runCommand(line);
      return;
    }
    await sendChat(line);
  };

  // Serialize handlers: a pending reply wait (reply/timeout/Ctrl+C) finishes
  // before the next input line is processed.
  let queue: Promise<void> = Promise.resolve();
  rl.on("line", (raw) => {
    queue = queue
      .then(() => handleLine(raw))
      .catch((e) => notice(`·· ${errMessage(e)}`))
      .finally(() => { jexSink = null; waiting = null; rl.prompt(true); });
  });

  const shutdown = (code: number): void => {
    if (exiting) return;
    exiting = true;
    conn.stop();
    rl.close();
    process.exit(code);
  };
  rl.on("SIGINT", () => {
    // pending wait: the first press interrupts it and arms the exit so the
    // very next press — even before the wait unwinds — counts as the second
    // of two in a row and quits
    if (waiting) {
      if (sigintArmed) { shutdown(0); return; }
      waiting.interrupt();
      sigintArmed = true;
      return;
    }
    if (sigintArmed) { shutdown(0); return; } // two presses in a row quit
    sigintArmed = true;
    notice("·· press Ctrl+C again to exit");
    rl.prompt(true);
  });
  rl.on("close", () => shutdown(0)); // Ctrl-D

  rl.prompt();
  await new Promise<void>(() => { /* exits via signals */ });
}

// --------------------------------------------------------------------- main

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  const timeoutMs = Number(process.env.JEX_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  if (args.once) return runOnce(args.url, timeoutMs);
  await runInteractive(args.url, timeoutMs);
  return 0;
}

// run only when executed as the entry module (node dist/index.js), never on
// import; a pkg binary always runs as main (import.meta.url is unavailable)
const isMain = (() => {
  if ((process as NodeJS.Process & { pkg?: unknown }).pkg) return true;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href; }
  catch { return false; }
})();
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => { process.stderr.write(`(error) ${errMessage(e)}\n`); process.exit(1); });
}
