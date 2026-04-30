---
id: 322
title: token pool 機能 OFF 設定の 3 階層実装
priority: medium
created_at: 2026-04-24T22:42:03.278Z
---

## タスク
## 概要

token pool 機能の有効/無効を 3 階層（env / project / global）で制御できるようにする。

依存: T321（spawn-agent selection ロジック）

## 優先順位（高 → 低）

1. **環境変数** `CMUX_TEAM_TOKEN_POOL=0` — 最優先、CI や一時的な無効化に使う
2. **プロジェクト設定** `.team/config.json` の `token_pool.enabled: false`
3. **グローバル設定** `~/.cmux-team/config.yaml` の `token_pool.enabled: true`
4. 未指定時は **false（opt-in）**

## 実装内容

- `isTokenPoolEnabled(projectRoot: string): boolean` 関数を実装
  - 上記の優先順位で評価して boolean を返す
- `cmdSpawnAgent` の冒頭で `isTokenPoolEnabled()` を呼び、false なら selection をスキップ
- `cmux-team start` の初期化ログに pool の有効/無効を出力

## 検証

- `CMUX_TEAM_TOKEN_POOL=0` で無効になること
- `.team/config.json: { "token_pool": { "enabled": false } }` で無効になること
- `~/.cmux-team/config.yaml: token_pool: { enabled: true }` + 他設定なし で有効になること
- 未設定時は無効（env 継承 fallback と同じ挙動）になること
