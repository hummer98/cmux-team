# 実装結果: trace DB をタスク-セッション索引に再設計

## 変更ファイル一覧

| ファイル | 変更種別 | 概要 |
|---------|---------|------|
| `trace-store.ts` | 全面書き換え | 旧 `TraceRecord` / `traces` テーブル / FTS5 を全削除。新 `TaskSessionRecord` / `task_sessions` テーブルに置換。`initDB()` に旧テーブル自動マイグレーション追加 |
| `proxy.ts` | 部分削除 | `insertTrace` / `initDB` import 削除、`bodiesDir` / `db` 変数削除、bodies 保存・SQLite 記録を全削除、`ProxyHandle` から `db` フィールド削除、`drainAndLog()` ctx を簡素化、chunks 蓄積コード削除 |
| `conductor.ts` | 追加 | `import { initDB, insertTaskSession }` 追加。`assignTask()` 内にタスク割り当てイベント（`event: "assigned"`）の trace DB 記録を追加 |
| `main.ts` | 修正 | import を新関数に更新、`createHash` import 追加。`cmdSpawnAgent()` に `agent_spawned` 記録追加、`cmdCloseTask()` に `closed` 記録追加、`cmdAbortTask()` に `aborted` 記録追加、`cmdTrace()` を全面書き換え（タスク別ツリー表示 + 全セッション一覧）、`deriveJsonlDir()` ヘルパー追加 |
| `daemon.ts` | 変更なし | `proxy.db` の参照なし。変更不要 |

## 新スキーマ

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
-- + idx_task_sessions_task_id, idx_task_sessions_session_id, idx_task_sessions_event
```

## 新関数

- `insertTaskSession(db, record)`: task_sessions に 1 行挿入
- `getTaskSessions(db, opts)`: 条件検索（taskId, taskRunId, sessionId, event, limit）
- `getSessionsForTask(db, taskId)`: タスク別セッション一覧（時系列順）

## イベント記録タイミング

| イベント | 記録箇所 | トリガー |
|---------|---------|---------|
| `assigned` | `conductor.ts` `assignTask()` | Conductor にタスク割り当て時 |
| `agent_spawned` | `main.ts` `cmdSpawnAgent()` | Agent spawn 時 |
| `closed` | `main.ts` `cmdCloseTask()` | タスク close 時 |
| `aborted` | `main.ts` `cmdAbortTask()` | タスク abort 時 |

## マイグレーション

`initDB()` 実行時に旧 `traces` テーブルが存在する場合、自動で `DROP TRIGGER traces_ai` → `DROP TABLE traces_fts` → `DROP TABLE traces` を実行し、新 `task_sessions` テーブルを作成する。

## 残したもの

- JSONL トレース（`appendFile(traceFile, ...)`）: proxy.ts で引き続き記録
- Proxy 機能自体: レート制限ヘッダー取得、デバッグエンドポイント、Master 状態更新、メッセージ受信
- Agent sessionId の state 反映ロジック

## 検証結果

- TypeScript コンパイル: 全4ファイル OK（`bun build --target bun`）
- 基本動作テスト: insertTaskSession / getSessionsForTask / getTaskSessions 全て OK
- マイグレーションテスト: 旧 traces テーブルが自動 DROP され task_sessions が作成されることを確認
