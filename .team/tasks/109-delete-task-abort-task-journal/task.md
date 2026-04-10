---
id: 109
title: delete-task コマンド追加 + abort-task の Journal 記録対応
priority: high
created_at: 2026-04-08T14:31:45.812Z
---

## タスク
## 概要

タスクの終了手段を整備する。

## 変更内容

### 1. delete-task コマンド新規追加

```bash
cmux-team delete-task --task-id NNN [--journal "理由"]
```

- task-state.json に `status: "deleted"` + `deletedAt` を記録
- journal 任意（未指定時はデフォルト: `"削除: T{id} {title}"`）
- Journal タブには記録を残す
- Tasks タブには表示しない（daemon.ts の openTasksList フィルタに `deleted` を追加）
- assigned 状態のタスクは削除不可（abort を使うべき）。ready/draft のみ対象
- CONDUCTOR_DONE は不要（未着手なので Conductor に割り当てられていない）

### 2. abort-task に journal オプション追加

```bash
cmux-team abort-task --task-id NNN [--journal "理由"]
```

- `--journal` 未指定時はデフォルトメッセージ: `"中断: T{id} {title}"`
- task-state.json に journal を記録（close-task と同じ形式）
- Journal タブに表示されるようにする

### 3. daemon.ts — deleted フィルタ追加

- openTasksList のフィルタに `deleted` を追加: `t.status !== "deleted"`
- closed set にも `deleted` を含める（依存関係の解決で deleted を完了扱い）

### 4. dashboard.tsx — deleted の表示対応

- taskList に deleted が混入しないことを確認（daemon 側でフィルタ済み）
- Journal タブで deleted タスクの journal が表示されることを確認

### 5. SKILL.md / テンプレート更新

- Master テンプレート（templates/master.md）に delete-task の使い方を追記
- Conductor テンプレートには不要（Conductor は delete しない）

## 対象ファイル

- skills/cmux-team/manager/main.ts（delete-task コマンド追加、abort-task 修正）
- skills/cmux-team/manager/daemon.ts（openTasksList フィルタ）
- skills/cmux-team/manager/task.ts（必要に応じて）
- skills/cmux-team/templates/master.md
