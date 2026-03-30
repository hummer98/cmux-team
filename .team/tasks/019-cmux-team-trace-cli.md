---
id: 019
title: cmux-team trace CLI コマンドの実装
priority: medium
created_at: 2026-03-29T10:59:20.390Z
---

## タスク
## 概要
トレースの検索・閲覧用 CLI コマンドを追加する。

## 変更対象
- skills/cmux-team/manager/main.ts

## サブコマンド

### cmux-team trace --task 042 --role impl
メタデータフィルタでトレース一覧を表示。

出力例:
```
#  Timestamp            Task  Role  Session              Duration  Tokens
1  2026-03-29T14:30:00  042   impl  e0f0f276...          3535ms    23
2  2026-03-29T14:30:04  042   impl  e0f0f276...          2100ms    156
```

### cmux-team trace --search "OAuth"
FTS5 全文検索でトレースを検索。

### cmux-team trace --show {id}
個別トレースの詳細表示（リクエスト/レスポンス本文含む）。glow がインストールされていれば glow でレンダリング。

### cmux-team trace --stats
タスク別・ロール別のトークン数・コスト・リクエスト数の集計。

## 関連
- Issue #15
- タスク 018（trace-store を使用）
