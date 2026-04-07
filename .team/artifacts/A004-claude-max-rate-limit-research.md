---
id: A004
type: research
title: "Claude Max レート制限・トークン残量測定の調査"
created: 2026-04-07T12:00:00+09:00
author: master
tags: [rate-limit, claude-max, dashboard, proxy]
---

# Claude Max レート制限・トークン残量測定

## 制限の仕組み

Claude Max のレート制限は **2つのローリングウィンドウ** で管理される:

### 5時間ローリングウィンドウ（バースト制限）
- 5時間の滑動窓内での使用量上限
- 推定値（サードパーティ検証）:
  - Max 5x: ~225メッセージ / 5時間
  - Max 20x: ~900メッセージ / 5時間
- 未使用分は繰り越されない

### 7日間ウィークリーキャップ（持続使用制限）
- 「アクティブコンピュート時間」で計測
- 推定値:
  - Max 5x: Sonnet 140-280h / Opus 15-35h（週）
  - Max 20x: Sonnet 240-480h / Opus 24-40h（週）

### ピーク時間の制限強化（2026年3月〜）
- 平日 5:00-11:00 AM PT の間、クォータ消費が加速

**注意:** Anthropic は具体的な上限値を公式に開示していない。上記は全てサードパーティ推定値。

## API レスポンスヘッダー（実装のキー）

Claude Max サブスクリプションでは `anthropic-ratelimit-unified-*` ヘッダーが返される:

```
anthropic-ratelimit-unified-status: "allowed" | "rate_limited"
anthropic-ratelimit-unified-representative-claim: "five_hour" | "7d"
anthropic-ratelimit-unified-5h-utilization: 0.018    # 5h窓の使用率 (0.0-1.0)
anthropic-ratelimit-unified-5h-reset: <unix_timestamp>
anthropic-ratelimit-unified-7d-utilization: 0.737    # 7d窓の使用率 (0.0-1.0)
anthropic-ratelimit-unified-7d-reset: <unix_timestamp>
```

**これが cmux-team の proxy.ts で取得可能。** 現在の `extractRateLimit()` は標準ヘッダー（`anthropic-ratelimit-tokens-*`）のみ見ているが、`unified-*` ヘッダーを追加で読み取れば 5h/7d の使用率をダッシュボードに表示できる。

## 既存の proxy.ts との統合方針

1. `proxy.ts` の `extractRateLimit()` を拡張し `unified-*` ヘッダーも取得
2. `schema.ts` の `RateLimitInfo` に `unified5hUtilization`, `unified7dUtilization`, `unified5hReset`, `unified7dReset` を追加
3. `dashboard.tsx` のヘッダー部分で 5h/7d プログレスバーを表示

## Claude Code 組み込み機能

| コマンド | 用途 | Max ユーザーへの有用性 |
|---------|------|---------------------|
| `/cost` | API トークン使用量と費用表示 | トークン消費量の参考程度 |
| `/usage` | クォータ残量・リセット時刻 | **最も有用** — 5h/7d 残量表示 |
| `/context` | コンテキストウィンドウ使用量 | セッション内トークン確認 |

ステータスラインでのプランクォータ表示は未実装（GitHub Issue #27915 でリクエスト中）。

## サードパーティツール

### ccusage
- https://github.com/ryoppippi/ccusage
- ローカル JSONL ログからトークン使用量分析
- `npx ccusage@latest daily` で即利用可能

### Claude-Code-Usage-Monitor
- https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor
- リアルタイムターミナルモニタリング
- P90 分析で実際の上限を推定

## cmux-team での実装案

1. **proxy.ts でヘッダー収集**: `unified-*` ヘッダーを読み取り state に反映
2. **ダッシュボード表示**: TPM の代わりに `5h: 18% ████████░░` `7d: 74% ███████░░░` のようなバーを表示
3. **自動スロットリング**: `5h-utilization` が閾値超過時に同時 Agent 数を自動削減
4. **モデル切替**: クォータ残量が少ない場合 Opus → Sonnet → Haiku への自動フォールバック

## 情報源

- [Rate limits - Claude API Docs](https://platform.claude.com/docs/en/api/rate-limits)
- [Claude Max Plan Explained - IntuitionLabs](https://intuitionlabs.ai/articles/claude-max-plan-pricing-usage-limits)
- [Claude Code Limits Guide - TrueFoundry](https://www.truefoundry.com/blog/claude-code-limits-explained)
- [Expose rate-limit in statusLine - GitHub Issue #27915](https://github.com/anthropics/claude-code/issues/27915)
- [ccusage - GitHub](https://github.com/ryoppippi/ccusage)
- [Claude-Code-Usage-Monitor - GitHub](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)
