// packages/ceo-core/test/timeout.test.ts
import { clampTimeout, createDeadline, createIdleWatchdog } from "../src/timeout.js";
import { expect, test, vi } from "vitest";

/* ───────────────── clampTimeout ───────────────── */

test("clampTimeout: defaults on absent/garbage hints, caps oversize hints", () => {
  expect(clampTimeout(undefined, 10, 100)).toBe(10); // absent → default
  expect(clampTimeout(NaN, 10, 100)).toBe(10); // non-finite → default (not the cap)
  expect(clampTimeout(Infinity, 10, 100)).toBe(10); // non-finite → default (not the cap)
  expect(clampTimeout(0, 10, 100)).toBe(10); // zero is not a "disable" sentinel
  expect(clampTimeout(-5, 10, 100)).toBe(10); // negative → default
  expect(clampTimeout("30", 10, 100)).toBe(10); // untyped config garbage → default
  expect(clampTimeout(50, 10, 100)).toBe(50); // sane hint honored
  expect(clampTimeout(150, 10, 100)).toBe(100); // cap wins
});

/* ───────────────── createDeadline ───────────────── */

test("createDeadline: timer wins → signal aborts, timedOut() true, TimeoutError reason", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const d = createDeadline(5_000);
    expect(d.signal.aborted).toBe(false);
    expect(d.timedOut()).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999); // one tick short
    expect(d.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.signal.aborted).toBe(true);
    expect(d.timedOut()).toBe(true);
    expect((d.signal.reason as Error).name).toBe("TimeoutError");
  } finally {
    vi.useRealTimers();
  }
});

test("createDeadline: external abort wins the race → timedOut() stays false, reason forwarded", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const ctl = new AbortController();
    const d = createDeadline(60_000, ctl.signal);
    ctl.abort("user stop");
    expect(d.signal.aborted).toBe(true);
    expect(d.timedOut()).toBe(false); // caller cancel, not a timeout
    expect(d.signal.reason).toBe("user stop"); // fused from the external signal, not synthesized
    vi.advanceTimersByTime(120_000); // even after the would-be timeout
    expect(d.timedOut()).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("createDeadline: already-aborted external signal aborts the fused signal immediately", () => {
  const ctl = new AbortController();
  ctl.abort();
  const d = createDeadline(60_000, ctl.signal);
  expect(d.signal.aborted).toBe(true);
  expect(d.timedOut()).toBe(false);
  d.dispose();
});

test("createDeadline: dispose disarms the timer (idempotent)", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const d = createDeadline(5_000);
    d.dispose();
    d.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.signal.aborted).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("createDeadline: external listener detached on dispose (no leak, no late abort)", () => {
  const ctl = new AbortController();
  const d = createDeadline(60_000, ctl.signal);
  d.dispose();
  ctl.abort(); // after dispose it must not reach the (settled) fused signal
  expect(d.signal.aborted).toBe(false);
});

/* ───────────────── createIdleWatchdog ───────────────── */

test("createIdleWatchdog: armed at creation — a zero-byte hang is caught without any touch", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let fires = 0;
    const w = createIdleWatchdog(1_000, () => { fires++; });
    vi.advanceTimersByTime(999);
    expect(fires).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fires).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("createIdleWatchdog: touch resets the countdown; fires exactly once; a fired watchdog stays spent", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let fires = 0;
    const w = createIdleWatchdog(1_000, () => { fires++; });
    vi.advanceTimersByTime(999);
    w.touch(); // progress at the last moment: full re-arm
    vi.advanceTimersByTime(999);
    expect(fires).toBe(0); // survived — the countdown restarted
    w.touch();
    vi.advanceTimersByTime(999);
    w.touch();
    vi.advanceTimersByTime(1_000);
    expect(fires).toBe(1); // fired once…
    w.touch(); // …and never re-arms
    vi.advanceTimersByTime(10_000);
    expect(fires).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("createIdleWatchdog: stop clears the pending timer; a throwing onFire cannot crash the caller", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let fires = 0;
    const w = createIdleWatchdog(1_000, () => { fires++; });
    w.stop();
    w.stop(); // idempotent
    vi.advanceTimersByTime(60_000);
    expect(fires).toBe(0);

    const boom = createIdleWatchdog(1_000, () => { throw new Error("boom"); });
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow(); // swallowed in the timer callback
    boom.stop();
  } finally {
    vi.useRealTimers();
  }
});
