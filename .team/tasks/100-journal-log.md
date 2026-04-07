---
id: 100
title: Journal/Log の表示順を最新が一番上に変更し自動スクロール挙動を改善
priority: medium
created_at: 2026-04-06T20:00:31.193Z
---

## タスク
## 背景

現在 Journal/Log は古い順（上）→ 新しい順（下）で表示されている。
最新エントリが一番上に来るよう逆順にし、自動スクロール挙動も改善する。

## 要件

### 表示順
- Journal・Log ともに最新エントリを一番上に表示する

### 自動スクロール挙動
- エントリが追加されたとき：
  - 一番上（最新）が表示領域に入っている場合 → 自動追従（常に最新を表示）
  - スクロールして過去を見ている場合 → 現在のスクロール位置を保持（追従しない）
- カーソル（フォーカス）表示中は自動スクロールしない

## 対象ファイル

- `skills/cmux-team/manager/dashboard.tsx`
  - `buildJournalRows()` の並び順
  - `buildLogRows()` の並び順
  - スクロールオフセット管理ロジック（journalScrollOffset / logScrollOffset）
  - エントリ更新時の自動スクロール判定
