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

// T354: unified utilization (5h / 7d) の時系列を記録する。
// proxy.ts が extractRateLimit 直後に non-null 行で 1 リクエスト 1 レコードで INSERT する。
// 取得できなかったフィールドは NULL のまま（projection 計算側で null フィルタ）。
//
// T354 S3: getProjection5h / getProjection7d はこのテーブルの直近 1 件と
// 「直近 reset 以降の最古 snapshot」を起点に projection 秒数を算出する。
export interface RateLimitSnapshotRecord {
  id?: number;
  /** snapshot 取得時刻（ISO 8601 UTC、`new Date().toISOString()` を期待） */
  timestamp: string;
  /** unified-5h-utilization (0-1)。null は未取得 */
  unified_5h_utilization?: number | null;
  /** unified-5h-reset (ISO 8601 文字列もしくは epoch 秒文字列)。null は未取得 */
  unified_5h_reset?: string | null;
  /** unified-7d-utilization (0-1)。null は未取得 */
  unified_7d_utilization?: number | null;
  /** unified-7d-reset (ISO 8601 文字列もしくは epoch 秒文字列)。null は未取得 */
  unified_7d_reset?: string | null;
}

// T305: Anthropic API 呼び出しごとの usage / rate limit を記録する。
// proxy.ts が /v1/messages（完全一致）のレスポンスから 1 リクエスト 1 レコードで INSERT する。
// 取得できなかったフィールドは NULL のまま（SUM/AVG 集計で無視される）。
export interface ApiUsageRecord {
  id?: number;
  timestamp: string;
  task_id?: string | null;
  role?: string | null;
  surface?: string | null;
  conductor_id?: string | null;
  model?: string | null;
  request_id?: string | null;
  status_code?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  stop_reason?: string | null;
  duration_ms?: number | null;
  ratelimit_tokens_remaining?: number | null;
  ratelimit_tokens_limit?: number | null;
  ratelimit_tokens_reset?: string | null;
  ratelimit_input_tokens_remaining?: number | null;
  ratelimit_input_tokens_limit?: number | null;
  ratelimit_input_tokens_reset?: string | null;
  ratelimit_output_tokens_remaining?: number | null;
  ratelimit_output_tokens_limit?: number | null;
  ratelimit_output_tokens_reset?: string | null;
  ratelimit_requests_remaining?: number | null;
  ratelimit_requests_limit?: number | null;
  ratelimit_requests_reset?: string | null;
  error?: string | null;
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
  notification_type TEXT,
  session_id TEXT,
  tool_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_hook_signals_type ON hook_signals(type);
CREATE INDEX IF NOT EXISTS idx_hook_signals_surface ON hook_signals(surface);
CREATE INDEX IF NOT EXISTS idx_hook_signals_timestamp ON hook_signals(timestamp);
CREATE TABLE IF NOT EXISTS api_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  task_id TEXT,
  role TEXT,
  surface TEXT,
  conductor_id TEXT,
  model TEXT,
  request_id TEXT,
  status_code INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  stop_reason TEXT,
  duration_ms INTEGER,
  ratelimit_tokens_remaining INTEGER,
  ratelimit_tokens_limit INTEGER,
  ratelimit_tokens_reset TEXT,
  ratelimit_input_tokens_remaining INTEGER,
  ratelimit_input_tokens_limit INTEGER,
  ratelimit_input_tokens_reset TEXT,
  ratelimit_output_tokens_remaining INTEGER,
  ratelimit_output_tokens_limit INTEGER,
  ratelimit_output_tokens_reset TEXT,
  ratelimit_requests_remaining INTEGER,
  ratelimit_requests_limit INTEGER,
  ratelimit_requests_reset TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS rate_limit_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  unified_5h_utilization REAL,
  unified_5h_reset TEXT,
  unified_7d_utilization REAL,
  unified_7d_reset TEXT
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_snapshots_ts ON rate_limit_snapshots(timestamp);
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
  ensureApiUsageColumns(db);
  ensureRateLimitSnapshotsColumns(db);
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
 * T305: 既存 DB の `api_usage` テーブルに列が無ければ ALTER TABLE で追加する（冪等）。
 *
 * 新規 DB では `db.exec(SCHEMA)` 直後に全列が揃っているため ALTER は走らない。
 * 将来 `service_tier` / `cache_creation.ephemeral_*_input_tokens` 等の列を追加する際も
 * この関数に required を追記するだけで既存 DB にマイグレーションできる。
 */
function ensureApiUsageColumns(db: Database): void {
  const rows = db
    .prepare("PRAGMA table_info(api_usage)")
    .all() as Array<{ name: string }>;
  const existing = new Set(rows.map((r) => r.name));
  const required: Array<[string, "TEXT" | "INTEGER"]> = [
    ["timestamp", "TEXT"],
    ["task_id", "TEXT"],
    ["role", "TEXT"],
    ["surface", "TEXT"],
    ["conductor_id", "TEXT"],
    ["model", "TEXT"],
    ["request_id", "TEXT"],
    ["status_code", "INTEGER"],
    ["input_tokens", "INTEGER"],
    ["output_tokens", "INTEGER"],
    ["cache_creation_input_tokens", "INTEGER"],
    ["cache_read_input_tokens", "INTEGER"],
    ["stop_reason", "TEXT"],
    ["duration_ms", "INTEGER"],
    ["ratelimit_tokens_remaining", "INTEGER"],
    ["ratelimit_tokens_limit", "INTEGER"],
    ["ratelimit_tokens_reset", "TEXT"],
    ["ratelimit_input_tokens_remaining", "INTEGER"],
    ["ratelimit_input_tokens_limit", "INTEGER"],
    ["ratelimit_input_tokens_reset", "TEXT"],
    ["ratelimit_output_tokens_remaining", "INTEGER"],
    ["ratelimit_output_tokens_limit", "INTEGER"],
    ["ratelimit_output_tokens_reset", "TEXT"],
    ["ratelimit_requests_remaining", "INTEGER"],
    ["ratelimit_requests_limit", "INTEGER"],
    ["ratelimit_requests_reset", "TEXT"],
    ["error", "TEXT"],
  ];
  for (const [col, type] of required) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE api_usage ADD COLUMN ${col} ${type}`);
      console.warn(`[trace-store] api_usage_migrated col=${col}`);
    }
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_api_usage_timestamp ON api_usage(timestamp)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_api_usage_task_id ON api_usage(task_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_api_usage_role ON api_usage(role)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_api_usage_surface ON api_usage(surface)",
  );
}

/**
 * T354: 既存 DB の `rate_limit_snapshots` テーブルに列が無ければ ALTER TABLE で追加（冪等）。
 *
 * 新規 DB では SCHEMA 内の CREATE TABLE で全列が揃っているため ALTER は走らない。
 * テーブル自体が無い旧 DB でも CREATE TABLE IF NOT EXISTS が SCHEMA 内で走るため安全。
 */
function ensureRateLimitSnapshotsColumns(db: Database): void {
  const rows = db
    .prepare("PRAGMA table_info(rate_limit_snapshots)")
    .all() as Array<{ name: string }>;
  const existing = new Set(rows.map((r) => r.name));
  const required: Array<[string, "TEXT" | "REAL"]> = [
    ["timestamp", "TEXT"],
    ["unified_5h_utilization", "REAL"],
    ["unified_5h_reset", "TEXT"],
    ["unified_7d_utilization", "REAL"],
    ["unified_7d_reset", "TEXT"],
  ];
  for (const [col, type] of required) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE rate_limit_snapshots ADD COLUMN ${col} ${type}`);
      console.warn(`[trace-store] rate_limit_snapshots_migrated col=${col}`);
    }
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_rate_limit_snapshots_ts ON rate_limit_snapshots(timestamp)",
  );
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
    // T379: tool 単位観察用の専用列。
    // session_id は hook stdin の `session_id`、tool_name は PreToolUse/PostToolUse の `tool_name` を入れる。
    // payload_json と冗長だが集計 SQL の WHERE/JOIN を高速化するためインデックス対象として実列化する。
    "session_id",
    "tool_name",
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
  // T379
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_hook_signals_session_id ON hook_signals(session_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_hook_signals_tool_name ON hook_signals(tool_name)",
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
  // T379: PRE_TOOL_USE / POST_TOOL_USE / PRE_TOOL_USE_DENIED で本体メッセージに乗る
  // role / sessionId / toolName を専用列に直接書く（NotificationEnrichment 経路を経由しない）。
  const role = typeof m.role === "string" ? m.role : null;
  const sessionId = typeof m.sessionId === "string" ? m.sessionId : null;
  const toolName = typeof m.toolName === "string" ? m.toolName : null;

  const json = JSON.stringify(message);
  let safeJson = json;
  if (json.length > HOOK_SIGNAL_PAYLOAD_LIMIT) {
    safeJson = json.slice(0, HOOK_SIGNAL_PAYLOAD_LIMIT);
    console.warn(
      `[trace-store] hook_signal_payload_truncated type=${type} size=${json.length}`
    );
  }

  const stmt = db.prepare(`
    INSERT INTO hook_signals (timestamp, type, surface, pid, reason, source, question, task_run_id, payload_json, role, session_id, tool_name)
    VALUES ($timestamp, $type, $surface, $pid, $reason, $source, $question, $task_run_id, $payload_json, $role, $session_id, $tool_name)
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
    $role: role,
    $session_id: sessionId,
    $tool_name: toolName,
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

/**
 * T305: /v1/messages 1 リクエスト分の usage / rate limit を api_usage に追記する。
 * proxy.ts のレスポンス終端（非 streaming body 読み終わり / SSE drain 終端）で 1 回だけ呼ぶ。
 * 取れなかったフィールドは NULL を明示する（TEXT/INTEGER 列とも NULL 許容）。
 */
export function insertApiUsage(db: Database, record: ApiUsageRecord): number {
  const stmt = db.prepare(`
    INSERT INTO api_usage (
      timestamp, task_id, role, surface, conductor_id,
      model, request_id, status_code,
      input_tokens, output_tokens,
      cache_creation_input_tokens, cache_read_input_tokens,
      stop_reason, duration_ms,
      ratelimit_tokens_remaining, ratelimit_tokens_limit, ratelimit_tokens_reset,
      ratelimit_input_tokens_remaining, ratelimit_input_tokens_limit, ratelimit_input_tokens_reset,
      ratelimit_output_tokens_remaining, ratelimit_output_tokens_limit, ratelimit_output_tokens_reset,
      ratelimit_requests_remaining, ratelimit_requests_limit, ratelimit_requests_reset,
      error
    ) VALUES (
      $timestamp, $task_id, $role, $surface, $conductor_id,
      $model, $request_id, $status_code,
      $input_tokens, $output_tokens,
      $cache_creation_input_tokens, $cache_read_input_tokens,
      $stop_reason, $duration_ms,
      $ratelimit_tokens_remaining, $ratelimit_tokens_limit, $ratelimit_tokens_reset,
      $ratelimit_input_tokens_remaining, $ratelimit_input_tokens_limit, $ratelimit_input_tokens_reset,
      $ratelimit_output_tokens_remaining, $ratelimit_output_tokens_limit, $ratelimit_output_tokens_reset,
      $ratelimit_requests_remaining, $ratelimit_requests_limit, $ratelimit_requests_reset,
      $error
    )
  `);
  const result = stmt.run({
    $timestamp: record.timestamp,
    $task_id: record.task_id ?? null,
    $role: record.role ?? null,
    $surface: record.surface ?? null,
    $conductor_id: record.conductor_id ?? null,
    $model: record.model ?? null,
    $request_id: record.request_id ?? null,
    $status_code: record.status_code ?? null,
    $input_tokens: record.input_tokens ?? null,
    $output_tokens: record.output_tokens ?? null,
    $cache_creation_input_tokens: record.cache_creation_input_tokens ?? null,
    $cache_read_input_tokens: record.cache_read_input_tokens ?? null,
    $stop_reason: record.stop_reason ?? null,
    $duration_ms: record.duration_ms ?? null,
    $ratelimit_tokens_remaining: record.ratelimit_tokens_remaining ?? null,
    $ratelimit_tokens_limit: record.ratelimit_tokens_limit ?? null,
    $ratelimit_tokens_reset: record.ratelimit_tokens_reset ?? null,
    $ratelimit_input_tokens_remaining: record.ratelimit_input_tokens_remaining ?? null,
    $ratelimit_input_tokens_limit: record.ratelimit_input_tokens_limit ?? null,
    $ratelimit_input_tokens_reset: record.ratelimit_input_tokens_reset ?? null,
    $ratelimit_output_tokens_remaining: record.ratelimit_output_tokens_remaining ?? null,
    $ratelimit_output_tokens_limit: record.ratelimit_output_tokens_limit ?? null,
    $ratelimit_output_tokens_reset: record.ratelimit_output_tokens_reset ?? null,
    $ratelimit_requests_remaining: record.ratelimit_requests_remaining ?? null,
    $ratelimit_requests_limit: record.ratelimit_requests_limit ?? null,
    $ratelimit_requests_reset: record.ratelimit_requests_reset ?? null,
    $error: record.error ?? null,
  });
  return Number(result.lastInsertRowid);
}

/**
 * T354 (F1): role 文字列を `master / conductor / agent / unknown` の 4 値に正規化する。
 * SQL の `aggregateApiUsageByRole` の CASE と完全に同じルールに従う:
 * - "master" / "master, x-cmux-surface: ..." → "master"
 * - "conductor" / "conductor:auto-..." → "conductor"
 * - "agent" / "agent-impl-1234" → "agent"
 * - その他（NULL / "" / "system" 等） → "unknown"
 *
 * caption 表示や JS 側のロール判定で SQL と同じ結果を得たいときに使う（DRY 担保）。
 * テストで SQL のグルーピング結果と一致することを検証する。
 */
export function normalizeRole(
  raw: string | null | undefined,
): "master" | "conductor" | "agent" | "unknown" {
  if (typeof raw !== "string" || raw.length === 0) return "unknown";
  if (raw.startsWith("master")) return "master";
  if (raw.startsWith("conductor")) return "conductor";
  if (raw.startsWith("agent")) return "agent";
  return "unknown";
}

// T354: getProjection5h / getProjection7d の戻り値。
// `utilization` は最新 snapshot の utilization (0-1)、
// `resetIso` は最新 snapshot の reset 列をそのまま返す（ISO 8601 / epoch 秒文字列）。
// projection 秒数は (1 - utilization) / rate。0 で「即時枯渇」、null で「計算不能」を表す。
// リスク計算は呼び出し側（dashboard-metrics）で `computeRiskLevel` を使う。
export interface ProjectionResult {
  /** 最新 snapshot の utilization (0-1) */
  utilization: number;
  /** 最新 snapshot の reset 列。null は未取得 */
  resetIso: string | null;
  /** 「window 開始（reset - windowSec）」起点の枯渇予測秒数。null は計算不能 */
  longTermProjectedSec: number | null;
  /** 「直近 reset 以降 かつ now-15min 以降」の最古 snapshot 起点の枯渇予測秒数。
   *  1 件しかない / Δutil ≤ 0 / Δsec ≤ 0 のとき null */
  recentProjectedSec: number | null;
}

/**
 * reset 列の値（ISO 8601 文字列または epoch 秒文字列）を ms に正規化する。
 * proxy.ts:toEpochSec / formatResetRemaining と同じロジック。
 */
function parseResetMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const asNum = Number(raw);
  if (!isNaN(asNum) && asNum > 1e9) return Math.floor(asNum * 1000);
  const ms = new Date(raw).getTime();
  return isNaN(ms) ? null : ms;
}

/**
 * T354: 5h / 7d 共通の projection 計算。windowSec で軸を切り替える。
 *
 * - long-term: window_start = reset_ms - windowSec、elapsed = now - window_start。
 *   rate = utilization / elapsed、projection = (1 - utilization) / rate。
 *   utilization >= 1 のときは即時枯渇として 0 を返す。
 *   reset_iso 不明 / elapsed <= 0 / utilization <= 0 のときは null。
 * - recent 15m: 起点 = max(now - 15min, 直近 reset 以降)。
 *   起点以降かつ最新 snapshot 未満の最古 snapshot を取り、Δutil/Δsec から rate を出す。
 *   1 件しかない / Δutil ≤ 0 / Δsec ≤ 0 のとき null。
 *   utilization >= 1 のときは即時枯渇として 0 を返す。
 */
function projection(
  db: Database,
  utilCol: "unified_5h_utilization" | "unified_7d_utilization",
  resetCol: "unified_5h_reset" | "unified_7d_reset",
  windowSec: number,
  now: number,
): ProjectionResult | null {
  const latest = db
    .prepare(
      `SELECT timestamp, ${utilCol} AS util, ${resetCol} AS reset
       FROM rate_limit_snapshots
       WHERE ${utilCol} IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get() as { timestamp: string; util: number; reset: string | null } | undefined;

  if (!latest) return null;

  const utilization = latest.util;
  const resetIso = latest.reset;
  const resetMs = parseResetMs(resetIso);

  // ── long-term projection ────────────────────────────────────────────────
  let longTermProjectedSec: number | null = null;
  if (utilization >= 1) {
    longTermProjectedSec = 0;
  } else if (resetMs !== null && utilization > 0) {
    const windowStartMs = resetMs - windowSec * 1000;
    const elapsedSec = (now - windowStartMs) / 1000;
    if (elapsedSec > 0) {
      const rate = utilization / elapsedSec;
      if (rate > 0) {
        longTermProjectedSec = (1 - utilization) / rate;
      }
    }
  }

  // ── recent 15m projection ───────────────────────────────────────────────
  let recentProjectedSec: number | null = null;
  if (utilization >= 1) {
    recentProjectedSec = 0;
  } else {
    const fifteenMinAgoMs = now - 15 * 60 * 1000;
    let windowStartMs = fifteenMinAgoMs;
    if (resetMs !== null) {
      const lastResetMs = resetMs - windowSec * 1000;
      if (lastResetMs > windowStartMs) windowStartMs = lastResetMs;
    }
    const oldest = db
      .prepare(
        `SELECT timestamp, ${utilCol} AS util
         FROM rate_limit_snapshots
         WHERE ${utilCol} IS NOT NULL
           AND timestamp >= $sinceIso
           AND timestamp < $latestTs
         ORDER BY id ASC LIMIT 1`,
      )
      .get({
        $sinceIso: new Date(windowStartMs).toISOString(),
        $latestTs: latest.timestamp,
      }) as { timestamp: string; util: number } | undefined;

    if (oldest) {
      const dUtil = utilization - oldest.util;
      const dSec =
        (Date.parse(latest.timestamp) - Date.parse(oldest.timestamp)) / 1000;
      if (dUtil > 0 && dSec > 0) {
        const rate = dUtil / dSec;
        recentProjectedSec = (1 - utilization) / rate;
      }
    }
  }

  return {
    utilization,
    resetIso,
    longTermProjectedSec,
    recentProjectedSec,
  };
}

/** T354: 5h projection を返す。snapshot ゼロ件なら null。 */
export function getProjection5h(
  db: Database,
  now: number = Date.now(),
): ProjectionResult | null {
  return projection(
    db,
    "unified_5h_utilization",
    "unified_5h_reset",
    5 * 3600,
    now,
  );
}

/** T354: 7d projection を返す。snapshot ゼロ件なら null。 */
export function getProjection7d(
  db: Database,
  now: number = Date.now(),
): ProjectionResult | null {
  return projection(
    db,
    "unified_7d_utilization",
    "unified_7d_reset",
    7 * 86400,
    now,
  );
}

/**
 * T354: rate_limit_snapshots へ 1 行 INSERT する。
 * proxy.ts が extractRateLimit から得た RateLimitInfo を渡す。
 * 5h / 7d util が両方 null の場合は呼び出し側で skip される想定だが、
 * INSERT 自体はガードしない（呼び出し側責務）。
 */
export function insertRateLimitSnapshot(
  db: Database,
  record: RateLimitSnapshotRecord,
): number {
  const stmt = db.prepare(`
    INSERT INTO rate_limit_snapshots (
      timestamp,
      unified_5h_utilization,
      unified_5h_reset,
      unified_7d_utilization,
      unified_7d_reset
    ) VALUES (
      $timestamp,
      $unified_5h_utilization,
      $unified_5h_reset,
      $unified_7d_utilization,
      $unified_7d_reset
    )
  `);
  const result = stmt.run({
    $timestamp: record.timestamp,
    $unified_5h_utilization: record.unified_5h_utilization ?? null,
    $unified_5h_reset: record.unified_5h_reset ?? null,
    $unified_7d_utilization: record.unified_7d_utilization ?? null,
    $unified_7d_reset: record.unified_7d_reset ?? null,
  });
  return Number(result.lastInsertRowid);
}

export function getApiUsage(
  db: Database,
  opts: {
    taskId?: string;
    role?: string;
    surface?: string;
    error?: string;
    limit?: number;
  },
): ApiUsageRecord[] {
  const conditions: string[] = [];
  const params: Record<string, any> = {};

  if (opts.taskId) {
    conditions.push("task_id = $taskId");
    params.$taskId = opts.taskId;
  }
  if (opts.role) {
    conditions.push("role = $role");
    params.$role = opts.role;
  }
  if (opts.surface) {
    conditions.push("surface = $surface");
    params.$surface = opts.surface;
  }
  if (opts.error) {
    conditions.push("error = $error");
    params.$error = opts.error;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 50;

  const stmt = db.prepare(
    `SELECT * FROM api_usage ${where} ORDER BY id DESC LIMIT ${limit}`,
  );
  return stmt.all(params) as ApiUsageRecord[];
}

// T306: trace-task の Metrics セクション用 read-only 集計。
// いずれも WHERE task_id = ? で idx_api_usage_task_id を活用する。
// エラー行（error NOT NULL）も COUNT(*) / SUM に含まれる（コスト可視化の意図）。
// SQL の SUM は NULL を自動で無視するため、cache 列 NULL 混在でも安全。
// COALESCE(SUM(...), 0) で 0 行ヒット時に NULL ではなく 0 を返す。
export interface TaskUsageTotal {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface TaskUsageByRole extends TaskUsageTotal {
  role: string;
}

export interface TaskUsageByModel extends TaskUsageTotal {
  model: string;
}

export function getTaskUsageTotal(db: Database, taskId: string): TaskUsageTotal {
  const row = db
    .prepare(
      `
      SELECT
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read
      FROM api_usage
      WHERE task_id = $taskId
      `,
    )
    .get({ $taskId: taskId }) as
    | {
        requests: number;
        input_tokens: number;
        output_tokens: number;
        cache_creation: number;
        cache_read: number;
      }
    | null;

  if (!row) {
    return { requests: 0, inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0 };
  }
  return {
    requests: row.requests,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheCreation: row.cache_creation,
    cacheRead: row.cache_read,
  };
}

export function getTaskUsageByRole(db: Database, taskId: string): TaskUsageByRole[] {
  const rows = db
    .prepare(
      `
      SELECT
        COALESCE(role, 'unknown') AS role,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read
      FROM api_usage
      WHERE task_id = $taskId
      GROUP BY COALESCE(role, 'unknown')
      ORDER BY (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0)) DESC
      `,
    )
    .all({ $taskId: taskId }) as Array<{
      role: string;
      requests: number;
      input_tokens: number;
      output_tokens: number;
      cache_creation: number;
      cache_read: number;
    }>;

  return rows.map((r) => ({
    role: r.role,
    requests: r.requests,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheCreation: r.cache_creation,
    cacheRead: r.cache_read,
  }));
}

export function getTaskUsageByModel(db: Database, taskId: string): TaskUsageByModel[] {
  const rows = db
    .prepare(
      `
      SELECT
        COALESCE(model, '(unknown)') AS model,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read
      FROM api_usage
      WHERE task_id = $taskId
      GROUP BY COALESCE(model, '(unknown)')
      ORDER BY COUNT(*) DESC
      `,
    )
    .all({ $taskId: taskId }) as Array<{
      model: string;
      requests: number;
      input_tokens: number;
      output_tokens: number;
      cache_creation: number;
      cache_read: number;
    }>;

  return rows.map((r) => ({
    model: r.model,
    requests: r.requests,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheCreation: r.cache_creation,
    cacheRead: r.cache_read,
  }));
}
// ── T307: dashboard Metrics タブ用の集計関数 ─────────────────────────────────
//
// SQL 集計は trace-store の責務、UI build は dashboard の責務（D4）。
// 4 関数とも `$param` バインディングで SQL インジェクション回避。
// timestamp は TEXT 列だが ISO 8601 は辞書順 = 時系列順なので文字列比較で OK。

/** aggregateApiUsageByRole の 1 ロール分の集計結果。 */
export interface AggregatedRoleRow {
  /** master / conductor / agent / unknown（NULL は "unknown" に fallback） */
  role: string;
  /** このロールの api_usage レコード件数 */
  requests: number;
  /** input_tokens SUM（NULL は無視） */
  input: number;
  /** output_tokens SUM（NULL は無視） */
  output: number;
  /** cache_creation_input_tokens + cache_read_input_tokens の合計（NULL は 0 扱い） */
  cache: number;
  /** cache_read_input_tokens SUM のみ（キャッシュヒット量の内訳） */
  cache_read: number;
}

/** aggregateApiUsageByTask の 1 タスク分の集計結果。 */
export interface AggregatedTaskRow {
  /** T001 / T042 等のタスク ID。task_id IS NULL 行は除外されるため常に非 null。 */
  task_id: string;
  /** このタスクの api_usage レコード件数 */
  requests: number;
  /** input_tokens SUM */
  input: number;
  /** output_tokens SUM */
  output: number;
  /** cache_creation + cache_read の合計 */
  cache: number;
}

/** getBurnRateWindow の戻り値。 */
export interface BurnRateResult {
  /** ウィンドウ内の input_tokens + output_tokens の合計（NULL は 0 扱い） */
  totalTokens: number;
  /** 入力で指定されたウィンドウ幅（秒） */
  windowSec: number;
  /** totalTokens / windowSec。空ウィンドウなら 0 */
  tokPerSec: number;
}

/**
 * ロール別に `[sinceIso, untilIso]` 範囲の api_usage を集計する。
 * T354: `master, x-cmux-surface: ...` のような汚染 role が `master` に集約されるよう
 * `WITH normalized AS (CASE ...)` で正規化してから GROUP BY する。
 * 値域は `master / conductor / agent / unknown` の 4 値のみに固定される。
 * ORDER BY も master → conductor → agent → unknown の固定順 → トークン合計降順の二段。
 */
export function aggregateApiUsageByRole(
  db: Database,
  opts: { sinceIso: string; untilIso: string },
): AggregatedRoleRow[] {
  const stmt = db.prepare(`
    WITH normalized AS (
      SELECT
        CASE
          WHEN role LIKE 'master%'    THEN 'master'
          WHEN role LIKE 'conductor%' THEN 'conductor'
          WHEN role LIKE 'agent%'     THEN 'agent'
          ELSE 'unknown'
        END AS role,
        input_tokens,
        output_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens
      FROM api_usage
      WHERE timestamp >= $sinceIso AND timestamp <= $untilIso
    )
    SELECT
      role,
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens), 0) AS input,
      COALESCE(SUM(output_tokens), 0) AS output,
      COALESCE(SUM(cache_creation_input_tokens), 0) + COALESCE(SUM(cache_read_input_tokens), 0) AS cache,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read
    FROM normalized
    GROUP BY role
    ORDER BY
      CASE role WHEN 'master' THEN 1 WHEN 'conductor' THEN 2 WHEN 'agent' THEN 3 ELSE 4 END,
      (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0)) DESC
  `);
  return stmt.all({
    $sinceIso: opts.sinceIso,
    $untilIso: opts.untilIso,
  }) as AggregatedRoleRow[];
}

/**
 * タスク別に `[sinceIso, untilIso]` 範囲の api_usage を集計する。
 * task_id IS NULL 行（Master 等のタスク紐付きなしリクエスト）は除外（D8 の方針）。
 * (input + output) の合計降順で limit 件を返す。
 */
export function aggregateApiUsageByTask(
  db: Database,
  opts: { sinceIso: string; untilIso: string; limit: number },
): AggregatedTaskRow[] {
  const stmt = db.prepare(`
    SELECT
      task_id AS task_id,
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens), 0) AS input,
      COALESCE(SUM(output_tokens), 0) AS output,
      COALESCE(SUM(cache_creation_input_tokens), 0) + COALESCE(SUM(cache_read_input_tokens), 0) AS cache
    FROM api_usage
    WHERE task_id IS NOT NULL
      AND timestamp >= $sinceIso
      AND timestamp <= $untilIso
    GROUP BY task_id
    ORDER BY (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0)) DESC
    LIMIT $limit
  `);
  return stmt.all({
    $sinceIso: opts.sinceIso,
    $untilIso: opts.untilIso,
    $limit: opts.limit,
  }) as AggregatedTaskRow[];
}

// ────────────────────────────────────────────────────────────────────────
// T379: hook_signals 由来の tool 単位集計 SQL
// ────────────────────────────────────────────────────────────────────────

/**
 * T379: PRE_TOOL_USE / POST_TOOL_USE / PRE_TOOL_USE_DENIED の集計 1 行。
 * 集計上 task_id が解決できない hook（task_assigned 前 / task_sessions 未到達）は
 * `task_id = null` で残し、CLI 側で「unattached」として別カウントできるようにする。
 */
export interface ToolCallByTaskRow {
  /** 対応する task_id（task_sessions の event=assigned 行で MIN(task_id) を取って解決した値）。未解決なら null。 */
  task_id: string | null;
  /** PreToolUse/PostToolUse メッセージの `tool_name`（Edit / Read / Bash 等）。 */
  tool_name: string;
  /** count(*) */
  n: number;
}

/**
 * T379: タスク × tool_name で PRE_TOOL_USE 件数を集計する。
 *
 * task_sessions は同 session_id に対して複数行を持ちうる（resume / clear 等で append される）ため、
 * `WITH session_to_task AS (... GROUP BY session_id)` で session_id → task_id を 1:1 に集約してから JOIN する。
 * これがないと 2 行 hit で tool 件数が二重カウントされる（design-review Recommendation 3）。
 *
 * T407: `event = 'assigned'` だけでは Conductor 由来の tool_use しか task_id 解決できないため、
 * `event IN ('assigned','agent_spawned')` に拡張して Agent 由来 tool_use も task_id へ紐づけられるようにする。
 * さらに `session_id != ''` の防御を加え、過去の backfill されていない空 session_id 行
 * （cmdSpawnAgent の旧経路で書かれた `session_id: ""` の agent_spawned 行 / 空 session_id の hook_signals 行）が
 * 互いに誤マッチして「empty 同士で JOIN ヒット」する regression を防ぐ。
 *
 * task_id 未解決（join 結果 NULL）の行は task_id = null として残し、
 * 集計 CLI 側で unattached として別カウントできるようにする。
 */
export function countToolCallsByTask(
  db: Database,
  opts: { sinceIso: string; untilIso: string; type?: "PRE_TOOL_USE" | "POST_TOOL_USE" },
): ToolCallByTaskRow[] {
  const type = opts.type ?? "PRE_TOOL_USE";
  const stmt = db.prepare(`
    WITH session_to_task AS (
      SELECT session_id, MIN(task_id) AS task_id
      FROM task_sessions
      WHERE event IN ('assigned','agent_spawned')
        AND task_id IS NOT NULL
        AND session_id IS NOT NULL AND session_id != ''
      GROUP BY session_id
    )
    SELECT s2t.task_id AS task_id, h.tool_name AS tool_name, COUNT(*) AS n
    FROM hook_signals h
    LEFT JOIN session_to_task s2t
      ON h.session_id = s2t.session_id
      AND h.session_id != ''
    WHERE h.type = $type
      AND h.timestamp >= $sinceIso
      AND h.timestamp <= $untilIso
      AND h.tool_name IS NOT NULL
    GROUP BY s2t.task_id, h.tool_name
    ORDER BY s2t.task_id IS NULL ASC, s2t.task_id ASC, h.tool_name ASC
  `);
  return stmt.all({
    $type: type,
    $sinceIso: opts.sinceIso,
    $untilIso: opts.untilIso,
  }) as ToolCallByTaskRow[];
}

/** T379: タスク別「最初の Edit ツール呼び出し時刻」を返す。 */
export interface FirstEditByTaskRow {
  /** 対応する task_id。session_to_task で解決できなかったものは含まない（NULL は除外）。 */
  task_id: string;
  /** 最初の PRE_TOOL_USE Edit の timestamp（ISO 8601）。 */
  first_edit_ts: string;
}

/**
 * T379: タスク別に最初の Edit ツール呼び出し時刻を返す。
 * task_assigned 時刻との差分から「time-to-first-edit」を算出する目的。
 * task_id 未解決行は除外（time-to-first-edit を算出できないため）。
 *
 * T407: countToolCallsByTask と同じく `event IN ('assigned','agent_spawned')` + `session_id != ''` 防御を適用。
 */
export function firstEditPerTask(
  db: Database,
  opts: { sinceIso: string; untilIso: string },
): FirstEditByTaskRow[] {
  const stmt = db.prepare(`
    WITH session_to_task AS (
      SELECT session_id, MIN(task_id) AS task_id
      FROM task_sessions
      WHERE event IN ('assigned','agent_spawned')
        AND task_id IS NOT NULL
        AND session_id IS NOT NULL AND session_id != ''
      GROUP BY session_id
    )
    SELECT s2t.task_id AS task_id, MIN(h.timestamp) AS first_edit_ts
    FROM hook_signals h
    JOIN session_to_task s2t
      ON h.session_id = s2t.session_id
      AND h.session_id != ''
    WHERE h.type = 'PRE_TOOL_USE'
      AND h.tool_name = 'Edit'
      AND h.timestamp >= $sinceIso
      AND h.timestamp <= $untilIso
    GROUP BY s2t.task_id
  `);
  return stmt.all({
    $sinceIso: opts.sinceIso,
    $untilIso: opts.untilIso,
  }) as FirstEditByTaskRow[];
}

/** T379: タスク別 PostToolUse の成功 / 失敗件数（payload_json から JSON_EXTRACT で抽出）。 */
export interface ToolFailureByTaskRow {
  task_id: string | null;
  total: number;
  failures: number;
}

/**
 * T379: タスク別に PostToolUse の総数と失敗数を返す。
 * 失敗判定は `tool_response.success = false` または `tool_response.error IS NOT NULL`。
 * 集計時の `JSON_EXTRACT` の path は payload_json の `payload.tool_response`（schema に従う）。
 *
 * T407: countToolCallsByTask と同じく `event IN ('assigned','agent_spawned')` + `session_id != ''` 防御を適用。
 */
export function failureRateByTask(
  db: Database,
  opts: { sinceIso: string; untilIso: string },
): ToolFailureByTaskRow[] {
  const stmt = db.prepare(`
    WITH session_to_task AS (
      SELECT session_id, MIN(task_id) AS task_id
      FROM task_sessions
      WHERE event IN ('assigned','agent_spawned')
        AND task_id IS NOT NULL
        AND session_id IS NOT NULL AND session_id != ''
      GROUP BY session_id
    )
    SELECT
      s2t.task_id AS task_id,
      COUNT(*) AS total,
      SUM(
        CASE
          WHEN NOT json_valid(h.payload_json) THEN 0
          WHEN JSON_EXTRACT(h.payload_json, '$.payload.tool_response.success') = 0 THEN 1
          WHEN JSON_EXTRACT(h.payload_json, '$.payload.tool_response.error') IS NOT NULL THEN 1
          ELSE 0
        END
      ) AS failures
    FROM hook_signals h
    LEFT JOIN session_to_task s2t
      ON h.session_id = s2t.session_id
      AND h.session_id != ''
    WHERE h.type = 'POST_TOOL_USE'
      AND h.timestamp >= $sinceIso
      AND h.timestamp <= $untilIso
    GROUP BY s2t.task_id
    ORDER BY s2t.task_id IS NULL ASC, s2t.task_id ASC
  `);
  return stmt.all({
    $sinceIso: opts.sinceIso,
    $untilIso: opts.untilIso,
  }) as ToolFailureByTaskRow[];
}

/** T379: 期間内の PreToolUse 総数と PRE_TOOL_USE_DENIED 件数（hook block 率算出用）。 */
export interface DenyRateRow {
  pre_total: number;
  denied: number;
}

/**
 * T379: 期間内の PRE_TOOL_USE 件数と PRE_TOOL_USE_DENIED 件数を返す。
 * help_metrics に明記する通り、現状の denied は「Conductor の Bash deny script による block」のみで
 * Claude Code の他 hook が exit 2 で deny した件数は含まない。利用者誤読を避けるため CLI 説明にも明記。
 */
export function denyRateByPeriod(
  db: Database,
  opts: { sinceIso: string; untilIso: string },
): DenyRateRow {
  const stmt = db.prepare(`
    SELECT
      SUM(CASE WHEN type = 'PRE_TOOL_USE' THEN 1 ELSE 0 END) AS pre_total,
      SUM(CASE WHEN type = 'PRE_TOOL_USE_DENIED' THEN 1 ELSE 0 END) AS denied
    FROM hook_signals
    WHERE timestamp >= $sinceIso AND timestamp <= $untilIso
  `);
  const row = stmt.get({
    $sinceIso: opts.sinceIso,
    $untilIso: opts.untilIso,
  }) as { pre_total: number | null; denied: number | null };
  return {
    pre_total: row.pre_total ?? 0,
    denied: row.denied ?? 0,
  };
}

/**
 * api_usage の最新 1 行（id DESC LIMIT 1）を返す。
 * Metrics タブの分単位 rate limit remaining/limit/reset 表示に使う
 * （Anthropic は account 単位ウィンドウなので role を問わず最新で OK）。
 * 空テーブルなら null。
 */
export function getLatestApiUsageRow(db: Database): ApiUsageRecord | null {
  const row = db
    .prepare("SELECT * FROM api_usage ORDER BY id DESC LIMIT 1")
    .get() as ApiUsageRecord | undefined;
  return row ?? null;
}

// ────────────────────────────────────────────────────────────────────────
// T414: Web ダッシュボード用 集計 SQL
// ────────────────────────────────────────────────────────────────────────

/** T414: per-tool 件数集計（task_id を集約せず tool_name で SUM） */
export interface ToolCallByPeriodRow {
  tool_name: string;
  n: number;
}

/**
 * T414: 期間内に発火した tool 呼び出しを tool_name 単位で件数集計する。
 * task_id 解決は不要（per-tool 集計のため）。
 */
export function countToolCallsByPeriod(
  db: Database,
  opts: { sinceIso: string; untilIso: string; type?: "PRE_TOOL_USE" | "POST_TOOL_USE" },
): ToolCallByPeriodRow[] {
  const type = opts.type ?? "PRE_TOOL_USE";
  const stmt = db.prepare(`
    SELECT tool_name, COUNT(*) AS n
    FROM hook_signals
    WHERE type = $type
      AND timestamp >= $sinceIso
      AND timestamp <= $untilIso
      AND tool_name IS NOT NULL
    GROUP BY tool_name
    ORDER BY n DESC, tool_name ASC
  `);
  return stmt.all({
    $type: type,
    $sinceIso: opts.sinceIso,
    $untilIso: opts.untilIso,
  }) as ToolCallByPeriodRow[];
}

/** T414: per-tool 失敗率集計（failureRateByTask の tool_name 版） */
export interface ToolFailureByToolRow {
  tool_name: string;
  total: number;
  failures: number;
}

/**
 * T414: 期間内の PostToolUse を tool_name 別に成功/失敗集計する。
 * 失敗判定ロジックは failureRateByTask と同じ（tool_response.success=0 / tool_response.error 非 NULL）。
 */
export function failureRateByTool(
  db: Database,
  opts: { sinceIso: string; untilIso: string },
): ToolFailureByToolRow[] {
  const stmt = db.prepare(`
    SELECT
      tool_name,
      COUNT(*) AS total,
      SUM(
        CASE
          WHEN NOT json_valid(payload_json) THEN 0
          WHEN JSON_EXTRACT(payload_json, '$.payload.tool_response.success') = 0 THEN 1
          WHEN JSON_EXTRACT(payload_json, '$.payload.tool_response.error') IS NOT NULL THEN 1
          ELSE 0
        END
      ) AS failures
    FROM hook_signals
    WHERE type = 'POST_TOOL_USE'
      AND timestamp >= $sinceIso
      AND timestamp <= $untilIso
      AND tool_name IS NOT NULL
    GROUP BY tool_name
    ORDER BY total DESC, tool_name ASC
  `);
  return stmt.all({
    $sinceIso: opts.sinceIso,
    $untilIso: opts.untilIso,
  }) as ToolFailureByToolRow[];
}

/** T414: time-bucket 単位の token 集計（Overview / Tokens timeline 用） */
export interface ApiUsageByBucketRow {
  bucket: string;
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
  requests: number;
}

/**
 * T414: api_usage を hour / day bucket で集計する。
 * timestamp は ISO 8601 UTC を期待し、`substr(timestamp, 1, $bucketLen)` で bucket key を生成。
 *  - day  : YYYY-MM-DD       (bucketLen=10)
 *  - hour : YYYY-MM-DDTHH    (bucketLen=13)
 *
 * task_id IS NULL も含めて全行を SUM する（grand-total として返す）。
 */
export function aggregateApiUsageByBucket(
  db: Database,
  opts: { sinceIso: string; untilIso: string; groupBy: "hour" | "day" },
): ApiUsageByBucketRow[] {
  const bucketLen = opts.groupBy === "hour" ? 13 : 10;
  const stmt = db.prepare(`
    SELECT
      substr(timestamp, 1, $bucketLen) AS bucket,
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens), 0) AS input,
      COALESCE(SUM(output_tokens), 0) AS output,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read
    FROM api_usage
    WHERE timestamp >= $sinceIso
      AND timestamp <= $untilIso
    GROUP BY bucket
    ORDER BY bucket ASC
  `);
  return stmt.all({
    $bucketLen: bucketLen,
    $sinceIso: opts.sinceIso,
    $untilIso: opts.untilIso,
  }) as ApiUsageByBucketRow[];
}

/**
 * 直近 `windowSec` 秒内の input_tokens + output_tokens 合計と tok/s を返す。
 *
 * `timestamp` 列は `2026-04-24T10:00:00.000Z` 形式の ISO 8601 UTC を期待する
 * （`insertApiUsage` 呼び出し側は `new Date().toISOString()` 等で渡す）。
 * SQLite 標準の `datetime('now', ...)` は `2026-04-24 10:00:00`（T なし Z なし）
 * を返すため辞書順比較が壊れる。ここでは境界時刻を JS 側で ISO 8601 に正規化して
 * パラメータで渡す（cutoff を 1 回計算して文字列比較するだけ）。
 * 空ウィンドウの場合 `tokPerSec = 0`。
 */
export function getBurnRateWindow(db: Database, windowSec: number): BurnRateResult {
  const cutoffIso = new Date(Date.now() - windowSec * 1000).toISOString();
  const row = db
    .prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total
      FROM api_usage
      WHERE timestamp >= $cutoffIso
    `)
    .get({ $cutoffIso: cutoffIso }) as { total: number };
  const totalTokens = row?.total ?? 0;
  return {
    totalTokens,
    windowSec,
    tokPerSec: windowSec > 0 ? totalTokens / windowSec : 0,
  };
}
