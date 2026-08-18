// packages/takeoverd/test/hotkey.test.ts
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseXi2Chunk, ComboDetector, HotkeyWatcher } from "../src/hotkey.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const spawnMock = vi.mocked(spawn);

/** EventEmitter stand-in exposing the stdout surface HotkeyWatcher uses. */
class FakeStdout extends EventEmitter {
  setEncoding = vi.fn();
  unref = vi.fn();
}

/** EventEmitter stand-in exposing the ChildProcess surface HotkeyWatcher uses. */
class FakeProc extends EventEmitter {
  stdout = new FakeStdout();
  kill = vi.fn(() => true);
  unref = vi.fn();
}

/** Queue the next spawn() return value and hand it to the test. */
function nextProc(): FakeProc {
  const p = new FakeProc();
  spawnMock.mockReturnValueOnce(p as unknown as ChildProcess);
  return p;
}

test("parses real xinput test-xi2 event blocks", () => {
  // Verbatim shape of `xinput test-xi2 --root` output: an "EVENT type N (...)"
  // header followed by indented "key: value" lines, blocks separated by blank
  // lines. The non-raw (KeyPress) block shares the detail line format and must
  // be ignored.
  const chunk = [
    "EVENT type 2 (KeyPress)",
    "  device: 3 (11)",
    "  time: 1692330531.123",
    "  detail: 50",
    "  root: 0x5b1",
    "",
    "EVENT type 24 (RawKeyPress)",
    "  device: 3 (11)",
    "  time: 1692330531.123",
    "  detail: 50",
    "  valuators:",
    "",
    "EVENT type 25 (RawKeyRelease)",
    "  device: 3 (11)",
    "  detail: 50",
    "  valuators:",
    "",
  ].join("\n");
  expect(parseXi2Chunk(chunk)).toEqual([
    { type: "press", detail: 50 },
    { type: "release", detail: 50 },
  ]);
});

test("parses a block whose detail line is last (no trailing newline)", () => {
  // HotkeyWatcher splits blocks on blank lines, so a block may end right
  // after its detail line without a trailing newline.
  expect(parseXi2Chunk("EVENT type 24 (RawKeyPress)\n  device: 3 (11)\n  detail: 37")).toEqual([
    { type: "press", detail: 37 },
  ]);
});

test("ignores non-raw key events entirely", () => {
  const chunk = "EVENT type 2 (KeyPress)\n  device: 3 (11)\n  time: 1692330531.123\n  detail: 37\n";
  expect(parseXi2Chunk(chunk)).toEqual([]);
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

describe("HotkeyWatcher", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("start() wires stdout and unrefs both the proc and its stdout pipe", () => {
    const w = new HotkeyWatcher();
    const p = nextProc();
    w.start();
    expect(spawnMock).toHaveBeenCalledWith(
      "xinput", ["test-xi2", "--root"], { stdio: ["ignore", "pipe", "ignore"] },
    );
    expect(p.stdout.setEncoding).toHaveBeenCalledWith("utf8");
    expect(p.unref).toHaveBeenCalled();
    expect(p.stdout.unref).toHaveBeenCalled();
  });

  test("a spawn 'error' event (e.g. ENOENT) is swallowed instead of crashing", () => {
    const w = new HotkeyWatcher();
    const p = nextProc();
    w.start();
    // EventEmitter rethrows synchronously on 'error' with no listener, which
    // in production surfaces as an uncaught exception killing the daemon.
    expect(() => p.emit("error", new Error("spawn xinput ENOENT"))).not.toThrow();
  });

  test("feeds real-format stdout blocks to the detector and isolates failing callbacks", () => {
    const w = new HotkeyWatcher();
    const p = nextProc();
    const boom = vi.fn(() => { throw new Error("listener bug"); });
    const ok = vi.fn();
    w.onToggle(boom);
    w.onToggle(ok);
    w.start();
    p.stdout.emit(
      "data",
      "EVENT type 24 (RawKeyPress)\n  device: 3 (11)\n  detail: 37\n  valuators:\n" +
        "\nEVENT type 24 (RawKeyPress)\n  device: 3 (11)\n  detail: 50\n  valuators:\n" +
        "\nEVENT type 25 (RawKeyRelease)\n  device: 3 (11)\n  detail: 37\n  valuators:\n" +
        "\nEVENT type 25 (RawKeyRelease)\n  device: 3 (11)\n  detail: 50\n  valuators:\n\n",
    );
    expect(boom).toHaveBeenCalledTimes(1); // invoked, but its throw was contained
    expect(ok).toHaveBeenCalledTimes(1);   // second listener still ran
  });

  test("unexpected exit restarts xinput with exponential backoff capped at 30s", () => {
    const w = new HotkeyWatcher();
    let p = nextProc();
    w.start();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    p.emit("exit", 1, "SIGKILL");
    p = nextProc();
    vi.advanceTimersByTime(999);
    expect(spawnMock).toHaveBeenCalledTimes(1); // 1s backoff not yet elapsed
    vi.advanceTimersByTime(1);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    p.emit("exit", 1, "SIGKILL");
    p = nextProc();
    vi.advanceTimersByTime(1999);
    expect(spawnMock).toHaveBeenCalledTimes(2); // 2s backoff
    vi.advanceTimersByTime(1);
    expect(spawnMock).toHaveBeenCalledTimes(3);

    for (const delay of [4000, 8000, 16000]) {
      p.emit("exit", 1, "SIGKILL");
      p = nextProc();
      vi.advanceTimersByTime(delay);
    }
    expect(spawnMock).toHaveBeenCalledTimes(6);

    // 2^5 * 1s = 32s uncapped; the cap must clamp it to 30s and fire on time.
    p.emit("exit", 1, "SIGKILL");
    p = nextProc();
    vi.advanceTimersByTime(30_000);
    expect(spawnMock).toHaveBeenCalledTimes(7);
    // Stable process: no further restarts.
    vi.advanceTimersByTime(120_000);
    expect(spawnMock).toHaveBeenCalledTimes(7);
  });

  test("stop() kills the running process and suppresses any restart", () => {
    const w = new HotkeyWatcher();
    const p = nextProc();
    w.start();
    w.stop();
    expect(p.kill).toHaveBeenCalledWith("SIGTERM");
    p.emit("exit", null, "SIGTERM"); // exit caused by our own kill
    vi.advanceTimersByTime(120_000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test("stop() cancels an already scheduled backoff restart", () => {
    const w = new HotkeyWatcher();
    const p = nextProc();
    w.start();
    p.emit("exit", 1, "SIGKILL"); // schedules a 1s restart
    w.stop();
    vi.advanceTimersByTime(120_000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
