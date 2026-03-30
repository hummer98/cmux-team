---
id: 017
title: Conductor/Master 起動時に ANTHROPIC_CUSTOM_HEADERS と ANTHROPIC_BASE_URL を設定
priority: high
created_at: 2026-03-29T10:58:54.584Z
---

## タスク
## 概要
全層（Conductor/Agent/Master）が Proxy を経由するよう環境変数を設定する。

## 変更対象
- skills/cmux-team/manager/conductor.ts（2箇所: initializeConductorSlots, spawnConductor）
- skills/cmux-team/manager/master.ts（Master spawn 時）

## やること
### conductor.ts
1. initializeConductorSlots: Conductor 起動時に ANTHROPIC_BASE_URL を設定（proxy port は state から取得）
2. spawnConductor（タスク割り当て時）: ANTHROPIC_CUSTOM_HEADERS に X-Cmux-Task-Id, X-Cmux-Conductor-Id, X-Cmux-Role を設定
3. 既に削除済みの誤コメント（ANTHROPIC_BASE_URL は Claude Max 認証を無効化する）に注意 — --bare が原因であり ANTHROPIC_BASE_URL は問題ない

### master.ts
1. Master spawn 時にも ANTHROPIC_BASE_URL を設定

### spawn-agent（main.ts cmdSpawnAgent）
1. 既に proxyPort を読んで ANTHROPIC_BASE_URL を設定している（427行目）
2. ANTHROPIC_CUSTOM_HEADERS も追加する（Conductor から環境変数を継承できるか要確認）

## 検証方法
- .team/debug/dump-proxy.ts で X-Cmux-* ヘッダーが Proxy に到達することを確認（実測手順は docs/research/research-claude-code-observability.md 参照）

## 関連
- Issue #15
- タスク 016（Proxy 側のヘッダー読み取り）
