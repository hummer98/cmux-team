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
import type { QueueMessage, WorktreeBaseSource } from "./schema";

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
  // T243: worktree 作成時の base 情報（assigned 行のみ書き込み、他は NULL）
  base_branch?: string | null;
  base_sha?: string | null;
  base_source?: WorktreeBaseSource | null;
}

export interface HookSignalRecord {
  id: number;
  timestamp: string;
  type: string;
  surface: string | null;
  pid: number | null;
  reason: string | null;
  source: string | null;
  question: string | null;
  task_run_id: string | null;
  payload_json: string;
  // T266: NOTIFICATION enrichment 列（他 type では NULL）
  surface_uuid?: string | null;
  workspace_uuid?: string | null;
  role?: string | null;
  task_id?: string | null;
  conductor_surface?: string | null;
  agent_role?: string | null;
  message?: string | null;
  notification_type?: string | null;
}

// T266: NOTIFICATION hook の daemon 側 enrichment。
// handleMessage 入口で insertHookSignal 実行直後、case "NOTIFICATION" 内で
// updateNotificationEnrichment を呼んで 8 列を追記する。
// 未指定フィールドは NULL のまま保持される。
export interface NotificationEnrichment {
  surfaceUuid?: string | null;
  workspaceUuid?: string | null;
  role?: "master" | "conductor" | "agent" | "unknown" | null;
  taskId?: string | null;
  conductorSurface?: string | null;
  agentRole?: string | null;
  message?: string | null;
  notificationType?: string | null;
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
  event TEXT NOT NULL,
  base_branch TEXT,
  base_sha TEXT,
  base_source TEXT
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
  payload_json TEXT NOT NULL,
  surface_uuid TEXT,
  workspace_uuid TEXT,
  role TEXT,
  task_id TEXT,
  conductor_surface TEXT,
  agent_role TEXT,
  message TEXT,
  notification_type TEXT
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
  ensureTaskSessionsColumns(db);
  ensureHookSignalsColumns(db);
  return db;
}

/**
 * T243: 既存 DB の `task_sessions` テーブルに `base_branch` / `base_sha` /
 * `base_source` 列が無ければ ALTER TABLE で追加する（冪等）。
 *
 * 新規 DB では `db.exec(SCHEMA)` 直後に PRAGMA で全列が確認できるため ALTER は走らない。
 * 既存 DB（旧スキーマ）では欠損列だけが ADD COLUMN される。
 */
function ensureTaskSessionsColumns(db: Database): void {
  const rows = db
    .prepare("PRAGMA table_info(task_sessions)")
    .all() as Array<{ name: string }>;
  const existing = new Set(rows.map((r) => r.name));
  const required = ["base_branch", "base_sha", "base_source"] as const;
  for (const col of required) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE task_sessions ADD COLUMN ${col} TEXT`);
      console.warn(`[trace-store] task_sessions_migrated col=${col}`);
    }
  }
}

/**
 * T266: 既存 DB の `hook_signals` テーブルに NOTIFICATION 用 8 列が無ければ ALTER TABLE で追加（冪等）。
 * 新規 DB では SCHEMA 内の CREATE TABLE で既に全列が揃っているため ALTER は走らない。
 * インデックスは SCHEMA 内の `CREATE INDEX IF NOT EXISTS` で冪等に作られる。
 */
function ensureHookSignalsColumns(db: Database): void {
  const rows = db
    .prepare("PRAGMA table_info(hook_signals)")
    .all() as Array<{ name: string }>;
  const existing = new Set(rows.map((r) => r.name));
  const required = [
    "surface_uuid",
    "workspace_uuid",
    "role",
    "task_id",
    "conductor_surface",
    "agent_role",
    "message",
    "notification_type",
  ] as const;
  for (const col of required) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE hook_signals ADD COLUMN ${col} TEXT`);
      console.warn(`[trace-store] hook_signals_migrated col=${col}`);
    }
  }
  // 旧 DB で SCHEMA 側の CREATE INDEX が既に走っていない場合に備え、
  // 追加 index も冪等に作っておく。
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_hook_signals_surface_uuid ON hook_signals(surface_uuid)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_hook_signals_role ON hook_signals(role)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_hook_signals_task_id ON hook_signals(task_id)",
  );
}

export function insertTaskSession(db: Database, record: TaskSessionRecord): number {
  const stmt = db.prepare(`
    INSERT INTO task_sessions (timestamp, task_id, task_run_id, session_id, role, surface, worktree_path, event, base_branch, base_sha, base_source)
    VALUES ($timestamp, $task_id, $task_run_id, $session_id, $role, $surface, $worktree_path, $event, $base_branch, $base_sha, $base_source)
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
    $base_branch: record.base_branch ?? null,
    $base_sha: record.base_sha ?? null,
    $base_source: record.base_source ?? null,
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

export function getHookSignals(
  db: Database,
  opts: {
    surface?: string;
    type?: string;
    taskRunId?: string;
    limit?: number;
    // T266: NOTIFICATION enrichment 列でのフィルタ
    role?: string;
    taskId?: string;
  }
): HookSignalRecord[] {
  const conditions: string[] = [];
  const params: Record<string, any> = {};

  if (opts.type) {
    conditions.push("type = $type");
    params.$type = opts.type;
  }
  if (opts.surface) {
    conditions.push("surface = $surface");
    params.$surface = opts.surface;
  }
  if (opts.taskRunId) {
    conditions.push("task_run_id = $taskRunId");
    params.$taskRunId = opts.taskRunId;
  }
  if (opts.role) {
    conditions.push("role = $role");
    params.$role = opts.role;
  }
  if (opts.taskId) {
    conditions.push("task_id = $taskId");
    params.$taskId = opts.taskId;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 50;

  const stmt = db.prepare(
    `SELECT * FROM hook_signals ${where} ORDER BY id DESC LIMIT ${limit}`
  );
  return stmt.all(params) as HookSignalRecord[];
}

/**
 * T266: NOTIFICATION hook の enrichment を hook_signals 行に UPDATE で追記する。
 * insertHookSignal で入口 INSERT 済みの `id` を引数に取り、8 列を書き換える。
 * 未指定フィールドは明示的に NULL になる（=未指定 = NULL のまま）。
 * 存在しない id を渡した場合は SQLite の UPDATE 仕様通り no-op。
 */
export function updateNotificationEnrichment(
  db: Database,
  id: number,
  enrichment: NotificationEnrichment,
): void {
  db.prepare(
    `UPDATE hook_signals SET
       surface_uuid = ?,
       workspace_uuid = ?,
       role = ?,
       task_id = ?,
       conductor_surface = ?,
       agent_role = ?,
       message = ?,
       notification_type = ?
     WHERE id = ?`,
  ).run(
    enrichment.surfaceUuid ?? null,
    enrichment.workspaceUuid ?? null,
    enrichment.role ?? null,
    enrichment.taskId ?? null,
    enrichment.conductorSurface ?? null,
    enrichment.agentRole ?? null,
    enrichment.message ?? null,
    enrichment.notificationType ?? null,
    id,
  );
}
