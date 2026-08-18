// packages/takeoverd/test/screen.test.ts
import { phash, hamming, grabGrayText } from "../src/screen.js";
import { expect, test } from "vitest";

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
