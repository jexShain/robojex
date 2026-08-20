// packages/ceo-core/src/api.ts
// Operator-facing HTTP+WS api (default :7620, config.apiPort): the jex web UI
// and the jex CLI both talk to this surface. HTTP serves a state snapshot,
// chat/mission/mode POSTs and the static web bundle; /api/events streams
// hello/chat_out/tasks/cycle/mode/budget frames and accepts {t:"chat"}.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, appendFileSync, statSync, createReadStream } from "node:fs";
import { join, dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type { TaskBoard, Task } from "./board.js";
import type { BudgetGovernor } from "./budget.js";
import type { LoopOutlet } from "./loop.js";

export type ChatFrom = "user" | "jex" | "system";
export interface ChatMessage { from: ChatFrom; ts: number; text: string; }

// The loop surface the api needs: chat events in, ctrl frames out (mode
// changes ride the takeover link), and the current takeover mode for state.
// sendCtrl/mode stay optional so a test double with only push() still wires.
export interface ApiLoopHandle {
  push(event: string): void;
  sendCtrl?(frame: Record<string, unknown>): boolean; // false/absent: takeover link down
  mode?(): string;
}

export interface ApiDeps {
  port: number;
  board: TaskBoard;
  budget: BudgetGovernor;
  runtimeDir: string;
  loop: ApiLoopHandle;
  webDir?: string;                     // static bundle (packages/web/dist); absent = no static serving
  host?: string;                       // default 127.0.0.1
  version?: string;                    // override for tests / embedded builds
  snapshotRuntime?: () => void;        // history hook fired before a mission append
  httpFactory?: () => Server;          // test seam: substitute the http server
  wssFactory?: () => WebSocketServer;  // test seam: substitute the ws server
}

// Trimmed card shape the protocol ships, both in state and in tasks frames.
export function taskView(t: Task): { id: string; title: string; status: string; resultSummary: string; createdAt: number } {
  return { id: t.id, title: t.title, status: t.status, resultSummary: t.resultSummary, createdAt: t.createdAt };
}

const RING_MAX = 100;               // chat history: last 100 messages, in memory
const TEXT_MAX_BYTES = 16 * 1024;   // chat/mission text cap
const BODY_MAX_BYTES = 64 * 1024;   // request body cap (text + json overhead)
const MODES = ["observe", "assist", "full"] as const;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".map": "application/json", ".woff": "font/woff", ".woff2": "font/woff2",
};

// Version of the running core: read from package.json beside the module; under
// a pkg binary no file sits there and we fall back to "dev".
const VERSION = (() => {
  try {
    const p = import.meta.url
      ? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json")
      : join(dirname(process.execPath), "package.json");
    return String((JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ?? "dev");
  } catch { return "dev"; }
})();

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

export class ApiServer implements LoopOutlet {
  private server: Server;
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private ring: ChatMessage[] = [];
  private root: string | null; // resolved webDir; null = static serving off
  private closed = false;
  private portNow = 0;
  ready: Promise<void> = Promise.resolve();

  constructor(private d: ApiDeps) {
    this.server = (d.httpFactory ?? createServer)();
    this.server.on("request", (req, res) => { this.onHttp(req, res).catch(() => res.destroy()); });
    this.wss = (d.wssFactory ?? (() => new WebSocketServer({ noServer: true })))();
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.root = d.webDir ? resolve(d.webDir) : null;
    this.server.on("upgrade", (req, socket, head) => {
      const path = new URL(req.url ?? "/", "http://local").pathname;
      if (path !== "/api/events") { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
    });
  }

  get port(): number { return this.portNow; }

  async start(): Promise<void> {
    if (this.server.listening) this.close();
    this.closed = false;
    this.ready = this.listen();
    return this.ready;
  }

  private async listen(): Promise<void> {
    const { promise: listening, resolve: listeningNow, reject: listenFailed } = Promise.withResolvers<void>();
    this.server.once("error", listenFailed);
    this.server.listen(this.d.port, this.d.host ?? "127.0.0.1", () => {
      this.server.off("error", listenFailed);
      listeningNow();
    });
    await listening;
    const addr = this.server.address();
    this.portNow = typeof addr === "object" && addr !== null ? addr.port : this.d.port;
    if (this.closed) this.close(); // stop() raced ahead of listen: undo now
  }

  // Synchronous on purpose: the shutdown handler must drop the listener (and
  // with it the port) before the process exits, with nothing left to await.
  close(): void {
    this.closed = true;
    if (this.server.listening) {
      (this.server as Server & { closeAllConnections?(): void }).closeAllConnections?.();
      this.server.close();
    }
    for (const c of this.clients) c.terminate();
    this.clients.clear();
    this.wss.close();
  }

  // -- LoopOutlet: jex replies and lifecycle frames ride the same broadcast --
  chatOut(from: ChatFrom, text: string): void {
    const msg: ChatMessage = { from, ts: Date.now(), text };
    this.ring.push(msg);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    this.broadcast({ t: "chat_out", from, text, ts: msg.ts });
  }

  frame(f: Record<string, unknown>): void { this.broadcast(f); }

  // -- internals ------------------------------------------------------------
  private broadcast(f: Record<string, unknown>): void {
    const s = JSON.stringify(f);
    for (const c of this.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    try { ws.send(JSON.stringify({ t: "hello", state: this.state() })); } catch { /* client gone already */ }
    ws.on("message", (raw: unknown) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
      if (m.t === "chat" && typeof m.text === "string") this.handleChat(m.text); // ≡ POST /api/chat
    });
  }

  private handleChat(text: string): void {
    this.d.loop.push(`chat: ${text}`);
    this.chatOut("user", text);
  }

  private state(): Record<string, unknown> {
    const read = (f: string): string => { try { return readFileSync(join(this.d.runtimeDir, f), "utf8"); } catch { return `(${f} missing)`; } };
    return {
      tasks: this.d.board.list().map(taskView),
      budget: this.d.budget.snapshot(),
      mode: this.d.loop.mode?.() ?? "observe",
      mission: read("MISSION.md"), rubric: read("RUBRIC.md"), memory: read("MEMORY.md"),
      chat: this.ring.slice(),
      version: this.d.version ?? VERSION,
    };
  }

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // dev mode serves the vite dev server origin: CORS stays open
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const path = new URL(req.url ?? "/", "http://local").pathname;
    if (path === "/api/state" && req.method === "GET") { json(res, 200, this.state()); return; }
    if (path === "/api/chat" && req.method === "POST") { await this.postChat(req, res); return; }
    if (path === "/api/mission" && req.method === "POST") { await this.postMission(req, res); return; }
    if (path === "/api/mode" && req.method === "POST") { await this.postMode(req, res); return; }
    if (path.startsWith("/api/")) { json(res, 404, { error: "not found" }); return; }
    this.serveStatic(res, path);
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > BODY_MAX_BYTES) throw new Error("body too large");
      chunks.push(c as Buffer);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be a JSON object");
    return parsed as Record<string, unknown>;
  }

  // shared validation for chat/mission texts: non-empty string of at most 16KB
  private validText(v: unknown): v is string {
    return typeof v === "string" && v.trim().length > 0 && Buffer.byteLength(v, "utf8") <= TEXT_MAX_BYTES;
  }

  private async postChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try { body = await this.readJson(req); } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : "bad body" }); return; }
    if (!this.validText(body.text)) { json(res, 400, { error: "text must be a non-empty string of at most 16KB" }); return; }
    this.handleChat(body.text);
    json(res, 202, { ok: true });
  }

  private async postMission(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try { body = await this.readJson(req); } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : "bad body" }); return; }
    if (!this.validText(body.text)) { json(res, 400, { error: "text must be a non-empty string of at most 16KB" }); return; }
    this.d.snapshotRuntime?.(); // pre-edit snapshot keeps the old mission recoverable, like mission_update
    const p = join(this.d.runtimeDir, "MISSION.md");
    const prev = (() => { try { return readFileSync(p, "utf8"); } catch { return ""; } })();
    appendFileSync(p, `${prev.endsWith("\n") || prev === "" ? "" : "\n"}${body.text}\n`); // append, never overwrite
    this.chatOut("system", body.text);
    json(res, 202, { ok: true });
  }

  private async postMode(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try { body = await this.readJson(req); } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : "bad body" }); return; }
    if (typeof body.mode !== "string" || !(MODES as readonly string[]).includes(body.mode)) {
      json(res, 400, { error: "mode must be one of observe|assist|full" });
      return;
    }
    // the mode switch itself is takeoverd's call: forward over the takeover WS
    const sent = this.d.loop.sendCtrl?.({ t: "ctrl", op: "set_mode", mode: body.mode }) ?? false;
    if (!sent) { json(res, 503, { error: "takeover link down" }); return; }
    json(res, 202, { ok: true });
  }

  private serveStatic(res: ServerResponse, pathname: string): void {
    const root = this.root;
    if (!root) { json(res, 404, { error: "not found" }); return; }
    let rel = "/";
    try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400).end("bad path"); return; }
    const full = resolve(join(root, rel === "/" ? "/index.html" : "." + rel));
    if (full !== root && !full.startsWith(root + sep)) { res.writeHead(403).end("forbidden"); return; }
    let target = full;
    let st = fileStat(target);
    if (!st) {
      // SPA fallback: extension-less routes render the app shell; a missing
      // asset with an extension is a genuine 404
      if (extname(target)) { res.writeHead(404).end("not found"); return; }
      target = join(root, "index.html");
      st = fileStat(target);
      if (!st) { res.writeHead(404).end("not found"); return; }
    }
    const ext = extname(target).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-length": st.size,
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    createReadStream(target).pipe(res);
  }
}

function fileStat(p: string): { size: number } | null {
  try { const s = statSync(p); return s.isFile() ? s : null; } catch { return null; }
}
