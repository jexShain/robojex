// packages/ceo-core/src/tools/manager.ts
// ToolManager — the gate in front of every builtin tool call: mode gating
// (observe/assist/full; internal jex-state tools and reads pass observe,
// non-internal writes do not), sensitive-path interception, output truncation,
// checkFn caching, and the assist-mode approval queue (hermes write_approval
// semantics: writes wait for a human yes/no delivered over chat).
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ToolCtx, ToolEntry } from "./registry.js";
import { ToolRegistry } from "./registry.js";
import { fileTools } from "./file.js";
import { terminalTools } from "./terminal.js";
import { jobsTools } from "./jobs.js";
import { boardTools, miscBridges } from "./bridges.js";

export const OUT_LIMIT = 8192;

// hermes file_safety list + jex's own secret store. The runtime config is
// matched by exact equality against <runtimeDir>/config.json below — a bare
// config.json$ regex would refuse every project's own config file.
const SENSITIVE = [
  /(^|[\\/])\.git-credentials$/i,
  /(^|[\\/])\.aws[\\/]credentials$/i,
  /(^|[\\/])\.ssh[\\/]/i,
  /(^|[\\/])\.env[^\\/]*$/i,
];

export type Gate = "observe" | "assist" | "full";

/* ───────────── hard blacklist (SPEC-BUTLER §1) ─────────────
 * Policy buys autonomy, never the right to delete files or rewrite the OS.
 * These refusals apply at EVERY gate under EVERY policy, before any approval
 * logic — butler's full gate still answers "no" here. */

// deletion-class commands: the first token of a terminal command (basename of
// an absolute path, case-insensitive, .exe stripped) must never be one of these
const DELETE_COMMANDS = new Set(["rm", "rmdir", "del", "erase", "shred", "unlink", "remove-item"]);

// privilege-escalation heads: `sudo rm …` slips past the head check (the head
// is sudo, not rm) — an escalated deletion or an escalated touch on a system
// directory is exactly the user's red line (no deletions, no system-config
// rewrites), no matter how politely it is asked for
const PRIVILEGE_HEADS = new Set(["sudo", "doas", "pkexec", "runas"]);

/** First token of a shell command line: /bin/rm -> rm, C:\tools\rm.exe -> rm.
 *  Env assignments and options are not special-cased — the head is the head. */
export function commandHead(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const base = first.split(/[\\/]/).pop() ?? first;
  return base.toLowerCase().replace(/\.exe$/i, "");
}

// system directories no jex write may touch: unix FHS + the Windows twins.
// Matched on forward-slash, lowercased forms with a path-boundary check.
const SYSTEM_DIRS = ["/etc", "/usr", "/bin", "/sbin", "/boot", "/sys", "/proc", "/dev", "c:/windows", "c:/program files", "c:/program files (x86)"];

function inSystemDir(fwdLower: string): boolean {
  return SYSTEM_DIRS.some((d) => fwdLower === d || fwdLower.startsWith(d + "/"));
}

/** Every terminal-command red line in one place (shared by the terminal tool
 *  and job_start so background jobs cannot sidestep the foreground rules):
 *  deletion-class heads, privilege-escalated deletions, and privilege-
 *  escalated writes into system directories. Returns the refusal text, or
 *  null when the command is within the autonomy grant. */
export function commandBlackline(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  const head = commandHead(command);
  if (head && DELETE_COMMANDS.has(head)) {
    return `blocked destructive command: ${tokens[0]} (deletions are off-limits — delegate cleanup to the human)`;
  }
  if (head && PRIVILEGE_HEADS.has(head)) {
    const next = commandHead(tokens.slice(1).join(" ") || "x"); // x: bare sudo never matches
    if (DELETE_COMMANDS.has(next)) {
      return `blocked privileged deletion: ${tokens[0]} ${tokens[1] ?? ""} (escalation does not buy the right to delete)`;
    }
    // scan with /dev/null elided — it is universal plumbing (2>/dev/null),
    // not a system-dir write; every other system-path mention under an
    // escalation head is treated as the config-rewrite red line
    const fwdLower = command.replaceAll("\\", "/").toLowerCase().replaceAll("/dev/null", " ");
    if (SYSTEM_DIRS.some((d) => fwdLower.includes(d + "/") || fwdLower.includes(d + " "))) {
      return `blocked privileged system-dir write: ${tokens.slice(0, 3).join(" ")} (system config is off-limits even escalated)`;
    }
  }
  return null;
}

export function P1_TOOLS(): ToolEntry[] {
  return [...fileTools(), ...terminalTools(), ...jobsTools(), ...boardTools(), ...miscBridges()];
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
    try {
      const ok = e.checkFn();
      this.cache.set(e.name, { ok, ts: now });
      return ok;
    } catch {
      return false;
    }
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

  /** Available tool names (R84b: the action loop routes bare tool-name actions
   *  — {"type":"job_start",...} — onto tool_call using this list). */
  names(): string[] {
    return this.opts.registry.entries().filter((e) => this.available(e)).map((e) => e.schema.name);
  }

  // Normalize path for sensitive-path detection
  private normalizePath(p: string): string {
    const withHome = p.replace(/^~(?=\/|\\)/, homedir());
    return resolve(withHome);
  }

  // sensitive-path scan: any string arg that names a forbidden file is refused
  private guardPaths(name: string, args: Record<string, unknown>): string | null {
    const runtimeCfg = resolve(this.opts.ctx.runtimeDir, "config.json");
    for (const v of Object.values(args)) {
      if (typeof v !== "string") continue;
      // Check both original and normalized forms against sensitive patterns
      const normalized = this.normalizePath(v);
      for (const check of [v, normalized]) {
        if (SENSITIVE.some((rx) => rx.test(check)) || check === runtimeCfg) {
          return `blocked sensitive path: ${v} (tool ${name} refused; secrets are off-limits)`;
        }
      }
    }
    return null;
  }

  // hard blacklist: destructive terminal heads and system-dir write targets
  // are refused under every policy and every gate — autonomy never buys these.
  // Both the raw and the resolved path are checked, so "C:\Windows\..." and
  // "~/etc" style forms cannot dodge via separator or case games.
  private hardBlacklist(name: string, args: Record<string, unknown>): string | null {
    if (name === "terminal" && typeof args.command === "string") {
      const refusal = commandBlackline(args.command);
      if (refusal) return `${refusal} (tool terminal refused)`;
    }
    if ((name === "write_file" || name === "patch") && typeof args.path === "string") {
      for (const form of [args.path, this.normalizePath(args.path)]) {
        if (inSystemDir(form.replaceAll("\\", "/").toLowerCase())) {
          return `blocked system path: ${args.path} (tool ${name} refused; system directories are off-limits)`;
        }
      }
    }
    return null;
  }

  async call(name: string, args: Record<string, unknown>, gate: Gate): Promise<string> {
    const e = this.opts.registry.get(name);
    if (!e) return `error: unknown tool '${name}' — available: ${this.opts.registry.names().join(", ")}`;
    // observe protects the user's system, not jex itself: internal tools
    // (board/memory — jex-own, reversible) and read-class tools still run;
    // only non-internal writes are frozen until the gate is raised
    if (gate === "observe" && e.writes && !e.internal) {
      return `error: observe mode: write-class tool '${name}' refused — observe only watches (switch to assist/full first)`;
    }
    if (!this.available(e)) return `error: tool '${name}' is not available in this environment`;
    const blocked = this.guardPaths(name, args);
    if (blocked) return `error: ${blocked}`;
    const hard = this.hardBlacklist(name, args);
    if (hard) return `error: ${hard}`;
    // internal writes skip the assist approval round: they touch no user system
    if (e.writes && !e.internal && gate === "assist") {
      // dedupe: a loop stuck on one blocked task re-requests the same call
      // every cycle; hand back the existing pending id instead of stacking
      // clones (they'd all expire the 50-slot queue and bury the human in
      // stale approval prompts)
      const argsKey = JSON.stringify(args);
      for (const [existingId, p] of this.pending) {
        if (p.entry === e && JSON.stringify(p.args) === argsKey) {
          return `needs-approval ${existingId} (already pending): '${name}' — reply 'approve ${existingId}' or 'deny ${existingId}'`;
        }
      }
      const id = randomUUID().slice(0, 8);
      this.pending.set(id, { entry: e, args });
      // Cap pending approvals at 50 entries; evict oldest if exceeded
      if (this.pending.size > 50) {
        const firstKey = this.pending.keys().next().value;
        if (firstKey) this.pending.delete(firstKey);
      }
      return `needs-approval ${id}: '${name}' is a write-class tool under assist mode — ask the human to reply 'approve ${id}' or 'deny ${id}'`;
    }
    try {
      return truncate(await e.handler(args, this.opts.ctx));
    } catch (err) {
      return `error: ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  pendingApprovals(): string[] { return [...this.pending.keys()]; }

  async resolveApproval(id: string, ok: boolean, gate?: Gate): Promise<string | null> {
    const p = this.pending.get(id);
    if (!p) return null;
    this.pending.delete(id);
    if (!ok) return `denied ${id}: '${p.entry.name}' cancelled by the human`;
    // Re-check mode gate when gate is explicitly provided
    if (gate === "observe") return `denied ${id}: observe mode re-checked`;
    // Verify tool is still available before executing (bypass cache for fresh check)
    if (p.entry.checkFn) {
      try {
        if (!p.entry.checkFn()) return `error: tool no longer available`;
      } catch {
        return `error: tool no longer available`;
      }
    }
    try {
      return truncate(await p.entry.handler(p.args, this.opts.ctx));
    } catch (err) {
      return `error: ${p.entry.name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
