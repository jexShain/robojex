// packages/ceo-core/src/board.ts
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export interface Task { id: string; title: string; status: "todo" | "running" | "done" | "blocked"; priority: number; assignee: string; attempts: number; resultSummary: string; createdAt: number; parentId: string | null; scheduledAt: number | null; dueAt: number | null; overdueNaggedAt: number | null; acceptance: string; progress: number; verdict: "unchecked" | "pass" | "partial" | "fail"; }

// Task plus its nested children: the shape of the board tree view.
export interface TaskNode extends Task { children: TaskNode[]; }

// Nests a flat task list: children under their parent (createdAt order),
// everything else — no parent, dangling parent reference, or an orphaned
// cycle — surfaces as a root so no task ever drops out of the tree.
export function nestTasks(tasks: Task[]): TaskNode[] {
  const nodes = new Map<string, TaskNode>();
  for (const t of tasks) nodes.set(t.id, { ...t, children: [] });
  const roots: TaskNode[] = [];
  for (const n of nodes.values()) {
    const p = n.parentId ? nodes.get(n.parentId) : undefined;
    if (p && p !== n) p.children.push(n); else roots.push(n);
  }
  for (const n of nodes.values()) n.children.sort((a, b) => a.createdAt - b.createdAt);
  // a parent cycle (a→b→a, only buildable through two updates) attaches to no
  // root: break it at one member and surface that member as a root, so no task
  // ever drops out of the tree and consumers can recurse without a seen-set
  const seen = new Set<string>();
  const visit = (n: TaskNode): void => { if (seen.has(n.id)) return; seen.add(n.id); for (const c of n.children) visit(c); };
  for (const r of roots) visit(r);
  for (const n of nodes.values()) if (!seen.has(n.id)) {
    const p = n.parentId ? nodes.get(n.parentId) : undefined;
    if (p) p.children = p.children.filter((c) => c !== n);
    roots.push(n);
    visit(n);
  }
  return roots;
}

export class TaskBoard {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
      priority INTEGER NOT NULL DEFAULT 0, assignee TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0, resultSummary TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT, scheduled_at INTEGER, due_at INTEGER)`);
    // boards created before a column existed: add it in place, old rows stay NULL
    const cols = this.db.prepare("PRAGMA table_info(tasks)").all() as unknown as { name: string }[];
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("createdAt")) this.db.exec("ALTER TABLE tasks ADD COLUMN createdAt INTEGER NOT NULL DEFAULT 0");
    if (!have.has("parent_id")) this.db.exec("ALTER TABLE tasks ADD COLUMN parent_id TEXT");
    if (!have.has("scheduled_at")) this.db.exec("ALTER TABLE tasks ADD COLUMN scheduled_at INTEGER");
    if (!have.has("due_at")) this.db.exec("ALTER TABLE tasks ADD COLUMN due_at INTEGER");
    if (!have.has("overdue_nagged_at")) this.db.exec("ALTER TABLE tasks ADD COLUMN overdue_nagged_at INTEGER");
    if (!have.has("acceptance")) this.db.exec("ALTER TABLE tasks ADD COLUMN acceptance TEXT NOT NULL DEFAULT ''");
    if (!have.has("progress")) this.db.exec("ALTER TABLE tasks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0");
    if (!have.has("verdict")) this.db.exec("ALTER TABLE tasks ADD COLUMN verdict TEXT NOT NULL DEFAULT 'unchecked'");
  }
  add(t: { title: string; priority?: number; assignee?: string; parentId?: string | null; scheduledAt?: number | null; dueAt?: number | null; acceptance?: string }): Task {
    const task: Task = { id: randomUUID(), title: t.title, status: "todo", priority: t.priority ?? 0, assignee: t.assignee ?? "", attempts: 0, resultSummary: "", createdAt: Date.now(), parentId: t.parentId ?? null, scheduledAt: t.scheduledAt ?? null, dueAt: t.dueAt ?? null, overdueNaggedAt: null, acceptance: t.acceptance ?? "", progress: 0, verdict: "unchecked" };
    this.db.prepare("INSERT INTO tasks (id,title,status,priority,assignee,attempts,resultSummary,createdAt,parent_id,scheduled_at,due_at,overdue_nagged_at,acceptance,progress,verdict) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(task.id, task.title, task.status, task.priority, task.assignee, task.attempts, task.resultSummary, task.createdAt, task.parentId, task.scheduledAt, task.dueAt, task.overdueNaggedAt, task.acceptance, task.progress, task.verdict);
    return task;
  }

  // snake_case rows -> Task; suffix is a literal fragment from this class only
  private rows(suffix: string, ...params: (string | number)[]): Task[] {
    const rows = this.db.prepare(`SELECT * FROM tasks ${suffix}`).all(...params) as unknown as (Task & { parent_id?: string | null; scheduled_at?: number | null; due_at?: number | null; overdue_nagged_at?: number | null })[];
    return rows.map(({ parent_id, scheduled_at, due_at, overdue_nagged_at, ...t }) => ({ ...t, parentId: parent_id ?? null, scheduledAt: scheduled_at ?? null, dueAt: due_at ?? null, overdueNaggedAt: overdue_nagged_at ?? null }));
  }
  list(): Task[] { return this.rows("ORDER BY priority DESC, rowid ASC"); }
  // Nested view: roots with children in createdAt order (see nestTasks).
  tree(): TaskNode[] { return nestTasks(this.list()); }
  // Chronological agenda: only tasks with a scheduled time, earliest first.
  timeline(): Task[] {
    return this.list().filter((t) => t.scheduledAt !== null).sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));
  }
  // Gantt pump queries: minute-tick comparisons against the wall clock.
  dueSpawnTasks(now: number): Task[] {
    return this.rows("WHERE status='todo' AND scheduled_at IS NOT NULL AND scheduled_at<=? ORDER BY scheduled_at ASC", now);
  }
  overdueTasks(now: number): Task[] {
    return this.rows("WHERE due_at IS NOT NULL AND due_at<? AND status IN ('todo','running') ORDER BY due_at ASC", now);
  }
  update(id: string, patch: Partial<Task>): void {
    const cur = this.rows("WHERE id=?", id)[0];
    if (!cur) return;
    // self-reference is the one cycle the store itself can build: reject it
    // before the write lands (add() cannot self-reference — it mints the id)
    if (patch.parentId === id) throw new Error("task cannot be its own parent");
    const next = { ...cur, ...patch };
    this.db.prepare("UPDATE tasks SET title=?,status=?,priority=?,assignee=?,attempts=?,resultSummary=?,createdAt=?,parent_id=?,scheduled_at=?,due_at=?,overdue_nagged_at=?,acceptance=?,progress=?,verdict=? WHERE id=?")
      .run(next.title, next.status, next.priority, next.assignee, next.attempts, next.resultSummary, next.createdAt, next.parentId ?? null, next.scheduledAt ?? null, next.dueAt ?? null, next.overdueNaggedAt ?? null, next.acceptance, next.progress, next.verdict, next.id);
  }
}
