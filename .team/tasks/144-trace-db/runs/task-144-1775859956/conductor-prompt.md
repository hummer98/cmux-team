# タスク割り当て

## タスク内容

---
id: 144
title: trace DB をタスク-セッション索引に再設計する
priority: high
created_at: 2026-04-10T22:25:56.920Z
---

## タスク
## 概要

trace DB を HTTP リクエストログからタスク-セッション索引に再設計する。JSONL が会話の真のデータであり、trace DB はそこへのインデックスとなる。

## 現状の問題

- trace DB は全 API リクエストを記録しているが、task_id / conductor_id / role が全件 NULL で使い物にならない
- request/response の bodies/ 保存もあるが、JSONL と重複しており参照されていない
- 14,445 件の HTTP ログが溜まっているが活用されていない

## 新スキーマ

既存の `traces` テーブルと `traces_fts` を DROP し、新テーブルを作成:

```sql
CREATE TABLE task_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  task_id TEXT NOT NULL,        -- "141"
  task_run_id TEXT,             -- "task-141-1775852524"
  session_id TEXT NOT NULL,     -- UUID
  role TEXT,                    -- "conductor", "impl", "inspector", "planner" 等
  surface TEXT,                 -- "surface:125"
  worktree_path TEXT,           -- JSONL フォルダパス導出用
  event TEXT NOT NULL           -- "assigned", "agent_spawned", "closed", "aborted"
);
```

## 記録タイミング

| イベント | トリガー箇所 | 記録内容 |
|---------|-------------|---------|
| タスク割り当て | `assignTask()` (conductor.ts) | conductor session_id + task_id + worktree_path |
| Agent spawn | `spawn-agent` CLI (main.ts) | agent session_id + role + task_id |
| タスク完了 | `close-task` | event=closed |
| タスク中止 | `abort-task` | event=aborted |

## マイグレーション

- バージョンアップ時に自動マイグレーション: 既存の traces テーブルを DROP → 新スキーマで CREATE
- `initDB()` 内でテーブル存在チェック + スキーマバージョン管理
- 既存データ（14,445件）は破棄

## 廃止するもの

- `.team/logs/traces/bodies/` ディレクトリ（request/response 本文保存）— proxy.ts から bodies 書き込みロジックを削除
- proxy.ts の `insertTrace()` 呼び出し（HTTP リクエスト記録）— 削除
- trace-store.ts の旧スキーマ・旧関数（`TraceRecord`, `insertTrace`, `searchTraces`, `getTrace`）— 新スキーマ用に書き換え

## CLI の更新

`cmux-team trace` コマンドを新スキーマに対応:

```bash
cmux-team trace --task 141
# → conductor: session=a87d71b5, role=conductor, surface=surface:125
# →     agent: session=1ad0d40a, role=impl
# →     agent: session=xxxxxxxx, role=inspector
```

JSONL パスは worktree_path からハッシュ化して `~/.claude/projects/<hash>/<session_id>.jsonl` で導出・表示する。

## .gitignore

`.team/logs/traces/bodies/` のエントリがあれば削除（または traces/ ごと無視のまま維持）。

## 注意

- Proxy 自体は残す（レート制限ヘッダー取得に必要）
- Proxy から trace DB への記録だけを廃止する


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-144-1775859956` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-144-1775859956
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-144-1775859956/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/144-trace-db/runs/task-144-1775859956
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/144-trace-db/runs/task-144-1775859956/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
