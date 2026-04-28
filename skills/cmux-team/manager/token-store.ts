/**
 * トークンストア — `~/.cmux-team/tokens.db` の初期化・CRUD・Keychain 連携。
 *
 * グローバルトークンプール機能 (A019) の基盤モジュール。単一ファイル完結で、
 * 後続タスク (token CLI / proxy UPSERT / spawn-agent selection / TUI) が import する。
 *
 * 設計は plan.md (T318) に従う。既存パターンは `trace-store.ts` / `gh-cache-store.ts` を踏襲。
 */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";

// ─────────────────────────────────────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────────────────────────────────────

export type TokenPlan = "pro" | "max-x5" | "max-x20" | "unknown";
export type CredentialSource = "claude-credentials" | "manual" | "auto-discover";

export interface Token {
  id: number;
  handle: string;
  organization_id: string;
  auth_hash: string;
  plan: TokenPlan;
  plan_ratio: number | null;
  credential_source: CredentialSource | null;
  tags: string[];
  selectable: boolean;
  created_at: string;
}

export interface UsageSnapshot {
  id: number;
  token_id: number;
  util_5h: number | null;
  util_7d: number | null;
  reset_5h_at: string | null;
  reset_7d_at: string | null;
  unified_status: string | null;
  recorded_at: string;
}

export interface Lease {
  token_id: number;
  holder: string;
  acquired_at: string;
  expires_at: string;
}

export interface TokenForCapacity {
  handle: string;
  plan_ratio: number | null;
  util_5h: number | null;
  util_7d: number | null;
  reset_5h_at: string | null;
  reset_7d_at: string | null;
}

export interface PoolCapacityResult {
  /** 全 token の 5h flow 合計を REFERENCE_FLOW で正規化したパーセント */
  capacity_5h_pct: number;
  /** 全 token の 7d flow 合計を REFERENCE_FLOW で正規化したパーセント */
  capacity_7d_pct: number;
  /**
   * 各 token の per-token cap。`cap_pct` は従来通り `min(flow_5h, flow_7d)` ベース
   * （per-token 表示は引き続きボトルネック側を出すのが自然なので維持）。
   */
  per_token: Array<{ handle: string; cap_pct: number }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// エラー型
// ─────────────────────────────────────────────────────────────────────────────

export class KeychainUnsupportedError extends Error {
  constructor(message = "keychain is only supported on macOS") {
    super(message);
    this.name = "KeychainUnsupportedError";
  }
}

export class KeychainNotFoundError extends Error {
  constructor(public readonly handle: string) {
    super(`token not found for handle=${handle}`);
    this.name = "KeychainNotFoundError";
  }
}

export class KeychainCommandError extends Error {
  constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = "KeychainCommandError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 初期化
// ─────────────────────────────────────────────────────────────────────────────

export interface InitTokenDBOptions {
  /** 明示指定が最優先。なければ env、それもなければ `~/.cmux-team/tokens.db`。 */
  dbPath?: string;
  /** DB ファイルの親ディレクトリ。省略時は dbPath の dirname。 */
  dirPath?: string;
}

const KEYCHAIN_SERVICE = "cmux-team-token";

/**
 * Claude Code 本体が credential を保管している macOS Keychain サービス名（T345）。
 * `~/.claude/.credentials.json` と同じ JSON shape（`claudeAiOauth` を含む）を返す。
 */
export const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS tokens (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  handle            TEXT    NOT NULL UNIQUE,
  organization_id   TEXT    NOT NULL UNIQUE,
  auth_hash         TEXT    NOT NULL,
  plan              TEXT    NOT NULL DEFAULT 'unknown',
  plan_ratio        REAL,
  credential_source TEXT,
  tags              TEXT    NOT NULL DEFAULT '["any"]',
  selectable        INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_selectable ON tokens(selectable);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id       INTEGER NOT NULL UNIQUE REFERENCES tokens(id),
  util_5h        REAL,
  util_7d        REAL,
  reset_5h_at    TEXT,
  reset_7d_at    TEXT,
  unified_status TEXT,
  recorded_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_snapshots_token_time
  ON usage_snapshots(token_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS leases (
  token_id    INTEGER NOT NULL UNIQUE REFERENCES tokens(id),
  holder      TEXT    NOT NULL,
  acquired_at TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  PRIMARY KEY (token_id, holder)
);
CREATE INDEX IF NOT EXISTS idx_leases_expires ON leases(expires_at);
`;

function resolveDbPath(opts?: InitTokenDBOptions): { dbPath: string; dirPath: string } {
  const envPath = process.env.TOKEN_STORE_DB_PATH;
  const dbPath = opts?.dbPath ?? envPath ?? join(homedir(), ".cmux-team", "tokens.db");
  const dirPath = opts?.dirPath ?? dirname(dbPath);
  return { dbPath, dirPath };
}

export function initTokenDB(opts?: InitTokenDBOptions): Database {
  const { dbPath, dirPath } = resolveDbPath(opts);

  mkdirSync(dirPath, { recursive: true, mode: 0o700 });

  const isNew = !existsSync(dbPath);
  const db = new Database(dbPath);
  if (isNew) {
    try {
      chmodSync(dbPath, 0o600);
    } catch (e) {
      // 既存 DB への上書きや test 環境での権限エラーは無視（親ディレクトリの 0700 が防御線）
      console.warn(`[token-store] chmod 0600 failed path=${dbPath} err=${(e as Error).message}`);
    }
  }

  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(SCHEMA_V1);

  ensureTokensColumns(db);
  ensureUsageSnapshotsColumns(db);
  ensureLeasesColumns(db);

  return db;
}

function ensureTokensColumns(db: Database): void {
  const rows = db.prepare("PRAGMA table_info(tokens)").all() as Array<{ name: string }>;
  const existing = new Set(rows.map((r) => r.name));
  const required: Array<[string, "TEXT" | "INTEGER" | "REAL"]> = [
    // v1 で全列揃っている。将来の列追加をここに追記する。
  ];
  for (const [col, type] of required) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE tokens ADD COLUMN ${col} ${type}`);
      console.warn(`[token-store] tokens_migrated col=${col}`);
    }
  }
}

function ensureUsageSnapshotsColumns(db: Database): void {
  const rows = db
    .prepare("PRAGMA table_info(usage_snapshots)")
    .all() as Array<{ name: string }>;
  const existing = new Set(rows.map((r) => r.name));
  const required: Array<[string, "TEXT" | "INTEGER" | "REAL"]> = [
    // v1 で全列揃っている。
  ];
  for (const [col, type] of required) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE usage_snapshots ADD COLUMN ${col} ${type}`);
      console.warn(`[token-store] usage_snapshots_migrated col=${col}`);
    }
  }
}

function ensureLeasesColumns(db: Database): void {
  const rows = db.prepare("PRAGMA table_info(leases)").all() as Array<{ name: string }>;
  const existing = new Set(rows.map((r) => r.name));
  const required: Array<[string, "TEXT" | "INTEGER" | "REAL"]> = [
    // v1 で全列揃っている。
  ];
  for (const [col, type] of required) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE leases ADD COLUMN ${col} ${type}`);
      console.warn(`[token-store] leases_migrated col=${col}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// tokens CRUD
// ─────────────────────────────────────────────────────────────────────────────

export interface InsertTokenInput {
  handle: string;
  organization_id: string;
  auth_hash: string;
  plan: TokenPlan;
  plan_ratio: number | null;
  tags: string[];
  credential_source: CredentialSource | null;
  selectable?: boolean;
}

interface TokenRow {
  id: number;
  handle: string;
  organization_id: string;
  auth_hash: string;
  plan: string;
  plan_ratio: number | null;
  credential_source: string | null;
  tags: string;
  selectable: number;
  created_at: string;
}

function rowToToken(row: TokenRow): Token {
  let tags: string[];
  try {
    const parsed = JSON.parse(row.tags);
    tags = Array.isArray(parsed) ? parsed.map(String) : ["any"];
  } catch {
    tags = ["any"];
  }
  return {
    id: row.id,
    handle: row.handle,
    organization_id: row.organization_id,
    auth_hash: row.auth_hash,
    plan: row.plan as TokenPlan,
    plan_ratio: row.plan_ratio,
    credential_source: (row.credential_source as CredentialSource | null) ?? null,
    tags,
    selectable: row.selectable === 1,
    created_at: row.created_at,
  };
}

export function insertToken(db: Database, input: InsertTokenInput): Token {
  const tagsJson = JSON.stringify(input.tags ?? ["any"]);
  const selectable = input.selectable === false ? 0 : 1;
  const createdAt = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO tokens (handle, organization_id, auth_hash, plan, plan_ratio,
                        credential_source, tags, selectable, created_at)
    VALUES ($handle, $organization_id, $auth_hash, $plan, $plan_ratio,
            $credential_source, $tags, $selectable, $created_at)
  `);
  const result = stmt.run({
    $handle: input.handle,
    $organization_id: input.organization_id,
    $auth_hash: input.auth_hash,
    $plan: input.plan,
    $plan_ratio: input.plan_ratio,
    $credential_source: input.credential_source,
    $tags: tagsJson,
    $selectable: selectable,
    $created_at: createdAt,
  });

  const row = db
    .prepare("SELECT * FROM tokens WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as TokenRow | undefined;
  if (!row) {
    throw new Error(`insertToken: row not found after insert id=${result.lastInsertRowid}`);
  }
  return rowToToken(row);
}

export function getTokenByOrganizationId(
  db: Database,
  organization_id: string,
): Token | null {
  const row = db
    .prepare("SELECT * FROM tokens WHERE organization_id = ?")
    .get(organization_id) as TokenRow | undefined;
  return row ? rowToToken(row) : null;
}

export function getTokenByHandle(db: Database, handle: string): Token | null {
  const row = db
    .prepare("SELECT * FROM tokens WHERE handle = ?")
    .get(handle) as TokenRow | undefined;
  return row ? rowToToken(row) : null;
}

export function getTokenByAuthHash(db: Database, authHash: string): Token | null {
  const row = db
    .prepare("SELECT * FROM tokens WHERE auth_hash = ?")
    .get(authHash) as TokenRow | undefined;
  return row ? rowToToken(row) : null;
}

export function listTokens(
  db: Database,
  opts?: { selectableOnly?: boolean },
): Token[] {
  const where = opts?.selectableOnly ? "WHERE selectable = 1" : "";
  const rows = db
    .prepare(`SELECT * FROM tokens ${where} ORDER BY id ASC`)
    .all() as TokenRow[];
  return rows.map(rowToToken);
}

/**
 * tokens / usage_snapshots / leases から token_id に紐付く全レコードを削除する。
 *
 * - 1 つの transaction で 3 テーブルを明示削除（既存 schema は ON DELETE CASCADE 未設定）
 * - 存在しない id でも例外を出さない（冪等。補償トランザクションでの再実行に必要）
 * - Keychain は別系統。呼び出し側で `deleteTokenFromKeychain(handle)` を実行すること
 */
export function deleteToken(db: Database, token_id: number): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM leases WHERE token_id = ?").run(token_id);
    db.prepare("DELETE FROM usage_snapshots WHERE token_id = ?").run(token_id);
    db.prepare("DELETE FROM tokens WHERE id = ?").run(token_id);
  });
  tx();
}

/** auth_hash 列だけを更新する。rotate の補償トランザクション両方向で利用する。 */
export function updateTokenAuth(
  db: Database,
  token_id: number,
  new_auth_hash: string,
): void {
  db.prepare("UPDATE tokens SET auth_hash = ? WHERE id = ?").run(
    new_auth_hash,
    token_id,
  );
}

/**
 * plan / plan_ratio のみ更新する（`set-plan` 用）。
 * selectable / tags / handle / organization_id / auth_hash は維持。
 */
export function updateTokenPlan(
  db: Database,
  token_id: number,
  plan: TokenPlan,
  plan_ratio: number | null,
): void {
  db.prepare("UPDATE tokens SET plan = ?, plan_ratio = ? WHERE id = ?").run(
    plan,
    plan_ratio,
    token_id,
  );
}

/**
 * auto-discover token を正規 token に昇格させる（T341 `cmux-team token promote`）。
 *
 * `handle / auth_hash / plan / plan_ratio / tags / credential_source` を atomic に
 * UPDATE し、`selectable=1` に切り替える。`organization_id` と `id` は維持するため
 * `usage_snapshots.token_id` 経由の関連レコードは壊れない。
 */
export function updateTokenPromoteFields(
  db: Database,
  token_id: number,
  fields: {
    handle: string;
    auth_hash: string;
    plan: TokenPlan;
    plan_ratio: number | null;
    tags: string[];
    credential_source: CredentialSource;
  },
): void {
  db.prepare(
    `UPDATE tokens SET
       handle = ?, auth_hash = ?, plan = ?, plan_ratio = ?,
       tags = ?, credential_source = ?, selectable = 1
     WHERE id = ?`,
  ).run(
    fields.handle,
    fields.auth_hash,
    fields.plan,
    fields.plan_ratio,
    JSON.stringify(fields.tags),
    fields.credential_source,
    token_id,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// usage_snapshots
// ─────────────────────────────────────────────────────────────────────────────

interface UsageSnapshotRow {
  id: number;
  token_id: number;
  util_5h: number | null;
  util_7d: number | null;
  reset_5h_at: string | null;
  reset_7d_at: string | null;
  unified_status: string | null;
  recorded_at: string;
}

export function upsertUsageSnapshot(
  db: Database,
  input: {
    token_id: number;
    util_5h: number | null;
    util_7d: number | null;
    reset_5h_at: string | null;
    reset_7d_at: string | null;
    unified_status: string | null;
  },
): UsageSnapshot {
  const recordedAt = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO usage_snapshots (token_id, util_5h, util_7d, reset_5h_at,
                                 reset_7d_at, unified_status, recorded_at)
    VALUES ($token_id, $util_5h, $util_7d, $reset_5h_at,
            $reset_7d_at, $unified_status, $recorded_at)
    ON CONFLICT(token_id) DO UPDATE SET
      util_5h = excluded.util_5h,
      util_7d = excluded.util_7d,
      reset_5h_at = excluded.reset_5h_at,
      reset_7d_at = excluded.reset_7d_at,
      unified_status = excluded.unified_status,
      recorded_at = excluded.recorded_at
    `,
  ).run({
    $token_id: input.token_id,
    $util_5h: input.util_5h,
    $util_7d: input.util_7d,
    $reset_5h_at: input.reset_5h_at,
    $reset_7d_at: input.reset_7d_at,
    $unified_status: input.unified_status,
    $recorded_at: recordedAt,
  });
  const row = db
    .prepare("SELECT * FROM usage_snapshots WHERE token_id = ?")
    .get(input.token_id) as UsageSnapshotRow | undefined;
  if (!row) {
    throw new Error(`upsertUsageSnapshot: row not found after upsert token_id=${input.token_id}`);
  }
  return row;
}

export function getLatestUsageSnapshot(
  db: Database,
  token_id: number,
): UsageSnapshot | null {
  const row = db
    .prepare(
      "SELECT * FROM usage_snapshots WHERE token_id = ? ORDER BY recorded_at DESC LIMIT 1",
    )
    .get(token_id) as UsageSnapshotRow | undefined;
  return row ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// leases
// ─────────────────────────────────────────────────────────────────────────────

interface LeaseRow {
  token_id: number;
  holder: string;
  acquired_at: string;
  expires_at: string;
}

export function acquireLease(
  db: Database,
  token_id: number,
  holder: string,
  ttl_seconds: number,
): Lease | null {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + ttl_seconds * 1000).toISOString();

  // 前置: 期限切れ lease を掃除。これで「直前に期限切れたがまだ残っている」lease を
  // 取り損ねることがなくなる。atomic 内で掃除すると自 lease を消してしまう恐れがあるので外で実行。
  db.prepare("DELETE FROM leases WHERE expires_at < ?").run(now);

  const result = db
    .prepare(
      `INSERT OR IGNORE INTO leases (token_id, holder, acquired_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(token_id, holder, now, expires);

  if (Number(result.changes) === 0) return null;
  return { token_id, holder, acquired_at: now, expires_at: expires };
}

export function releaseLease(db: Database, token_id: number, holder: string): void {
  db.prepare("DELETE FROM leases WHERE token_id = ? AND holder = ?").run(
    token_id,
    holder,
  );
}

/** holder（agent surface）が持つ全 lease を解放する。agent 完了時に呼ぶ。 */
export function releaseLeaseByHolder(db: Database, holder: string): void {
  db.prepare("DELETE FROM leases WHERE holder = ?").run(holder);
}

export function expireLeases(
  db: Database,
  nowIso: string = new Date().toISOString(),
): number {
  const result = db.prepare("DELETE FROM leases WHERE expires_at < ?").run(nowIso);
  return Number(result.changes);
}

export function listActiveLeases(
  db: Database,
  nowIso: string = new Date().toISOString(),
): Lease[] {
  const rows = db
    .prepare("SELECT * FROM leases WHERE expires_at >= ? ORDER BY token_id ASC")
    .all(nowIso) as LeaseRow[];
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keychain 連携
// ─────────────────────────────────────────────────────────────────────────────

const inMemoryKeychain = new Map<string, string>();
/** T345: Claude Code 用 Keychain (`Claude Code-credentials`) の in-memory モック。 */
const inMemoryClaudeCodeKeychain = new Map<string, string>();

function useInMemory(): boolean {
  return process.env.KEYCHAIN_TEST_MODE === "1";
}

/**
 * macOS Keychain (`Claude Code-credentials` / account=`process.env.USER` 既定) から
 * Claude Code の credentials JSON 文字列を取得する（T345）。
 *
 * - `KEYCHAIN_TEST_MODE === "1"` のときは in-memory map を参照（spawnSync を呼ばない）
 * - 非 macOS は null
 * - account が空（`$USER` 未設定）も null
 * - `security` が exit 44 (errSecItemNotFound) もしくはその他のエラーで失敗した場合は
 *   全て null を返し、呼び出し側で `~/.claude/.credentials.json` への fallback を委ねる
 *   （44 を区別しても呼び出し側の挙動は同じであり、Keychain ロック中などの
 *    fallback したいケースを単純な null で吸収する方が呼び出し側の分岐が減る）
 * - JSON parse は本関数では行わず、raw 文字列を返す
 */
export function readClaudeCodeKeychain(
  account: string = process.env.USER ?? "",
): string | null {
  if (useInMemory()) {
    return inMemoryClaudeCodeKeychain.get(account) ?? null;
  }
  if (process.platform !== "darwin") return null;
  if (!account) return null;

  const result = spawnSync(
    "security",
    [
      "find-generic-password",
      "-s",
      CLAUDE_CODE_KEYCHAIN_SERVICE,
      "-a",
      account,
      "-w",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.error) return null;
  if (result.status !== 0) return null;
  const out = (result.stdout?.toString() ?? "").replace(/\n$/, "");
  return out.length > 0 ? out : null;
}

export function isKeychainSupported(): boolean {
  if (useInMemory()) return false;
  return process.platform === "darwin";
}

function maskToken(s: string, token: string): string {
  if (!token) return s;
  return s.split(token).join("***");
}

export function storeTokenInKeychain(handle: string, token_string: string): void {
  if (useInMemory()) {
    inMemoryKeychain.set(handle, token_string);
    return;
  }
  if (process.platform !== "darwin") {
    throw new KeychainUnsupportedError();
  }
  const result = spawnSync(
    "security",
    [
      "add-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      handle,
      "-U",
      "-w",
      token_string,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    const stdout = maskToken(result.stdout?.toString() ?? "", token_string);
    const stderr = maskToken(result.stderr?.toString() ?? "", token_string);
    throw new KeychainCommandError(
      `security add-generic-password failed for handle=${handle}`,
      stdout,
      stderr,
      result.status ?? -1,
    );
  }
}

export function retrieveTokenFromKeychain(handle: string): string {
  if (useInMemory()) {
    const v = inMemoryKeychain.get(handle);
    if (v === undefined) throw new KeychainNotFoundError(handle);
    return v;
  }
  if (process.platform !== "darwin") {
    throw new KeychainUnsupportedError();
  }
  const result = spawnSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", handle, "-w"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  // macOS security: errSecItemNotFound = 44
  if (result.status === 44) {
    throw new KeychainNotFoundError(handle);
  }
  if (result.status !== 0) {
    throw new KeychainCommandError(
      `security find-generic-password failed for handle=${handle}`,
      result.stdout?.toString() ?? "",
      result.stderr?.toString() ?? "",
      result.status ?? -1,
    );
  }
  return (result.stdout?.toString() ?? "").replace(/\n$/, "");
}

export function deleteTokenFromKeychain(handle: string): void {
  if (useInMemory()) {
    inMemoryKeychain.delete(handle);
    return;
  }
  if (process.platform !== "darwin") {
    throw new KeychainUnsupportedError();
  }
  const result = spawnSync(
    "security",
    ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", handle],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status === 0 || result.status === 44) {
    // 成功 or 見つからない（冪等削除）
    return;
  }
  throw new KeychainCommandError(
    `security delete-generic-password failed for handle=${handle}`,
    result.stdout?.toString() ?? "",
    result.stderr?.toString() ?? "",
    result.status ?? -1,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// pool_capacity 計算（A019 §pool_capacity）
// ─────────────────────────────────────────────────────────────────────────────

export const REFERENCE_FLOW = 20.0 / 168;
const FULL_WEEK_HOURS = 168;
const MIN_HOURS = 1 / 60; // 1 分未満は 1 分として扱う (clamp)

function hoursUntil(raw: string | null, nowMs: number): number | null {
  if (!raw) return null;
  // Anthropic API は ISO 文字列と Unix epoch 秒文字列の両形式で返す
  const asNum = Number(raw);
  const targetMs = !isNaN(asNum) && asNum > 1e9 ? asNum * 1000 : new Date(raw).getTime();
  if (Number.isNaN(targetMs)) return null;
  const deltaH = (targetMs - nowMs) / 3_600_000;
  if (deltaH <= 0) return null; // reset 過ぎ
  return Math.max(deltaH, MIN_HOURS);
}

/**
 * Anthropic ratelimit ヘッダー由来の reset 時刻を epoch ms に変換する。
 * - epoch sec の文字列（例 "1777366200"）→ * 1000 して epoch ms
 * - ISO 8601 文字列（例 "2026-04-25T10:00:00.000Z"）→ Date.parse 経由で epoch ms
 * - 不正値・空文字 → NaN（呼び出し側の `<=` 比較で安全側 false になる）
 */
export function parseResetEpochMs(v: string): number {
  const n = Number(v);
  if (Number.isFinite(n)) return n * 1000;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

export function computePoolCapacity(
  tokens: TokenForCapacity[],
  nowIso: string = new Date().toISOString(),
): PoolCapacityResult {
  const now = new Date(nowIso).getTime();
  const perToken: Array<{ handle: string; cap_pct: number }> = [];
  let total5h = 0;
  let total7d = 0;

  for (const t of tokens) {
    if (t.plan_ratio == null) continue;

    const util5h = t.util_5h ?? 0;
    const util7d = t.util_7d ?? 0;
    const remaining5h = Math.max(0, 1 - util5h);
    const remaining7d = Math.max(0, 1 - util7d);

    const t5hH = hoursUntil(t.reset_5h_at, now);
    const t7dH = hoursUntil(t.reset_7d_at, now);

    // 5h 側合計: reset 情報がある token のみ寄与
    if (t5hH != null) {
      total5h += ((remaining5h * t.plan_ratio) / t5hH / REFERENCE_FLOW) * 100;
    }

    // 7d 側合計: reset 情報がある token は通常計算、両 window null の token は
    // 「フル 7d 相当」として 7d 側に寄与（既存挙動を 7d 側で温存）
    if (t7dH != null) {
      total7d += ((remaining7d * t.plan_ratio) / t7dH / REFERENCE_FLOW) * 100;
    } else if (t5hH == null) {
      total7d += ((1.0 * t.plan_ratio) / FULL_WEEK_HOURS / REFERENCE_FLOW) * 100;
    }

    // per_token は従来通り min(flow_5h, flow_7d) ベース
    const candidates: number[] = [];
    if (t5hH != null) candidates.push((remaining5h * t.plan_ratio) / t5hH);
    if (t7dH != null) candidates.push((remaining7d * t.plan_ratio) / t7dH);
    if (candidates.length === 0) {
      candidates.push((1.0 * t.plan_ratio) / FULL_WEEK_HOURS);
    }
    const flow = Math.min(...candidates);
    perToken.push({ handle: t.handle, cap_pct: (flow / REFERENCE_FLOW) * 100 });
  }

  return {
    capacity_5h_pct: total5h,
    capacity_7d_pct: total7d,
    per_token: perToken,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// token selection（T321 / T335）
// ─────────────────────────────────────────────────────────────────────────────

export interface SelectedToken {
  token: Token;
  lease: Lease;
}

/**
 * `selectToken()` の policy 引数（T335）。
 *
 * - `projectTags`: 旧 T321 の第 3 引数相当。OSS / include / default 以外の admit 判定に使う
 * - `projectDefault`: project 側の `tokenPool.default` handle（最優先で候補化）
 * - `include`: tags 不一致でも候補化を強制する handle 配列
 * - `exclude`: 最優先で候補から除外する handle 配列
 * - `isOss`: OSS project フラグ。true なら exclude を除く selectable=1 全 token を admit
 * - `ossDefault`: OSS の場合の default fallback handle（projectDefault が空なら effectiveDefault に昇格）
 */
export interface SelectTokenPolicy {
  projectTags: string[];
  projectDefault: string | null;
  include: string[];
  exclude: string[];
  isOss: boolean;
  ossDefault: string | null;
}

function normalizePolicy(policy: SelectTokenPolicy | string[] | undefined): SelectTokenPolicy {
  if (policy === undefined) {
    return {
      projectTags: ["any"],
      projectDefault: null,
      include: [],
      exclude: [],
      isOss: false,
      ossDefault: null,
    };
  }
  if (Array.isArray(policy)) {
    // 後方互換: 旧 T321 の `selectToken(db, holder, ["any"])` 形式
    return {
      projectTags: policy.length === 0 ? ["any"] : policy,
      projectDefault: null,
      include: [],
      exclude: [],
      isOss: false,
      ossDefault: null,
    };
  }
  return policy;
}

/**
 * admit 判定の純粋抽出（T367）。
 *
 * `selectToken` から lease 取得・スコア計算・候補ソートを除いた admit ループと同一ロジックで
 * candidates 配列を返す。`canSelectAnyToken` と `selectToken` の両方が同じこの関数を呼ぶことで、
 * pool-throttle と spawn-agent の admit 整合性が構造的に保証される（T367）。
 *
 * 選択ロジック（T335 改訂、優先順位）:
 *  1. **exclude**: handle が `policy.exclude` に含まれる token は最優先で除外
 *  2. **default の runtime 昇格**: `effectiveDefault = projectDefault ?? (isOss ? ossDefault : null)`
 *     と一致する handle は **`selectable=0` でも runtime で候補化**（DB 不変。spawn-agent ごとに in-memory 判定）。
 *     副作用ゼロ・auto-discover 経路と相互汚染しない。複数 spawn の競合は 120 秒 lease で吸収する
 *  3. **selectable=0 の他 token は候補外**（default 以外の non-selectable は素通し）
 *  4. **lease 中**は除外
 *  5. **stale snapshot の reset 反映 (T373)**: recorded_at が 30 分超前でも除外しない。
 *     `reset_5h_at` / `reset_7d_at` を過ぎた軸は実 util がリセット済みと見なし `effUtil*=0` で評価し、
 *     未到達 / null の軸は `snap.util_*` を下限として残す。stale だけを理由に候補から外さない。
 *     高 util の stale token は次の `effUtil5h > 0.95` ブロッカーで止まる。
 *  6. **ブロッカー除外**: `effUtil5h > 0.95` は候補外
 *  7. **admit 判定**:
 *     - `effectiveDefault` 一致 → 無条件 admit
 *     - `policy.include` に含まれる → tags 不問で admit
 *     - `policy.isOss=true` → admit（exclude のみ尊重、tag 不問）
 *     - 通常 tag マッチ（`token.tags` が "any" を含む / `projectTags` が "any" / 交集合あり）→ admit
 *  8. **score 最小**: `0.3 * effUtil5h + 0.7 * effUtil7d`（null は 0 扱い）
 *  9. **atomic lease 取得**: `INSERT OR IGNORE`、120 秒 TTL（`selectToken` のみ。`canSelectAnyToken` は peek）
 *
 * 副作用なし。`expireLeases` を呼ばない（呼び出し側の責務）。
 */
function admitCandidates(
  db: Database,
  policy: SelectTokenPolicy,
  nowIso: string,
): Array<{ token: Token; score: number }> {
  const effectiveDefault: string | null =
    policy.projectDefault !== null ? policy.projectDefault : policy.isOss ? policy.ossDefault : null;

  const now = new Date(nowIso).getTime();
  const staleThresholdMs = 30 * 60 * 1000;

  // T335: selectable=0 でも default の runtime 昇格に対応するため、全 token を取得して内部で絞る
  const tokens = listTokens(db, { selectableOnly: false });
  const activeLeases = new Set(
    (db.prepare("SELECT token_id FROM leases WHERE expires_at >= ?").all(nowIso) as Array<{ token_id: number }>)
      .map((r) => r.token_id),
  );

  const projectTagSet = new Set(policy.projectTags);
  const includeSet = new Set(policy.include);
  const excludeSet = new Set(policy.exclude);
  const candidates: Array<{ token: Token; score: number }> = [];

  for (const tok of tokens) {
    // 1) exclude 最優先
    if (excludeSet.has(tok.handle)) continue;

    // 2) selectable=0 の token は default に明示参照されているときだけ runtime 候補化
    if (!tok.selectable && tok.handle !== effectiveDefault) continue;

    // 3) lease 中は除外
    if (activeLeases.has(tok.id)) continue;

    const snap = getLatestUsageSnapshot(db, tok.id);

    // 4) stale 判定 + reset 反映による util 上書き（T373）
    //    snapshot が 30 分以上前でも除外しない。reset_*_at を過ぎた軸は effUtil*=0、
    //    未到達 / null の軸は snap.util_* を下限としてそのまま残す。
    //    高 util の stale token はこの後の 5) ブロッカーで止まる。
    let effUtil5h = snap?.util_5h ?? 0;
    let effUtil7d = snap?.util_7d ?? 0;

    if (snap) {
      const recAt = new Date(snap.recorded_at).getTime();
      const isStale = now - recAt > staleThresholdMs;

      if (isStale) {
        if (snap.reset_5h_at != null && parseResetEpochMs(snap.reset_5h_at) <= now) {
          effUtil5h = 0;
        }
        if (snap.reset_7d_at != null && parseResetEpochMs(snap.reset_7d_at) <= now) {
          effUtil7d = 0;
        }
      }
    }

    // 5) ブロッカー除外: 5h > 95%
    if (effUtil5h > 0.95) continue;

    // 6) admit 判定（順序: default → include → OSS → tag マッチ）
    let admitted = false;
    if (tok.handle === effectiveDefault) {
      admitted = true;
    } else if (includeSet.has(tok.handle)) {
      admitted = true;
    } else if (policy.isOss) {
      // OSS は selectable=1 なら tags 不問で admit（M2 確定）
      admitted = true;
    } else {
      const tokenTags = tok.tags;
      const tagsMatch =
        tokenTags.includes("any") ||
        projectTagSet.has("any") ||
        tokenTags.some((t) => projectTagSet.has(t));
      if (tagsMatch) admitted = true;
    }
    if (!admitted) continue;

    const score = 0.3 * effUtil5h + 0.7 * effUtil7d;
    candidates.push({ token: tok, score });
  }

  return candidates;
}

/**
 * pool に admit 可能な token が 1 つでもあるかを判定する peek 関数（T367）。
 *
 * `selectToken` の admit ロジック（exclude / lease / stale / blocker > 0.95 / default 昇格 /
 * include / OSS / tag マッチ）を共有する。lease は取得しない。
 *
 * 副作用: `expireLeases` のみ（既存の selectToken と同じ。pool DB 一貫性維持に必要）。
 *
 * `holder` は admit 判定では使わないが API 一貫性のため取る（将来の holder-aware policy 追加余地）。
 *
 * @returns true = admit 候補が 1 つ以上ある（throttled=false）
 */
export function canSelectAnyToken(
  db: Database,
  _holder: string,
  policy: SelectTokenPolicy | string[] = ["any"],
  nowIso: string = new Date().toISOString(),
): boolean {
  const p = normalizePolicy(policy);
  expireLeases(db, nowIso);
  return admitCandidates(db, p, nowIso).length > 0;
}

/**
 * tokens.db から最適トークンを選択して 120 秒の lease を取得する（T321 / T335）。
 *
 * 選択ロジック（T335 改訂、優先順位）:
 *  1. **exclude**: handle が `policy.exclude` に含まれる token は最優先で除外
 *  2. **default の runtime 昇格**: `effectiveDefault = projectDefault ?? (isOss ? ossDefault : null)`
 *     と一致する handle は **`selectable=0` でも runtime で候補化**（DB 不変。spawn-agent ごとに in-memory 判定）。
 *     副作用ゼロ・auto-discover 経路と相互汚染しない。複数 spawn の競合は 120 秒 lease で吸収する
 *  3. **selectable=0 の他 token は候補外**（default 以外の non-selectable は素通し）
 *  4. **lease / `effUtil5h>0.95` ブロッカー**は除外。stale は除外条件ではなく、
 *     reset 済み軸を `effUtil*=0` で上書き、未到達軸は `snap.util_*` をそのまま残す形で救済する (T373)
 *  5. **admit 判定**:
 *     - `effectiveDefault` 一致 → 無条件 admit
 *     - `policy.include` に含まれる → tags 不問で admit
 *     - `policy.isOss=true` → admit（exclude のみ尊重、tag 不問）
 *     - 通常 tag マッチ（`token.tags` が "any" を含む / `projectTags` が "any" / 交集合あり）→ admit
 *  6. **score 最小**: `0.3 * effUtil5h + 0.7 * effUtil7d`（null は 0 扱い）
 *  7. **atomic lease 取得**: `INSERT OR IGNORE`、120 秒 TTL
 *
 * **後方互換**: 第 3 引数に `string[]` を渡すと旧 T321 シグネチャとして解釈される
 * （`{ projectTags, projectDefault: null, include: [], exclude: [], isOss: false, ossDefault: null }`）。
 *
 * @returns 選択結果 or null（候補なし / lease 取得失敗）
 */
export function selectToken(
  db: Database,
  holder: string,
  policy: SelectTokenPolicy | string[] = ["any"],
  nowIso: string = new Date().toISOString(),
): SelectedToken | null {
  const p = normalizePolicy(policy);

  expireLeases(db, nowIso);

  const candidates = admitCandidates(db, p, nowIso);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  if (!best) return null;
  const selected = best.token;

  const lease = acquireLease(db, selected.id, holder, 120);
  if (!lease) return null; // race で他が先に取得

  return { token: selected, lease };
}

// ─────────────────────────────────────────────────────────────────────────────
// テスト用内部ヘルパ
// ─────────────────────────────────────────────────────────────────────────────

/** テスト専用: in-memory Keychain Map をクリアする。本番コードから呼んではならない。 */
export function __resetInMemoryKeychainForTest(): void {
  inMemoryKeychain.clear();
}

/**
 * テスト専用: Claude Code Keychain (`Claude Code-credentials`) の in-memory map を操作する（T345）。
 * `json === null` で当該 account のエントリを削除。
 * 本番コードから呼んではならない。
 */
export function __setClaudeCodeKeychainForTest(
  account: string,
  json: string | null,
): void {
  if (json === null) {
    inMemoryClaudeCodeKeychain.delete(account);
    return;
  }
  inMemoryClaudeCodeKeychain.set(account, json);
}

/** テスト専用: Claude Code Keychain in-memory map をクリアする（T345）。 */
export function __resetClaudeCodeKeychainForTest(): void {
  inMemoryClaudeCodeKeychain.clear();
}

/** テスト用: dbPath と dirPath の解決結果を観測する。 */
export function __resolveDbPathForTest(opts?: InitTokenDBOptions): {
  dbPath: string;
  dirPath: string;
} {
  return resolveDbPath(opts);
}

/** テスト用: ファイルの権限ビットを取得する (statSync + mode & 0o777)。 */
export function __statMode(path: string): number {
  return statSync(path).mode & 0o777;
}
