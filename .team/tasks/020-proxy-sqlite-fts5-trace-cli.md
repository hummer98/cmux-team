---
id: 020
title: トレーサビリティ基盤: Proxy 本文記録 + メタデータ伝播 + SQLite FTS5 + trace CLI
priority: high
created_at: 2026-03-29T11:00:14.902Z
---

## タスク
## 概要
エージェントの API 通信をメタデータ付きで記録し、事後検索可能にする。全体で ~215 行の追加。

## 背景
- Issue #15: エージェント行動トレーサビリティ基盤の構築
- 調査レポート: docs/research/research-claude-code-observability.md
- 実測確認済み: ANTHROPIC_CUSTOM_HEADERS でカスタムヘッダーが Proxy に到達する
- 実測確認済み: x-claude-code-session-id がヘッダーに含まれる

## 変更内容

### 1. proxy.ts 拡張 (~60行)
- リクエストヘッダーから X-Cmux-Task-Id, X-Cmux-Conductor-Id, X-Cmux-Role, x-claude-code-session-id を抽出（opts の固定値ではなくリクエストごと）
- リクエスト本文を .team/logs/traces/bodies/ に保存（reqBody は既に読んでいる 85行目）
- レスポンス本文を drainAndLog 内でバッファし保存（streaming tee は既存）
- trace-store に登録

### 2. conductor.ts 環境変数追加 (~5行)
- initializeConductorSlots と spawnConductor の 2箇所:
  - ANTHROPIC_BASE_URL=http://127.0.0.1:${proxyPort}
  - ANTHROPIC_CUSTOM_HEADERS="X-Cmux-Task-Id: ${taskId}\\nX-Cmux-Conductor-Id: ${conductorId}\\nX-Cmux-Role: ${role}"
- master.ts にも ANTHROPIC_BASE_URL を追加
- 注意: --bare が Claude Max 認証に影響する原因であり、ANTHROPIC_BASE_URL は問題ない

### 3. trace-store.ts 新規作成 (~100行)
- Bun 内蔵 SQLite（bun:sqlite）で依存ゼロ
- DB: .team/traces/traces.db
- テーブル: traces（メタデータ）+ traces_fts（FTS5 全文検索）
- 関数: initDB, insertTrace, searchTraces, getTrace

### 4. main.ts に trace CLI コマンド追加 (~50行)
- cmux-team trace --task 042 --role impl（メタデータフィルタ）
- cmux-team trace --search "OAuth"（FTS5 全文検索）
- cmux-team trace --show {id}（詳細表示）

## 検証方法
- .team/debug/dump-proxy.ts で X-Cmux-* ヘッダーの到達を確認
- cmux-team start → タスク実行 → cmux-team trace --task {id} で記録を確認
