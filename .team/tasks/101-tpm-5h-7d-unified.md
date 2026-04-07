---
id: 101
title: ダッシュボードTPMを5h/7d unified使用率表示に置換
priority: high
created_at: 2026-04-06T20:01:22.080Z
---

## タスク
## 背景

A004調査結果に基づく。Claude MaxではAPIレスポンスに `anthropic-ratelimit-unified-*` ヘッダーが返される。現在のTPM表示は Claude Max 環境で常に `--` になり無意味。

## 変更内容

### 1. proxy.ts — ヘッダー収集の拡張

`extractRateLimit()` で以下のヘッダーも読み取る:

- `anthropic-ratelimit-unified-5h-utilization` (0.0-1.0)
- `anthropic-ratelimit-unified-7d-utilization` (0.0-1.0)
- `anthropic-ratelimit-unified-5h-reset` (unix timestamp)
- `anthropic-ratelimit-unified-7d-reset` (unix timestamp)
- `anthropic-ratelimit-unified-status` (allowed/rate_limited)
- `anthropic-ratelimit-unified-representative-claim` (five_hour/7d)

### 2. schema.ts — RateLimitInfo 拡張

`RateLimitInfo` に以下を追加:
- `unified5hUtilization: number | null`
- `unified7dUtilization: number | null`
- `unified5hReset: string | null`
- `unified7dReset: string | null`
- `unifiedStatus: string | null`

### 3. dashboard.tsx — 表示の置換

現在の `TPM: --` を以下のような表示に変更:
```
5h: 18% ████████░░  7d: 74% ███████░░░
```

- unified データがある場合: 5h/7d のプログレスバーを表示
- unified データがない場合（API直接利用時）: 従来のTPM表示にフォールバック
- utilization が高い場合（>70%）は黄色、>90% は赤色

## 参考

- A004: Claude Max レート制限調査
- 現在の実装: proxy.ts:38-55, dashboard.tsx:174-185, schema.ts:133

## 対象ファイル

- skills/cmux-team/manager/proxy.ts
- skills/cmux-team/manager/schema.ts
- skills/cmux-team/manager/dashboard.tsx
