// packages/takeoverd/src/hotkey.ts
import { spawn, type ChildProcess } from "node:child_process";

// X keycode: 37=CtrlL 105=CtrlR 50=ShiftL 62=ShiftR
const CTRL = new Set([37, 105]);
const SHIFT = new Set([50, 62]);

export type XiEvent = { type: "press" | "release"; detail: number };

export function parseXi2Chunk(chunk: string): XiEvent[] {
  const out: XiEvent[] = [];
  const re = /RawKey(Press|Release)\([^)]*\)[^\n]*\n\s*detail:\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    out.push({ type: m[1] === "Press" ? "press" : "release", detail: Number(m[2]) });
  }
  return out;
}

export class ComboDetector {
  private ctrl = false; private shift = false; private armed = false;
  feed(e: XiEvent): boolean {
    const isCtrl = CTRL.has(e.detail), isShift = SHIFT.has(e.detail);
    if (!isCtrl && !isShift) { // any non-modifier key cancels an armed combo
      if (e.type === "press" && this.armed) { this.ctrl = false; this.shift = false; this.armed = false; }
      return false;
    }
    if (isCtrl) this.ctrl = e.type === "press";
    if (isShift) this.shift = e.type === "press";
    if (this.ctrl && this.shift) this.armed = true;
    if (this.armed && !this.ctrl && !this.shift) { this.armed = false; return true; }
    return false;
  }
}

export class HotkeyWatcher {
  private proc: ChildProcess | null = null;
  private detector = new ComboDetector();
  private cbs: (() => void)[] = [];
  onToggle(cb: () => void): void { this.cbs.push(cb); }
  start(): void {
    this.stop();
    this.proc = spawn("xinput", ["test-xi2", "--root"], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (d: string) => {
      buf += d;
      // xinput emits event blocks separated by blank lines
      const blocks = buf.split(/\n\s*\n/);
      buf = blocks.pop() ?? "";
      for (const b of blocks) {
        for (const ev of parseXi2Chunk(b)) {
          if (this.detector.feed(ev)) for (const cb of this.cbs) cb();
        }
      }
    });
    this.proc.on("exit", () => { this.proc = null; });
    this.proc.unref();
  }
  stop(): void { this.proc?.kill("SIGTERM"); this.proc = null; }
}
