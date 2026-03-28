---
id: 029
title: ジャーナルに daemon_reload イベントを表示する
priority: medium
status: ready
created_at: 2026-03-28T04:20:00Z
---

## タスク

TUI ダッシュボードのジャーナルタブに `daemon_reload` イベントを表示する。
現在ジャーナルは `task_received`, `conductor_started`, `task_completed` の3イベントのみ表示しているが、`daemon_reload` も表示対象に追加する。

## 対象ファイル

- `skills/cmux-team/manager/dashboard.tsx` — `useJournalEntries()` 内のイベントパース処理

## 完了条件

- ジャーナルに `daemon_reload` がアイコン付きで表示される（例: `[↻] reload` のような表記）
- 既存のジャーナルエントリ表示に影響を与えない
- テストがパスする（`bun test`）

## Journal

- summary: useJournalEntries() に daemon_reload イベントのパース処理を追加（アイコン [↻]、magenta）
- files_changed: 1
