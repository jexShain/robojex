// packages/ceo-core/src/tools/bridges.ts
// Bridge tools — hermes tool names mapped onto jex-native subsystems instead
// of reimplementing them: kanban/todo → TaskBoard, memory → MEMORY.md,
// skills → skills/, delegate_task → orchestrator, computer_use → takeoverd.
import { existsSync, readFileSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolEntry, ToolCtx } from "./registry.js";
import type { Task } from "../board.js";

const COLUMN_STATUS: Record<string, Task["status"]> = { todo: "todo", doing: "running", done: "done", blocked: "blocked" };
const STATUS_COLUMN: Record<Task["status"], string> = { todo: "todo", running: "doing", done: "done", blocked: "blocked" };

// task_id accepted under hermes' alias too (todo uses task_id, kanban card_id)
function findCard(ctx: ToolCtx, raw: unknown): Task | undefined {
  const id = String(raw ?? "");
  if (!id) return undefined;
  return ctx.board.list().find((t) => t.id === id || t.id.startsWith(id));
}

async function todo(args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const action = String(args.action ?? "");
  if (action === "add") {
    const title = String(args.title ?? "");
    if (!title) return "error: title required";
    const t = ctx.board.add({ title });
    return `added ${t.id}: ${title}`;
  }
  if (action === "list") {
    const rows = ctx.board.list().map((t) => `- [${t.status}] ${t.id.slice(0, 8)} ${t.title}`);
    return rows.length ? rows.join("\n") : "(board empty)";
  }
  if (action === "complete") {
    const t = findCard(ctx, args.task_id);
    if (!t) return `error: task not found: ${String(args.task_id)}`;
    ctx.board.update(t.id, { status: "done" });
    return `done: ${t.title}`;
  }
  return `error: invalid action '${action}' — supported: add, list, complete`;
}

async function kanbanCreate(args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const title = String(args.title ?? "");
  if (!title) return "error: title required";
  const column = String(args.column ?? "todo");
  const status = COLUMN_STATUS[column];
  if (!status) return `error: column must be one of todo/doing/done/blocked (got '${column}')`;
  const t = ctx.board.add({ title });
  if (status !== "todo") ctx.board.update(t.id, { status });
  return `created ${t.id} in ${column}: ${title}`;
}

const cardLine = (t: Task) => `- [${STATUS_COLUMN[t.status]}] ${t.id.slice(0, 8)} ${t.title}${t.resultSummary ? ` — ${t.resultSummary.slice(0, 80)}` : ""}`;

function kanbanGroup(ctx: ToolCtx): string {
  const cols: Record<string, string[]> = { todo: [], doing: [], blocked: [], done: [] };
  for (const t of ctx.board.list()) cols[STATUS_COLUMN[t.status]].push(cardLine(t));
  return (["todo", "doing", "blocked", "done"] as const).map((c) => `## ${c}\n${cols[c].join("\n") || "(empty)"}`).join("\n");
}

function withCard(ctx: ToolCtx, rawId: unknown, fn: (t: Task) => string): string {
  const t = findCard(ctx, rawId);
  if (!t) return `error: card not found: ${String(rawId)}`;
  return fn(t);
}

export function boardTools(): ToolEntry[] {
  const boardSchema = (name: string, description: string, props: Record<string, { type: string; description: string; enum?: string[] }>, required: string[]): ToolEntry => ({
    name, toolset: "kanban", writes: true, handler: (a, ctx) => boardDispatch(name, a, ctx),
    schema: { name, description, parameters: { type: "object", properties: props, required } },
  });
  // single dispatch keeps every kanban variant visible in one switch
  const boardDispatch = async (name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<string> => {
    switch (name) {
      case "kanban_create": return kanbanCreate(args, ctx);
      case "kanban_list": return kanbanGroup(ctx);
      case "kanban_show": return withCard(ctx, args.card_id, (t) => `${t.id} [${STATUS_COLUMN[t.status]}] ${t.title}\nattempts=${t.attempts} created=${new Date(t.createdAt).toISOString()}${t.resultSummary ? `\nnotes: ${t.resultSummary}` : ""}`);
      case "kanban_complete": return withCard(ctx, args.card_id, (t) => { ctx.board.update(t.id, { status: "done" }); return `done: ${t.title}`; });
      case "kanban_block": return withCard(ctx, args.card_id, (t) => { ctx.board.update(t.id, { status: "blocked", resultSummary: [t.resultSummary, `blocked: ${String(args.reason ?? "")}`].filter(Boolean).join(" | ") }); return `blocked: ${t.title}`; });
      case "kanban_unblock": return withCard(ctx, args.card_id, (t) => { ctx.board.update(t.id, { status: "todo", resultSummary: t.resultSummary.replace(/blocked: [^|]*\|?/g, "").trim() }); return `unblocked: ${t.title}`; });
      case "kanban_comment": return withCard(ctx, args.card_id, (t) => { const text = String(args.text ?? ""); if (!text) return "error: text required"; ctx.board.update(t.id, { resultSummary: [t.resultSummary, text].filter(Boolean).join(" | ") }); return `commented on ${t.title}`; });
      case "kanban_heartbeat": return withCard(ctx, args.card_id, (t) => `alive: ${t.title} [${STATUS_COLUMN[t.status]}] attempts=${t.attempts}`);
      case "kanban_request_review": return withCard(ctx, args.card_id, (t) => { ctx.chatOut("system", `review requested: ${t.title} (${t.id.slice(0, 8)})`); return `review requested for ${t.title}`; });
      case "kanban_request_changes": return withCard(ctx, args.card_id, (t) => { ctx.board.update(t.id, { status: "blocked", attempts: t.attempts + 1, resultSummary: [t.resultSummary, `changes requested: ${String(args.notes ?? "")}`].filter(Boolean).join(" | ") }); return `changes requested on ${t.title}`; });
      case "kanban_link": case "kanban_attach": return withCard(ctx, args.card_id, (t) => { const url = String(args.url ?? args.text ?? ""); if (!url) return "error: url required"; ctx.board.update(t.id, { resultSummary: [t.resultSummary, `attach: ${url}`].filter(Boolean).join(" | ") }); return `attached to ${t.title}: ${url}`; });
      case "kanban_attach_url": return withCard(ctx, args.card_id, (t) => { const url = String(args.url ?? ""); if (!url) return "error: url required"; ctx.board.update(t.id, { resultSummary: [t.resultSummary, `attach: ${url}`].filter(Boolean).join(" | ") }); return `attached ${url} to ${t.title}`; });
      case "kanban_attachments": return withCard(ctx, args.card_id, (t) => { const att = (t.resultSummary.match(/attach: \S+/g) ?? []).map((s) => `- ${s.slice(8)}`).join("\n"); return att || "(no attachments)"; });
      default: return `error: unknown tool ${name}`;
    }
  };
  return [
    { name: "todo", toolset: "todo", writes: true, handler: todo,
      schema: { name: "todo", description: "Lightweight personal todo list backed by the task board.", parameters: { type: "object", properties: { action: { type: "string", description: "What to do", enum: ["add", "list", "complete"] }, title: { type: "string", description: "Task title (action='add')" }, task_id: { type: "string", description: "Task id (action='complete'; unique prefix works)" } }, required: ["action"] } } },
    boardSchema("kanban_create", "Create a kanban card in a column (todo/doing/done/blocked).", { title: { type: "string", description: "Card title" }, column: { type: "string", description: "Column", enum: ["todo", "doing", "done", "blocked"] } }, ["title"]),
    boardSchema("kanban_list", "Show the whole board grouped by column.", {}, []),
    boardSchema("kanban_show", "Show one card with status and notes.", { card_id: { type: "string", description: "Card id (unique prefix works)" } }, ["card_id"]),
    boardSchema("kanban_complete", "Mark a card done.", { card_id: { type: "string", description: "Card id" } }, ["card_id"]),
    boardSchema("kanban_block", "Mark a card blocked with a reason.", { card_id: { type: "string", description: "Card id" }, reason: { type: "string", description: "Why it is blocked" } }, ["card_id"]),
    boardSchema("kanban_unblock", "Reopen a blocked card.", { card_id: { type: "string", description: "Card id" } }, ["card_id"]),
    boardSchema("kanban_comment", "Append a note to a card.", { card_id: { type: "string", description: "Card id" }, text: { type: "string", description: "Note text" } }, ["card_id", "text"]),
    boardSchema("kanban_heartbeat", "Signal this card's worker is still alive.", { card_id: { type: "string", description: "Card id" } }, ["card_id"]),
    boardSchema("kanban_request_review", "Ask the human to review a card.", { card_id: { type: "string", description: "Card id" } }, ["card_id"]),
    boardSchema("kanban_request_changes", "Report that a card needs rework.", { card_id: { type: "string", description: "Card id" }, notes: { type: "string", description: "What must change" } }, ["card_id"]),
    boardSchema("kanban_link", "Attach a link/note to a card (alias of kanban_attach).", { card_id: { type: "string", description: "Card id" }, url: { type: "string", description: "Link to attach" } }, ["card_id", "url"]),
    boardSchema("kanban_attach", "Attach a link to a card.", { card_id: { type: "string", description: "Card id" }, url: { type: "string", description: "Link" } }, ["card_id", "url"]),
    boardSchema("kanban_attach_url", "Attach a URL to a card.", { card_id: { type: "string", description: "Card id" }, url: { type: "string", description: "URL" } }, ["card_id", "url"]),
    boardSchema("kanban_attachments", "List a card's attachments.", { card_id: { type: "string", description: "Card id" } }, ["card_id"]),
  ];
}

// ---- misc bridges: memory / skills / delegate / computer_use ----

async function memory(args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const action = String(args.action ?? "read");
  const p = join(ctx.runtimeDir, "MEMORY.md");
  if (action === "read") return existsSync(p) ? readFileSync(p, "utf8") : "(memory empty)";
  if (action === "append") {
    const content = String(args.content ?? "");
    if (!content) return "error: content required";
    appendFileSync(p, `${content}\n`);
    return `remembered: ${content.slice(0, 80)}`;
  }
  return `error: invalid action '${action}' — supported: append, read`;
}

async function skillView(args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const name = String(args.name ?? "");
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) return `error: invalid name '${name}' — letters/digits/dashes only`;
  const p = join(ctx.skillsDir, `${name}.md`);
  if (!existsSync(p)) {
    const have = readdirSync(ctx.skillsDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
    return `error: no skill '${name}' — available: ${have.join(", ") || "(none)"}`;
  }
  return readFileSync(p, "utf8");
}

export function miscBridges(): ToolEntry[] {
  return [
    { name: "memory", toolset: "memory", writes: true, handler: memory,
      schema: { name: "memory", description: "Long-lived memory: append durable facts (read by every future decision cycle) or read them back.", parameters: { type: "object", properties: { action: { type: "string", description: "append or read", enum: ["append", "read"] }, content: { type: "string", description: "The fact to remember (action='append')" } }, required: ["action"] } } },
    { name: "skills_list", toolset: "skills", writes: false, handler: async (_a, ctx) => readdirSync(ctx.skillsDir).filter((f) => f.endsWith(".md")).map((f) => `- ${f.slice(0, -3)}`).join("\n") || "(no skills)",
      schema: { name: "skills_list", description: "List the agent framework manuals available to delegate to.", parameters: { type: "object", properties: {} } } },
    { name: "skill_view", toolset: "skills", writes: false, handler: skillView,
      schema: { name: "skill_view", description: "Read one framework manual (how to invoke, strengths, failure modes).", parameters: { type: "object", properties: { name: { type: "string", description: "Skill name from skills_list" } }, required: ["name"] } } },
    { name: "skill_manage", toolset: "skills", writes: true, handler: async () => "error: skill_manage is not available in jex — register agents via the agent registry instead",
      schema: { name: "skill_manage", description: "Reserved: jex manages frameworks through the agent registry, not skill files. Always returns guidance.", parameters: { type: "object", properties: {} } } },
    { name: "delegate_task", toolset: "delegation", writes: true, handler: async (args, ctx) => {
      const framework = String(args.framework ?? "hermes");
      const prompt = String(args.prompt ?? "");
      if (!prompt) return "error: prompt required";
      const r = await ctx.spawn(framework, prompt);
      return `delegated to ${framework}: exit=${r.exitCode} ${r.summary}`;
    },
      schema: { name: "delegate_task", description: "Hand a task to a sub-agent framework (hermes/claude-code) and wait for its summary. For long or heavy jobs; small file/terminal work needs no delegation.", parameters: { type: "object", properties: { framework: { type: "string", description: "Agent name (hermes, claude-code)" }, prompt: { type: "string", description: "Full task prompt for the sub-agent" } }, required: ["framework", "prompt"] } } },
    { name: "computer_use", toolset: "computer_use", writes: true, handler: async (args, ctx) => {
      const action = String(args.action ?? "");
      const send = (a: Record<string, unknown>) => ctx.takeoverSend({ t: "ctrl", op: "input", id: randomUUID(), action: a });
      switch (action) {
        case "screenshot": ctx.takeoverSend({ t: "ctrl", op: "screenshot", id: randomUUID() }); return "screenshot requested — the screen stream carries the frame";
        case "key": if (!args.key) return "error: key required (e.g. 'Return', 'ctrl shift t')"; send({ kind: "key", key: String(args.key) }); return `sent key ${args.key}`;
        case "type": if (!args.text) return "error: text required"; send({ kind: "type", text: String(args.text) }); return `typed ${String(args.text).length} chars`;
        case "click": { const x = Number(args.x), y = Number(args.y); if (!Number.isFinite(x) || !Number.isFinite(y)) return "error: x and y required"; send({ kind: "click", x, y, button: String(args.button ?? "left") }); return `clicked ${x},${y}`; }
        case "move": { const x = Number(args.x), y = Number(args.y); if (!Number.isFinite(x) || !Number.isFinite(y)) return "error: x and y required"; send({ kind: "move", x, y }); return `moved to ${x},${y}`; }
        default: return `error: invalid action '${action}' — supported: screenshot, key, type, click, move`;
      }
    },
      schema: { name: "computer_use", description: "Desktop control through takeoverd: screenshot, key presses, typing, mouse move/click. Gated by takeover availability and mode.", parameters: { type: "object", properties: { action: { type: "string", description: "What to do", enum: ["screenshot", "key", "type", "click", "move"] }, key: { type: "string", description: "Key name (action='key')" }, text: { type: "string", description: "Text to type (action='type')" }, x: { type: "integer", description: "Target x (click/move)" }, y: { type: "integer", description: "Target y (click/move)" }, button: { type: "string", description: "Mouse button (click)", enum: ["left", "right", "middle"] } }, required: ["action"] } } },
  ];
}
