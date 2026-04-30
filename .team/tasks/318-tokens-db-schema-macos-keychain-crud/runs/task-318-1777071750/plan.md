---
task: T318
title: tokens.db schema + macOS Keychain 連携 + CRUD ライブラリ 実装計画
author: surface:89 (planner)
worktree: task-318-1777071750
related_artifacts: [A019, A020]
---

# T318 実装計画 — `skills/cmux-team/manager/token-store.ts`

## 1. 概要

グローバルトークンプール機能（A019 で設計確定）の**基盤**となる `~/.cmux-team/tokens.db` (SQLite + WAL) と macOS Keychain 連携を、単一の TypeScript モジュール `skills/cmux-team/manager/token-store.ts`（新規）として実装する。

このモジュールは以下 4 つの責務を持つ:

1. **DB 初期化**: `~/.cmux-team/` ディレクトリ (mode 0700) + `tokens.db` (mode 0600) + WAL + migration
2. **CRUD API**: `tokens` / `usage_snapshots` / `leases` 3 テーブルへの insert/select/upsert + atomic lease
3. **Keychain 連携**: macOS `security` コマンドで実トークン文字列を保管（他 OS では throw）
4. **`pool_capacity` 計算**: A019 の数式通り純粋関数として実装

後続タスク（token CLI / proxy UPSERT / spawn-agent selection / TUI）は全て本モジュールを import して使う。**新規ファイルのみ**で完結し、既存ファイルの変更は一切行わない。

## 2. 既存パターン分析（trace-store.ts から踏襲する設計）

`skills/cmux-team/manager/trace-store.ts` と `gh-cache-store.ts` を読み、以下のパターンを踏襲する。

### 2.1 DB クライアント

- **`bun:sqlite` の `Database`** を使用（外部依存なし。`better-sqlite3` 不採用）。
- `trace-store.ts:8` / `gh-cache-store.ts:8` ともに `import { Database } from "bun:sqlite"`。ここに合わせる。

### 2.2 ハンドル管理

- lazy init ではなく、明示的に `initDB(): Database` が `open + exec(SCHEMA) + migration + return db`。
- 呼び出し側が `Database` インスタンスを保持し、close 制御も行う（`db.close()`）。
- `token-store` も同様に **`initTokenDB(opts?): Database`** を export し、呼び出し側が DB オブジェクトを保有する。

### 2.3 WAL pragma

- `db.exec("PRAGMA journal_mode=WAL;")` を `initDB` の冒頭で実行。
- `gh-cache-store.ts:169` では `PRAGMA foreign_keys=ON;` も追加している。`token-store` は **`usage_snapshots.token_id` / `leases.token_id` が FK 参照を持つ**ため、`foreign_keys=ON` も付ける。

### 2.4 Migration 機構

- `trace-store.ts` と `gh-cache-store.ts` は **schema_version テーブルを使わず**、`PRAGMA table_info(<table>)` で既存列を検出し、欠けた列だけを `ALTER TABLE ... ADD COLUMN` する方式。
- 新 DB 作成時は `CREATE TABLE IF NOT EXISTS` で全列が揃い ALTER は走らない。
- **本実装もこの方式を採用**。初回 v1 スキーマは `CREATE TABLE IF NOT EXISTS` 3 本 + 必要な INDEX。将来の列追加はすべて `ensureXxxColumns(db)` 関数で対応する。
- `schema_version` テーブルは不採用（既存パターンに合わせる / v1 では不要）。

### 2.5 `.team/` 外のパス戦略

- `trace-store.ts` / `gh-cache-store.ts` は `projectRoot` 引数を受けて `.team/` 配下に DB を置く。
- 本 `token-store` は **プロジェクト跨ぎ共有** のため `~/.cmux-team/` 配下。テスト汚染防止に **`TOKEN_STORE_DB_PATH` 環境変数** か関数引数で override 可能にする（§7 / §9 で詳述）。

### 2.6 エラー / ログ

- 外部コマンド（`security`）失敗時は **stderr / stdout / exit code** を必ず Error の detail に含める（CLAUDE.md 「実装ルール」準拠）。
- `gh-cache-store.ts` は `log` import で daemon log に書く。本モジュールはトップレベルの冪等な関数群として `console.warn` を使う（`trace-store.ts:214` パターン踏襲）。必要になれば後続タスクで logger 差し替え。

## 3. モジュール構成（export 一覧）

```ts
// skills/cmux-team/manager/token-store.ts

import { Database } from "bun:sqlite";

// --- 型定義 ---

export type TokenPlan = "pro" | "max-x5" | "max-x20" | "unknown";
export type CredentialSource = "claude-credentials" | "manual" | "auto-discover";

export interface Token {
  id: number;
  handle: string;              // "@pers"
  organization_id: string;     // UUID
  auth_hash: string;           // 12 文字 prefix
  plan: TokenPlan;
  plan_ratio: number | null;   // 1.0 / 5.0 / 20.0 / null
  credential_source: CredentialSource | null;
  tags: string[];              // parse 済み（DB は JSON 文字列）
  selectable: boolean;         // DB は 0/1
  created_at: string;          // ISO 8601
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

// --- エラー型 ---

export class KeychainUnsupportedError extends Error {}
export class KeychainCommandError extends Error {
  constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly exitCode: number,
  ) { super(message); }
}

// --- 初期化 ---

export interface InitTokenDBOptions {
  /** デフォルト: ~/.cmux-team/tokens.db。TOKEN_STORE_DB_PATH env でも override 可 */
  dbPath?: string;
  /** デフォルト: ~/.cmux-team */
  dirPath?: string;
}
export function initTokenDB(opts?: InitTokenDBOptions): Database;

// --- tokens CRUD ---

export interface InsertTokenInput {
  handle: string;
  organization_id: string;
  auth_hash: string;
  plan: TokenPlan;
  plan_ratio: number | null;
  tags: string[];
  credential_source: CredentialSource | null;
  selectable?: boolean;       // default true
}
export function insertToken(db: Database, input: InsertTokenInput): Token;
export function getTokenByOrganizationId(db: Database, organization_id: string): Token | null;
export function getTokenByHandle(db: Database, handle: string): Token | null;
export function listTokens(db: Database, opts?: { selectableOnly?: boolean }): Token[];

// --- usage_snapshots ---

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
): UsageSnapshot;
export function getLatestUsageSnapshot(db: Database, token_id: number): UsageSnapshot | null;

// --- leases ---

/** 競合時は null（acquire 失敗）。成功時は Lease を返す。 */
export function acquireLease(
  db: Database,
  token_id: number,
  holder: string,
  ttl_seconds: number,
): Lease | null;
export function releaseLease(db: Database, token_id: number, holder: string): void;
/** expires_at < now() の行を DELETE。削除件数を返す。 */
export function expireLeases(db: Database, nowIso?: string): number;
export function listActiveLeases(db: Database, nowIso?: string): Lease[];

// --- Keychain ---

export function isKeychainSupported(): boolean;   // platform === "darwin" && not test-mode
export function storeTokenInKeychain(handle: string, token_string: string): void;
export function retrieveTokenFromKeychain(handle: string): string;   // not found は throw
export function deleteTokenFromKeychain(handle: string): void;

// --- pool capacity ---

export const REFERENCE_FLOW = 20.0 / 168;
export function computePoolCapacity(
  selectableTokens: TokenForCapacity[],
  nowIso?: string,                               // テスト時の固定時刻用
): PoolCapacityResult;
```

### 各 export の責務

| export | 責務 |
|---|---|
| `initTokenDB` | ディレクトリ作成（mode 0700）/ DB 作成（mode 0600）/ WAL / FK on / migration |
| `insertToken` | 1 行 INSERT → 作成した Token を SELECT して返す。`tags` は `JSON.stringify` |
| `getTokenByOrganizationId` / `getTokenByHandle` | UNIQUE key ルックアップ |
| `listTokens` | TUI / CLI 表示用 |
| `upsertUsageSnapshot` | 同 token_id の直近行を UPDATE、無ければ INSERT。`recorded_at` を daemon 側で付与 |
| `getLatestUsageSnapshot` | `ORDER BY recorded_at DESC LIMIT 1` |
| `acquireLease` | §6.3 参照。atomic |
| `releaseLease` | 条件付き DELETE（holder も一致） |
| `expireLeases` | `WHERE expires_at < ?` |
| `listActiveLeases` | `WHERE expires_at >= ?` |
| `isKeychainSupported` | `process.platform === "darwin"` のみ true |
| `storeTokenInKeychain` | `security add-generic-password` を spawnSync |
| `retrieveTokenFromKeychain` | `security find-generic-password -w` を spawnSync → stdout 末尾改行を trim |
| `deleteTokenFromKeychain` | `security delete-generic-password` |
| `computePoolCapacity` | §8 参照。純粋関数 |

## 4. DB 初期化フロー（`initTokenDB`）

```
1. dbPath / dirPath を解決
   - opts.dbPath があれば最優先
   - なければ process.env.TOKEN_STORE_DB_PATH
   - それもなければ ${os.homedir()}/.cmux-team/tokens.db
   - dirPath は dbPath の親ディレクトリから導出

2. ディレクトリ作成
   - fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 })
   - 既存ディレクトリの mode は尊重（chmod しない＝他共有ファイルへの影響回避）

3. 新規作成 or 既存判定
   - fs.existsSync(dbPath) が false なら「新規」フラグを立てる

4. new Database(dbPath) で open（存在しなければ作成される）

5. 新規作成だった場合のみ fs.chmodSync(dbPath, 0o600)
   - 既存 DB には触らない（ユーザーが意図的に変更した権限を尊重）

6. PRAGMA journal_mode=WAL;
7. PRAGMA foreign_keys=ON;

8. db.exec(SCHEMA_V1)  — CREATE TABLE IF NOT EXISTS 3 本 + index

9. ensureTokensColumns(db) / ensureUsageSnapshotsColumns(db) / ensureLeasesColumns(db)
   - PRAGMA table_info(...) で欠損列を検出 → ALTER TABLE ADD COLUMN（v1 時点では no-op）

10. return db
```

### WAL の -wal / -shm 権限

SQLite は `tokens.db-wal` / `tokens.db-shm` を自動生成する。生成時の umask に依存して 0644 等になる可能性があるが、**同じディレクトリ (0700) に置かれるため他ユーザーからは到達不能**。本実装では明示的な chmod は行わない。セキュリティ上のリスクは親ディレクトリの 0700 が担保する。

## 5. Migration 設計

### 5.1 v1 スキーマ（初期投入）

```sql
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
  token_id       INTEGER NOT NULL REFERENCES tokens(id),
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
  token_id    INTEGER NOT NULL REFERENCES tokens(id),
  holder      TEXT    NOT NULL,
  acquired_at TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  PRIMARY KEY (token_id, holder)
);
CREATE INDEX IF NOT EXISTS idx_leases_expires ON leases(expires_at);
```

### 5.2 `ensureXxxColumns` パターン

`trace-store.ts:ensureApiUsageColumns` と同一のパターン:

```ts
function ensureTokensColumns(db: Database): void {
  const rows = db.prepare("PRAGMA table_info(tokens)").all() as Array<{ name: string }>;
  const existing = new Set(rows.map(r => r.name));
  const required: Array<[string, "TEXT" | "INTEGER" | "REAL"]> = [
    // v1 で全列揃っているため現時点で追記なし。
    // v2 以降の追加列をここに列挙する。
  ];
  for (const [col, type] of required) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE tokens ADD COLUMN ${col} ${type}`);
      console.warn(`[token-store] tokens_migrated col=${col}`);
    }
  }
}
```

v1 では空だが、**将来の列追加フックとして必ず呼び出す**（既存パターン踏襲）。

## 6. CRUD 実装方針

### 6.1 `insertToken`

```sql
INSERT INTO tokens (handle, organization_id, auth_hash, plan, plan_ratio,
                    credential_source, tags, selectable, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
```

- `tags` は `JSON.stringify(input.tags ?? ["any"])`
- `selectable` は `input.selectable ?? true` → `?1 : 0`
- `created_at` は `new Date().toISOString()`
- UNIQUE 制約違反（handle / organization_id 重複）は `bun:sqlite` が SQLite 側のエラーを throw → 呼び出し側で `catch` させる（`getTokenByHandle` で事前判定する責務は呼び出し側）
- INSERT 後は `db.prepare("SELECT * FROM tokens WHERE id = ?").get(lastInsertRowid)` → `rowToToken()` 変換（tags は `JSON.parse`、selectable は 1 → true）

### 6.2 `upsertUsageSnapshot`

**方針**: 同 `token_id` に対して複数行を履歴として積むのではなく、**直近 1 行を保持するか履歴を積むかを検討**する必要がある。

A019 §pool_capacity / spawn-agent selection では「直近の util_5h / util_7d」のみを使用。**単純化のため token_id あたり 1 行（UPSERT）** とし、`getLatestUsageSnapshot` は `WHERE token_id = ? ORDER BY recorded_at DESC LIMIT 1` で実装。

実装アプローチ 2 択:

- **A. token_id を UNIQUE 扱いで UPSERT**: `UNIQUE(token_id)` 制約を付けて `INSERT ON CONFLICT(token_id) DO UPDATE SET ...`
- **B. 履歴として INSERT**: UNIQUE 制約なしで毎回 INSERT、`getLatestUsageSnapshot` が ORDER BY で最新を取る

→ **A 採用**。理由:
  - proxy 側は 30 秒 throttled で「値が変化したときのみ」呼ぶ運用（A020）。履歴は traces.db:api_usage が持つ
  - tokens.db は「現在値」のストアで良い
  - テーブル肥大を避ける（GC 責務を持たない）

→ v1 スキーマを以下に修正:

```sql
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
```

UPSERT SQL:

```sql
INSERT INTO usage_snapshots (token_id, util_5h, util_7d, reset_5h_at, reset_7d_at,
                             unified_status, recorded_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(token_id) DO UPDATE SET
  util_5h = excluded.util_5h,
  util_7d = excluded.util_7d,
  reset_5h_at = excluded.reset_5h_at,
  reset_7d_at = excluded.reset_7d_at,
  unified_status = excluded.unified_status,
  recorded_at = excluded.recorded_at;
```

（`recorded_at` は引数で受けず、関数内で `new Date().toISOString()` を付与する）

### 6.3 `acquireLease` — atomic 制御

spawn-agent で複数 surface が同時に同一 token を取ろうとするレースを防ぐ。

```ts
export function acquireLease(
  db: Database,
  token_id: number,
  holder: string,
  ttl_seconds: number,
): Lease | null {
  const now = new Date();
  const expires = new Date(now.getTime() + ttl_seconds * 1000);

  // 前置: 期限切れ lease を掃除（自前で呼ぶ必要をなくす）
  db.prepare("DELETE FROM leases WHERE expires_at < ?").run(now.toISOString());

  const tx = db.transaction(() => {
    // 同一 token_id に有効な lease（他 holder 含む）があれば失敗
    const occupied = db
      .prepare("SELECT token_id FROM leases WHERE token_id = ? LIMIT 1")
      .get(token_id);
    if (occupied) return null;

    db.prepare(
      `INSERT INTO leases (token_id, holder, acquired_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    ).run(token_id, holder, now.toISOString(), expires.toISOString());

    return { token_id, holder, acquired_at: now.toISOString(), expires_at: expires.toISOString() };
  });

  // bun:sqlite の db.transaction は DEFERRED モード。
  // IMMEDIATE を明示して書き込み競合を早期にシリアライズする。
  return db.transaction(tx, "immediate")();
}
```

**重要**: `bun:sqlite` の `db.transaction(fn)` は SQLite の DEFERRED モードで BEGIN する。書き込みロック獲得が遅延されると並行実行で busy になりやすい。**`BEGIN IMMEDIATE` 相当を得るため、実装では次のいずれかを採用**:

- a. `db.transaction(fn, "immediate")` （Bun が対応している場合）
- b. 手動で `db.exec("BEGIN IMMEDIATE;")` / `db.exec("COMMIT;")` / `db.exec("ROLLBACK;")` を回す
- c. `INSERT OR IGNORE` 方式: `INSERT OR IGNORE INTO leases` → `db.changes()` で 0 件なら競合 → return null

→ **c（`INSERT OR IGNORE` 方式）を採用**。理由:
  - `leases` の PRIMARY KEY は `(token_id, holder)` のため**同じ holder なら衝突**するが、**別 holder が同じ token_id を取ろうとしても衝突しない** → `UNIQUE(token_id)` を追加すれば OR IGNORE で完全に atomic にできる
  - 「同一 token_id に lease は 1 個まで」というドメイン不変条件を **スキーマで表現**（構造的正しさ原則に一致）
  - トランザクション制御を自分で書かずに済む

→ v1 スキーマをさらに修正:

```sql
CREATE TABLE IF NOT EXISTS leases (
  token_id    INTEGER NOT NULL UNIQUE REFERENCES tokens(id),
  holder      TEXT    NOT NULL,
  acquired_at TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  PRIMARY KEY (token_id, holder)
);
```

`PRIMARY KEY (token_id, holder)` は残すが、実質的に `UNIQUE(token_id)` が効くため `token_id` 単独で一意。複合 PK は「同じ holder が同じ token を何度も取らない」という意図の冗長な保険。

実装:

```ts
export function acquireLease(db, token_id, holder, ttl_seconds): Lease | null {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + ttl_seconds * 1000).toISOString();

  // 掃除は前置で（atomic 内でやると直前に解放された lease を取れる）
  db.prepare("DELETE FROM leases WHERE expires_at < ?").run(now);

  const result = db.prepare(
    `INSERT OR IGNORE INTO leases (token_id, holder, acquired_at, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run(token_id, holder, now, expires);

  if (result.changes === 0) return null;
  return { token_id, holder, acquired_at: now, expires_at: expires };
}
```

### 6.4 `releaseLease`

```sql
DELETE FROM leases WHERE token_id = ? AND holder = ?;
```

holder 不一致は no-op（他 surface の lease を横取り解放しない）。

### 6.5 `expireLeases`

```ts
export function expireLeases(db, nowIso = new Date().toISOString()): number {
  const result = db.prepare("DELETE FROM leases WHERE expires_at < ?").run(nowIso);
  return Number(result.changes);
}
```

**呼ばれる場所**:
- `acquireLease` 内で前置（実装済み）
- 外部から周期的に呼ばれる（後続タスクの daemon タイマーで）

## 7. Keychain 連携実装

### 7.1 OS 分岐

```ts
export function isKeychainSupported(): boolean {
  if (process.env.KEYCHAIN_TEST_MODE === "1") return false;   // test override
  return process.platform === "darwin";
}
```

### 7.2 テスト用 in-memory fallback

テスト時（CI / 非 macOS）に実 Keychain を汚さないため:

```ts
const inMemoryKeychain = new Map<string, string>();

function useInMemory(): boolean {
  return process.env.KEYCHAIN_TEST_MODE === "1";
}
```

- `KEYCHAIN_TEST_MODE=1` のとき全 Keychain 関数は `inMemoryKeychain` Map を操作
- `isKeychainSupported()` は test mode でも `false` を返す（「Keychain 連携なし」として外部に見える）
- テスト内で直接 `storeTokenInKeychain` を呼んだ場合の動作確認用（in-memory が動くこと）

注意: 本番の `macOS` 非 test-mode 時は `isKeychainSupported() === true` で、`security` コマンドを使う。

### 7.3 `security` コマンド呼び出し

**エスケープ対策**: `child_process.spawnSync` の **args 配列渡し**にすることで shell metacharacter の解釈を回避（shell=false）。token を位置引数で渡しても shell 経由ではないため安全。

ただし **`ps` / プロセスリストから token が見える**問題があるため:

```ts
// store: stdin 経由で token を渡す（argv 露出を避ける）
spawnSync("security", [
  "add-generic-password",
  "-s", "cmux-team-token",
  "-a", handle,
  "-w",                     // 値を引数で渡さず、prompt で stdin から読ませる
  "-U",                     // upsert
], {
  input: token_string + "\n",
  stdio: ["pipe", "pipe", "pipe"],
});
```

補足: `security add-generic-password -w` は**値の引数を省略すると stdin/tty から prompt で読む**仕様（macOS 15 で確認）。しかし **`-U`（既存更新）と同時に使うと -w は引数必須になる可能性**があり、実機確認が必要。

**実装方針（優先順）**:

1. **試行 A: `-w` 無指定 + stdin** — 最も安全。`security` が stdin から読むかを `bun test` で確認。動けばこれ。
2. **試行 B: `-w <token>` を args 配列で渡す** — `spawnSync` の args 配列は shell を介さず `execve` されるため `ps auxww` 上で args が表示される問題はある（root でない限り自プロセスは見えるが他ユーザーからは `hidepid` 次第）が、shell log には残らない。**macOS の `ps` は他ユーザー分も見えるのが既定**なので short window ながら露出リスクあり。
3. **試行 C: ファイル経由** — `fs.writeFileSync(tmp, token, { mode: 0o600 })` → `security ... -w "$(cat tmp)"` → `rm tmp`。複雑化。

→ **実装時は A を最優先で試し、動かなければ B にフォールバック**。いずれにせよ TypeScript ソース内で `token_string` を**ログに出さない**ことを徹底（try/catch の err.message にも含めない）。

### 7.4 retrieve

```ts
const result = spawnSync("security", [
  "find-generic-password",
  "-s", "cmux-team-token",
  "-a", handle,
  "-w",    // password のみ出力
], { stdio: ["ignore", "pipe", "pipe"] });

if (result.status === 44 /* errSecItemNotFound */) {
  throw new Error(`token not found for handle=${handle}`);
}
if (result.status !== 0) {
  throw new KeychainCommandError(
    `security find-generic-password failed`,
    result.stdout?.toString() ?? "",
    result.stderr?.toString() ?? "",
    result.status ?? -1,
  );
}
return result.stdout.toString().replace(/\n$/, "");   // 末尾改行を trim
```

### 7.5 delete

```ts
spawnSync("security", [
  "delete-generic-password",
  "-s", "cmux-team-token",
  "-a", handle,
], { stdio: ["ignore", "pipe", "pipe"] });
// status 44 (not found) は無視（冪等削除）
```

### 7.6 非 macOS での挙動

`isKeychainSupported() === false` かつ `KEYCHAIN_TEST_MODE !== "1"` のとき:

- `storeTokenInKeychain` / `retrieveTokenFromKeychain` / `deleteTokenFromKeychain` は `throw new KeychainUnsupportedError("keychain only supported on macOS")`。
- 後続実装（spawn-agent selection）は `isKeychainSupported()` を先に見て pool 機能全体を OFF にする（A019 の設計通り）。

## 8. pool_capacity 計算実装

### 8.1 数式（A019 §pool_capacity 直訳）

```
remaining_5h_i = max(0, 1.0 - util_5h_i)
remaining_7d_i = max(0, 1.0 - util_7d_i)

t_5h_i = (reset_5h_at_i - now) / 1h     # hours
t_7d_i = (reset_7d_at_i - now) / 1h

flow_5h_i = remaining_5h_i * plan_ratio_i / t_5h_i
flow_7d_i = remaining_7d_i * plan_ratio_i / t_7d_i
flow_i    = min(flow_5h_i, flow_7d_i)

cap_pct_i = flow_i / REFERENCE_FLOW * 100
capacity_pct = Σ cap_pct_i
REFERENCE_FLOW = 20.0 / 168
```

### 8.2 エッジケース処理

| ケース | 処理 |
|---|---|
| `plan_ratio === null` | capacity 計算から除外（0 件として per_token にも含めない） |
| `util_5h` / `util_7d` が null | 「満タン＝ 0」として扱い、残量 = 1.0 |
| `reset_5h_at` / `reset_7d_at` が null | 対応する flow を **Infinity にしない**。→ null の場合はその window を skip（min の片側のみ有効） |
| reset 時刻が過去（`reset - now <= 0`） | **すでに reset されているのでフル残量相当**。t→ 0 で flow→∞ は不適切 → その window を skip し、もう片方を使う |
| 両 window とも skip（両方 reset 済み / null） | 満タン 7d 相当として `flow = 1.0 × plan_ratio / 168` |
| `t < 1 minute` の極小値 | clamp: `t = max(t, 1/60)` （1 分未満は 1 分として扱う。指標のノイズ抑制） |

### 8.3 A019 検証表の再現

検証表（A019 §pool_capacity §ユーザー例での検証）の 6 ケース全てを **network なし / mock なし** でテストする。nowIso を固定で与えて時刻依存性を排除。

| # | ケース | plan_ratio | util_5h | util_7d | reset_5h (now からの時間) | reset_7d | 期待 cap |
|---|---|---|---|---|---|---|---|
| 1 | x20 満タン、reset 5h | 20.0 | 0.0 | 0.0 | now+5h | now+7d | 672% |
| 2 | x20 満タン、reset 7d | 20.0 | 0.0 | 0.0 | now+7d | now+7d | 100% |
| 3 | x20 10% 残、reset 30min | 20.0 | 0.9 | 0.5 | now+0.5h | now+7d | 336% |
| 4 | x20 10% 残、reset 3h | 20.0 | 0.9 | 0.5 | now+3h | now+7d | 112% |
| 5 | Pro 満タン、reset 7d | 1.0 | 0.0 | 0.0 | now+7d | now+7d | 5% |
| 6 | x20 + Pro 両方満タン 7d | [20.0, 1.0] | [0.0, 0.0] | [0.0, 0.0] | [now+7d, now+7d] | [now+7d, now+7d] | 105% |

→ **ケース 1 の確認**:
  `flow_5h = 1.0 × 20 / 5 = 4.0`
  `flow_7d = 1.0 × 20 / 168 = 0.119`
  → `flow = min(4.0, 0.119) = 0.119` → cap = 100%？

**A019 表との食い違い検出**: 表では「5h 内はフル流量で使える → 672%」となっている。

A019 の式「`flow_i = min(flow_5h_i, flow_7d_i)` → 悲観寄り」と、表のケース 1 が整合しない。表のケース 1 を再計算:

```
flow_5h = 1.0 × 20 / 5 = 4.0          # 20 / 168 = 0.119 との比 ≒ 33.6倍 → 3360%
表の計算式: 1.0×20÷5 / (20÷168) × 100 = 4.0 / 0.119 × 100 = 3360%
```

表記載の 672% と 3360% も一致しない。A019 の表は「5h window だけで評価」した値で、min を取っていない可能性。ケース 3 も:

```
flow_5h = 0.1 × 20 / 0.5 = 4.0
flow_7d = 0.5 × 20 / 168 = 0.0595 （ケース 3 は util_7d=0.5 相当と推測）
min = 0.0595 → cap ≒ 50%
表: 336%
```

→ **A019 の表は min を取っていない**可能性が濃厚。実装は式に従って `min` で計算するが、**期待値表を A019 の表そのままにするとテストが通らない**。

**対応案**:

1. Planner 判断として「A019 の式 (`min`) を正とし、表の数値はケース 1/3/4 について再計算して期待値表をテスト内で持つ」。
2. 疑義を plan.md に明記し、**Conductor / Implementer にエスカレーション**。Master に確認する。

→ **案 1 を採用しつつ、plan.md の本 §8.3 に明確に「A019 §pool_capacity §ユーザー例での検証の数値と実装式は不整合を含む。実装は式を正とし、テスト期待値は式で再計算する」と記載する**。ケース 2（100%）と 5（5%）は 7d のみの単純計算で min を取っても同一、ケース 6 も 7d 満タン同士なので同一、なので表の**「5h に余裕があり 7d がボトルネック」ケース（1/3/4）だけ表と式が一致しない**。

実装時の期待値（式に従う再計算）:

| # | 期待 cap（式） | 説明 |
|---|---|---|
| 1 | **100%** | min(4.0, 0.119) = 0.119 → 100% |
| 2 | 100% | 0.119 → 100% |
| 3 | **~50%** | min(4.0, 0.0595) = 0.0595 → 50%（util_7d=0.5 と仮定） |
| 4 | **~50%** | min(0.667, 0.0595) = 0.0595 → 50% |
| 5 | 5% | 0.00595 → 5% |
| 6 | 105% | 0.125 → 105% |

**Implementer への指示**: ケース 1/3/4 は A019 表と食い違うが**式**に従う。食い違いは本 §8.3 に明記済み。コード実装時に A019 を改訂するか、式を見直すかは **Master 判断**（Implementer は plan.md の期待値でまず実装し、テスト時に違和感を感じたら Master に再確認する）。

### 8.4 実装

```ts
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

    const t5hH = hoursUntil(t.reset_5h_at, now);   // null / 過去 → null
    const t7dH = hoursUntil(t.reset_7d_at, now);

    const candidates: number[] = [];
    if (t5hH != null) candidates.push(remaining5h * t.plan_ratio / t5hH);
    if (t7dH != null) candidates.push(remaining7d * t.plan_ratio / t7dH);
    if (candidates.length === 0) {
      candidates.push(1.0 * t.plan_ratio / 168);   // フル 7d 相当
    }

    const flow = Math.min(...candidates);
    const cap_pct = flow / REFERENCE_FLOW * 100;

    perToken.push({ handle: t.handle, cap_pct });
    totalCap += cap_pct;
  }

  return { capacity_pct: totalCap, per_token: perToken };
}

function hoursUntil(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (isNaN(target)) return null;
  const deltaH = (target - nowMs) / 3_600_000;
  if (deltaH <= 0) return null;           // reset 過ぎ
  return Math.max(deltaH, 1 / 60);        // clamp 1 min minimum
}
```

## 9. テスト計画

### 9.1 テストファイル

`skills/cmux-team/manager/token-store.test.ts`（新規）。`bun:test`。

### 9.2 共通セットアップ

```ts
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";

let testDir: string;
let db: Database;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "cmux-token-store-"));
  db = initTokenDB({ dirPath: testDir, dbPath: join(testDir, "tokens.db") });
});
afterEach(() => {
  try { db.close(); } catch {}
  rmSync(testDir, { recursive: true, force: true });
});
```

### 9.3 ユニットテスト一覧

#### initTokenDB

- [ ] **新規 DB 作成**: ファイルが存在しない → mkdir 0700 → DB 作成 → `fs.statSync(dbPath).mode & 0o777 === 0o600`
- [ ] **既存 DB 再 open**: 2 回目 initTokenDB 呼び出しでエラーなし、schema 重複作成なし
- [ ] **WAL mode**: `db.prepare("PRAGMA journal_mode").get().journal_mode === "wal"`
- [ ] **FK on**: `db.prepare("PRAGMA foreign_keys").get().foreign_keys === 1`
- [ ] **3 テーブルと index 存在**: `sqlite_master` SELECT
- [ ] **env override**: `TOKEN_STORE_DB_PATH` 設定時にそのパスが使われる

#### insertToken / getTokenByXxx

- [ ] INSERT → `getTokenByHandle` / `getTokenByOrganizationId` で取得できる（tags が配列に復元）
- [ ] `tags` デフォルト `["any"]` が入る
- [ ] `selectable` デフォルト true
- [ ] handle 重複で UNIQUE エラー throw
- [ ] organization_id 重複で UNIQUE エラー throw
- [ ] `listTokens({ selectableOnly: true })` が selectable=true のみ返す

#### upsertUsageSnapshot

- [ ] 初回は INSERT（行数 1）
- [ ] 同 token_id で 2 回目は UPDATE（行数 1 のまま、値が更新）
- [ ] `recorded_at` が毎回新しく更新される
- [ ] `getLatestUsageSnapshot` が最新を返す
- [ ] FK 違反: 存在しない token_id で INSERT → throw

#### leases（atomic）

- [ ] `acquireLease` 初回成功 → Lease 返却、`listActiveLeases` に含まれる
- [ ] 同 token_id を別 holder が取ろうとすると `null`
- [ ] 同 token_id を**同じ holder** が再度 acquire → `null`（2 重取得不可）
- [ ] `releaseLease` 後に別 holder が acquire 可
- [ ] `releaseLease` 他 holder 指定 → no-op
- [ ] TTL 過ぎた lease は `acquireLease` 前置の cleanup で DELETE → 次の acquire 成功
- [ ] `expireLeases(nowIso)` で過去 lease 数を戻り値で得る
- [ ] **並行 race 再現**: `Promise.all` で 10 並列 acquire → 成功は 1 件のみ

#### Keychain（KEYCHAIN_TEST_MODE=1 in-memory）

- [ ] `storeTokenInKeychain("@x", "sec")` → `retrieveTokenFromKeychain("@x") === "sec"`
- [ ] `deleteTokenFromKeychain("@x")` 後の retrieve は throw
- [ ] `isKeychainSupported()` は test-mode で false

#### Keychain（macOS 実機、`process.platform === "darwin"` && `KEYCHAIN_TEST_MODE !== "1"`）

プレフィックス `@cmux-team-test-` を付けて本物の Keychain に書き、終わったら delete で掃除。CI が非 macOS なら skip。

- [ ] store → retrieve → delete が成功
- [ ] shell metacharacter を含む handle（例: `@test;rm-rf`）でも安全（args 配列渡しで shell 経由しない）
- [ ] 存在しない handle の retrieve は not-found エラー
- [ ] 存在しない handle の delete は silently 成功（冪等）

#### computePoolCapacity

- [ ] A019 検証表 6 ケース（§8.3 の**式基準の期待値**）を network なしで pass
- [ ] `plan_ratio = null` のアカウントは除外（capacity に寄与 0）
- [ ] `util = null` は満タン扱い
- [ ] `reset_*_at = null` はその window skip
- [ ] 両 reset が過去 → フル 7d 扱い
- [ ] 空配列 → `{ capacity_pct: 0, per_token: [] }`

### 9.4 ビルド検証

- [ ] `bunx tsc --noEmit` エラー 0 件
- [ ] `bun test skills/cmux-team/manager/token-store.test.ts` 全 pass

## 10. TDD 実装手順（Red → Green）

1. **空の `token-store.ts`** と **テストファイル骨格**をコミット（import エラーだけの Red）
2. **initTokenDB 系テスト**を書く → `initTokenDB` / SCHEMA を実装 → Green
3. **insertToken / getTokenByXxx テスト** → 実装 → Green
4. **upsertUsageSnapshot テスト** → 実装 → Green
5. **lease テスト（atomic + race）** → 実装 → Green
6. **Keychain in-memory テスト** → in-memory 実装 → Green
7. **Keychain macOS 実機テスト**（macOS のみ実行 skip 条件付き） → spawnSync 実装 → Green
8. **computePoolCapacity テスト**（A019 検証表 6 ケース） → 実装 → Green
9. `bunx tsc --noEmit` 0 件確認
10. `bun test` 全件 pass 確認
11. 最終コミット

## 11. 既存 codebase への影響

**新規ファイルのみ。既存ファイル変更なし。**

- 追加: `skills/cmux-team/manager/token-store.ts`
- 追加: `skills/cmux-team/manager/token-store.test.ts`

後続タスクが import する想定の named export は §3 に列挙済み。特に重要なのは:

- `initTokenDB` — daemon 起動時 / CLI entry で 1 回呼ぶ
- `insertToken` / `getTokenByOrganizationId` / `listTokens` — token CLI / proxy auto-discover で使う
- `upsertUsageSnapshot` — proxy の throttled UPSERT で使う
- `acquireLease` / `releaseLease` / `expireLeases` — spawn-agent selection で使う
- `storeTokenInKeychain` / `retrieveTokenFromKeychain` / `deleteTokenFromKeychain` — token CLI / spawn-agent で使う
- `computePoolCapacity` — TUI の `pool capacity` 表示で使う
- `isKeychainSupported` — pool 機能の有効化判定で使う
- `KeychainUnsupportedError` — catch 判定用

## 付録: 設計上の論点と結論（plan.md で結論を出したもの）

| 論点 | 結論 |
|---|---|
| DB クライアント | `bun:sqlite`（既存パターン踏襲） |
| schema_version テーブル | **不採用**。`PRAGMA table_info` ベースの ensureXxxColumns 方式（既存パターン踏襲） |
| Keychain エスケープ | `spawnSync(args 配列)` で shell を介さず `execve` |
| `tokens.tags` | JSON 文字列で保存、読み出し時 `JSON.parse` で配列に復元 |
| `acquireLease` atomic 性 | `UNIQUE(token_id)` + `INSERT OR IGNORE` で十分（BEGIN IMMEDIATE 手動制御不要） |
| `expireLeases` 呼び出し位置 | `acquireLease` 冒頭で前置自動実行 + 外部からも呼べる export |
| テスト DB パス | `TOKEN_STORE_DB_PATH` env + `InitTokenDBOptions.dbPath`（関数引数優先） |
| テスト Keychain | `KEYCHAIN_TEST_MODE=1` で in-memory Map fallback |
| `usage_snapshots` の履歴 | 履歴は traces.db:api_usage に任せ、tokens.db は token_id で UNIQUE（1 行のみ保持） |
| `security -w` の値渡し | 第 1 優先: `-w` 無指定 + stdin。動作確認して NG なら args 渡しにフォールバック |
| A019 検証表との数値乖離 | §8.3 参照。**実装は式を正**とする。表値と食い違うケース（1/3/4）はテストで式基準の期待値を使う。Implementer は実装後に Master へ報告 |

## 付録: A019 検証表の疑義（Master への報告事項）

§8.3 に詳述の通り、A019 の検証表は `min(flow_5h, flow_7d)` の式で再計算すると数値が合わない。ケース 1/3/4 が該当。本実装は**式を正**として進めるが、Master には以下を確認してほしい:

- **A** 式が正しい → 表を修正すべき（ケース 1: 672% → 100%、ケース 3: 336% → ~50%、ケース 4: 112% → ~50%）
- **B** 表が正しい → 式を「5h window 優先」「5h に余裕があれば min を取らない」などに修正すべき

本 plan.md 時点では **A を仮採用** し、Implementer は実装後のテスト pass 時点で Master に結果報告 + 再確認を行う。
