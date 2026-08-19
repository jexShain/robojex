// packages/takeoverd/test/screen.test.ts
import { phash, hamming, grabGrayText, grabOcrText, ScreenPipeline, type DiffEvent } from "../src/screen.js";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

const N = 32;
function flat(v: number): Uint8Array { return new Uint8Array(N * N).fill(v); }

test("identical images -> hamming 0", () => {
  const h1 = phash(flat(128), N), h2 = phash(flat(128), N);
  expect(hamming(h1, h2)).toBe(0);
});
test("different images -> hamming > 0", () => {
  const a = flat(10); const b = flat(200);
  expect(hamming(phash(a, N), phash(b, N))).toBeGreaterThan(0);
});
test("structured vs inverted differs strongly", () => {
  const a = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) a[y * N + x] = x * 8;
  const b = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) b[y * N + x] = 255 - x * 8;
  expect(hamming(phash(a, N), phash(b, N))).toBeGreaterThan(10);
});
test("grabGrayText parses ImageMagick txt:- output", () => {
  const txt = "32x32\n0,0: (30%)\n1,0: (50%)\n";
  const g = grabGrayText(txt, 2, 1);
  expect(Array.from(g)).toEqual([77, 127]); // 0.30*255≈77, 0.50*255≈127
});

test("setPolling(false) halts interval polling; setPolling(true) resumes it", async () => {
  vi.useFakeTimers();
  try {
    class CountingPipeline extends ScreenPipeline {
      polls = 0;
      async pollOnce(): Promise<null> { this.polls++; return null; }
    }
    const p = new CountingPipeline();
    p.start(10);
    await vi.advanceTimersByTimeAsync(35);
    expect(p.polls).toBeGreaterThanOrEqual(2);
    p.setPolling(false);
    const halted = p.polls;
    await vi.advanceTimersByTimeAsync(35);
    expect(p.polls).toBe(halted);
    p.setPolling(true);
    await vi.advanceTimersByTimeAsync(25);
    expect(p.polls).toBeGreaterThan(halted);
    p.stop();
  } finally {
    vi.useRealTimers();
  }
});

// ---- optional OCR (tesseract): fake-binary fixtures shadowing PATH ----
// The fakes keep tests off a real display and off a real tesseract install.
// `tesseractScript` omitted = no tesseract on PATH (ENOENT path).
function makeOcrBin(tesseractScript?: string): string {
  const bin = mkdtempSync(join(tmpdir(), "robojex-ocrbin-"));
  const state = join(bin, "flip");
  // fake `import`: txt:- dumps alternating single-pixel frames (drives the
  // hamming diff); png:<path> writes a dummy image for the OCR pass.
  writeFileSync(join(bin, "import"), `#!/bin/sh
case "$*" in
  *txt:*)
    if [ -f "${state}" ]; then rm -f "${state}"; printf '31,31: (90%%)\\n'
    else : > "${state}"; printf '0,0: (90%%)\\n'; fi ;;
  *) printf 'PNGDATA' > "\${3#png:}" ;;
esac
`);
  chmodSync(join(bin, "import"), 0o755);
  if (tesseractScript !== undefined) {
    writeFileSync(join(bin, "tesseract"), tesseractScript);
    chmodSync(join(bin, "tesseract"), 0o755);
  }
  return bin;
}

test("grabOcrText: fake tesseract fixture recognizes the captured frame", async () => {
  const bin = makeOcrBin(`#!/bin/sh\nprintf '${"A".repeat(600)}'\n`);
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath ?? ""}`;
  try {
    expect(await grabOcrText()).toBe("A".repeat(600));
  } finally {
    process.env.PATH = prevPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("grabOcrText: tesseract missing -> null, never a throw", async () => {
  const bin = makeOcrBin(); // import present, tesseract absent -> ENOENT
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath ?? ""}`;
  try {
    expect(await grabOcrText()).toBeNull();
  } finally {
    process.env.PATH = prevPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("pollOnce attaches ocrText (first 500 chars) to diff events when OCR answers", async () => {
  const bin = makeOcrBin(`#!/bin/sh\nprintf '${"B".repeat(600)}'\n`);
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath ?? ""}`;
  try {
    const p = new ScreenPipeline(1);
    const events: DiffEvent[] = [];
    p.onEvent((e) => events.push(e));
    await p.pollOnce();          // frame A: arms prev, no diff yet
    const e2 = await p.pollOnce(); // frame B: pixel moved -> diff -> OCR attached
    expect(e2?.type).toBe("screen_diff");
    expect(e2?.ocrText).toBe("B".repeat(500)); // capped at 500 chars
    expect(events).toHaveLength(1);
    expect(events[0]?.ocrText).toBe("B".repeat(500));
  } finally {
    process.env.PATH = prevPath;
    rmSync(bin, { recursive: true, force: true });
  }
});
