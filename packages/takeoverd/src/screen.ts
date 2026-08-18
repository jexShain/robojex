// packages/takeoverd/src/screen.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

export async function grabGray(w: number, h: number, display = process.env.DISPLAY): Promise<Uint8Array> {
  // ImageMagick import: capture root window, downscale, grayscale, text dump.
  const { stdout } = await pexec("import", ["-window", "root", "-resize", `${w}x${h}!`, "-colorspace", "gray", "txt:-"], { env: { ...process.env, DISPLAY: display ?? ":0" }, maxBuffer: 1 << 22 });
  return grabGrayText(stdout, w, h);
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

type DiffEvent = { type: "screen_diff"; hamming: number; ts: number };

export class ScreenPipeline {
  private timer: NodeJS.Timeout | null = null;
  private prev: bigint | null = null;
  private last: bigint | null = null;
  private cbs: ((e: DiffEvent) => void)[] = [];
  constructor(private threshold = 10) {}
  onEvent(cb: (e: DiffEvent) => void): void { this.cbs.push(cb); }
  lastHash(): bigint { return this.last ?? 0n; }
  async pollOnce(): Promise<DiffEvent | null> {
    const g = await grabGray(32, 32);
    const h = phash(g, 32);
    this.last = h;
    if (this.prev !== null) {
      const d = hamming(this.prev, h);
      if (d >= this.threshold) {
        const e: DiffEvent = { type: "screen_diff", hamming: d, ts: Date.now() };
        for (const cb of this.cbs) cb(e);
        this.prev = h;
        return e;
      }
    }
    this.prev = h;
    return null;
  }
  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => { this.pollOnce().catch(() => {}); }, intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
