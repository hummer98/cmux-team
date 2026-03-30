---
id: 016
title: Proxy: X-Cmux-* ヘッダー読み取り + リクエスト/レスポンス本文記録
priority: high
created_at: 2026-03-29T10:58:41.517Z
---

## タスク
## 概要
proxy.ts を拡張し、エージェントの API 通信をメタデータ付きで完全記録する。

## 変更対象
- skills/cmux-team/manager/proxy.ts

## やること
1. リクエストヘッダーから X-Cmux-Task-Id, X-Cmux-Conductor-Id, X-Cmux-Role, x-claude-code-session-id を抽出
2. TraceEntry にこれらのメタデータを記録（opts の固定値ではなくリクエストごとに取得）
3. リクエスト本文（reqBody）を .team/logs/traces/bodies/ に保存
4. レスポンス本文を drainAndLog 内でバッファし保存（streaming 対応）
5. trace-store（次タスク）に登録する呼び出しを追加

## 保存先
- .team/logs/traces/api-trace.jsonl（メタデータ、既存形式を拡張）
- .team/logs/traces/bodies/{timestamp}_{session_id}_{seq}.req.json
- .team/logs/traces/bodies/{timestamp}_{session_id}_{seq}.res.json

## 注意
- レスポンスの streaming (tee) は既に実装済み。バイト数だけカウントして捨てている部分を本文保持に変更
- reqBody は既に arrayBuffer として読んでいる（85行目）。記録するだけ
- 参考: .team/debug/dump-proxy.ts（実測で動作確認済みのダンプ実装）

## 関連
- Issue #15: エージェント行動トレーサビリティ基盤の構築
- docs/research/research-claude-code-observability.md
