---
id: 25
title: ログ・TUI 表示のタイムゾーン対応
priority: medium
status: ready
created_at: 2026-03-28T00:05:00Z
depends_on: [24]
---

## 概要

ログファイルの記録は UTC のまま維持しつつ、TUI やジャーナル、status API での時刻表示をシステムのローカルタイムゾーン（例: JST）に変換する。

## 現状

- `logger.ts`: `new Date().toISOString()` で UTC 記録 → `[2026-03-27T15:32:55Z]`
- `dashboard.tsx`: UTC 文字列から `slice(11, 19)` で `HH:MM:SS` を切り出し → 9時間ずれる
- `main.ts status`: 同様に UTC の `HH:MM:SS` を表示

## 設計

### ログファイル（変更なし）

`manager.log` は UTC ISO 8601 のまま。機械可読性・ソート・タイムゾーン非依存を維持。

### TUI / ジャーナル / status API（ローカルタイムに変換）

UTC 文字列をパースして `toLocaleTimeString` でローカル時刻に変換する共通ユーティリティを作成:

```typescript
function utcToLocal(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
```

適用箇所:
- `dashboard.tsx` の `formatLogLine` 関数
- `dashboard.tsx` の `formatElapsed` 関数（ここは相対時間なので影響なし）
- `main.ts` の `cmdStatus` 関数内のログ表示
- ジャーナル表示（#24 で追加されるタブ）

## 完了条件

- [ ] TUI のログ・ジャーナル表示がローカルタイムで表示される
- [ ] `main.ts status` のログ表示がローカルタイムで表示される
- [ ] ログファイル（`manager.log`）は UTC のまま変更なし
- [ ] 既存テストが通ること

## Journal

- summary: TUI ダッシュボード（journal/log タブ）と status コマンドの時刻表示を UTC からローカルタイムゾーン（JST等）に変換。utcToLocal ユーティリティ関数を dashboard.tsx に追加し、formatLogLine・useJournalEntries・cmdStatus の3箇所に適用。ログファイルは UTC のまま維持。
- files_changed: 2
