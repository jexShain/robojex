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
export function classifyRisk(a: InputAction): Risk {
  if (a.kind === "type" && a.text && HARD_PATTERNS.some((re) => re.test(a.text))) return "hard";
  if (a.risk === "high") return "high";
  if (a.kind === "key" && a.key && HIGH_KEYS.has(a.key)) return "high";
  return "low";
}

export class InputInjector {
  constructor(private modes: ModeStateMachine) {}
  async exec(a: InputAction): Promise<"done" | "blocked-observe" | "blocked-hard" | "needs-approval"> {
    if (!this.modes.canInject()) return "blocked-observe"; // observe: refuse at the gate
    const risk = classifyRisk(a);
    if (risk === "hard") return "blocked-hard";
    if (risk === "high" && this.modes.needsApproval()) return "needs-approval";
    switch (a.kind) {
      case "key": await pexec("xdotool", ["key", a.key!]); break;
      case "move": await pexec("xdotool", ["mousemove", String(a.x), String(a.y)]); break;
      case "click": await pexec("xdotool", ["click", a.button === "right" ? "3" : "1"]); break;
      case "type": await pexec("xdotool", ["type", "--", a.text!]); break;
    }
    return "done";
  }
}
