// packages/takeoverd/src/server.ts
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { ModeStateMachine, Mode } from "./modes.js";
import { classifyRisk } from "./input.js";
import type { InputInjector, InputAction } from "./input.js";
import { grabGray } from "./screen.js";
import type { ScreenPipeline } from "./screen.js";
import type { HotkeyWatcher } from "./hotkey.js";

type Msg = Record<string, unknown> & { t?: string };
type InjectResult = "done" | "blocked-observe" | "blocked-hard" | "needs-approval";

export interface ServerDeps {
  modes: ModeStateMachine;
  injector: InputInjector | null;
  screen: ScreenPipeline | null;
  hotkey: HotkeyWatcher | null;
  port?: number;
  approvalTimeoutMs?: number;
}

export class TakeoverServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private pending = new Map<string, { action: InputAction; timer: NodeJS.Timeout }>();
  constructor(private deps: ServerDeps) {}

  private broadcast(msg: Msg): void {
    const s = JSON.stringify(msg);
    for (const c of this.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
  }

  // Same gate as InputInjector.exec, applied server-side so the approval flow
  // works even before the real injector is wired (deps.injector === null).
  private async tryExec(action: InputAction, approved: boolean): Promise<InjectResult> {
    if (!this.deps.modes.canInject()) return "blocked-observe";
    const risk = classifyRisk(action);
    if (risk === "hard") return "blocked-hard";
    if (!approved && risk === "high" && this.deps.modes.needsApproval()) return "needs-approval";
    if (!this.deps.injector) return "done";
    return this.deps.injector.exec(action, approved);
  }

  async start(port: number): Promise<void> {
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
    this.deps.hotkey?.onToggle(() => {
      this.deps.modes.next();
      this.broadcast({ t: "evt", type: "mode_changed", mode: this.deps.modes.current });
    });
    this.deps.screen?.onEvent((e) => this.broadcast({ t: "evt", ...e }));
    await new Promise<void>((res) => this.wss!.once("listening", res));
  }

  private async handle(ws: WebSocket, m: Msg): Promise<void> {
    if (m.t === "human") { this.broadcast({ t: "human", text: m.text }); return; }
    if (m.t !== "ctrl") return;
    if (m.op === "set_mode") {
      // modes.set throws on unknown mode; the throw is swallowed by the
      // message wrapper and the invalid request simply never broadcasts
      this.deps.modes.set(m.mode as Mode);
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
  }

  async stop(): Promise<void> {
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    const wss = this.wss; this.wss = null;
    if (wss) await new Promise<void>((res) => wss.close(() => res()));
    for (const c of this.clients) c.close();
    this.clients.clear();
  }
}
