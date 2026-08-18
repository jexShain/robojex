// packages/takeoverd/test/hotkey.test.ts
import { parseXi2Chunk, ComboDetector } from "../src/hotkey.js";
import { expect, test } from "vitest";

test("parses RawKeyPress/RawKeyRelease blocks", () => {
  const chunk = `.RawKeyPress(…) 20:36:01
    detail: 50
  RawKeyRelease(…) 20:36:01
    detail: 50
`;
  const evs = parseXi2Chunk(chunk);
  expect(evs).toEqual([
    { type: "press", detail: 50 },
    { type: "release", detail: 50 },
  ]);
});

test("shift+ctrl press then release with no other key toggles", () => {
  const d = new ComboDetector();
  expect(d.feed({ type: "press", detail: 37 })).toBe(false);  // ctrl down
  expect(d.feed({ type: "press", detail: 50 })).toBe(false);  // shift down (combo armed)
  expect(d.feed({ type: "release", detail: 37 })).toBe(false);
  expect(d.feed({ type: "release", detail: 50 })).toBe(true); // both released -> toggle
});

test("other key between press and release cancels", () => {
  const d = new ComboDetector();
  d.feed({ type: "press", detail: 37 });
  d.feed({ type: "press", detail: 50 });
  d.feed({ type: "press", detail: 24 });   // 'q' sneaks in -> cancel
  expect(d.feed({ type: "release", detail: 37 })).toBe(false);
  expect(d.feed({ type: "release", detail: 50 })).toBe(false);
});

test("repeats do not double-toggle", () => {
  const d = new ComboDetector();
  d.feed({ type: "press", detail: 50 });
  d.feed({ type: "press", detail: 37 });
  expect(d.feed({ type: "release", detail: 50 })).toBe(false);
  expect(d.feed({ type: "release", detail: 37 })).toBe(true);
  expect(d.feed({ type: "release", detail: 37 })).toBe(false);
});
