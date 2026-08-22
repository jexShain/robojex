// packages/ceo-core/src/tools/registry.ts
// Tool registry — semantic port of hermes-agent tools/registry.py: tools
// self-register with name, toolset, JSON schema, handler, and an optional
// checkFn gating schema exposure by runtime availability.
import type { TaskBoard } from "../board.js";

export interface ToolParam { type: string; description: string; enum?: string[]; default?: unknown }

export interface ToolSchema {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, ToolParam>; required?: string[] };
}

// Everything a tool handler may reach: injected by assembleAndStart, kept
// interface-shaped so tests substitute fakes without spinning up ceo-core.
export interface ToolCtx {
  runtimeDir: string;
  board: Pick<TaskBoard, "add" | "update" | "list">;
  spawn: (framework: string, prompt: string) => Promise<{ exitCode: number; summary: string }>;
  skillsDir: string;
  takeoverSend: (frame: Record<string, unknown>) => void;
  chatOut: (from: "system", text: string) => void;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolCtx) => Promise<string>;

export interface ToolEntry {
  name: string;
  toolset: string;
  schema: ToolSchema;
  handler: ToolHandler;
  checkFn?: () => boolean; // absent = always available
  writes?: boolean;        // write-class: approval-gated under assist mode
  internal?: boolean;      // jex-own state (board, memory, todo): reversible, touches
                           // no user system — runs under observe, skips assist approval
}

export class ToolRegistry {
  private byName = new Map<string, ToolEntry>();
  register(e: ToolEntry): void { this.byName.set(e.name, e); }
  entries(): ToolEntry[] { return [...this.byName.values()]; }
  get(name: string): ToolEntry | undefined { return this.byName.get(name); }
  names(): string[] { return [...this.byName.keys()]; }
}
