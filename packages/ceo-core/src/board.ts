// packages/ceo-core/src/board.ts
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export interface Task { id: string; title: string; status: "todo" | "running" | "done" | "blocked"; priority: number; assignee: string; attempts: number; resultSummary: string; }

export class TaskBoard {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
      priority INTEGER NOT NULL DEFAULT 0, assignee TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0, resultSummary TEXT NOT NULL DEFAULT '')`);
  }
  add(t: { title: string; priority?: number; assignee?: string }): Task {
    const task: Task = { id: randomUUID(), title: t.title, status: "todo", priority: t.priority ?? 0, assignee: t.assignee ?? "", attempts: 0, resultSummary: "" };
    this.db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?)")
      .run(task.id, task.title, task.status, task.priority, task.assignee, task.attempts, task.resultSummary);
    return task;
  }
  list(): Task[] {
    return this.db.prepare("SELECT * FROM tasks ORDER BY priority DESC, rowid ASC").all() as unknown as Task[];
  }
  update(id: string, patch: Partial<Task>): void {
    const cur = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as unknown as Task | undefined;
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.db.prepare("UPDATE tasks SET title=?,status=?,priority=?,assignee=?,attempts=?,resultSummary=? WHERE id=?")
      .run(next.title, next.status, next.priority, next.assignee, next.attempts, next.resultSummary, next.id);
  }
}
