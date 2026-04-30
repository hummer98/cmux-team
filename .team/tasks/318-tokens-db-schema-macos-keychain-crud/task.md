---
id: 318
title: tokens.db schema + macOS Keychain 連携 + CRUD ライブラリ
priority: high
created_at: 2026-04-24T22:40:51.677Z
---

## タスク
## 概要

グローバルトークンプール機能の基盤となる \`~/.cmux-team/tokens.db\` (SQLite + WAL) を実装する。
後続タスク（token CLI / proxy UPSERT / spawn-agent selection / TUI）が全てこのライブラリに依存するため最優先。

## 設計根拠

`.team/artifacts/A019-token-pool-design.md` / `A020-token-pool-probe.md` 参照。
GitHub issue: https://github.com/hummer98/cmux-team/issues/35

## スキーマ

```sql
CREATE TABLE tokens (
  id              INTEGER PRIMARY KEY,
  handle          TEXT NOT NULL UNIQUE,        -- @pers, @kddi (name 先頭4文字)
  organization_id TEXT NOT NULL UNIQUE,        -- anthropic-organization-id UUID（account 単位キー）
  auth_hash       TEXT NOT NULL,               -- sha256("Bearer "+token) の 12 文字 prefix
  plan            TEXT NOT NULL DEFAULT 'unknown', -- pro / max-x5 / max-x20 / unknown
  plan_ratio      REAL,                        -- 1.0 / 5.0 / 20.0 / NULL
  credential_source TEXT,                      -- claude-credentials / manual / auto-discover
  tags            TEXT NOT NULL DEFAULT '["any"]', -- JSON 配列
  selectable      INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);

CREATE TABLE usage_snapshots (
  id        INTEGER PRIMARY KEY,
  token_id  INTEGER NOT NULL REFERENCES tokens(id),
  util_5h   REAL,       -- 0.0〜1.0
  util_7d   REAL,
  reset_5h_at TEXT,
  reset_7d_at TEXT,
  unified_status TEXT,
  recorded_at TEXT NOT NULL
);

CREATE TABLE leases (
  token_id   INTEGER NOT NULL REFERENCES tokens(id),
  holder     TEXT NOT NULL,    -- cmux surface ID
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  PRIMARY KEY (token_id, holder)
);
```

## 実装内容

- `~/.cmux-team/` ディレクトリ + `tokens.db` の初期化（WAL モード、ファイル権限 0600）
- migration 機構（既存 `trace-store.ts` パターンに倣う）
- CRUD:
  - `insertToken(handle, organization_id, auth_hash, plan, plan_ratio, tags, credential_source)`
  - `getTokenByOrganizationId(organization_id)` / `getTokenByHandle(handle)`
  - `upsertUsageSnapshot(token_id, util_5h, util_7d, reset_5h_at, reset_7d_at, unified_status)`
  - `acquireLease(token_id, holder, ttl_seconds)` — BEGIN IMMEDIATE で atomic
  - `releaseLease(token_id, holder)`
  - `expireLeases()` — expires_at 過ぎたレコードを削除
- macOS Keychain 連携:
  - `storeToken(handle, token_string)` — `security add-generic-password` 相当
  - `retrieveToken(handle)` — `security find-generic-password` 相当
  - `deleteToken(handle)` — `security delete-generic-password` 相当
  - 他 OS（macOS 以外）ではこれらを no-op にし、pool 機能を自動 OFF
- pool_capacity 計算関数:
  - `computePoolCapacity(selectableTokens)` → `{ capacity_pct, per_token: [{handle, cap_pct}] }`
  - 式: `flow_i = min(remaining_5h×ratio/t_5h, remaining_7d×ratio/t_7d)` / reference = `20.0/168`

## 配置

- `skills/cmux-team/manager/token-store.ts`（新規）

## 検証

- `bun test` に token-store のユニットテスト追加
- `tsc --noEmit` エラー 0 件
- DB ファイルが 0600 で作成されること
- Keychain 登録 → 取得 → 削除が正常動作すること（macOS のみ）
- pool_capacity 計算の期待値テスト（A019 の検証表ケースを網羅）
