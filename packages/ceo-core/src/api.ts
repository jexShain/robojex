// packages/ceo-core/src/api.ts
// Operator-facing HTTP+WS api (default :7620, config.apiPort): the jex web UI
// and the jex CLI both talk to this surface. HTTP serves a state snapshot,
// chat/mission/mode POSTs and the static web bundle; /api/events streams
// hello/chat_out/tasks/cycle/mode/budget frames and accepts {t:"chat"}.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, appendFileSync, statSync, createReadStream } from "node:fs";
import { join, dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import type { TaskBoard, Task } from "./board.js";
import type { BudgetGovernor } from "./budget.js";
import type { LoopOutlet } from "./loop.js";
import type { ChatService } from "./chat-service.js";
import type { GearController } from "./gears.js";
import { isGearId, GEAR_IDS } from "./gears.js";
import type { LLMClient } from "./llm.js";
import { aggregateStats } from "./stats.js";
import { computeTrends, extractPatterns, parseOutcomes, priorityAdvice } from "./auto-rubric.js";
import { jobSnapshot } from "./tools/jobs.js";

export type ChatFrom = "user" | "jex" | "system";
export interface ChatMessage { from: ChatFrom; ts: number; text: string; }

// The loop surface the api needs: chat events in, ctrl frames out (mode
// changes ride the takeover link), and the current takeover mode for state.
// sendCtrl/mode stay optional so a test double with only push() still wires.
export interface ApiLoopHandle {
  push(event: string): void;
  sendCtrl?(frame: Record<string, unknown>): boolean; // false/absent: takeover link down
  setModeLocal?(mode: string): void;                  // link-down fallback: switch the mode without takeoverd
  rescheduleById?(id: string, times: { scheduledAt?: number | null; dueAt?: number | null }): void; // operator drag-to-reschedule landing (pump re-arm included)
  markDoneById?(id: string, note: string): void; // operator "settled it myself" — todo→done with pump state cleared
  mode?(): string;
  tickN?(): number;                     // decision-cycle count for HUD lag detection; absent = 0
  resolveToolApproval?(id: string, ok: boolean): Promise<string | null>; // settles a pending assist-mode tool write
  setPolicy?(policy: string): void;     // hot autonomy-policy switch (butler|conservative)
  policy?(): string;                    // current policy for state snapshots; absent = butler
  recentThinking?(): Record<string, unknown>[]; // T7: recent thinking-trace steps (oldest first) for late joiners
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
  rubricHistory?: () => { commit: string; message: string }[]; // T9: commits that touched RUBRIC.md
  httpFactory?: () => Server;          // test seam: substitute the http server
  wssFactory?: () => WebSocketServer;  // test seam: substitute the ws server
  chat?: ChatService;                  // direct-chat surface (conversations + SSE); absent = routes 503
  gear?: GearController;               // autonomy gears; absent = gear routes 503, state.gear = balanced
  llm?: LLMClient;                     // /api/models proxy; absent = 503
}

// Trimmed card shape the protocol ships, both in state and in tasks frames.
// parentId/scheduledAt/dueAt are board-v2 fields (epoch ms numbers); the ?? null
// keeps hand-built Task fixtures (tests) shipping an explicit null, not undefined.
export function taskView(t: Task): { id: string; title: string; status: string; priority: number; resultSummary: string; createdAt: number; parentId: string | null; scheduledAt: number | null; dueAt: number | null; acceptance: string; progress: number; verdict: string; assignee: string; milestone: boolean } {
  return { id: t.id, title: t.title, status: t.status, priority: t.priority, resultSummary: t.resultSummary, createdAt: t.createdAt, parentId: t.parentId ?? null, scheduledAt: t.scheduledAt ?? null, dueAt: t.dueAt ?? null, acceptance: t.acceptance, progress: t.progress, verdict: t.verdict, assignee: t.assignee, milestone: t.milestone };
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

// The api is unauthenticated, so it must only answer the operator's own
// browser. Host must name this machine (anti DNS-rebinding: a rebound domain
// resolves to 127.0.0.1 but still carries evil.com in Host), and a browser
// Origin — when one is sent — must target the same host, so the console works
// same-origin from any NIC address (e.g. http://10.10.7.69:7620), or be a
// loopback origin on any port (vite dev server proxying the api).
// Returns the Origin to echo for CORS ("" when none was sent), null to refuse.
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true };
const LOCAL_HOSTS = (() => {
  const hosts = new Set(Object.keys(LOOPBACK_HOSTS)); // dynamic: NIC addresses join at runtime
  for (const addrs of Object.values(networkInterfaces()))
    for (const a of addrs ?? []) if (a.address) hosts.add(a.address);
  return hosts;
})();

function originGate(req: IncomingMessage): string | null {
  const raw = req.headers.host?.trim().toLowerCase() ?? "";
  // strip the port: IPv6 literals arrive bracketed ([::1]:7620), IPv4/dns as host:port
  const host = raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw.replace(/:\d+$/, "");
  if (!host || !LOCAL_HOSTS.has(host)) return null;
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin === "") return ""; // non-browser client or same-origin GET
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return null; } // includes Origin: null (sandboxed frames)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.hostname === host || LOOPBACK_HOSTS[parsed.hostname] ? origin : null;
}

// Version of the running core: read from the package.json one level above this
// module (src -> package root, dist -> package root); under a pkg binary no
// file sits there and we fall back to "dev".
const VERSION = (() => {
  try {
    const p = import.meta.url
      ? join(dirname(fileURLToPath(import.meta.url)), "..", "package.json")
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
    // 1MB covers any legal frame (chat texts cap at 16KB); the ws default of
    // 100MiB would let one frame blow up the ring, the broadcast and the loop.
    this.wss = (d.wssFactory ?? (() => new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })))();
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.root = d.webDir ? resolve(d.webDir) : null;
    this.server.on("upgrade", (req, socket, head) => {
      const path = new URL(req.url ?? "/", "http://local").pathname;
      // browsers do not gate WS on CORS: the same Host/Origin check as HTTP
      // applies, otherwise any webpage can open /api/events cross-origin.
      if (path !== "/api/events" || originGate(req) === null) { socket.destroy(); return; }
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

  // HUD notice: one gantt event (due_spawn/overdue/unlocked/verify_due) just
  // hit a task — widgets flash the card. LoopOutlet.hud routes here.
  hud(kind: string, taskId: string): void { this.broadcast({ t: "hud", kind, taskId, ts: Date.now() }); }

  // -- internals ------------------------------------------------------------
  private broadcast(f: Record<string, unknown>): void {
    const s = JSON.stringify(f);
    for (const c of this.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    // ws re-emits receiver errors (e.g. a frame past maxPayload) on the
    // socket: without a listener one bad client would crash the whole console.
    ws.on("error", () => this.clients.delete(ws));
    try { ws.send(JSON.stringify({ t: "hello", state: this.state() })); } catch { /* client gone already */ }
    ws.on("message", (raw: unknown) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
      if (m.t === "chat" && this.validText(m.text)) void this.routeChat(m.text); // ≡ POST /api/chat: same non-empty ≤16KB rule
    });
  }


  // Shared shortcut resolver: returns true if text was consumed as approval.
  private async routeChat(text: string): Promise<boolean> {
    const m = /^(approve|deny)\s+([0-9a-f]{8})\b/i.exec(text.trim());
    if (m && this.d.loop.resolveToolApproval) {
      const id = m[2].toLowerCase();
      const approved = m[1].toLowerCase() === "approve";
      const result = await this.d.loop.resolveToolApproval(id, approved);
      if (result === null) {
        this.chatOut("system", `no pending approval ${id} — it may be expired or already resolved`);
      } else {
        this.chatOut("system", `approval ${m[1].toLowerCase()}d: ${id}`);
      }
      return true;
    }
    // Not a shortcut: queue as normal chat
    this.d.loop.push(`chat: ${text}`);
    this.chatOut("user", text);
    return false;
  }

  private state(): Record<string, unknown> {
    const read = (f: string): string => { try { return readFileSync(join(this.d.runtimeDir, f), "utf8"); } catch { return `(${f} missing)`; } };
    return {
      now: Date.now(), // server clock: clients align sched/due rendering on it
      tasks: this.d.board.list().map(taskView),
      budget: this.d.budget.snapshot(),
      mode: this.d.loop.mode?.() ?? "observe",
      tickN: this.d.loop.tickN?.() ?? 0,
      gear: this.d.gear?.current() ?? "balanced",
      policy: this.d.loop.policy?.() ?? "butler",
      mission: read("MISSION.md"), rubric: read("RUBRIC.md"), memory: read("MEMORY.md"),
      chat: this.ring.slice(),
      // T7 late-joiner replay: the recent thinking-trace window so a fresh
      // tab paints jex's reasoning history before the next wake
      thinking: this.d.loop.recentThinking?.() ?? [],
      version: this.d.version ?? VERSION,
    };
  }

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = originGate(req);
    if (origin === null) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); res.end("forbidden origin"); return; }
    if (origin !== "") res.setHeader("access-control-allow-origin", origin); // echo exactly the origin just vetted
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const path = new URL(req.url ?? "/", "http://local").pathname;
    if (path === "/api/state" && req.method === "GET") { json(res, 200, this.state()); return; }
    if (path === "/api/chat" && req.method === "POST") { await this.postChat(req, res); return; }
    // -- direct-chat surface (ChatService) ---------------------------------
    if (path === "/api/chat/stream" && req.method === "POST") { await this.postChatStream(req, res); return; }
    if (path === "/api/chat/stop" && req.method === "POST") { await this.postChatStop(req, res); return; }
    if (path === "/api/conversations" && req.method === "GET") {
      if (!this.d.chat) { json(res, 503, { error: "chat not wired" }); return; }
      json(res, 200, { conversations: this.d.chat.store.listConversations() });
      return;
    }
    if (path === "/api/conversations" && req.method === "POST") { await this.postConversation(req, res); return; }
    {
      const m = path.match(/^\/api\/conversations\/([^/]+)$/);
      const mm = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      const dm = path.match(/^\/api\/messages\/([^/]+)$/);
      const seg = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
      if (mm && req.method === "GET") {
        if (!this.d.chat) { json(res, 503, { error: "chat not wired" }); return; }
        const id = seg(mm[1]);
        if (!this.d.chat.store.get(id)) { json(res, 404, { error: "conversation not found" }); return; }
        json(res, 200, { messages: this.d.chat.store.listMessages(id) });
        return;
      }
      if (m && req.method === "PATCH") { await this.patchConversation(req, res, seg(m[1])); return; }
      if (m && req.method === "DELETE") {
        if (!this.d.chat) { json(res, 503, { error: "chat not wired" }); return; }
        json(res, 200, { ok: this.d.chat.store.delete(seg(m[1])) });
        return;
      }
      if (dm && req.method === "DELETE") {
        if (!this.d.chat) { json(res, 503, { error: "chat not wired" }); return; }
        json(res, 200, { ok: this.d.chat.store.deleteMessage(seg(dm[1])) });
        return;
      }
    }
    // -- gears / models / usage --------------------------------------------
    if (path === "/api/gear" && req.method === "GET") { this.getGear(res); return; }
    if (path === "/api/gear" && req.method === "PUT") { await this.putGear(req, res); return; }
    if (path === "/api/models" && req.method === "GET") { await this.getModels(res); return; }
    if (path === "/api/usage" && req.method === "GET") { this.getUsage(req, res); return; }
    if (path === "/api/stats" && req.method === "GET") { this.getStats(res); return; }
    if (path === "/api/rubric" && req.method === "GET") { this.getRubric(res); return; }
    if (path === "/api/rubric/history" && req.method === "GET") { json(res, 200, { history: this.d.rubricHistory?.() ?? [] }); return; }
    if (path === "/api/mission" && req.method === "POST") { await this.postMission(req, res); return; }
    if (path === "/api/task" && req.method === "POST") { await this.postTask(req, res); return; }
    if (path === "/api/task" && req.method === "PUT") { await this.putTask(req, res); return; }
    if (path === "/api/task" && req.method === "PATCH") { await this.patchTask(req, res); return; }
    if (path === "/api/task/reorder" && req.method === "POST") { await this.reorderTasks(req, res); return; }
    if (path === "/api/mode" && req.method === "POST") { await this.postMode(req, res); return; }
    if (path === "/api/settings" && req.method === "GET") { this.getSettings(res); return; }
    if (path === "/api/settings" && req.method === "PUT") { await this.putSettings(req, res); return; }
    if (path === "/api/jobs" && req.method === "GET") { json(res, 200, { jobs: jobSnapshot() }); return; }
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
    // ≡ POST /api/chat: same tokenization and shortcut routing as WS {t:"chat"}
    await this.routeChat(body.text);
    json(res, 202, { ok: true });
  }

  // -- direct-chat surface ------------------------------------------------
  // SSE: the body parses as JSON first (same cap/validation as every POST),
  // then the chat service owns the response from headers to last frame.
  private async postChatStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.d.chat) { json(res, 503, { error: "chat not wired" }); return; }
    let body: Record<string, unknown>;
    try { body = await this.readJson(req); } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : "bad body" }); return; }
    await this.d.chat.handleStream(req, res, body);
  }

  private async postChatStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.d.chat) { json(res, 503, { error: "chat not wired" }); return; }
    let conversationId: string | undefined;
    try {
      const body = await this.readJson(req);
      if (typeof body.conversationId === "string" && body.conversationId.length > 0) conversationId = body.conversationId;
    } catch { /* empty body also means stop-all */ }
    json(res, 200, { ok: true, stopped: this.d.chat.stop(conversationId) });
  }

  private async postConversation(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.d.chat) { json(res, 503, { error: "chat not wired" }); return; }
    let title: string | undefined;
    try {
      const body = await this.readJson(req);
      if (typeof body.title === "string") title = body.title;
    } catch { /* no/empty body: default title */ }
    json(res, 201, this.d.chat.store.create(title));
  }

  private async patchConversation(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    if (!this.d.chat) { json(res, 503, { error: "chat not wired" }); return; }
    let body: Record<string, unknown>;
    try { body = await this.readJson(req); } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : "bad body" }); return; }
    const patch: { title?: string; pinned?: boolean | 0 | 1; archived?: boolean | 0 | 1 } = {};
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || body.title.trim().length === 0) { json(res, 400, { error: "title must be a non-empty string" }); return; }
      patch.title = body.title;
    }
    for (const f of ["pinned", "archived"] as const) {
      const v = body[f];
      if (v === undefined) continue;
      if (typeof v !== "boolean" && v !== 0 && v !== 1) { json(res, 400, { error: `${f} must be a boolean` }); return; }
      patch[f] = v;
    }
    const updated = this.d.chat.store.update(id, patch);
    if (!updated) { json(res, 404, { error: "conversation not found" }); return; }
    json(res, 200, updated);
  }

  // -- gears / models / usage ----------------------------------------------
  private gearBody(): { gear: string; gears: unknown[]; appliedTickMs: number } {
    const g = this.d.gear!;
    return { gear: g.current(), gears: g.list(), appliedTickMs: g.appliedTickMs() };
  }

  /** Hot switch through the wired controller + WS broadcast {t:'gear'}. The
   *  loop retime rides GearController.onApply (index.ts wiring). */
  private gearSwitch(gear: string): void {
    this.d.gear!.set(gear);
    this.broadcast({ t: "gear", gear: this.d.gear!.current() });
  }

  private getGear(res: ServerResponse): void {
    if (!this.d.gear) { json(res, 503, { error: "gear not wired" }); return; }
    json(res, 200, this.gearBody());
  }

  private async putGear(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.d.gear) { json(res, 503, { error: "gear not wired" }); return; }
    let body: Record<string, unknown>;
    try { body = await this.readJson(req); } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : "bad body" }); return; }
    if (!isGearId(body.gear)) { json(res, 400, { error: `gear must be one of ${GEAR_IDS.join("|")}` }); return; }
    try { this.gearSwitch(body.gear); } catch (e) { json(res, 500, { error: e instanceof Error ? e.message : "gear switch failed" }); return; }
    json(res, 200, this.gearBody());
  }

  private async getModels(res: ServerResponse): Promise<void> {
    if (!this.d.llm) { json(res, 503, { error: "llm not wired" }); return; }
    json(res, 200, { models: await this.d.llm.listModels() });
  }

  private getUsage(req: IncomingMessage, res: ServerResponse): void {
    if (!this.d.chat) { json(res, 503, { error: "chat not wired" }); return; }
    const q = new URL(req.url ?? "/", "http://local").searchParams.get("days");
    json(res, 200, { usage: this.d.chat.usage(q === null ? 7 : Number(q)) });
  }

  // R8 ledger read side: the tail of runtime/STATS.md (appendStat lines)
  // folded into a per-agent track record for the command-center strip. A
  // missing ledger (fresh runtime / pre-R8 core) answers { agents: [] } —
  // 200, not 404, so the UI treats "no record yet" as ordinary state.
  private getStats(res: ServerResponse): void {
    let raw = "";
    try { raw = readFileSync(join(this.d.runtimeDir, "STATS.md"), "utf8"); } catch { /* no ledger yet */ }
    json(res, 200, { agents: aggregateStats(raw) });
  }

  // T9 auto-rubric read side: the live RUBRIC.md plus what the task-outcome
  // ledger (runtime/STATS.md) currently proves — learned patterns, completion
  // trends, and history-weighted advice for pending cards. A fresh runtime
  // (no ledger) answers with the seeded rubric and empty views: 200, same
  // "no record yet is ordinary state" convention as getStats.
  private getRubric(res: ServerResponse): void {
    let rubric = "";
    try { rubric = readFileSync(join(this.d.runtimeDir, "RUBRIC.md"), "utf8"); } catch { /* fresh runtime */ }
    let raw = "";
    try { raw = readFileSync(join(this.d.runtimeDir, "STATS.md"), "utf8"); } catch { /* no ledger yet */ }
    const outcomes = parseOutcomes(raw);
    const patterns = extractPatterns(outcomes);
    json(res, 200, {
      rubric,
      patterns,
      trends: computeTrends(outcomes, Date.now()),
      advice: priorityAdvice(this.d.board.list(), patterns),
    });
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

  // POST /api/task: operator-created todo card with optional tree/schedule
  // fields; 202 + tasks broadcast (same frame the loop emits), 400 with the
  // first failing field named in the error.
  private async postTask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try { body = await this.readJson(req); } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : "bad body" }); return; }
    if (typeof body.title !== "string" || body.title.trim().length === 0 || Buffer.byteLength(body.title, "utf8") > 200) {
      json(res, 400, { error: "title must be a non-empty string of at most 200 bytes" });
      return;
    }
    const times: { scheduledAt?: number; dueAt?: number } = {};
    for (const f of ["scheduledAt", "dueAt"] as const) {
      const v = body[f];
      if (v === undefined || v === null) continue; // absent means unscheduled
      if (typeof v !== "number" || !Number.isFinite(v)) {
        json(res, 400, { error: `${f} must be a finite number (epoch ms)` }); // JSON 1e999 parses to Infinity
        return;
      }
      times[f] = v;
    }
    const pid = body.parentId;
    let parentId: string | null = null;
    if (pid !== undefined && pid !== null) {
      if (typeof pid !== "string" || !this.d.board.list().some((t) => t.id === pid)) {
        json(res, 400, { error: "parentId must be the id of an existing task" });
        return;
      }
      parentId = pid;
    }
    const t = this.d.board.add({ title: body.title, parentId, ...times });
    this.broadcast({ t: "tasks", tasks: this.d.board.list().map(taskView) });
    json(res, 202, { ok: true, task: taskView(t) });
  }

  // PUT /api/task: operator status write — { id, status: "cancelled" | "done" }.
  // Cancel mirrors the agent's archive action (create existed, cancel did not —
  // a mis-planned card had no retreat path). Done is the "settled it myself"
  // path: a self-created errand finished offline by the human, before its
  // scheduled time wakes a redundant spawn. Done is limited to never-dispatched
  // todo cards (no assignee) — an agent-owned card must finish through verify.
  // Cancel idempotent on already-cancelled; done on done refuses with 409.
  private async putTask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try { body = await this.readJson(req); } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : "bad body" }); return; }
    if (typeof body.id !== "string" || body.id.length === 0) { json(res, 400, { error: "id must be a non-empty task id" }); return; }
    if (body.status !== undefined && body.status !== "cancelled" && body.status !== "done") { json(res, 400, { error: "only status \"cancelled\" or \"done\" is supported" }); return; }
    const hit = this.d.board.list().find((t) => t.id === body.id);
    if (!hit) { json(res, 404, { error: "no such task" }); return; }
    if (body.status === "done") {
      if (hit.status === "done" || hit.status === "cancelled") { json(res, 409, { error: `task is ${hit.status} — history is immutable` }); return; }
      if (hit.status !== "todo" || hit.assignee !== "") { json(res, 409, { error: "only never-dispatched todo cards can be marked done — an agent-owned card finishes through verify, or cancel it" }); return; }
      if (!this.d.loop.markDoneById) { json(res, 503, { error: "loop not wired for operator-done" }); return; }
      this.d.loop.markDoneById(hit.id, "[done by operator]");
      const now = this.d.board.list().find((t) => t.id === hit.id)!;
      json(res, 202, { ok: true, task: taskView(now) });
      return;
    }
    if (hit.status === "done") { json(res, 409, { error: "task is done — history is immutable" }); return; }
    if (hit.status !== "cancelled") {
      this.d.board.update(hit.id, { status: "cancelled", resultSummary: [hit.resultSummary, "[cancelled by operator]"].filter(Boolean).join(" | ") });
      this.broadcast({ t: "tasks", tasks: this.d.board.list().map(taskView) });
    }
    const now = this.d.board.list().find((t) => t.id === hit.id)!;
    json(res, 202, { ok: true, task: taskView(now) });
  }

  // PATCH /api/task: operator card edit — { id, scheduledAt?, dueAt?, title?, priority?, milestone? }
  // with epoch-ms numbers (null clears), a rename (same shape rule as
  // POST: non-empty, ≤200 bytes), a priority bump (finite number, rounded
  // to an integer — board.list() orders priority DESC), and a milestone flag
  // (boolean — the T4 gantt view marks it, no times involved). Times land
  // through the loop's reschedule (pump re-arm included); a typo fix no
  // longer costs cancel+recreate, which would orphan the card's times and
  // children. done/cancelled are history: 409.
  private async patchTask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try { body = await this.readJson(req); } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : "bad body" }); return; }
    if (typeof body.id !== "string" || body.id.length === 0) { json(res, 400, { error: "id must be a non-empty task id" }); return; }
    const hasTimes = body.scheduledAt !== undefined || body.dueAt !== undefined;
    if (!hasTimes && body.title === undefined && body.priority === undefined && body.milestone === undefined) { json(res, 400, { error: "scheduledAt, dueAt, title, priority, or milestone is required" }); return; }
    for (const k of ["scheduledAt", "dueAt"] as const) {
      const v = body[k];
      if (v !== undefined && v !== null && typeof v !== "number") { json(res, 400, { error: `${k} must be epoch ms or null` }); return; }
    }
    if (body.priority !== undefined && (typeof body.priority !== "number" || !Number.isFinite(body.priority))) {
      json(res, 400, { error: "priority must be a finite number" }); return; // JSON 1e999 parses to Infinity
    }
    if (body.milestone !== undefined && typeof body.milestone !== "boolean") {
      json(res, 400, { error: "milestone must be a boolean" }); return;
    }
    if (body.title !== undefined && (typeof body.title !== "string" || body.title.trim().length === 0 || Buffer.byteLength(body.title, "utf8") > 200)) {
      json(res, 400, { error: "title must be a non-empty string of at most 200 bytes" });
      return;
    }
    const hit = this.d.board.list().find((t) => t.id === body.id);
    if (!hit) { json(res, 404, { error: "no such task" }); return; }
    if (hit.status === "done" || hit.status === "cancelled") { json(res, 409, { error: `task is ${hit.status} — history is immutable` }); return; }
    const resched = this.d.loop.rescheduleById; // captured: board.update below would blur property narrowing
    if (hasTimes && !resched) { json(res, 503, { error: "loop not wired for reschedule" }); return; }
    if (body.title !== undefined) this.d.board.update(hit.id, { title: body.title });
    if (body.priority !== undefined) this.d.board.update(hit.id, { priority: Math.round(body.priority as number) });
    if (body.milestone !== undefined) this.d.board.update(hit.id, { milestone: body.milestone as boolean });
    if (hasTimes) {
      resched!(hit.id, {
        ...(body.scheduledAt !== undefined ? { scheduledAt: body.scheduledAt as number | null } : {}),
        ...(body.dueAt !== undefined ? { dueAt: body.dueAt as number | null } : {}),
      });
    } else {
      this.broadcast({ t: "tasks", tasks: this.d.board.list().map(taskView) });
    }
    const now = this.d.board.list().find((t) => t.id === hit.id)!;
    json(res, 202, { ok: true, task: taskView(now) });
  }

  // POST /api/task/reorder: drag-drop sibling reprioritisation — { ids: string[] }
  // (an optional parentId must match every card's parent). Priority lands as
  // ids.length - index, so the drop order IS the board order (list() renders
  // priority DESC). One broadcast replaces the PATCH storm a naive per-card
  // swap would produce; cards outside the list keep their old priority and
  // merely interleave around the new ladder. History cards ride along: priority
  // is ordering, not history content.
  private async reorderTasks(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try { body = await this.readJson(req); } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : "bad body" }); return; }
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length < 2 || !ids.every((x): x is string => typeof x === "string" && x.length > 0)) {
      json(res, 400, { error: "ids must be an array of at least two task ids" }); return;
    }
    if (body.parentId !== undefined && body.parentId !== null && typeof body.parentId !== "string") {
      json(res, 400, { error: "parentId must be a task id or null" }); return;
    }
    const byId = new Map(this.d.board.list().map((t) => [t.id, t]));
    const seen = new Set<string>();
    const group: Task[] = [];
    for (const id of ids) {
      if (seen.has(id)) { json(res, 400, { error: `duplicate id ${id}` }); return; }
      seen.add(id);
      const t = byId.get(id);
      if (!t) { json(res, 404, { error: `no such task ${id}` }); return; }
      const parent = t.parentId ?? null;
      if (body.parentId !== undefined && body.parentId !== null && parent !== body.parentId) {
        json(res, 400, { error: `${id} does not belong to the requested parent group` }); return;
      }
      group.push(t);
    }
    if (body.parentId === undefined) {
      const first = group[0]!.parentId ?? null;
      if (group.some((t) => (t.parentId ?? null) !== first)) {
        json(res, 400, { error: "ids must share one parent group; pass parentId to pin it" }); return;
      }
    }
    ids.forEach((id, i) => this.d.board.update(id, { priority: ids.length - i }));
    this.broadcast({ t: "tasks", tasks: this.d.board.list().map(taskView) });
    json(res, 202, { ok: true, ordered: ids.length });
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
    if (sent) { json(res, 202, { ok: true }); return; }
    // takeoverd absent (desktop-less/headless): apply locally instead of a
    // 503 — otherwise the operator can never leave observe and the agent
    // freezes; only a loop handle with neither seam still answers 503
    if (!this.d.loop.setModeLocal) { json(res, 503, { error: "takeover link down" }); return; }
    this.d.loop.setModeLocal(body.mode);
    json(res, 202, { ok: true, local: true });
  }

  // -- Settings CRUD -----------------------------------------------------
  // Safe subset of Config keys the UI may read/write. API key is masked on read.
  private static SETTINGS_KEYS = ["baseUrl", "apiKey", "patrolModel", "decideModel",
    "budgetMode", "dailyTokens", "tickMs", "takeoverUrl", "apiPort", "apiHost", "autonomyGear", "policy", "thinking"] as const;

  private getSettings(res: ServerResponse): void {
    const cfgPath = join(this.d.runtimeDir, "config.json");
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>; } catch { /* first run: empty config */ }
    const safe: Record<string, unknown> = {};
    for (const k of ApiServer.SETTINGS_KEYS) {
      if (k in cfg) safe[k] = k === "apiKey" ? maskKey(String(cfg[k])) : cfg[k];
      else if (k === "policy") safe.policy = "butler"; // effective default — the UI badge needs it even when unset
      else if (k === "thinking") safe.thinking = false; // effective default: thinking OFF until explicitly enabled
    }
    json(res, 200, safe);
  }

  private async putSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try { body = await this.readJson(req); } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : "bad body" }); return; }
    for (const k of Object.keys(body)) {
      if (!(ApiServer.SETTINGS_KEYS as readonly string[]).includes(k)) {
        json(res, 400, { error: `unknown setting: ${k}` }); return;
      }
    }
    for (const numKey of ["dailyTokens", "tickMs", "apiPort", "webhookPort"] as const) {
      const v = body[numKey];
      if (v !== undefined && v !== null && (typeof v !== "number" || !Number.isFinite(v))) {
        json(res, 400, { error: `${numKey} must be a number` }); return;
      }
    }
    for (const strKey of ["baseUrl", "apiKey", "patrolModel", "decideModel", "takeoverUrl", "apiHost", "budgetMode", "autonomyGear", "policy"] as const) {
      const v = body[strKey];
      if (v !== undefined && v !== null && typeof v !== "string") {
        json(res, 400, { error: `${strKey} must be a string` }); return;
      }
    }
    if (body.budgetMode && body.budgetMode !== "burn" && body.budgetMode !== "budgeted") {
      json(res, 400, { error: "budgetMode must be burn|budgeted" }); return;
    }
    if (body.policy !== undefined && body.policy !== null && body.policy !== "butler" && body.policy !== "conservative") {
      json(res, 400, { error: "policy must be butler|conservative" }); return;
    }
    if (body.autonomyGear !== undefined && body.autonomyGear !== null && !isGearId(body.autonomyGear)) {
      json(res, 400, { error: `autonomyGear must be one of ${GEAR_IDS.join("|")}` }); return;
    }
    if (body.thinking !== undefined && body.thinking !== null && typeof body.thinking !== "boolean") {
      json(res, 400, { error: "thinking must be a boolean" }); return;
    }
    const cfgPath = join(this.d.runtimeDir, "config.json");
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>; } catch { /* ok */ }
    if (typeof body.apiKey === "string" && body.apiKey.startsWith("***")) {
      delete body.apiKey;
    }
    Object.assign(cfg, body);
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    // autonomyGear hot-applies (tick retime + WS broadcast) instead of waiting
    // for a restart; gearSwitch re-persists the same value harmlessly
    let note = "Restart ceo-core to apply changes";
    if (isGearId(body.autonomyGear) && this.d.gear && this.d.gear.current() !== body.autonomyGear) {
      try { this.gearSwitch(body.autonomyGear); note = `gear switched to ${body.autonomyGear}`; } catch { /* config already written */ }
    }
    // policy hot-applies the same way: the loop's tool gate flips immediately
    // (butler = full + blacklist, conservative = mode-driven), no restart
    if ((body.policy === "butler" || body.policy === "conservative") && this.d.loop.setPolicy) {
      this.d.loop.setPolicy(body.policy);
    }
    // thinking hot-applies too: the next LLM request (chat stream, patrol,
    // decide) carries the new mode — no restart needed
    if (typeof body.thinking === "boolean" && this.d.llm) {
      this.d.llm.setThinking(body.thinking);
      note = `thinking ${body.thinking ? "enabled" : "disabled"} (live)`;
    }
    json(res, 200, { ok: true, note });
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

function maskKey(key: string): string {
  if (key.length <= 8) return "***";
  return key.slice(0, 4) + "***" + key.slice(-4);
}

function fileStat(p: string): { size: number } | null {
  try { const s = statSync(p); return s.isFile() ? s : null; } catch { return null; }
}
