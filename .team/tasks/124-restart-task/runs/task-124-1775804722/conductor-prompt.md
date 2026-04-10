# タスク割り当て

## タスク内容

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


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-124-1775804722` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-124-1775804722
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-124-1775804722/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/124-restart-task/runs/task-124-1775804722
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/124-restart-task/runs/task-124-1775804722/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
