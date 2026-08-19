// packages/takeoverd/src/server.ts
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { ModeStateMachine, Mode } from "./modes.js";
import { classifyRisk } from "./input.js";
import type { InputInjector, InputAction } from "./input.js";
import { grabGray, type DiffEvent } from "./screen.js";
import type { ScreenPipeline } from "./screen.js";
import type { HotkeyWatcher } from "./hotkey.js";
import type { CdpChannel } from "./cdp.js";

type Msg = Record<string, unknown> & { t?: string };
type InjectResult = "done" | "blocked-observe" | "blocked-hard" | "needs-approval" | "human-active";

export interface ServerDeps {
  modes: ModeStateMachine;
  injector: InputInjector | null;
  screen: ScreenPipeline | null;
  hotkey: HotkeyWatcher | null;
  cdp?: CdpChannel | null; // null / absent: cdp signaling is a no-op
  port?: number;
  approvalTimeoutMs?: number;
}
export class TakeoverServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private pending = new Map<string, { action: InputAction; timer: NodeJS.Timeout }>();
  // Listener-dedupe handles: hotkey/screen expose no off(), so a second
  // start() would stack a second callback and double-fire every event.
  private toggleCb: (() => void) | null = null;
  private screenCb: ((e: DiffEvent) => void) | null = null;
  constructor(private deps: ServerDeps) {}

  private broadcast(msg: Msg): void {
    const s = JSON.stringify(msg);
    for (const c of this.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
  }

  // Same gate as InputInjector.exec, applied server-side so the approval flow
  // works even before the real injector is wired (deps.injector === null).
  private async tryExec(action: InputAction, approved: boolean): Promise<InjectResult> {
    if (!this.deps.modes.canInject()) return "blocked-observe";
    // Mirror gate: refuse unknown kinds same batch as classifyRisk hard
    if (!["key", "move", "click", "type"].includes(action.kind)) return "blocked-hard";
    const risk = classifyRisk(action);
    if (risk === "hard") return "blocked-hard";
    if (!approved && risk === "high" && this.deps.modes.needsApproval()) return "needs-approval";
    if (!this.deps.injector) return "done";
    return this.deps.injector.exec(action, approved);
  }
  async start(port: number): Promise<void> {
    // Re-entry guard: a second start() tears the previous listener down
    // first instead of throwing (EADDRINUSE) — double-boot recovers cleanly.
    if (this.wss) await this.stop();
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      ws.on("message", (raw) => {
        // a malformed frame from one client must never kill the daemon
        let m: Msg;
        try { m = JSON.parse(String(raw)) as Msg; } catch { return; }
        this.handle(ws, m).catch(() => {});
      });
    });
    if (!this.toggleCb) {
      this.toggleCb = () => {
        this.deps.modes.next();
        this.applyPolling();
        this.broadcast({ t: "evt", type: "mode_changed", mode: this.deps.modes.current });
      };
      this.deps.hotkey?.onToggle(this.toggleCb);
    }
    if (!this.screenCb) {
      this.screenCb = (e) => this.broadcast({ t: "evt", ...e });
      this.deps.screen?.onEvent(this.screenCb);
    }
    this.applyPolling();
    await new Promise<void>((res) => this.wss!.once("listening", res));
  }

  // observe continuously diffs the screen at 1 fps; assist/full poll on jex
  // request only (screenshot op) — polling follows every mode transition.
  private applyPolling(): void {
    this.deps.screen?.setPolling(this.deps.modes.current === "observe");
  }

  private async handle(ws: WebSocket, m: Msg): Promise<void> {
    try {
      await this.dispatch(m);
    } catch {
      // a throwing handler (e.g. injector.exec rejecting on a missing
      // xdotool) must still answer the requester instead of silence
      if (typeof m.id === "string") {
        this.broadcast({ t: "evt", type: "input_result", id: m.id, result: "error" });
      }
    }
  }

  private async dispatch(m: Msg): Promise<void> {
    if (m.t === "human") { this.broadcast({ t: "human", text: m.text }); return; }
    if (m.t !== "ctrl") return;
    if (m.op === "set_mode") {
      // modes.set throws on unknown mode; the throw is swallowed by handle's
      // catch and the invalid request simply never broadcasts
      this.deps.modes.set(m.mode as Mode);
      this.applyPolling();
      this.broadcast({ t: "evt", type: "mode_changed", mode: m.mode });
      return;
    }
    if (m.op === "approve") {
      if (typeof m.id !== "string") return;
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer); this.pending.delete(m.id);
      if (m.ok) {
        const r = await this.tryExec(p.action, true);
        this.broadcast({ t: "evt", type: "input_result", id: m.id, result: r });
      } else {
        this.broadcast({ t: "evt", type: "input_result", id: m.id, result: "denied" });
      }
      return;
    }
    if (m.op === "input") {
      const action = m.action as InputAction;
      const id: string = typeof m.id === "string" ? m.id : randomUUID();
      const r = await this.tryExec(action, false);
      if (r === "needs-approval") {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.broadcast({ t: "evt", type: "input_result", id, result: "timeout-denied" });
        }, this.deps.approvalTimeoutMs ?? 60_000);
        // a reused id must not leave the old timer armed — the orphan would
        // later delete this new entry and broadcast a bogus timeout-denied
        const prev = this.pending.get(id);
        if (prev) clearTimeout(prev.timer);
        this.pending.set(id, { action, timer });
        this.broadcast({ t: "evt", type: "approval", id, action });
      } else {
        this.broadcast({ t: "evt", type: "input_result", id, result: r });
      }
      return;
    }
    if (m.op === "screenshot" && this.deps.screen) {
      const g = await grabGray(64, 36);
      this.broadcast({ t: "evt", type: "screenshot_gray", w: 64, h: 36, data: Array.from(g) });
      return;
    }
    // cdp browsing drives the live desktop: observe mode gates it exactly like
    // input injection, and the refusal is broadcast — never silence
    if ((m.op === "cdp_open" || m.op === "cdp_snapshot") && !this.deps.modes.canInject()) {
      this.broadcast({ t: "evt", type: "cdp_result", op: m.op, result: "blocked-observe" });
      return;
    }
    if (m.op === "cdp_open" && this.deps.cdp) {
      const url = typeof m.url === "string" ? m.url : "";
      // a rejected cdp call still answers everyone — never silence
      const result = await this.deps.cdp.open(url)
        .catch((e: unknown) => `cdp-error: ${e instanceof Error ? e.message : String(e)}`);
      this.broadcast({ t: "evt", type: "cdp_result", op: "cdp_open", url, result });
      return;
    }
    if (m.op === "cdp_snapshot" && this.deps.cdp) {
      const result = await this.deps.cdp.snapshot()
        .catch((e: unknown) => `cdp-error: ${e instanceof Error ? e.message : String(e)}`);
      this.broadcast({ t: "evt", type: "cdp_result", op: "cdp_snapshot", result });
      return;
    }
  }

  async stop(): Promise<void> {
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    // wss.close() delegates to the http server, whose close callback only
    // fires once every connection is gone — Node never drops live sockets on
    // its own, so stop() would hang with any connected client. Close each
    // client first; terminate() (a no-op on already-closed sockets) backstops
    // a stalled close handshake. The timer is unref'd so it can never hold
    // the process open after shutdown.
    for (const c of this.clients) {
      c.close();
      setTimeout(() => c.terminate(), 500).unref();
    }
    this.clients.clear();
    const wss = this.wss; this.wss = null;
    if (wss) await new Promise<void>((res) => wss.close(() => res()));
  }
}
