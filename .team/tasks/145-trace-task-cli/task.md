---
id: 145
title: trace-task CLI + スキルでタスクのセッション履歴を分析可能にする
priority: medium
depends_on: [144]
created_at: 2026-04-10T22:29:28.034Z
---

## タスク
## 概要

あるタスクに関連した全セッション（Conductor + Agent）の情報を追跡・分析できる CLI コマンドとスキルを追加する。配布先のユーザーも利用可能にする。

## CLI: `cmux-team trace-task <task-id>`

### 基本モード（セッション一覧）

```
$ cmux-team trace-task T141

Task T141: SESSION_CLEAR で running Conductor のステータスをリセットする
Run: task-141-1775852524
Worktree: .worktrees/task-141-1775852524

Sessions:
  conductor  a87d71b5  surface:125  54 lines   ~/.claude/projects/.../a87d71b5.jsonl
  impl       1ad0d40a  surface:136  77 lines   ~/.claude/projects/.../1ad0d40a.jsonl
  inspector  xxxxxxxx  surface:137  45 lines   ~/.claude/projects/.../xxxxxxxx.jsonl
```

- T144 の新 `task_sessions` テーブルをクエリ
- worktree_path から JSONL パスを導出: `~/.claude/projects/<hashed-worktree-path>/<session_id>.jsonl`
- 各 JSONL の行数も表示

### 要約モード（`--summary`）

```
$ cmux-team trace-task T141 --summary
```

- 各セッションの JSONL を読み、何をしたかの要約を生成
- デフォルトでは要約なし（一覧のみ）

## スキル: SKILL.md + コマンド

### SKILL.md（自動トリガー）

`skills/trace-task/SKILL.md` を作成。「T141 を分析して」「タスクの履歴を見せて」等の発言で自動発動。CLI の使い方とJSONL の読み方を提供。

### コマンド（/trace-task）

`commands/trace-task.md` を作成。`/trace-task T141` で明示呼び出し。

手順:
1. `cmux-team trace-task <id>` でセッション一覧を取得
2. 必要に応じて JSONL を Read で読んで分析
3. ツール呼び出し・判断・エラー等を報告

## 既存の `cmux-team trace` コマンドとの関係

T144 で trace DB スキーマが変わるため、既存の `cmux-team trace` は `trace-task` に置き換える。旧コマンドは廃止。

## 依存

- T144（trace DB をタスク-セッション索引に再設計）が前提
