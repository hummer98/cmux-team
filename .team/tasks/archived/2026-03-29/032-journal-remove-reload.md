---
id: 032
title: ジャーナルから daemon_reload を除外しログタブのみに表示
priority: high
status: ready
created_at: 2026-03-28T04:30:00Z
---

## タスク

#029 で追加した daemon_reload のジャーナル表示を取り消す。daemon_reload はジャーナルには表示せず、ログタブ（2キーで切替）のみに表示されるようにする。

## 対象ファイル

- `skills/cmux-team/manager/dashboard.tsx` — `useJournalEntries()` 内の `daemon_reload` パース処理を削除

## 完了条件

- ジャーナルタブに `daemon_reload` が表示されない
- ログタブには `daemon_reload` が従来通り表示される
- テストがパスする（`bun test`）

## Journal

- summary: dashboard.tsx の useJournalEntries() から daemon_reload パース処理を削除し、ジャーナルタブへの表示を除外
- files_changed: 1
