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
import type { QueueMessage } from "./schema";

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
CREATE TABLE IF NOT EXISTS hook_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  surface TEXT,
  pid INTEGER,
  reason TEXT,
  source TEXT,
  question TEXT,
  task_run_id TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hook_signals_type ON hook_signals(type);
CREATE INDEX IF NOT EXISTS idx_hook_signals_surface ON hook_signals(surface);
CREATE INDEX IF NOT EXISTS idx_hook_signals_timestamp ON hook_signals(timestamp);
`;

const HOOK_SIGNAL_PAYLOAD_LIMIT = 64 * 1024;

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

/**
 * T216: hook 全送信ポリシー — handleMessage 入口で受信した全 QueueMessage を
 * hook_signals テーブルに丸ごと記録する。フィルタ/ルーティングの前に書き込むことで、
 * 「hook は発火したか」「Manager は受信したか」を事後解析できるようにする。
 *
 * payload_json は JSON.stringify(message) をそのまま格納。64KB を超えた場合は
 * 先頭から 64KB に truncate して `hook_signal_payload_truncated` を warn 出力する。
 */
export function insertHookSignal(db: Database, message: QueueMessage): number {
  const m = message as Record<string, unknown>;
  const type = typeof m.type === "string" ? m.type : "UNKNOWN";
  const timestamp = typeof m.timestamp === "string" ? m.timestamp : new Date().toISOString();
  const surface = typeof m.surface === "string" ? m.surface : null;
  const pid = typeof m.pid === "number" ? m.pid : null;
  const reason = typeof m.reason === "string" ? m.reason : null;
  const source = typeof m.source === "string" ? m.source : null;
  const question = typeof m.question === "string" ? m.question : null;
  const taskRunId = typeof m.taskRunId === "string" ? m.taskRunId : null;

  const json = JSON.stringify(message);
  let safeJson = json;
  if (json.length > HOOK_SIGNAL_PAYLOAD_LIMIT) {
    safeJson = json.slice(0, HOOK_SIGNAL_PAYLOAD_LIMIT);
    console.warn(
      `[trace-store] hook_signal_payload_truncated type=${type} size=${json.length}`
    );
  }

  const stmt = db.prepare(`
    INSERT INTO hook_signals (timestamp, type, surface, pid, reason, source, question, task_run_id, payload_json)
    VALUES ($timestamp, $type, $surface, $pid, $reason, $source, $question, $task_run_id, $payload_json)
  `);
  const result = stmt.run({
    $timestamp: timestamp,
    $type: type,
    $surface: surface,
    $pid: pid,
    $reason: reason,
    $source: source,
    $question: question,
    $task_run_id: taskRunId,
    $payload_json: safeJson,
  });
  return Number(result.lastInsertRowid);
}
