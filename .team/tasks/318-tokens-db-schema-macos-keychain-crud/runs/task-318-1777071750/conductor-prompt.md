# タスク割り当て

## タスク内容

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


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-318-1777071750` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-318-1777071750
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-318-1777071750/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/318-tokens-db-schema-macos-keychain-crud/runs/task-318-1777071750
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/318-tokens-db-schema-macos-keychain-crud/runs/task-318-1777071750/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
