---
id: 320
title: proxy: tokens.db throttled UPSERT + auto-discover
priority: high
created_at: 2026-04-24T22:41:33.478Z
---

## タスク
## 概要

proxy.ts が Anthropic API レスポンスを受け取った際に、`~/.cmux-team/tokens.db` の `usage_snapshots` を throttled UPSERT する。
また、未登録アカウントを検出した場合は auto-discover 登録を行う。

依存: tokens.db schema + Keychain + CRUD ライブラリ（T318）

## 設計根拠

`.team/artifacts/A019-token-pool-design.md` / `A020-token-pool-probe.md` 参照。

## 実装内容

### 1. auth_hash の算出

- `proxy.ts` の fetch 呼び出し直前（`proxy.ts:425-439` 付近）で Authorization header を取得
- `sha256("Bearer " + token)` を計算し 12 文字 prefix を auth_hash として保持
- この auth_hash をリクエスト処理の context に持ち回す

### 2. usage_snapshots への throttled UPSERT

既存の `api_usage` INSERT とは別に、以下の条件でのみ `tokens.db` を更新（書き込み頻度を抑制）:
- `util_5h` または `util_7d` が前回値から 1pt（0.01）以上変化した場合
- `reset_5h_at` または `reset_7d_at` が変化した場合
- `unified_status` が変化した場合

既存の `.team/traces/traces.db` への api_usage INSERT は**変更しない**。

### 3. auto-discover

`auth_hash` が tokens.db に存在しない場合:
- `anthropic-organization-id` レスポンスヘッダーを取得
- tokens.db に INSERT:
  - `handle` = organization_id 先頭 4 文字（衝突時は 5, 6 文字と伸長）
  - `selectable = 0`, `tags = ["auto"]`, `plan = "unknown"`, `credential_source = "auto-discover"`
- 実 token は Keychain に**登録しない**（selectable=0 なので spawn には使われない）

### 4. tokens.db への接続管理

複数 cmux-team プロジェクトが同時に書き込む可能性があるため WAL モードを確認。
単一プロセス内では DB ハンドルを singleton として保持。

### 配置

- `skills/cmux-team/manager/proxy.ts`（既存ファイルへの追加）
- token-store.ts の CRUD 関数を呼び出す

## 検証

- Agent 実行後に `~/.cmux-team/tokens.db` の `usage_snapshots` に行が増えること
- utilization が変化しない場合は UPSERT されないこと（throttle が効いていること）
- auto-discover: 未登録 token で動作した場合に `selectable=0` のレコードが作成されること
- 既存の `.team/traces/traces.db` api_usage は変化しないこと
- `bun test` + `tsc --noEmit` が通ること
