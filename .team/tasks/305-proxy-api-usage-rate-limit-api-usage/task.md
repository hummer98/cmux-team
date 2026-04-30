---
id: 305
title: proxy で API usage + rate limit を抽出し api_usage テーブルに記録
priority: high
depends_on: [304]
created_by: surface:629
created_at: 2026-04-23T18:06:22.618Z
---

## タスク
## 背景

T304 で Master / Conductor / Agent の role ヘッダーが全て埋まる前提で、token 消費観測機能の**基盤**を作る。現状 proxy は JSONL に `request_bytes` / `response_bytes` のバイト数のみ記録しており、Anthropic API レスポンスの `usage` フィールド（input_tokens / output_tokens / cache_creation_input_tokens / cache_read_input_tokens）は完全に破棄されている。

トークン消費をタスク別・ロール別・時系列に追跡するには、これらを構造化テーブルに永続化する必要がある。また burn-rate 可視化のために rate limit ヘッダーも同時に捕まえる。

## ゴール

- 新規 SQLite テーブル `api_usage` を trace DB に追加
- proxy が Anthropic API レスポンスから usage と rate limit ヘッダーを抽出し、全リクエストで INSERT する
- task_id / role / surface / conductor_id がヘッダーから解決できた場合は埋める。不明な場合は NULL（リクエスト自体は記録）
- 既存挙動（レスポンス転送、JSONL 記録）は変更しない

## api_usage テーブル（案 — 最終形は実装側で判断）

| カラム | 説明 |
|---|---|
| `id` | PK |
| `timestamp` | ISO 8601（時系列ソート用） |
| `task_id` | ヘッダー `x-cmux-task-id` 由来、NULL 可 |
| `role` | master / conductor / agent / unknown |
| `surface` | ヘッダー `x-cmux-conductor-surface` 由来 |
| `conductor_id` | ヘッダー `x-cmux-conductor-id` 由来 |
| `model` | レスポンスの `model` フィールド |
| `input_tokens` | `usage.input_tokens` |
| `output_tokens` | `usage.output_tokens` |
| `cache_creation_input_tokens` | キャッシュ書き込み |
| `cache_read_input_tokens` | キャッシュ読み込み |
| `duration_ms` | レスポンス時間 |
| `request_id` | `anthropic-request-id` ヘッダー |
| `ratelimit_tokens_remaining` | `anthropic-ratelimit-tokens-remaining` |
| `ratelimit_tokens_limit` | `anthropic-ratelimit-tokens-limit` |
| `ratelimit_tokens_reset` | `anthropic-ratelimit-tokens-reset`（ISO 8601） |
| `ratelimit_requests_remaining` | `anthropic-ratelimit-requests-remaining` |
| `ratelimit_requests_limit` | `anthropic-ratelimit-requests-limit` |
| `ratelimit_requests_reset` | `anthropic-ratelimit-requests-reset` |
| `stop_reason` | `stop_reason` フィールド |
| `error` | 非 2xx 時のエラー種別（`status_code` 等） |

※ input-tokens / output-tokens の dedicated rate limit ヘッダーも Anthropic が提供していれば同様に記録する（実装時確認）。

## 調査スコープ

- `skills/cmux-team/manager/proxy.ts`:
  - 非ストリームレスポンスの body parse（`/v1/messages` のみ対象）
  - SSE レスポンス対応: `message_start` / `message_delta` / `message_stop` イベントを tee して usage を集約する必要がある。**パフォーマンスを落とさない実装**（body 丸ごとバッファせず行単位で tee）
  - エラーレスポンス（4xx / 5xx）でも INSERT（error 列で記録）
- `skills/cmux-team/manager/trace-store.ts`:
  - 既存の migration / schema パターンに従って `api_usage` を追加
  - `hook_signals` と同じく自動 GC は実装しない（手動 DELETE で OK、CLAUDE.md にも運用注記追加）

## Out of scope

- 集計・可視化（T306 / T307 で扱う）
- 既存 JSONL の廃止・置き換え（当面並存）

## 検証方法

- cmux-team start → Master / Conductor で適当に作業 → `sqlite3 .team/traces/traces.db "SELECT role, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_input_tokens) FROM api_usage GROUP BY role"` で各 role の消費が記録されていること
- ストリームレスポンスでも usage が正しく取れること（`message_delta.usage.output_tokens` の最終値が SUM されること）
- bun test が通ること（既存 proxy テストに usage 抽出ケースを追加）
- tsc --noEmit の新規エラー 0 件

## 参考

- 調査報告（先行会話）: proxy.ts:350-352 でヘッダー抽出、proxy.ts:441 で response_bytes 計測、body parse 未実施
- Anthropic rate limit ヘッダー仕様: https://docs.anthropic.com/en/api/rate-limits
