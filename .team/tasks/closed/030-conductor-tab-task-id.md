---
id: 030
title: Conductor タブタイトルにタスク番号を追加
priority: medium
status: ready
created_at: 2026-03-28T04:22:00Z
---

## タスク

Conductor のタブ名にタスク番号を追加する。

現在: `[234] ♦ proxy修正`
期待: `[234] ♦ #023 proxy修正`

## 対象ファイル

- `skills/cmux-team/manager/conductor.ts` — タブ名設定箇所（`cmux.renameTab` の呼び出し）

## 完了条件

- Conductor タブ名が `[num] ♦ #taskId タスク名` の形式になる
- 既存の Agent タブ名には影響しない

## Journal

- summary: conductor.ts のタブ名テンプレートに #${taskId} を追加し、Conductor タブにタスク番号が表示されるようにした
- files_changed: 1
