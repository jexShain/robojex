// packages/ceo-core/src/tools/manager.ts
// ToolManager — the gate in front of every builtin tool call: mode gating
// (observe/assist/full), sensitive-path interception, output truncation,
// checkFn caching, and the assist-mode approval queue (hermes write_approval
// semantics: writes wait for a human yes/no delivered over chat).
import { randomUUID } from "node:crypto";
import type { ToolCtx, ToolEntry } from "./registry.js";
import { ToolRegistry } from "./registry.js";
import { fileTools } from "./file.js";
import { terminalTools } from "./terminal.js";
import { boardTools, miscBridges } from "./bridges.js";

export const OUT_LIMIT = 8192;

// hermes file_safety list + jex's own secret store
const SENSITIVE = [/\.git-credentials$/i, /[\\/]\.aws[\\/]credentials$/i, /[\\/]\.ssh[\\/]/i, /[\\/]runtime[\\/]config\.json$/i, /(^|[\\/])\.env(\.|$)/i];

export type Gate = "observe" | "assist" | "full";

export function P1_TOOLS(): ToolEntry[] {
  return [...fileTools(), ...terminalTools(), ...boardTools(), ...miscBridges()];
}

function truncate(s: string): string {
  return s.length <= OUT_LIMIT ? s : s.slice(0, OUT_LIMIT) + "\n...[truncated]";
}

export class ToolManager {
  private cache = new Map<string, { ok: boolean; ts: number }>();
  private pending = new Map<string, { entry: ToolEntry; args: Record<string, unknown> }>();

  constructor(private opts: { registry: ToolRegistry; ctx: ToolCtx }) {}

  private available(e: ToolEntry): boolean {
    if (!e.checkFn) return true;
    const hit = this.cache.get(e.name);
    const now = Date.now();
    if (hit && now - hit.ts < 30_000) return hit.ok;
    const ok = e.checkFn();
    this.cache.set(e.name, { ok, ts: now });
    return ok;
  }

  schemasBlock(): string {
    const lines = this.opts.registry.entries()
      .filter((e) => this.available(e))
      .map((e) => {
        const req = e.schema.parameters.required ?? [];
        const params = Object.entries(e.schema.parameters.properties).map(([k, v]) => `${k}:${v.type}${req.includes(k) ? "" : "?"}`).join(", ");
        return `${e.schema.name}(${params}) — ${e.schema.description}`;
      });
    return lines.length ? `# BUILTIN TOOLS\ninvoke via {"type":"tool_call","tool":"<name>","args":{...}}\n${lines.join("\n")}` : "";
  }

  // sensitive-path scan: any string arg that names a forbidden file is refused
  private guardPaths(name: string, args: Record<string, unknown>): string | null {
    const runtimeDir = this.opts.ctx.runtimeDir;
    for (const v of Object.values(args)) {
      if (typeof v !== "string") continue;
      // Block runtimeDir/config.json explicitly
      if (v === runtimeDir + "/config.json" || v === runtimeDir + "\\config.json") {
        return `blocked sensitive path: ${v} (tool ${name} refused; secrets are off-limits)`;
      }
      if (SENSITIVE.some((rx) => rx.test(v))) return `blocked sensitive path: ${v} (tool ${name} refused; secrets are off-limits)`;
    }
    return null;
  }

  async call(name: string, args: Record<string, unknown>, gate: Gate): Promise<string> {
    const e = this.opts.registry.get(name);
    if (!e) return `error: unknown tool '${name}' — available: ${this.opts.registry.names().join(", ")}`;
    if (gate === "observe") return `error: observe mode: tool calls disabled (switch to assist/full first)`;
    if (!this.available(e)) return `error: tool '${name}' is not available in this environment`;
    const blocked = this.guardPaths(name, args);
    if (blocked) return `error: ${blocked}`;
    if (e.writes && gate === "assist") {
      const id = randomUUID().slice(0, 8);
      this.pending.set(id, { entry: e, args });
      return `needs-approval ${id}: '${name}' is a write-class tool under assist mode — ask the human to reply 'approve ${id}' or 'deny ${id}'`;
    }
    try {
      return truncate(await e.handler(args, this.opts.ctx));
    } catch (err) {
      return `error: ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  pendingApprovals(): string[] { return [...this.pending.keys()]; }

  async resolveApproval(id: string, ok: boolean): Promise<string | null> {
    const p = this.pending.get(id);
    if (!p) return null;
    this.pending.delete(id);
    if (!ok) return `denied ${id}: '${p.entry.name}' cancelled by the human`;
    try {
      return truncate(await p.entry.handler(p.args, this.opts.ctx));
    } catch (err) {
      return `error: ${p.entry.name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
