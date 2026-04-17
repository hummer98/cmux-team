# タスク割り当て

## タスク内容

---
id: 243
title: trace DB の task_sessions に base_branch と base_sha を記録する
priority: medium
depends_on: [242]
created_by: surface:47
created_at: 2026-04-17T10:50:36.698Z
---

## 概要

worktree 作成時の start-point（base branch と base commit SHA）を trace DB に記録する。T242 で worktree 作成ロジックが明示化・多段フォールバックになるため、どの source から base を解決したかを事後診断できるようにする。

## 背景

T165 (Dear) の調査で「ローカル dev HEAD 依存で他 14 タスクの変更が PR に混入」という事故が発生した。現状 trace DB の `task_sessions` には `worktree_path` は記録されているが **base branch や base SHA は保存されていない**。そのため事後診断は `git log` で親チェーンを辿って分岐点を推定する必要があり、ブランチ/コミットが削除された後では追跡不能になる。

## 現状スキーマ

`skills/cmux-team/manager/trace-store.ts:39`:

```sql
CREATE TABLE task_sessions (
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
```

## 修正内容

1. **マイグレーション**: `task_sessions` に `base_branch TEXT` と `base_sha TEXT` カラムを追加（`ALTER TABLE ADD COLUMN` で既存 DB を破壊せず拡張）。加えて「解決経路」を残すため `base_source TEXT`（`explicit` / `config-origin` / `config-local` / `head-fallback` 等）も追加すると T242 のログと対応が取れて嬉しい
2. **書き込み**: `conductor.ts` の worktree 作成直後に `git rev-parse HEAD`（worktree の cwd で）で SHA を取って insert
3. **既存レコードは NULL 許容**（過去データは残す、後付け補完はしない）
4. **索引**: 必要なら `idx_task_sessions_base_branch` を追加。基本は task_id 経路で引くので無くてもよい

## 完了条件

### コード

- [ ] trace-store.ts にマイグレーションを追加（起動時に `PRAGMA table_info` で欠損カラムを検出して ALTER）
- [ ] conductor.ts の worktree 作成完了後に base_branch / base_sha / base_source を `task_sessions` に書き込む
- [ ] 既存 insert 経路が壊れないこと（カラム追加のみなので後方互換のはず）
- [ ] 簡単な e2e/unit テストで新カラムに値が入ることを確認

### ドキュメント

- [ ] `docs/spec/` の trace DB スキーマを記載しているファイルを更新
- [ ] `CLAUDE.md` の「トレーサビリティ（v3.4.0）」セクションに新カラムを反映
- [ ] `CHANGELOG.md` に記載

### スキル

- [ ] `skills/cmux-team/SKILL.md` で trace DB について言及している箇所があれば更新
- [ ] `skills/cmux-team:trace-task` スキル（`skills/cmux-team/SKILL.md` 配下の trace-task 関連定義 / `commands/` 内のコマンド定義）に新カラムを使った検索・表示の項目を追加。最低限 `base_branch` / `base_sha` / `base_source` を結果に出せるようにする

## 依存関係

- **T242 の完了後に着手**。T242 の `base source` 区分（`explicit` / `config-origin` / `config-local` / `head-fallback`）が確定しないと `base_source` カラムの値域が決まらないため


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-243-1776424220` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-243-1776424220
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-243-1776424220/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/243-trace-db-task-sessions-base-branch-base-sha/runs/task-243-1776424220
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/243-trace-db-task-sessions-base-branch-base-sha/runs/task-243-1776424220/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
