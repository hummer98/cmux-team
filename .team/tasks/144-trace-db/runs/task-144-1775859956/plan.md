# 実装計画書: trace DB をタスク-セッション索引に再設計

## 概要

trace DB を HTTP リクエストログ（`traces` + `traces_fts`）からタスク-セッション索引（`task_sessions`）に再設計する。JSONL が会話の真のデータであり、trace DB はそこへのインデックスとなる。

## 変更対象ファイル一覧

| ファイル | 変更種別 | 概要 |
|---------|---------|------|
| `skills/cmux-team/manager/trace-store.ts` | **全面書き換え** | 旧スキーマ → 新 `task_sessions` スキーマ |
| `skills/cmux-team/manager/proxy.ts` | **部分削除** | `insertTrace` / `bodies` 関連を削除、DB インスタンスをプロキシから分離 |
| `skills/cmux-team/manager/conductor.ts` | **追加** | `assignTask()` 内部で `initDB()` を呼びタスク割り当てイベントを記録 |
| `skills/cmux-team/manager/main.ts` | **修正** | import 変更、`cmdSpawnAgent` / `cmdCloseTask` / `cmdAbortTask` / `cmdTrace` を更新 |
| `skills/cmux-team/manager/daemon.ts` | **変更不要** | 各 CLI コマンド内で `initDB()` を直接呼ぶ方針のため DaemonState への DB 追加は不要 |
| `skills/cmux-team/manager/schema.ts` | **変更不要** | 同上 |

## 各ファイルの具体的な変更内容

### 1. trace-store.ts（全面書き換え）

#### 削除するもの
- `TraceRecord` インターフェース（HTTP リクエスト記録用の14フィールド）
- `SCHEMA` 定数（`traces` テーブル + `traces_fts` FTS5 + トリガー）
- `insertTrace()` 関数
- `searchTraces()` 関数
- `getTrace()` 関数

#### 新規作成するもの

**`TaskSessionRecord` インターフェース:**
```typescript
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
```

**新スキーマ (`SCHEMA` 定数):**
```sql
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
```

**`initDB()` 関数（修正）:**
- 既存と同じシグネチャ `(projectRoot: string): Database` を維持
- マイグレーション追加: `traces` テーブルが存在する場合は DROP（旧→新への移行）
  - `SELECT name FROM sqlite_master WHERE type='table' AND name='traces'` で存在チェック
  - 存在すれば `DROP TABLE IF EXISTS traces_fts` → `DROP TABLE IF EXISTS traces` → `DROP TRIGGER IF EXISTS traces_ai` の順で削除
- 新スキーマの `CREATE TABLE IF NOT EXISTS` を実行

**`insertTaskSession()` 関数（新規）:**
```typescript
export function insertTaskSession(db: Database, record: TaskSessionRecord): number
```
- `task_sessions` テーブルに1行挿入
- `lastInsertRowid` を返す

**`getTaskSessions()` 関数（新規）:**
```typescript
export function getTaskSessions(
  db: Database,
  opts: { taskId?: string; taskRunId?: string; sessionId?: string; event?: string; limit?: number }
): TaskSessionRecord[]
```
- 条件に合致する `task_sessions` レコードを返す
- `ORDER BY id DESC`、デフォルト limit=50

**`getSessionsForTask()` 関数（新規）:**
```typescript
export function getSessionsForTask(
  db: Database,
  taskId: string
): TaskSessionRecord[]
```
- 特定タスクの全セッションを時系列順（`ORDER BY id ASC`）で返す
- `cmdTrace --task <id>` のメイン表示用

### 2. proxy.ts（部分削除）

#### 削除するもの

**import 文 (L10):**
- `import { initDB, insertTrace } from "./trace-store";` → `initDB` のみ残す（後述: daemon 経由に変更するため import 自体も削除する可能性あり）

**変数・ディレクトリ作成 (L84-86):**
- `const bodiesDir = ...` (L84) → 削除
- `await mkdir(bodiesDir, { recursive: true });` (L85) → 削除
- `const db = initDB(projectRoot);` (L86) → 削除

**リクエスト本文の bodies/ 保存 (L214-219):**
- `const traceId = ...` (L214) → 削除
- `let reqBodyPath: ...` (L215) → 削除
- `if (reqBody && requestBytes > 0) { ... }` (L216-219) → 削除

**非 streaming: レスポンス本文 bodies/ 保存 + SQLite 記録 (L306-329):**
- `let resBodyPath: ...` (L306) → 削除
- `if (resBody.byteLength > 0) { ... }` (L307-309) → 削除
- `try { insertTrace(db, { ... }); } catch { ... }` (L311-329) → 削除

**`drainAndLog()` 関数の ctx パラメータから削除:**
- `db`, `bodiesDir`, `traceId`, `reqBodyPath` を ctx から削除

**`drainAndLog()` 関数内の bodies 保存 + SQLite 記録 (L415-447):**
- bodies/ へのレスポンス本文書き込み (L416-426) → 削除
- `try { insertTrace(...) } catch { ... }` (L429-447) → 削除
- `chunks` 配列の蓄積コード → 削除（bodies 保存削除により不要になったデッドコード）

**`ProxyHandle` インターフェース (L18-22):**
- `db: Database` フィールドを削除
- `import type { Database } from "bun:sqlite";` (L14) → 削除

**`start()` の return 文 (L351-355):**
- `db` を返さないように変更
- `stop` から `db.close()` を削除

#### 残すもの
- プロキシ機能自体（`fetch`, `Bun.serve`）
- JSONL トレースファイル書き込み（`appendFile(traceFile, ...)` — L303, L413）
- レート制限ヘッダー抽出（`extractRateLimit`）
- デバッグエンドポイント（`/state`, `/tasks`, `/conductors`）
- Master 状態更新エンドポイント（`/master-state`）
- メッセージ受信エンドポイント（`/api/messages`）
- Agent sessionId の state 反映ロジック (L187-207)

### 3. conductor.ts（追加）

#### `assignTask()` 関数 (L237-425) に追加

**方針:** `assignTask()` のシグネチャは変更しない。関数内部で `initDB(projectRoot)` を呼び出して記録し、完了後に `db.close()` する。

**import 追加:**
- `import { initDB, insertTaskSession } from "./trace-store";`

**タスク割り当てイベントの記録（ステップ 6 の直前、L389 付近）:**
```typescript
// タスク-セッション索引に記録
try {
  const db = initDB(projectRoot);
  insertTaskSession(db, {
    timestamp: new Date().toISOString(),
    task_id: taskId,
    task_run_id: taskRunId,
    session_id: conductor.sessionId!,
    role: "conductor",
    surface: conductor.surface,
    worktree_path: worktreePath,
    event: "assigned",
  });
  db.close();
} catch (e: any) {
  log("error", `trace DB assigned insert failed: ${e?.message ?? e}`).catch(() => {});
}
```

### 4. main.ts（修正）

#### import 文の変更 (L34)
```typescript
// Before:
import { initDB, searchTraces, getTrace } from "./trace-store";
// After:
import { initDB, insertTaskSession, getSessionsForTask, getTaskSessions } from "./trace-store";
```

#### `cmdSpawnAgent()` (L1060-1174) に追加

AGENT_SPAWNED メッセージ送信部分（L1162-1170）の後に DB 記録を追加:

```typescript
// タスク-セッション索引に記録
try {
  const db = initDB(PROJECT_ROOT);
  // team.json から taskId/taskRunId を取得
  const cond = teamJson?.conductors?.find((c: any) => c.surface === conductorSurface);
  if (cond?.taskId) {
    insertTaskSession(db, {
      timestamp: new Date().toISOString(),
      task_id: cond.taskId,
      task_run_id: cond.taskRunId,
      session_id: "", // Agent の sessionId は spawn 時点では未知（空文字で記録）
      role,
      surface,
      worktree_path: worktreePath,
      event: "agent_spawned",
    });
  }
  db.close();
} catch (e: any) {
  log("error", `trace DB agent_spawned insert failed: ${e?.message ?? e}`).catch(() => {});
}
```

**sessionId について:** Agent の sessionId は Claude Code 起動後に proxy の `x-claude-code-session-id` ヘッダーで初めて判明するため、spawn 時点では空文字で記録する。sessionId の補完は proxy の既存ロジック（state への反映）に任せ、DB への sessionId 更新は行わない（JSONL パスは worktree_path から導出するため、sessionId は参考情報）。

#### `cmdCloseTask()` (L1401-1448) に追加

task-state.json 更新後（L1427 付近）に DB 記録を追加:

```typescript
// タスク-セッション索引に記録
try {
  const db = initDB(PROJECT_ROOT);
  insertTaskSession(db, {
    timestamp: new Date().toISOString(),
    task_id: taskId,
    task_run_id: conductor?.taskRunId,
    session_id: conductor?.sessionId ?? "",
    role: "conductor",
    surface: conductor?.surface,
    event: "closed",
  });
  db.close();
} catch (e: any) {
  log("error", `trace DB closed insert failed: ${e?.message ?? e}`).catch(() => {});
}
```

#### `cmdAbortTask()` (L1491-1569) に追加

task-state.json 更新後（L1548 付近）に DB 記録を追加:

```typescript
// タスク-セッション索引に記録
try {
  const db = initDB(PROJECT_ROOT);
  insertTaskSession(db, {
    timestamp: new Date().toISOString(),
    task_id: taskId,
    task_run_id: conductor?.taskRunId,
    session_id: conductor?.sessionId ?? "",
    role: "conductor",
    surface: conductor?.surface,
    event: "aborted",
  });
  db.close();
} catch (e: any) {
  log("error", `trace DB aborted insert failed: ${e?.message ?? e}`).catch(() => {});
}
```

#### `cmdTrace()` (L1706-1776) — 全面書き換え

新スキーマに対応した表示ロジック:

```typescript
async function cmdTrace(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_trace"));
  const db = initDB(PROJECT_ROOT);
  const taskId = getArg("task");
  const sessionId = getArg("session");
  const limit = getArg("limit");

  if (taskId) {
    // タスク別セッション表示（ツリー形式）
    const sessions = getSessionsForTask(db, taskId);
    if (sessions.length === 0) {
      console.log(`No sessions found for task ${taskId}`);
      db.close();
      return;
    }

    console.log(`Task ${taskId} sessions:`);
    for (const s of sessions) {
      const indent = s.role === "conductor" ? "  " : "      ";
      const label = s.role === "conductor" ? "conductor" : `agent`;
      const sessionStr = s.session_id ? `session=${s.session_id.slice(0, 8)}` : "";
      const surfaceStr = s.surface ? `surface=${s.surface}` : "";
      const eventStr = `event=${s.event}`;
      console.log(`${indent}${label}: ${sessionStr} role=${s.role ?? "-"} ${surfaceStr} ${eventStr}`);

      // JSONL パスの導出・表示
      if (s.worktree_path && s.session_id) {
        // worktree_path からプロジェクトハッシュを計算して JSONL パスを導出
        const jsonlDir = deriveJsonlDir(s.worktree_path);
        const jsonlPath = join(jsonlDir, `${s.session_id}.jsonl`);
        if (existsSync(jsonlPath)) {
          console.log(`${indent}  jsonl: ${jsonlPath}`);
        }
      }
    }
  } else {
    // 全セッション一覧
    const sessions = getTaskSessions(db, {
      sessionId,
      limit: limit ? Number(limit) : 20,
    });

    if (sessions.length === 0) {
      console.log("No sessions found");
      db.close();
      return;
    }

    console.log(`${"ID".padStart(4)}  ${"TIME".padEnd(19)}  ${"TASK".padEnd(6)}  ${"RUN".padEnd(24)}  ${"ROLE".padEnd(12)}  ${"EVENT".padEnd(10)}  SURFACE`);
    console.log("─".repeat(100));
    for (const s of sessions) {
      const time = s.timestamp?.slice(0, 19) || "";
      const task = s.task_id.padEnd(6);
      const run = (s.task_run_id ?? "-").padEnd(24);
      const role = (s.role ?? "-").padEnd(12);
      const event = s.event.padEnd(10);
      const surface = s.surface ?? "-";
      console.log(`${String(s.id).padStart(4)}  ${time}  ${task}  ${run}  ${role}  ${event}  ${surface}`);
    }
  }
  db.close();
}
```

**`deriveJsonlDir()` ヘルパー関数（新規、main.ts 内に追加）:**
```typescript
import { createHash } from "crypto";

function deriveJsonlDir(worktreePath: string): string {
  const hash = createHash("sha256").update(worktreePath).digest("hex").slice(0, 16);
  return join(process.env.HOME ?? "~", ".claude/projects", hash);
}
```
※ `import { createHash } from "crypto"` は main.ts の先頭 import 群に追加する。
**注意:** Claude Code の JSONL パス導出ロジックの正確な実装は要確認。`~/.claude/projects/` 配下のハッシュ化方式はClaude Code のバージョンにより異なる可能性がある。初回実装ではハッシュで導出を試み、見つからない場合はパスを表示しない方針とする。

### 5. daemon.ts（変更不要）

daemon.ts / schema.ts は変更不要。各 CLI コマンド（`cmdSpawnAgent` / `cmdCloseTask` / `cmdAbortTask`）および `conductor.ts` の `assignTask()` は、関数内部で `initDB()` を直接呼んで DB を開閉する方針で統一する（WAL モードにより並行アクセスは安全）。

**設計意図: daemon 内部の自動 abort は trace DB に記録しない。** daemon の `assignTask()` が `AssignTaskError` で失敗した場合の自動 abort（タスクを ready に戻す処理）は、trace DB には記録しない。trace DB に記録するのは CLI 経由の明示的な `abort-task` コマンドのみとする。理由: daemon 内部の自動 abort はリトライのための一時的な状態遷移であり、ユーザーの意図に基づく操作（CLI の `abort-task`）とは性質が異なるため。

## 実装順序

依存関係を考慮し、以下の順序で実装する。

### Step 1: trace-store.ts の全面書き換え

1. 旧インターフェース・旧スキーマ・旧関数をすべて削除
2. 新 `TaskSessionRecord` インターフェースを定義
3. 新スキーマ（`task_sessions` テーブル + インデックス）を定義
4. `initDB()` にマイグレーションロジックを追加（旧テーブル DROP）
5. `insertTaskSession()`, `getTaskSessions()`, `getSessionsForTask()` を実装

**依存関係:** なし（他のファイルは旧関数を参照しているが、次の Step で修正する）

### Step 2: proxy.ts の修正

1. `import { initDB, insertTrace }` から `insertTrace` を削除、`initDB` も削除
2. `import type { Database }` を削除
3. `bodiesDir` 関連（作成・変数）を削除
4. `const db = initDB(projectRoot)` を削除
5. 非 streaming パス: `reqBodyPath` / `resBodyPath` / `insertTrace()` を削除
6. `drainAndLog()` の ctx から `db`, `bodiesDir`, `traceId`, `reqBodyPath` を削除
7. `drainAndLog()` 内の bodies 保存 + `insertTrace()` を削除
8. `drainAndLog()` 内の `chunks` 配列の蓄積コードを削除（bodies 保存削除により不要）
9. `ProxyHandle` から `db` フィールドを削除
10. `start()` の return から `db` を削除、`stop` から `db.close()` を削除

**依存関係:** Step 1 完了後（`insertTrace` が消えているため）

### Step 3: conductor.ts の修正

1. `import { initDB, insertTaskSession } from "./trace-store"` を追加
2. `assignTask()` 内、ConductorState 更新直前（L389 付近）にタスク割り当てイベント記録を追加（シグネチャは変更しない）
3. 関数内部で `initDB(projectRoot)` → 記録 → `db.close()` する

**依存関係:** Step 1 完了後

### Step 4: main.ts の修正

1. import 文を更新: `searchTraces`, `getTrace` → `insertTaskSession`, `getSessionsForTask`, `getTaskSessions`
2. `cmdSpawnAgent()` に `agent_spawned` イベント記録を追加
3. `cmdCloseTask()` に `closed` イベント記録を追加
4. `cmdAbortTask()` に `aborted` イベント記録を追加
5. `cmdTrace()` を全面書き換え
6. `deriveJsonlDir()` ヘルパーを追加

**依存関係:** Step 1 完了後（新関数を使用するため）

### Step 5: daemon.ts の確認

1. `proxy.ts` の `ProxyHandle` から `db` が消えたことで、daemon.ts 内で `proxy.db` を参照している箇所がないか確認
2. 参照があれば削除（DaemonState への DB 追加は不要）

**依存関係:** Step 2 完了後

## テスト方針

### 機能テスト（E2E）

自動テストはないため、以下の手動テストで検証する。

1. **マイグレーションテスト:**
   - 既存の traces.db がある状態で daemon を再起動
   - `traces` / `traces_fts` テーブルが DROP され、`task_sessions` テーブルが作成されることを確認
   - `cmux-team trace` がエラーなく動作すること

2. **記録テスト:**
   - `cmux-team start` でチームを起動
   - タスクを ready にして Conductor に割り当てられるのを待つ
   - `cmux-team trace --task <id>` で `assigned` イベントが記録されていることを確認
   - Conductor が Agent を spawn したら `agent_spawned` イベントが記録されていることを確認
   - タスク完了後に `closed` イベントが記録されていることを確認

3. **abort テスト:**
   - 稼働中タスクを `cmux-team abort-task --task-id <id>` で中止
   - `cmux-team trace --task <id>` で `aborted` イベントが記録されていることを確認

4. **Proxy 機能テスト:**
   - API リクエストが正常にプロキシされること（bodies 保存なし）
   - JSONL トレースが引き続き記録されること
   - レート制限ヘッダーが正常に抽出されること

5. **DB 直接確認:**
   ```bash
   sqlite3 .team/traces/traces.db ".tables"
   # → task_sessions のみ表示（traces, traces_fts がないこと）
   sqlite3 .team/traces/traces.db "SELECT * FROM task_sessions"
   ```

### 回帰テスト

- `cmux-team status` が正常に動作すること
- `cmux-team agents` が正常に動作すること
- Proxy のデバッグエンドポイント（`/state`, `/tasks`, `/conductors`）が動作すること
- ダッシュボードが正常に表示されること

## マイグレーション手順

### 自動マイグレーション（`initDB()` 内）

```typescript
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

  // 新スキーマ作成
  db.exec(SCHEMA);
  return db;
}
```

### 手動クリーンアップ（任意）

既存の `.team/logs/traces/bodies/` ディレクトリは手動で削除可能。自動削除は行わない（データ損失リスクを避けるため）。

## リスクと注意点

1. **既存データの破棄:** 旧 traces テーブルの 14,445 件は破棄される。ただし task_id/conductor_id/role が全件 NULL で使い物にならないため、実害はない。

2. **JSONL トレースは残す:** proxy.ts の JSONL 書き込み（`api-trace.jsonl`）は削除しない。HTTP リクエストの時系列ログとして引き続き有用。

3. **Proxy 自体は残す:** レート制限ヘッダーの取得に必要。`insertTrace` と bodies 保存のみ削除。

4. **SQLite 並行アクセス:** CLI コマンド（`cmdSpawnAgent` 等）と daemon が同じ SQLite DB にアクセスするが、WAL モードにより安全。ただし短時間で開閉する方針とする。

5. **Agent の sessionId:** spawn 時点では Claude Code の sessionId が未知。空文字で記録する。正確な sessionId が必要な場合は、proxy の sessionId 反映ロジックと組み合わせるか、`team.json` の agents 配列から後引きする。

6. **JSONL パス導出:** Claude Code の `~/.claude/projects/<hash>/` のハッシュ化方式は内部実装に依存。初回は推定ロジックで実装し、合わなければ `worktree_path` のみ表示に留める。

7. **bodies/ ディレクトリ:** 既存の bodies/ は自動削除しない。proxy.ts から書き込みロジックを削除するのみ。将来的にユーザーが手動で `rm -rf .team/logs/traces/bodies/` できる。
