// packages/takeoverd/test/server.test.ts
import { TakeoverServer } from "../src/server.js";
import { ModeStateMachine } from "../src/modes.js";
import WebSocket from "ws";
import { expect, test, afterEach } from "vitest";

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
