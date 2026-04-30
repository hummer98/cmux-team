---
task: T318
title: tokens.db schema + macOS Keychain 連携 + CRUD ライブラリ
date: 2026-04-25
worktree: task-318-1777071750
deliverable: merged (ff-only into main)
---

# T318 結果サマリー

## 完了したサブタスク

| Phase | Agent | 結果 |
|---|---|---|
| Phase 1: Plan | Planner (surface:124) | plan.md 879 行作成。11 セクション網羅、設計上の論点 11 件を結論 |
| Phase 2: Design Review | Design Reviewer (surface:127) | **APPROVED**（一発承認）。9 観点すべて OK、推奨改善 3 件は Implementer 裁量 |
| Phase 3: TDD Implementation | Implementer (surface:130) | token-store.ts (649行) + token-store.test.ts (889行) を新規作成、TDD 6 ステップ完走 |
| Phase 4: Inspection | Inspector (surface:131) | **GO**。静的検証・適合性・セキュリティ・スコープ・テスト・品質すべて OK |

## 変更ファイル

新規 2 ファイルのみ、既存ファイルへの変更なし:

| ファイル | 行数 | 役割 |
|---|---:|---|
| `skills/cmux-team/manager/token-store.ts` | 649 | `~/.cmux-team/tokens.db` 初期化・3 テーブル CRUD・Keychain 連携・pool_capacity 計算 |
| `skills/cmux-team/manager/token-store.test.ts` | 889 | bun:test ユニットテスト |
| **合計追加** | **1538** | |

## 主要 export

- 初期化: `initTokenDB()` / `closeTokenDB()` / `resetTokenStoreForTesting()`
- 型: `Token` / `UsageSnapshot` / `Lease` / `TokenForCapacity` / `PoolCapacityResult` / `TokenPlan` / `CredentialSource` / `InitTokenDBOptions` / `InsertTokenInput`
- エラー: `KeychainUnsupportedError` / `KeychainNotFoundError` / `KeychainCommandError`
- CRUD: `insertToken` / `getTokenByOrganizationId` / `getTokenByHandle` / `listTokens`
- 使用状況: `upsertUsageSnapshot` / `getLatestUsageSnapshot`
- リース: `acquireLease` / `releaseLease` / `expireLeases` / `listActiveLeases`
- Keychain: `isKeychainSupported` / `storeTokenInKeychain` / `retrieveTokenFromKeychain` / `deleteTokenFromKeychain`
- 計算: `computePoolCapacity` / `REFERENCE_FLOW`

## テスト結果

| 検証 | 結果 |
|---|---|
| `bun test skills/cmux-team/manager/token-store.test.ts` | **57 pass / 1 skip / 0 fail** (108 expect calls, ~1s) |
| `bunx tsc --noEmit` (skills/cmux-team/manager) | **exit 0**（新規エラー 0 件） |
| `bun test --timeout 60000`（全体 regression） | **1295 pass / 1 skip / 0 fail** (43 files, ~53s) |

skip 1 件は「Keychain unsupported platform guard」で macOS では `skipIf` で正しく除外されている。

## 設計上の判断点（Implementer 採用）

- DB クライアント: `bun:sqlite`（`trace-store.ts` と同じ）
- WAL モード + `PRAGMA foreign_keys=ON`
- DB ファイル権限: 0600（テストで `fs.statSync().mode` 検証）
- ディレクトリ権限: 0700（`-wal` / `-shm` ファイル防御）
- Migration: `PRAGMA table_info` ベース `ensureXxxColumns` パターン（v1 は noop）
- `acquireLease`: `INSERT OR IGNORE` + `UNIQUE(token_id)` で atomic 性をスキーマ層に表現
- `upsertUsageSnapshot`: 1 行保持（`ON CONFLICT(token_id) DO UPDATE SET`）
- Keychain: `spawnSync` 配列渡し（shell: false）。試行 B（`-w token` args 渡し）を採用 — `-U` + stdin の組み合わせが macOS バージョン依存で不安定なため
- 環境変数: `TOKEN_STORE_DB_PATH`（DB パス上書き）/ `KEYCHAIN_TEST_MODE=1`（in-memory Map fallback）
- review R2 (`KeychainNotFoundError`) を採用、R3 (token マスク) を `storeTokenInKeychain` 経路で実装

## Master 判断必要事項（残課題）

**A019 §pool_capacity 検証表の数値不整合**

plan.md §8.3 / impl-result.md / inspection.md Rec3 の通り、A019 検証表のケース 1/3/4（672% / 336% / 112%）は `flow = min(flow_5h, flow_7d)` 式と整合しない。実装・テストは plan.md の指示通り **式を正**として:

- ケース 1（x20 満タン、reset 5h）: 期待値 **100%**（A019 表 672% との不整合）
- ケース 3（x20 10% 残、reset 30min）: 期待値 **~50%**（A019 表 336% との不整合）
- ケース 4（x20 10% 残、reset 3h）: 期待値 **~50%**（A019 表 112% との不整合）

ケース 2/5/6 は数値一致。

Master は以下のいずれかを決定する必要がある:
- (A) A019 表を `min(flow_5h, flow_7d)` 式に合わせて再計算・更新する（Inspector 推奨）
- (B) 式を「5h 余裕あり時は flow_5h を flow_7d より優先する」等に変更し、A019 表に合わせる

T319 以降の TUI 表示（`pool capacity: X%`）の意味付けに影響する。

## 後続タスク

T319 / T320 / T321 / T322 / T323 が本ライブラリに依存:

- T319: `cmux-team token add|list|remove|rotate|set-plan` CLI
- T320: proxy の tokens.db throttled UPSERT（auto-discover 込み）
- T321: spawn-agent token selection（tags filter + score 最小 + lease）
- T322: 機能 OFF 設定の 3 階層実装
- T323: TUI `pool capacity` + `cmux-team pool status`

## マージ先 / 納品方式

- ベース: `main`
- 納品: ローカル ff-only マージ（個人プロジェクト、設計確定済み、レビュー APPROVED、後続が依存する基盤のため main に積む）
- マージコミット SHA: 後段で記載

## 関連アーティファクト

- `.team/artifacts/A019-token-pool-design.md` — 設計判断
- `.team/artifacts/A020-token-pool-probe.md` — 実機検証
