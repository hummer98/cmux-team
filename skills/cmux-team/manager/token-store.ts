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
  capacity_pct: number;
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

function useInMemory(): boolean {
  return process.env.KEYCHAIN_TEST_MODE === "1";
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

function hoursUntil(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return null;
  const deltaH = (target - nowMs) / 3_600_000;
  if (deltaH <= 0) return null; // reset 過ぎ
  return Math.max(deltaH, MIN_HOURS);
}

export function computePoolCapacity(
  tokens: TokenForCapacity[],
  nowIso: string = new Date().toISOString(),
): PoolCapacityResult {
  const now = new Date(nowIso).getTime();
  const perToken: Array<{ handle: string; cap_pct: number }> = [];
  let totalCap = 0;

  for (const t of tokens) {
    if (t.plan_ratio == null) continue;

    const util5h = t.util_5h ?? 0;
    const util7d = t.util_7d ?? 0;
    const remaining5h = Math.max(0, 1 - util5h);
    const remaining7d = Math.max(0, 1 - util7d);

    const t5hH = hoursUntil(t.reset_5h_at, now);
    const t7dH = hoursUntil(t.reset_7d_at, now);

    const candidates: number[] = [];
    if (t5hH != null) candidates.push((remaining5h * t.plan_ratio) / t5hH);
    if (t7dH != null) candidates.push((remaining7d * t.plan_ratio) / t7dH);
    if (candidates.length === 0) {
      // 両 window とも reset 済み / null → フル 7d 相当として扱う
      candidates.push((1.0 * t.plan_ratio) / FULL_WEEK_HOURS);
    }

    const flow = Math.min(...candidates);
    const cap_pct = (flow / REFERENCE_FLOW) * 100;

    perToken.push({ handle: t.handle, cap_pct });
    totalCap += cap_pct;
  }

  return { capacity_pct: totalCap, per_token: perToken };
}

// ─────────────────────────────────────────────────────────────────────────────
// token selection（T321）
// ─────────────────────────────────────────────────────────────────────────────

export interface SelectedToken {
  token: Token;
  lease: Lease;
}

/**
 * tokens.db から最適トークンを選択して 120 秒の lease を取得する（T321）。
 *
 * 選択ロジック:
 *  1. selectable=1 かつ project_tags に適合するものを候補に絞る
 *  2. ブロッカー除外: util_5h > 0.95 / stale（30 分超未更新）/ lease 中
 *  3. score = 0.3 * util_5h + 0.7 * util_7d（null は 0 扱い）
 *  4. score 最小を選択
 *  5. atomic lease 取得（INSERT OR IGNORE）
 *
 * project_tags が空 / ["any"] の場合は全 selectable=1 が候補。
 * tags 適合: token.tags が "any" を含む、または project_tags との交差がある。
 *
 * @returns 選択結果 or null（候補なし / lease 取得失敗）
 */
export function selectToken(
  db: Database,
  holder: string,
  projectTags: string[] = ["any"],
  nowIso: string = new Date().toISOString(),
): SelectedToken | null {
  expireLeases(db, nowIso);

  const now = new Date(nowIso).getTime();
  const staleThresholdMs = 30 * 60 * 1000;

  const tokens = listTokens(db, { selectableOnly: true });
  const activeLeases = new Set(
    (db.prepare("SELECT token_id FROM leases WHERE expires_at >= ?").all(nowIso) as Array<{ token_id: number }>)
      .map((r) => r.token_id),
  );

  const projectTagSet = new Set(projectTags);
  const candidates: Array<{ token: Token; score: number }> = [];

  for (const tok of tokens) {
    // tags フィルタ
    const tokenTags = tok.tags;
    const tagsMatch =
      tokenTags.includes("any") ||
      projectTagSet.has("any") ||
      tokenTags.some((t) => projectTagSet.has(t));
    if (!tagsMatch) continue;

    // lease 中は除外
    if (activeLeases.has(tok.id)) continue;

    const snap = getLatestUsageSnapshot(db, tok.id);

    // stale 除外（30 分以上未更新）
    if (snap) {
      const recAt = new Date(snap.recorded_at).getTime();
      if (now - recAt > staleThresholdMs) continue;
    }

    const util5h = snap?.util_5h ?? 0;
    const util7d = snap?.util_7d ?? 0;

    // ブロッカー除外: 5h > 95%
    if (util5h > 0.95) continue;

    const score = 0.3 * util5h + 0.7 * util7d;
    candidates.push({ token: tok, score });
  }

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
