---
id: 124
title: restart-task サブコマンドの実装
priority: high
created_at: 2026-04-10T07:05:22.851Z
---

## タスク
## 背景

Conductor がダウンした場合、現状は `abort-task` + `create-task` の2ステップが必要。1コマンドでリトライできる `restart-task` を追加する。

## やること

`cmux-team restart-task --task-id <id> [--journal "理由"]` サブコマンドを実装する。

## 動作

1. 対象タスクが assigned 状態であることを確認
2. abort-task と同じクリーンアップを実行（worktree 削除 + Conductor リセット）
3. ただしタスクを closed にせず、status を `ready` に戻す（task-state.json を更新）
4. Manager に TASK_CREATED 通知を送信 → idle Conductor に自動再割り当て

つまり abort-task の処理を流用しつつ、最後に closed ではなく ready にするだけ。同一タスク ID で再実行される。

## インターフェース

```
cmux-team restart-task --task-id <id> [--journal "理由"]
```

- `--task-id`: 必須。再実行するタスク ID
- `--journal`: 任意。リスタート理由（タスクファイルの Journal セクションに追記）

## 対象ファイル

- `skills/cmux-team/manager/main.ts` — サブコマンド追加（abort-task の処理を参考に）
- `skills/cmux-team/manager/task.ts` — 必要に応じてヘルパー追加

## 注意

- abort-task のクリーンアップロジックを重複実装せず、共通化すること
- closed ではなく ready に戻す点が abort-task との唯一の違い
- journal には restart であることを明記（例: `[restart] 理由`）
