// packages/takeoverd/src/screen.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const pexec = promisify(execFile);

// Parse ImageMagick "txt:-" gray output: "x,y: (NN%)" or "x,y: (NN)" 0-255.
export function grabGrayText(txt: string, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const re = /^(\d+),(\d+):\s*\(([\d.]+)(%?)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt)) !== null) {
    const v = m[4] === "%" ? Math.round(parseFloat(m[3]) * 2.55) : Math.round(parseFloat(m[3]));
    out[Number(m[2]) * w + Number(m[1])] = Math.max(0, Math.min(255, v));
  }
  return out;
}

// Whether the ImageMagick `import` binary is known missing on this host.
let grabWarned = false;
export function grabGrayLastFailureWasEnoent(): boolean { return grabWarned; }

export async function grabGray(w: number, h: number, display = process.env.DISPLAY): Promise<Uint8Array> {
  try {
    // ImageMagick import: capture root window, downscale, grayscale, text dump.
    const { stdout } = await pexec("import", ["-window", "root", "-resize", `${w}x${h}!`, "-colorspace", "gray", "txt:-"], { env: { ...process.env, DISPLAY: display ?? ":0" }, maxBuffer: 1 << 22 });
    return grabGrayText(stdout, w, h);
  } catch (e) {
    const isEnoent = (e as NodeJS.ErrnoException)?.code === "ENOENT";
    if (isEnoent && !grabWarned) {
      grabWarned = true;
      console.warn("[takeoverd] ImageMagick import unavailable: screen capture disabled");
    }
    throw e; // re-raise so the caller (pollOnce) can .catch(() => {})
  }
}

// Capture the root window as a PNG temp file and run tesseract over it.
// Returns the recognized text, or null when OCR is unavailable on this host.
let ocrWarned = false;
let lastOcrFailureWasEnoent = false;
export async function grabOcrText(display = process.env.DISPLAY): Promise<string | null> {
  const env = { ...process.env, DISPLAY: display ?? ":0" };
  const png = join(tmpdir(), `robojex-ocr-${randomUUID()}.png`);
  let stage = "import";
  try {
    await pexec(stage, ["-window", "root", `png:${png}`], { env, maxBuffer: 1 << 22 });
    stage = "tesseract";
    const { stdout } = await pexec(stage, [png, "stdout"], { env, maxBuffer: 1 << 22 });
    lastOcrFailureWasEnoent = false;
    return stdout.trim();
  } catch (e) {
    // OCR is optional machinery: a missing binary must degrade to "no text",
    // never to a crashed poller. Warn once per process, then stay silent-null.
    const isEnoent = (e as NodeJS.ErrnoException)?.code === "ENOENT";
    if (isEnoent) lastOcrFailureWasEnoent = true;
    if (isEnoent && !ocrWarned) {
      ocrWarned = true;
      console.warn(`[takeoverd] ${stage} unavailable: OCR text capture disabled`);
    }
    return null;
  } finally {
    rmSync(png, { force: true });
  }
}

// Exported helper: did the most recent grabOcrText failure come from ENOENT?
export function grabOcrLastFailureWasEnoent(): boolean {
  return lastOcrFailureWasEnoent;
}

// 32x32 gray -> 2D DCT-II -> top-left 8x8 coeffs (skip DC) -> median threshold -> 64-bit hash
export function phash(g: Uint8Array, n: number): bigint {
  const cos: number[][] = [];
  for (let k = 0; k < 8; k++) { cos[k] = []; for (let x = 0; x < n; x++) cos[k][x] = Math.cos(((2 * x + 1) * k * Math.PI) / (2 * n)); }
  const coef: number[] = [];
  for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
    let s = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) s += g[y * n + x] * cos[u][y] * cos[v][x];
    coef.push(s);
  }
  const window = coef.slice(1); // drop DC
  const sorted = [...window].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  let h = 0n;
  for (let i = 0; i < 64; i++) if (window[i] > med) h |= 1n << BigInt(63 - i);
  return h;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b, c = 0;
  while (x) { c += Number(x & 1n); x >>= 1n; }
  return c;
}

export type DiffEvent = { type: "screen_diff"; hamming: number; ts: number; ocrText?: string };

export class ScreenPipeline {
  private timer: NodeJS.Timeout | undefined;
  private intervalMs: number | null = null;
  private prev: bigint | null = null;
  private last: bigint | null = null;
  private ocrUsable: boolean | null = null; // null = never tried, false = binary known missing
  private cbs: ((e: DiffEvent) => void)[] = [];
  constructor(private threshold = 10) {}
  onEvent(cb: (e: DiffEvent) => void): void { this.cbs.push(cb); }
  lastHash(): bigint { return this.last ?? 0n; }
  async pollOnce(): Promise<DiffEvent | null> {
    let g: Uint8Array;
    try {
      g = await grabGray(32, 32);
    } catch {
      return null; // ImageMagick import missing or display error
    }
    const h = phash(g, 32);
    this.last = h;
    if (this.prev !== null) {
      const d = hamming(this.prev, h);
      if (d >= this.threshold) {
        const e: DiffEvent = { type: "screen_diff", hamming: d, ts: Date.now() };
        // OCR rides the diff event only while tesseract answers; once a
        // binary is known missing it must not respawn per poll.
        if (this.ocrUsable !== false) {
          const text = await grabOcrText();
          if (text === null && grabOcrLastFailureWasEnoent()) this.ocrUsable = false;
          else if (text) e.ocrText = text.slice(0, 500);
        }
        for (const cb of this.cbs) cb(e);
        this.prev = h;
        return e;
      }
    }
    this.prev = h;
    return null;
  }
  // Boot arms continuous polling — the daemon starts in observe, where screen
  // diffs are the wake signal.
  start(intervalMs: number): void {
    this.intervalMs = intervalMs;
    this.setPolling(true);
  }
  // Polling is observe-only: in assist/full the daemon captures a frame solely
  // when jex asks (screenshot op), instead of burning CPU at 1 fps.
  setPolling(enabled: boolean): void {
    this.stop();
    if (enabled && this.intervalMs !== null) {
      this.timer = setInterval(() => { this.pollOnce().catch(() => {}); }, this.intervalMs);
      this.timer.unref();
    }
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; }
}
