// packages/takeoverd/src/hotkey.ts
import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "node:net";

// X keycode: 37=CtrlL 105=CtrlR 50=ShiftL 62=ShiftR
const CTRL = new Set([37, 105]);
const SHIFT = new Set([50, 62]);

export type XiEvent = { type: "press" | "release"; detail: number };

export function parseXi2Chunk(chunk: string): XiEvent[] {
  const out: XiEvent[] = [];
  // Real `xinput test-xi2 --root` output (blocks separated by blank lines):
  //   EVENT type 24 (RawKeyPress)
  //     device: 3 (11)
  //     detail: 50
  //     valuators:
  // Anchor on the "RawKey*" header so non-raw events (e.g. "(KeyPress)"),
  // which carry the same indented "detail:" lines, are ignored. The lazy
  // repetition skips intermediate "key: value" lines (device/time/valuators)
  // between the header and its "detail:" line.
  const re = /EVENT type \d+ \(RawKey(Press|Release)\)\n(?:[ ]+\w+:[^\n]*\n)*?[ ]+detail: (\d+)/g;
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
  private stopping = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  onToggle(cb: () => void): void { this.cbs.push(cb); }
  start(): void {
    this.stop();
    this.stopping = false;
    this.restartAttempts = 0;
    this.spawnProc();
  }
  stop(): void {
    this.stopping = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.proc?.kill("SIGTERM");
    this.proc = null;
  }
  private spawnProc(): void {
    const proc = spawn("xinput", ["test-xi2", "--root"], { stdio: ["ignore", "pipe", "ignore"] });
    this.proc = proc;
    let buf = "";
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (d: string) => {
      buf += d;
      // xinput emits event blocks separated by blank lines
      const blocks = buf.split(/\n\s*\n/);
      buf = blocks.pop() ?? "";
      for (const b of blocks) {
        for (const ev of parseXi2Chunk(b)) {
          if (this.detector.feed(ev)) {
            // One misbehaving listener must not take down the daemon.
            for (const cb of this.cbs) {
              try { cb(); } catch { /* isolated per-listener */ }
            }
          }
        }
      }
    });
    // Failed spawns (e.g. xinput missing -> ENOENT) surface as an async
    // 'error' event; without a listener Node rethrows it uncaught.
    proc.on("error", (e) => {
      if (this.proc === proc) this.proc = null;
      const isEnoent = (e as NodeJS.ErrnoException)?.code === "ENOENT";
      if (isEnoent && !this.stopping) {
        console.warn("[takeoverd] xinput unavailable: hotkey toggle (Ctrl+Shift) disabled");
      }
    });
    proc.on("exit", () => {
      if (this.proc !== proc) return; // stale exit from an already-replaced proc
      this.proc = null;
      if (this.stopping) return;      // deliberate stop, no restart
      // xinput died unexpectedly (X restart, crash): retry with exponential
      // backoff capped at 30s so the watcher never silently stays dead.
      const delay = Math.min(30_000, 1000 * 2 ** this.restartAttempts);
      this.restartAttempts += 1;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.spawnProc();
      }, delay);
    });
    // unref both: the open stdout pipe alone would keep the event loop alive.
    proc.unref();
    (proc.stdout as Socket | null)?.unref();
  }
}
