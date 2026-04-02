---
id: 043
title: TUI Journal を新しい順（逆順）で表示する
priority: medium
created_at: 2026-04-02T15:21:23.876Z
---

## タスク
## 背景
Journal タブはスクロール機能がなく、エントリが画面外に溢れると最新のものが見えなくなる。

## 対応
`dashboard.tsx` の `buildJournalRows` に渡す entries を逆順にして、最新エントリが常に上に表示されるようにする。

## 対象ファイル
- `skills/cmux-team/manager/dashboard.tsx`

## 変更箇所
- L570 付近: `buildJournalRows(state.journalEntries, repoUrl)` → `buildJournalRows([...state.journalEntries].reverse(), repoUrl)`
  - または `parseJournalEntries` の結果を reverse する

## 確認ポイント
- TUI の Journal タブで最新エントリが一番上に表示されること
- 既存の表示（アイコン、色、リンク等）が崩れないこと
