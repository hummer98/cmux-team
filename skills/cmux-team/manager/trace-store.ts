/**
 * トレースストア — SQLite ベースのタスク-セッション索引
 *
 * JSONL が会話の真のデータであり、trace DB はそこへのインデックス。
 * bun:sqlite を使用。外部依存なし。
 * DB パス: .team/traces/traces.db
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";

export interface TaskSessionRecord {
  id?: number;
  timestamp: string;
  task_id: string;
  task_run_id?: string;
  session_id: string;
  role?: string;
  surface?: string;
  worktree_path?: string;
  event: "assigned" | "agent_spawned" | "closed" | "aborted";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS task_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_run_id TEXT,
  session_id TEXT NOT NULL,
  role TEXT,
  surface TEXT,
  worktree_path TEXT,
  event TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_sessions_task_id ON task_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_task_sessions_session_id ON task_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_task_sessions_event ON task_sessions(event);
`;

export function initDB(projectRoot: string): Database {
  const dir = join(projectRoot, ".team/traces");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "traces.db"));
  db.exec("PRAGMA journal_mode=WAL;");

  // マイグレーション: 旧 traces テーブルが存在する場合は DROP
  const hasOldTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='traces'"
  ).get();
  if (hasOldTable) {
    db.exec("DROP TRIGGER IF EXISTS traces_ai;");
    db.exec("DROP TABLE IF EXISTS traces_fts;");
    db.exec("DROP TABLE IF EXISTS traces;");
  }

  db.exec(SCHEMA);
  return db;
}

export function insertTaskSession(db: Database, record: TaskSessionRecord): number {
  const stmt = db.prepare(`
    INSERT INTO task_sessions (timestamp, task_id, task_run_id, session_id, role, surface, worktree_path, event)
    VALUES ($timestamp, $task_id, $task_run_id, $session_id, $role, $surface, $worktree_path, $event)
  `);
  const result = stmt.run({
    $timestamp: record.timestamp,
    $task_id: record.task_id,
    $task_run_id: record.task_run_id ?? null,
    $session_id: record.session_id,
    $role: record.role ?? null,
    $surface: record.surface ?? null,
    $worktree_path: record.worktree_path ?? null,
    $event: record.event,
  });
  return Number(result.lastInsertRowid);
}

export function getTaskSessions(
  db: Database,
  opts: { taskId?: string; taskRunId?: string; sessionId?: string; event?: string; limit?: number }
): TaskSessionRecord[] {
  const conditions: string[] = [];
  const params: Record<string, any> = {};

  if (opts.taskId) {
    conditions.push("task_id = $taskId");
    params.$taskId = opts.taskId;
  }
  if (opts.taskRunId) {
    conditions.push("task_run_id = $taskRunId");
    params.$taskRunId = opts.taskRunId;
  }
  if (opts.sessionId) {
    conditions.push("session_id = $sessionId");
    params.$sessionId = opts.sessionId;
  }
  if (opts.event) {
    conditions.push("event = $event");
    params.$event = opts.event;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 50;

  const stmt = db.prepare(`SELECT * FROM task_sessions ${where} ORDER BY id DESC LIMIT ${limit}`);
  return stmt.all(params) as TaskSessionRecord[];
}

export function getSessionsForTask(
  db: Database,
  taskId: string
): TaskSessionRecord[] {
  const stmt = db.prepare("SELECT * FROM task_sessions WHERE task_id = $taskId ORDER BY id ASC");
  return stmt.all({ $taskId: taskId }) as TaskSessionRecord[];
}
