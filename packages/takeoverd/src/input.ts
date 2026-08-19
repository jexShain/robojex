// packages/takeoverd/src/input.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ModeStateMachine } from "./modes.js";
const pexec = promisify(execFile);

export type InputAction = {
  kind: "key" | "move" | "click" | "type";
  key?: string; x?: number; y?: number; button?: "left" | "right";
  text?: string; risk?: "high";
};

const HIGH_KEYS = new Set(["Return", "KP_Enter", "Delete", "BackSpace"]);
const HARD_PATTERNS = [/\brm\s+-[rf]{2}/, /\bsudo\b/];

export type Risk = "low" | "high" | "hard";
// xdotool type turns \n/\r/\t into real Return/Tab keypresses — treat them as keystrokes, not text
const CONTROL_CHARS = /[\n\r\t]/;

export function classifyRisk(a: InputAction): Risk {
  const text = a.kind === "type" ? a.text : undefined;
  if (text && HARD_PATTERNS.some((re) => re.test(text))) return "hard";
  if (a.risk === "high") return "high";
  if (text && CONTROL_CHARS.test(text)) return "high";
  // combo keys like "ctrl+Return" must not smuggle a high-risk member through
  if (a.kind === "key" && a.key && a.key.split("+").some((k) => HIGH_KEYS.has(k))) return "high";
  return "low";
}

// Test seams: idle query and low-level exec are overridable per injector so
// tests never touch a real display or depend on installed tools.
export interface InjectorDeps {
  idleFn?: () => Promise<number>; // ms since the last real user input
  execFn?: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
}

const KEY_BUF_MAX = 32; // rolling window of what recent keystrokes would type
const HUMAN_ACTIVE_MS = 2000; // human touched input within the last 2s -> back off

// Keys that steer focus or end a line: they never put text on it.
const NO_TEXT_KEYS: Record<string, true> = { tab: true, return: true, kp_enter: true };
// Modifier names xdotool accepts, lowercased, incl. bare L/R keysyms (control_l...).
const MODIFIERS = new Set<string>();
for (const base of ["ctrl", "control", "shift", "alt", "meta", "super", "hyper"]) {
  MODIFIERS.add(base);
  MODIFIERS.add(`${base}_l`);
  MODIFIERS.add(`${base}_r`);
}
// Key names that must join the window as the character they actually type.
const KEY_NAMES: Record<string, string> = {
  space: " ", minus: "-", kp_subtract: "-", slash: "/", period: ".",
  comma: ",", semicolon: ";", equal: "=",
};
for (let d = 0; d <= 9; d++) KEY_NAMES[`kp_${d}`] = String(d);

// Append what an action types, keeping only the last KEY_BUF_MAX chars
// (older keystrokes scroll off the window).
function pushText(buf: string, text: string): string {
  const joined = buf + text;
  return joined.length > KEY_BUF_MAX ? joined.slice(joined.length - KEY_BUF_MAX) : joined;
}

// The window after key `raw` lands on `buf`: BackSpace eats the last char
// (nothing to eat on an empty buffer), Tab/Return-family keys and any combo —
// modifiers alone never type — add nothing, every other single key joins as
// its mapped character or lowercased name.
function applyKey(buf: string, raw: string): string {
  const k = raw.toLowerCase();
  if (k === "backspace") return buf.slice(0, -1);
  if (NO_TEXT_KEYS[k] || k.includes("+") || MODIFIERS.has(k)) return buf;
  return pushText(buf, KEY_NAMES[k] ?? k);
}

async function xprintidleMs(): Promise<number> {
  const { stdout } = await pexec("xprintidle", [], { timeout: 1000 });
  return Number(stdout.trim());
}

export class InputInjector {
  private keyBuf = "";
  private idleWarned = false;
  constructor(private modes: ModeStateMachine, private deps: InjectorDeps = {}) {}

  private run(cmd: string, args: string[]): Promise<{ stdout: string }> {
    return (this.deps.execFn ?? pexec)(cmd, args);
  }

  // null means "unknown, skip the check" — a missing (ENOENT), hanging or
  // otherwise failing xprintidle degrades to no preemption instead of failing
  // every injection; either way it is logged once.
  private async idleMs(): Promise<number | null> {
    try {
      const ms = await (this.deps.idleFn ?? xprintidleMs)();
      return Number.isFinite(ms) ? ms : null;
    } catch (e) {
      if (!this.idleWarned) {
        this.idleWarned = true;
        const why = (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message;
        console.warn(`[takeoverd] xprintidle unavailable (${why}): human-preemption check disabled`);
      }
      return null;
    }
  }

  async exec(a: InputAction, approved = false): Promise<"done" | "blocked-observe" | "blocked-hard" | "needs-approval" | "human-active"> {
    if (!this.modes.canInject()) return "blocked-observe"; // observe: refuse at the gate
    // Candidate window: what it would read if this action really landed —
    // keys go through applyKey, type appends its text, click/move change
    // nothing. It is committed only after injection succeeds, so blocked or
    // refused actions leave the window exactly as it was.
    let candidate = this.keyBuf;
    if (a.kind === "key" && a.key) candidate = applyKey(candidate, a.key);
    else if (a.kind === "type" && a.text) candidate = pushText(candidate, a.text);
    const risk = classifyRisk(a); // single action first...
    if (risk === "hard" || HARD_PATTERNS.some((re) => re.test(candidate))) return "blocked-hard"; // ...then the buffered join
    // approval already granted by the caller (server approval flow): skip only this branch
    if (!approved && risk === "high" && this.modes.needsApproval()) return "needs-approval";
    // assist shares the machine with a human: while they are actively typing
    // or moving, the AI must not inject and fight over focus
    if (this.modes.needsApproval()) {
      const idle = await this.idleMs();
      if (idle !== null && idle < HUMAN_ACTIVE_MS) return "human-active";
    }
    switch (a.kind) {
      case "key": await this.run("xdotool", ["key", a.key!]); break;
      case "move": await this.run("xdotool", ["mousemove", String(a.x), String(a.y)]); break;
      case "click": await this.run("xdotool", ["click", a.button === "right" ? "3" : "1"]); break;
      case "type": await this.run("xdotool", ["type", "--", a.text!]); break;
    }
    // a submitted line is gone: Return/KP_Enter restart the window from empty
    this.keyBuf = a.kind === "key" && (a.key === "Return" || a.key === "KP_Enter") ? "" : candidate;
    return "done";
  }
}
