// packages/ceo-core/src/board.ts
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface Task { id: string; title: string; status: "todo" | "running" | "done" | "blocked"; priority: number; assignee: string; attempts: number; resultSummary: string; }

export class TaskBoard {
  private db: Database.Database;
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
      priority INTEGER NOT NULL DEFAULT 0, assignee TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0, resultSummary TEXT NOT NULL DEFAULT '')`);
  }
  add(t: { title: string; priority?: number; assignee?: string }): Task {
    const task: Task = { id: randomUUID(), title: t.title, status: "todo", priority: t.priority ?? 0, assignee: t.assignee ?? "", attempts: 0, resultSummary: "" };
    this.db.prepare("INSERT INTO tasks VALUES (@id,@title,@status,@priority,@assignee,@attempts,@resultSummary)").run(task);
    return task;
  }
  list(): Task[] {
    return this.db.prepare("SELECT * FROM tasks ORDER BY priority DESC, rowid ASC").all() as Task[];
  }
  update(id: string, patch: Partial<Task>): void {
    const cur = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Task | undefined;
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.db.prepare("UPDATE tasks SET title=@title,status=@status,priority=@priority,assignee=@assignee,attempts=@attempts,resultSummary=@resultSummary WHERE id=@id").run(next);
  }
}
