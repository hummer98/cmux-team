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
  notification_type TEXT
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
 * role が NULL の行は `"unknown"` に fallback される（D8 の方針）。
 */
export function aggregateApiUsageByRole(
  db: Database,
  opts: { sinceIso: string; untilIso: string },
): AggregatedRoleRow[] {
  const stmt = db.prepare(`
    SELECT
      COALESCE(role, 'unknown') AS role,
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens), 0) AS input,
      COALESCE(SUM(output_tokens), 0) AS output,
      COALESCE(SUM(cache_creation_input_tokens), 0) + COALESCE(SUM(cache_read_input_tokens), 0) AS cache,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read
    FROM api_usage
    WHERE timestamp >= $sinceIso AND timestamp <= $untilIso
    GROUP BY COALESCE(role, 'unknown')
    ORDER BY (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0)) DESC
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
