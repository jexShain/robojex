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

async function xprintidleMs(): Promise<number> {
  const { stdout } = await pexec("xprintidle", []);
  return Number(stdout.trim());
}

export class InputInjector {
  private keyBuf = "";
  private idleWarned = false;
  constructor(private modes: ModeStateMachine, private deps: InjectorDeps = {}) {}

  private run(cmd: string, args: string[]): Promise<{ stdout: string }> {
    return (this.deps.execFn ?? pexec)(cmd, args);
  }

  // Append what this key would type: the space key contributes a real space
  // character, anything else its lowercased name; the window keeps the last
  // KEY_BUF_MAX chars (older keystrokes scroll off).
  private bufferKey(k: string): void {
    this.keyBuf += k.toLowerCase() === "space" ? " " : k.toLowerCase();
    if (this.keyBuf.length > KEY_BUF_MAX) this.keyBuf = this.keyBuf.slice(this.keyBuf.length - KEY_BUF_MAX);
  }

  // null means "unknown, skip the check" — a missing xprintidle (ENOENT)
  // degrades to no preemption, logged once; any other failure still throws.
  private async idleMs(): Promise<number | null> {
    try {
      const ms = await (this.deps.idleFn ?? xprintidleMs)();
      return Number.isFinite(ms) ? ms : null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        if (!this.idleWarned) {
          this.idleWarned = true;
          console.warn("[takeoverd] xprintidle not found: human-preemption check disabled");
        }
        return null;
      }
      throw e;
    }
  }

  async exec(a: InputAction, approved = false): Promise<"done" | "blocked-observe" | "blocked-hard" | "needs-approval" | "human-active"> {
    if (!this.modes.canInject()) return "blocked-observe"; // observe: refuse at the gate
    if (a.kind === "key" && a.key) this.bufferKey(a.key);
    else this.keyBuf = ""; // type/click/move break any assembled sequence
    const risk = classifyRisk(a); // single action first...
    if (risk === "hard" || HARD_PATTERNS.some((re) => re.test(this.keyBuf))) return "blocked-hard"; // ...then the buffered join
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
    return "done";
  }
}
