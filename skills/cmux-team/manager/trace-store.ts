/**
 * トレースストア — SQLite ベースの API トレース記録
 *
 * bun:sqlite を使用。外部依存なし。
 * DB パス: .team/traces/traces.db
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";

export interface TraceRecord {
  id?: number;
  timestamp: string;
  task_id?: string;
  conductor_id?: string;
  role?: string;
  session_id?: string;
  method: string;
  path: string;
  status?: number;
  request_bytes?: number;
  response_bytes?: number;
  duration_ms?: number;
  request_body_path?: string;
  response_body_path?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  task_id TEXT,
  conductor_id TEXT,
  role TEXT,
  session_id TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER,
  request_bytes INTEGER,
  response_bytes INTEGER,
  duration_ms INTEGER,
  request_body_path TEXT,
  response_body_path TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS traces_fts USING fts5(
  task_id, conductor_id, role, session_id, path,
  content=traces, content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS traces_ai AFTER INSERT ON traces BEGIN
  INSERT INTO traces_fts(rowid, task_id, conductor_id, role, session_id, path)
  VALUES (new.id, new.task_id, new.conductor_id, new.role, new.session_id, new.path);
END;
`;

export function initDB(projectRoot: string): Database {
  const dir = join(projectRoot, ".team/traces");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "traces.db"));
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(SCHEMA);
  return db;
}

export function insertTrace(db: Database, trace: TraceRecord): number {
  const stmt = db.prepare(`
    INSERT INTO traces (timestamp, task_id, conductor_id, role, session_id, method, path, status, request_bytes, response_bytes, duration_ms, request_body_path, response_body_path)
    VALUES ($timestamp, $task_id, $conductor_id, $role, $session_id, $method, $path, $status, $request_bytes, $response_bytes, $duration_ms, $request_body_path, $response_body_path)
  `);
  const result = stmt.run({
    $timestamp: trace.timestamp,
    $task_id: trace.task_id ?? null,
    $conductor_id: trace.conductor_id ?? null,
    $role: trace.role ?? null,
    $session_id: trace.session_id ?? null,
    $method: trace.method,
    $path: trace.path,
    $status: trace.status ?? null,
    $request_bytes: trace.request_bytes ?? null,
    $response_bytes: trace.response_bytes ?? null,
    $duration_ms: trace.duration_ms ?? null,
    $request_body_path: trace.request_body_path ?? null,
    $response_body_path: trace.response_body_path ?? null,
  });
  return Number(result.lastInsertRowid);
}

export function searchTraces(
  db: Database,
  opts: { taskId?: string; conductorId?: string; role?: string; search?: string; limit?: number }
): TraceRecord[] {
  const conditions: string[] = [];
  const params: Record<string, any> = {};

  if (opts.taskId) {
    conditions.push("t.task_id = $taskId");
    params.$taskId = opts.taskId;
  }
  if (opts.conductorId) {
    conditions.push("t.conductor_id = $conductorId");
    params.$conductorId = opts.conductorId;
  }
  if (opts.role) {
    conditions.push("t.role = $role");
    params.$role = opts.role;
  }
  if (opts.search) {
    conditions.push("t.id IN (SELECT rowid FROM traces_fts WHERE traces_fts MATCH $search)");
    params.$search = opts.search;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 20;

  const stmt = db.prepare(`SELECT t.* FROM traces t ${where} ORDER BY t.id DESC LIMIT ${limit}`);
  return stmt.all(params) as TraceRecord[];
}

export function getTrace(db: Database, id: number): TraceRecord | null {
  const stmt = db.prepare("SELECT * FROM traces WHERE id = $id");
  return (stmt.get({ $id: id }) as TraceRecord) ?? null;
}
