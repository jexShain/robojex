// packages/takeoverd/test/server.test.ts
import { TakeoverServer } from "../src/server.js";
import { ModeStateMachine } from "../src/modes.js";
import type { CdpChannel } from "../src/cdp.js";
import type { InputInjector } from "../src/input.js";
import WebSocket from "ws";
import { expect, test, afterEach, vi } from "vitest";

let server: TakeoverServer | null = null;
afterEach(async () => { await server?.stop(); server = null; });

function connect(): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket("ws://127.0.0.1:7601");
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}
function nextMsg(ws: WebSocket): Promise<any> {
  return new Promise((res) => ws.once("message", (d) => res(JSON.parse(String(d)))));
}
// Captured before any vi.useFakeTimers() swap of the globals — deadline
// races keep a real clock even while the server's timers are faked.
const realSetTimeout = setTimeout;
const realSleep = (ms: number) => new Promise((r) => realSetTimeout(r, ms));

test("set_mode + input roundtrip; approval flow for high-risk in assist", async () => {
  const modes = new ModeStateMachine();
  server = new TakeoverServer({ modes, port: 7601, injector: null, screen: null, hotkey: null });
  await server.start(7601);
  const ceo = await connect();
  const viewer = await connect();

  ceo.send(JSON.stringify({ t: "ctrl", op: "set_mode", mode: "assist" }));
  const evt = await nextMsg(viewer);
  expect(evt).toMatchObject({ t: "evt", type: "mode_changed", mode: "assist" });

  // high-risk action in assist -> approval request broadcast to viewer
  ceo.send(JSON.stringify({ t: "ctrl", op: "input", id: "r1", action: { kind: "key", key: "Return" } }));
  const appr = await nextMsg(viewer);
  expect(appr).toMatchObject({ t: "evt", type: "approval", id: "r1" });

  viewer.send(JSON.stringify({ t: "ctrl", op: "approve", id: "r1", ok: true }));
  const result = await nextMsg(ceo);
  expect(result).toMatchObject({ t: "evt", type: "input_result", id: "r1" });

  ceo.close(); viewer.close();
});

test("explicit deny -> denied; approval timeout -> timeout-denied", async () => {
  const modes = new ModeStateMachine();
  server = new TakeoverServer({ modes, port: 7601, injector: null, screen: null, hotkey: null, approvalTimeoutMs: 60 });
  await server.start(7601);
  const ceo = await connect();

  ceo.send(JSON.stringify({ t: "ctrl", op: "set_mode", mode: "assist" }));
  await nextMsg(ceo); // mode_changed

  // viewer denies -> denied result, action never executed
  ceo.send(JSON.stringify({ t: "ctrl", op: "input", id: "r2", action: { kind: "key", key: "Return" } }));
  expect(await nextMsg(ceo)).toMatchObject({ t: "evt", type: "approval", id: "r2" });
  ceo.send(JSON.stringify({ t: "ctrl", op: "approve", id: "r2", ok: false }));
  expect(await nextMsg(ceo)).toMatchObject({ t: "evt", type: "input_result", id: "r2", result: "denied" });

  // nobody answers -> 60ms timeout denies by default
  ceo.send(JSON.stringify({ t: "ctrl", op: "input", id: "r3", action: { kind: "key", key: "Delete" } }));
  expect(await nextMsg(ceo)).toMatchObject({ t: "evt", type: "approval", id: "r3" });
  expect(await nextMsg(ceo)).toMatchObject({ t: "evt", type: "input_result", id: "r3", result: "timeout-denied" });

  ceo.close();
});

test("observe blocks at gate; low-risk assist skips approval; hard text never pends; malformed frames ignored", async () => {
  const modes = new ModeStateMachine();
  server = new TakeoverServer({ modes, port: 7601, injector: null, screen: null, hotkey: null });
  await server.start(7601);
  const ceo = await connect();

  // boots in observe: input refused before any approval flow
  ceo.send(JSON.stringify({ t: "ctrl", op: "input", id: "o1", action: { kind: "type", text: "hi" } }));
  expect(await nextMsg(ceo)).toMatchObject({ t: "evt", type: "input_result", id: "o1", result: "blocked-observe" });

  // malformed frame must not crash the daemon or kill the connection
  ceo.send("{{{not json");
  ceo.send(JSON.stringify({ t: "ctrl", op: "set_mode", mode: "assist" }));
  expect(await nextMsg(ceo)).toMatchObject({ t: "evt", type: "mode_changed", mode: "assist" });

  // low-risk typing in assist: straight result, no approval roundtrip
  ceo.send(JSON.stringify({ t: "ctrl", op: "input", id: "l1", action: { kind: "type", text: "hello" } }));
  expect(await nextMsg(ceo)).toMatchObject({ t: "evt", type: "input_result", id: "l1", result: "done" });

  // hard-blocked text is refused immediately, never becomes an approval request
  ceo.send(JSON.stringify({ t: "ctrl", op: "input", id: "h1", action: { kind: "type", text: "rm -rf /home" } }));
  expect(await nextMsg(ceo)).toMatchObject({ t: "evt", type: "input_result", id: "h1", result: "blocked-hard" });

  ceo.close();
});

test("stop() resolves promptly even with a client still connected", async () => {
  const modes = new ModeStateMachine();
  server = new TakeoverServer({ modes, port: 7601, injector: null, screen: null, hotkey: null });
  await server.start(7601);
  const ceo = await connect();
  ceo.on("error", () => {}); // forced teardown may surface ECONNRESET on the client

  // Real-clock deadline as the bug detector: the defect is a close callback
  // that never fires while a real client socket lives — an integration fact
  // fake timers cannot express. stop() must drop clients itself, not wait.
  const winner = await Promise.race([
    server!.stop().then(() => "stopped"),
    new Promise((res) => setTimeout(() => res("timeout"), 2000)),
  ]);
  ceo.close();
  server = null; // already stopped above; skip the afterEach re-stop
  expect(winner).toBe("stopped");
});

test("duplicate input id: the orphaned old approval timer must not evict the new pending entry", async () => {
  const modes = new ModeStateMachine();
  server = new TakeoverServer({ modes, port: 7601, injector: null, screen: null, hotkey: null, approvalTimeoutMs: 150 });
  await server.start(7601);
  const ceo = await connect();

  // Persistent collector: a once("message") waiter can miss a broadcast that
  // lands between two awaits, which made this scenario hang instead of fail.
  const got: Record<string, unknown>[] = [];
  ceo.on("message", (d) => got.push(JSON.parse(String(d)) as Record<string, unknown>));
  const untilGot = (pred: (m: Record<string, unknown>) => boolean): Promise<void> =>
    got.some(pred)
      ? Promise.resolve()
      : new Promise((res) => {
          const on = (d: unknown) => {
            if (pred(JSON.parse(String(d)) as Record<string, unknown>)) { ceo.off("message", on); res(); }
          };
          ceo.on("message", on);
        });

  // Fake timers drive the server's approval timers deterministically (enabled
  // after connect so the ws handshake keeps its real I/O).
  vi.useFakeTimers();
  try {
    ceo.send(JSON.stringify({ t: "ctrl", op: "set_mode", mode: "assist" }));
    await untilGot((m) => m.type === "mode_changed");

    // first request pends under id "dup" — its timer expires at t=150
    ceo.send(JSON.stringify({ t: "ctrl", op: "input", id: "dup", action: { kind: "key", key: "Return" } }));
    await untilGot((m) => m.type === "approval" && m.id === "dup");

    await vi.advanceTimersByTimeAsync(100); // first timer has 50ms left

    // same id again: the old entry is overwritten, its timer must be cleared
    ceo.send(JSON.stringify({ t: "ctrl", op: "input", id: "dup", action: { kind: "key", key: "Delete" } }));
    await untilGot(
      (m) => m.type === "approval" && m.id === "dup" && (m.action as Record<string, unknown>).key === "Delete"
    );

    // past the orphaned first timer (150), far from the second one (250):
    // in the buggy version the orphan fires here, evicts the new entry and
    // broadcasts a bogus timeout-denied
    await vi.advanceTimersByTimeAsync(60);

    ceo.send(JSON.stringify({ t: "ctrl", op: "approve", id: "dup", ok: true }));
    // fixed: the approve clears the second timer and broadcasts done;
    // buggy: the entry was evicted at t=150, the approve is dropped
    const outcome = await Promise.race([
      untilGot((m) => m.type === "input_result" && m.id === "dup" && m.result === "done").then(() => "done"),
      realSleep(1000).then(() => "missing"),
    ]);
    expect(outcome).toBe("done");
  } finally {
    vi.useRealTimers();
  }
});

test("injector exec failure still answers the requester with result error", async () => {
  const modes = new ModeStateMachine();
  const failing = { exec: () => Promise.reject(new Error("boom")) } as unknown as InputInjector;
  server = new TakeoverServer({ modes, port: 7601, injector: failing, screen: null, hotkey: null });
  await server.start(7601);
  const ceo = await connect();

  ceo.send(JSON.stringify({ t: "ctrl", op: "set_mode", mode: "assist" }));
  await nextMsg(ceo); // mode_changed

  // low-risk typing reaches the injector, which rejects (e.g. xdotool
  // missing) — the requester must get an input_result, not eternal silence.
  // Real-clock deadline: the defect is a message that never arrives.
  ceo.send(JSON.stringify({ t: "ctrl", op: "input", id: "e1", action: { kind: "type", text: "hi" } }));
  const res = await Promise.race([
    nextMsg(ceo),
    realSleep(1000).then(() => "missing"),
  ]);
  expect(res).toMatchObject({ t: "evt", type: "input_result", id: "e1", result: "error" });
});

test("cdp_open/cdp_snapshot are forwarded to the cdp channel; results broadcast", async () => {
  const modes = new ModeStateMachine();
  const calls: string[] = [];
  const cdp: CdpChannel = {
    available: async () => true,
    open: async (url: string) => { calls.push(`open:${url}`); return "Example Domain"; },
    snapshot: async () => { calls.push("snapshot"); return "page text"; },
  };
  server = new TakeoverServer({ modes, port: 7601, injector: null, screen: null, hotkey: null, cdp });
  await server.start(7601);
  const ceo = await connect();

  ceo.send(JSON.stringify({ t: "ctrl", op: "cdp_open", url: "https://example.com" }));
  expect(await nextMsg(ceo)).toMatchObject({ t: "evt", type: "cdp_result", op: "cdp_open", url: "https://example.com", result: "Example Domain" });

  ceo.send(JSON.stringify({ t: "ctrl", op: "cdp_snapshot" }));
  expect(await nextMsg(ceo)).toMatchObject({ t: "evt", type: "cdp_result", op: "cdp_snapshot", result: "page text" });

  expect(calls).toEqual(["open:https://example.com", "snapshot"]);
  ceo.close();
});
