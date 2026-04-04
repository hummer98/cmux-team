---
id: 061
title: abort-task コマンドの追加
priority: high
created_at: 2026-04-04T00:35:49.303Z
---

## タスク
## 概要

実行中のタスクを中止する abort-task コマンドを追加する。現状は closed にするだけで中止と完了の区別がつかず、実行中の Conductor を停止する手段もない。

## やること

### 1. task-state.json に aborted ステータスを追加

既存: draft → ready → assigned → closed
追加: assigned → aborted（abort-task 実行時）

### 2. cmux-team abort-task CLI コマンド

```bash
cmux-team abort-task --task-id NNN
```

処理フロー:
1. task-state.json から該当タスクを特定（status が assigned であること）
2. 該当 Conductor を特定（taskId で検索）
3. Conductor の sub-agents を PID kill（agents[] の PID）
4. Conductor 自体を PID kill
5. worktree を削除
6. タスク状態を aborted に変更
7. Conductor の surface に `cmux-team conductor` を再送信して新セッションを起動し idle に戻す

### 3. TUI の Journal 表示

aborted タスクを closed と区別して表示する。アイコンや色を変える。

### 4. スキーマ変更

- schema.ts の TaskStatus に aborted を追加
- task.ts の close-task 周辺ロジックへの影響確認

## 対象ファイル

- `manager/main.ts` — abort-task サブコマンド追加
- `manager/task.ts` — aborted ステータス対応
- `manager/schema.ts` — TaskStatus 型拡張
- `manager/dashboard.tsx` — Journal での aborted 表示
- `manager/conductor.ts` — Conductor 再起動ロジック
- `manager/daemon.ts` — aborted タスクの扱い
