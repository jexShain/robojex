// packages/ceo-core/src/chat-store.ts
// Durable conversations + messages for the direct-chat surface (ChatGPT-style
// history). Wire shape mirrors packages/web/src/state/types.ts: Conversation
// (camelCase, messageCount + preview server-computed) and Message.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: 0 | 1;
  gear: string;
  model: string;
  archived: 0 | 1;
}

export interface ConversationView extends Conversation {
  messageCount: number;
  /** latest message content, ≤80 chars, newlines flattened */
  preview: string;
}

export interface StoredMessage {
  id: string;
  convId: string;
  role: string; // user | assistant | system | notice
  content: string;
  reasoning: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  createdAt: number;
  error: string;
}

export interface DayUsage { day: string; tokensIn: number; tokensOut: number; calls: number; }

const PREVIEW_MAX = 80;

// local calendar day as YYYY-MM-DD (usage days are a human "today" concept)
function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class ChatStore {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新对话',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0, gear TEXT NOT NULL DEFAULT 'balanced',
      model TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '', reasoning TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '', tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      error TEXT NOT NULL DEFAULT '')`);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, created_at)");
  }

  private convRow(r: Record<string, unknown> | undefined): Conversation | null {
    if (!r) return null;
    return {
      id: String(r.id), title: String(r.title ?? ""),
      createdAt: Number(r.created_at ?? 0), updatedAt: Number(r.updated_at ?? 0),
      pinned: Number(r.pinned ?? 0) as 0 | 1, gear: String(r.gear ?? "balanced"),
      model: String(r.model ?? ""), archived: Number(r.archived ?? 0) as 0 | 1,
    };
  }

  private msgRow(r: Record<string, unknown>): StoredMessage {
    return {
      id: String(r.id), convId: String(r.conv_id), role: String(r.role ?? ""),
      content: String(r.content ?? ""), reasoning: String(r.reasoning ?? ""),
      model: String(r.model ?? ""), tokensIn: Number(r.tokens_in ?? 0), tokensOut: Number(r.tokens_out ?? 0),
      createdAt: Number(r.created_at ?? 0), error: String(r.error ?? ""),
    };
  }

  create(title?: string, opts: { gear?: string; model?: string } = {}): Conversation {
    const now = Date.now();
    const c: Conversation = {
      id: randomUUID(),
      title: title && title.trim().length > 0 ? title.trim().slice(0, 120) : "新对话",
      createdAt: now, updatedAt: now, pinned: 0,
      gear: opts.gear ?? "balanced", model: opts.model ?? "", archived: 0,
    };
    this.db.prepare("INSERT INTO conversations (id,title,created_at,updated_at,pinned,gear,model,archived) VALUES (?,?,?,?,?,?,?,?)")
      .run(c.id, c.title, c.createdAt, c.updatedAt, c.pinned, c.gear, c.model, c.archived);
    return c;
  }

  // Sidebar listing: pinned first, then most-recently-updated. Each row ships
  // the message count and a ≤80-char preview of the latest message.
  listConversations(): ConversationView[] {
    const rows = this.db.prepare(`SELECT c.*,
        COUNT(m.id) AS message_count,
        COALESCE((SELECT content FROM messages WHERE conv_id = c.id ORDER BY created_at DESC, rowid DESC LIMIT 1), '') AS preview
      FROM conversations c LEFT JOIN messages m ON m.conv_id = c.id
      GROUP BY c.id ORDER BY c.pinned DESC, c.updated_at DESC, c.rowid DESC`)
      .all() as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      ...this.convRow(r)!,
      messageCount: Number(r.message_count ?? 0),
      preview: String(r.preview ?? "").replace(/\s+/g, " ").trim().slice(0, PREVIEW_MAX),
    }));
  }

  get(id: string): Conversation | null {
    return this.convRow(this.db.prepare("SELECT * FROM conversations WHERE id=?").get(id) as Record<string, unknown> | undefined);
  }

  findByTitle(title: string): Conversation | null {
    return this.convRow(this.db.prepare("SELECT * FROM conversations WHERE title=? ORDER BY updated_at DESC LIMIT 1").get(title) as Record<string, unknown> | undefined);
  }

  update(id: string, patch: { title?: string; pinned?: 0 | 1 | boolean; archived?: 0 | 1 | boolean; gear?: string; model?: string }): Conversation | null {
    const cur = this.get(id);
    if (!cur) return null;
    const pin = typeof patch.pinned === "boolean" ? (patch.pinned ? 1 : 0) : (patch.pinned ?? cur.pinned);
    const arch = typeof patch.archived === "boolean" ? (patch.archived ? 1 : 0) : (patch.archived ?? cur.archived);
    const next: Conversation = {
      ...cur,
      title: patch.title !== undefined && patch.title.trim().length > 0 ? patch.title.trim().slice(0, 120) : cur.title,
      pinned: pin as 0 | 1, archived: arch as 0 | 1,
      gear: patch.gear ?? cur.gear, model: patch.model ?? cur.model,
    };
    this.db.prepare("UPDATE conversations SET title=?,updated_at=?,pinned=?,gear=?,model=?,archived=? WHERE id=?")
      .run(next.title, Date.now(), next.pinned, next.gear, next.model, next.archived, id);
    return this.get(id);
  }

  // touch updated_at (every append does this implicitly; exposed for streams)
  touch(id: string): void {
    this.db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(Date.now(), id);
  }

  /** Delete a conversation and all its messages atomically. */
  delete(id: string): boolean {
    if (!this.get(id)) return false;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM messages WHERE conv_id=?").run(id);
      this.db.prepare("DELETE FROM conversations WHERE id=?").run(id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return true;
  }

  // chronological, notice rows excluded (client-only role)
  listMessages(convId: string): StoredMessage[] {
    const rows = this.db.prepare("SELECT * FROM messages WHERE conv_id=? AND role!='notice' ORDER BY created_at ASC, rowid ASC").all(convId) as unknown as Record<string, unknown>[];
    return rows.map((r) => this.msgRow(r));
  }

  appendMessage(convId: string, m: { id?: string; role: string; content: string; reasoning?: string; model?: string; tokensIn?: number; tokensOut?: number; error?: string; createdAt?: number }): StoredMessage {
    const row: StoredMessage = {
      id: m.id ?? randomUUID(), convId, role: m.role, content: m.content,
      reasoning: m.reasoning ?? "", model: m.model ?? "",
      tokensIn: m.tokensIn ?? 0, tokensOut: m.tokensOut ?? 0,
      createdAt: m.createdAt ?? Date.now(), error: m.error ?? "",
    };
    this.db.prepare("INSERT INTO messages (id,conv_id,role,content,reasoning,model,tokens_in,tokens_out,created_at,error) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(row.id, row.convId, row.role, row.content, row.reasoning, row.model, row.tokensIn, row.tokensOut, row.createdAt, row.error);
    this.touch(convId);
    return row;
  }

  updateMessage(id: string, patch: Partial<Pick<StoredMessage, "content" | "reasoning" | "tokensIn" | "tokensOut" | "error">>): StoredMessage | null {
    const cur = this.db.prepare("SELECT * FROM messages WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!cur) return null;
    const base = this.msgRow(cur);
    const next = { ...base, ...patch };
    this.db.prepare("UPDATE messages SET content=?,reasoning=?,tokens_in=?,tokens_out=?,error=? WHERE id=?")
      .run(next.content, next.reasoning, next.tokensIn, next.tokensOut, next.error, id);
    return next;
  }

  deleteMessage(id: string): boolean {
    return this.db.prepare("DELETE FROM messages WHERE id=?").run(id).changes > 0;
  }

  /** Regenerate prep: drop everything AFTER the last user message (the user
   *  message itself stays as the tail of the history). Returns rows removed. */
  truncateAfterLastUser(convId: string): number {
    const last = this.db.prepare("SELECT rowid AS rid FROM messages WHERE conv_id=? AND role='user' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(convId) as { rid?: number } | undefined;
    if (!last) return 0;
    return Number(this.db.prepare("DELETE FROM messages WHERE conv_id=? AND rowid>?").run(convId, Number(last.rid)).changes);
  }

  /** Daily assistant-token ledger since fromMs (for /api/usage). */
  usageSince(fromMs: number): DayUsage[] {
    const rows = this.db.prepare("SELECT tokens_in, tokens_out, created_at FROM messages WHERE role='assistant' AND created_at>=?").all(fromMs) as unknown as { tokens_in?: number; tokens_out?: number; created_at?: number }[];
    const byDay = new Map<string, DayUsage>();
    for (const r of rows) {
      const day = localDay(Number(r.created_at ?? 0));
      const u = byDay.get(day) ?? { day, tokensIn: 0, tokensOut: 0, calls: 0 };
      u.tokensIn += Number(r.tokens_in ?? 0);
      u.tokensOut += Number(r.tokens_out ?? 0);
      u.calls += 1;
      byDay.set(day, u);
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  close(): void { this.db.close(); }
}
