// packages/cli/test/cli.test.ts
// End-to-end --once tests against a local stub of the frozen core protocol
// (.superpowers/dsh-plan.md: POST /api/chat + WS /api/events frames), plus
// unit tests for arg parsing, WS URL derivation and frame summaries.
// The CLI is spawned as a real child process (node --experimental-strip-types
// src/index.ts) so exit codes, stdin piping and stdout purity are all covered.
import { afterAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, wsEventsUrl, summarizeFrame } from "../src/index.js";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- unit tests

test("parseArgs: defaults to the local core URL, parses --url/--once/--help in both spellings", () => {
  expect(parseArgs([])).toEqual({ url: "http://127.0.0.1:7620", once: false, help: false });
  expect(parseArgs(["--once"])).toEqual({ url: "http://127.0.0.1:7620", once: true, help: false });
  expect(parseArgs(["--url", "http://10.10.7.69:7620", "--once"]))
    .toEqual({ url: "http://10.10.7.69:7620", once: true, help: false });
  expect(parseArgs(["--url=ws://h:1"])).toEqual({ url: "ws://h:1", once: false, help: false });
  expect(parseArgs(["--help"]).help).toBe(true);
});

test("wsEventsUrl: derives the /api/events endpoint from any base URL shape", () => {
  expect(wsEventsUrl("http://127.0.0.1:7620")).toBe("ws://127.0.0.1:7620/api/events");
  expect(wsEventsUrl("http://127.0.0.1:7620/")).toBe("ws://127.0.0.1:7620/api/events");
  expect(wsEventsUrl("https://core.example.com")).toBe("wss://core.example.com/api/events");
  expect(wsEventsUrl("127.0.0.1:7620")).toBe("ws://127.0.0.1:7620/api/events");
});

test("summarizeFrame: state frames collapse to one line; chat frames are not summaries", () => {
  expect(summarizeFrame({
    t: "tasks",
    tasks: [
      { id: "t1", title: "a", status: "done" },
      { id: "t2", title: "b", status: "running" },
      { id: "t3", title: "c", status: "done" },
    ],
  })).toBe("tasks 3 (2 done, 1 running)");
  expect(summarizeFrame({ t: "cycle", wake: 3, cost: 0.0123, actions: [{}, {}] }))
    .toBe("cycle wake=3 cost=0.0123 actions=2");
  expect(summarizeFrame({ t: "mode", mode: "assist" })).toBe("mode assist");
  expect(summarizeFrame({ t: "budget", line: "burn · today 12k/2M" })).toBe("budget burn · today 12k/2M");
  expect(summarizeFrame({ t: "chat_out", from: "jex", text: "hi" })).toBeNull();
  expect(summarizeFrame({ t: "hello", state: {} })).toBeNull();
});

// ------------------------------------------------------------- stub core API

const STATE = {
  tasks: [
    { id: "t1", title: "first", status: "done", resultSummary: "", createdAt: 0 },
    { id: "t2", title: "second", status: "running", resultSummary: "", createdAt: 1 },
  ],
  budget: { mode: "burn", dailyTokens: 2_000_000, spentToday: 0, line: "burn · today 0/2M" },
  mode: "assist", mission: "", rubric: "", memory: "", chat: [], version: "stub",
};

type ChatHook = (text: string, reply: (t: string) => void) => void;

class StubCore {
  server: Server = createServer();
  wss = new WebSocketServer({ noServer: true });
  // dynamic membership: sockets join/leave — a Set is the right shape here
  clients = new Set<WebSocket>();
  chats: string[] = [];
  onChat: ChatHook | null = null;

  async start(): Promise<string> {
    this.server.on("request", (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const path = (req.url ?? "/").split("?")[0]!;
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { text?: string };
        if (req.method === "POST" && path === "/api/chat") {
          this.chats.push(body.text ?? "");
          res.writeHead(202, { "content-type": "application/json" });
          res.end('{"ok":true}');
          this.onChat?.(body.text ?? "", (t) =>
            this.broadcast({ t: "chat_out", from: "jex", text: t, ts: Date.now() }));
          return;
        }
        if (req.method === "GET" && path === "/api/state") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(STATE));
          return;
        }
        res.writeHead(404).end();
      });
    });
    this.server.on("upgrade", (req, socket, head) => {
      if ((req.url ?? "").split("?")[0] === "/api/events") {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.clients.add(ws);
          ws.on("close", () => this.clients.delete(ws));
          ws.send(JSON.stringify({ t: "hello", state: STATE }));
        });
      } else {
        socket.destroy();
      }
    });
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    this.server.once("error", reject);
    this.server.listen(0, "127.0.0.1", () => resolve((this.server.address() as { port: number }).port));
    const port = await promise;
    return `http://127.0.0.1:${port}`;
  }

  broadcast(frame: unknown): void {
    const s = JSON.stringify(frame);
    for (const c of this.clients) c.send(s);
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.close();
    const closed1 = Promise.withResolvers<void>();
    this.wss.close(() => closed1.resolve());
    const closed2 = Promise.withResolvers<void>();
    this.server.close(() => closed2.resolve());
    await closed1.promise;
    await closed2.promise;
  }
}

const stubs: StubCore[] = [];
afterAll(async () => { for (const s of stubs) await s.stop(); });

async function stubCore(): Promise<{ stub: StubCore; url: string }> {
  const stub = new StubCore();
  stubs.push(stub);
  return { stub, url: await stub.start() };
}

/** Grab a port that is guaranteed closed (for the unreachable-server test). */
async function deadUrl(): Promise<string> {
  const srv = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port));
  const port = await promise;
  const closed = Promise.withResolvers<void>();
  srv.close(() => closed.resolve());
  await closed.promise;
  return `http://127.0.0.1:${port}`;
}

// ------------------------------------------------------------ --once e2e

interface CliResult { code: number; stdout: string; stderr: string }

// The 15s setTimeout below is a watchdog against a hung child, never a
// synchronization wait — every assertion below waits for the child's real
// exit event, so no wall-clock delay is ever baked into the test duration.
function runOnce(url: string, opts: { input?: string; env?: Record<string, string> } = {}): Promise<CliResult> {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "src/index.ts", "--once", "--url", url],
    { cwd: PKG_DIR, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const { promise, resolve, reject } = Promise.withResolvers<CliResult>();
  const kill = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("jex --once hung")); }, 15_000);
  child.on("error", (e) => { clearTimeout(kill); reject(e); });
  child.on("close", (code) => { clearTimeout(kill); resolve({ code: code ?? -1, stdout, stderr }); });
  child.stdin.end(opts.input ?? "");
  return promise;
}

test("--once: posts the stdin line to /api/chat and prints exactly the jex reply", { timeout: 20_000 }, async () => {
  const { stub, url } = await stubCore();
  stub.onChat = (text, reply) => reply(`hello back (${text.length} chars)`);
  const r = await runOnce(url, { input: "hello jex\n" });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("hello back (9 chars)\n"); // stdout carries the reply only
  expect(stub.chats).toEqual(["hello jex"]);
});

// Real-clock exception: the 30s reply deadline runs inside the spawned CLI
// process, where fake timers cannot reach; JEX_TIMEOUT_MS shrinks it so the
// test still completes in under a second of actual waiting.
test("--once: exits 1 on timeout when no jex reply ever arrives", { timeout: 20_000 }, async () => {
  const { stub, url } = await stubCore();
  stub.onChat = () => { /* jex stays silent */ };
  const r = await runOnce(url, { input: "anyone?\n", env: { JEX_TIMEOUT_MS: "700" } });
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/timeout/i);
  expect(r.stdout).toBe("");
});

test("--once: exits 1 with an error when the core is unreachable", { timeout: 20_000 }, async () => {
  const r = await runOnce(await deadUrl(), { input: "hi\n", env: { JEX_TIMEOUT_MS: "3000" } });
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/error|reach/i);
});

test("--once: empty stdin is rejected with exit 1", { timeout: 20_000 }, async () => {
  const { url } = await stubCore();
  const r = await runOnce(url, { input: "" });
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/no input/i);
});
