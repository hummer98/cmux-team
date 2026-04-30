---
task: T318
role: implementer
worktree: task-318-1777071750
date: 2026-04-25
---

# T318 実装結果サマリー

## 作成ファイル

| ファイル | 行数 | 役割 |
|---|---:|---|
| `skills/cmux-team/manager/token-store.ts` | 649 | `~/.cmux-team/tokens.db` 初期化・3 テーブル CRUD・macOS Keychain 連携・pool_capacity 計算 |
| `skills/cmux-team/manager/token-store.test.ts` | 889 | ユニットテスト (bun:test)。plan.md §9 網羅 + A019 検証表 6 ケース |
| **合計** | **1538** | |

既存ファイルは 1 行も変更していません (`git status` で確認)。

## テスト結果

### `bun test skills/cmux-team/manager/token-store.test.ts`

```
 57 pass
 1 skip
 0 fail
 108 expect() calls
Ran 58 tests across 1 file. [997.00ms]
```

- **57 pass**: initTokenDB (7) / insertToken+getTokenBy* (10) / upsertUsageSnapshot (5) / leases (8) / Keychain in-memory (6) / Keychain macOS 実機 (6) / computePoolCapacity (15)
- **1 skip**: 「Keychain (unsupported platform guard)」の 1 ケース — 現環境が macOS のため `skipIf(!shouldRun)` で正しく skip
- **0 fail**

### `bunx tsc --noEmit` (skills/cmux-team/manager)

```
exit code: 0
```

型エラー 0 件。新規 export 型 (Token / UsageSnapshot / Lease / TokenForCapacity / PoolCapacityResult / TokenPlan / CredentialSource / InitTokenDBOptions / InsertTokenInput / KeychainUnsupportedError / KeychainNotFoundError / KeychainCommandError) が全て解決。

### `bun test --timeout 60000` (全体 regression)

```
 1295 pass
 1 skip
 0 fail
 3128 expect() calls
Ran 1296 tests across 43 files. [53.42s]
```

- 新規追加 58 テスト込みで全体 0 fail を維持
- 既存テスト (1237 件) に影響なし

## 規模

- 追加行数: +1538
- 変更行数: 0
- 削除行数: 0
- 既存ファイル変更: なし

## plan.md 乖離点

**乖離なし。**

plan.md §3 / §4 / §5 / §6 / §7 / §8 / §10 の指示に完全準拠:

- §3 (モジュール構成): export 一覧と型定義を完全一致で実装 (`initTokenDB` / `insertToken` / `getTokenByOrganizationId` / `getTokenByHandle` / `listTokens` / `upsertUsageSnapshot` / `getLatestUsageSnapshot` / `acquireLease` / `releaseLease` / `expireLeases` / `listActiveLeases` / `isKeychainSupported` / `storeTokenInKeychain` / `retrieveTokenFromKeychain` / `deleteTokenFromKeychain` / `computePoolCapacity` / `REFERENCE_FLOW`)
- §4 (DB 初期化フロー): 10 ステップ通りに実装 (mkdir 0700 / 新規判定 / chmod 0600 / WAL / FK / SCHEMA / ensureXxxColumns)
- §5.1 (v1 スキーマ): DDL 完全一致。`usage_snapshots.token_id UNIQUE` / `leases` に `UNIQUE(token_id)` + `PRIMARY KEY(token_id, holder)` を両方維持
- §5.2 (ensureXxxColumns パターン): `PRAGMA table_info` ベース migration を 3 テーブル全てに設置。v1 では required が空だが将来の列追加フックとして存在
- §6.2 (upsertUsageSnapshot): `ON CONFLICT(token_id) DO UPDATE SET ...` で 1 行保持方針を採用 (案 A)。`recorded_at` は関数内で `new Date().toISOString()` 付与
- §6.3 (acquireLease): **案 c (`INSERT OR IGNORE`)** を採用。BEGIN IMMEDIATE 手動制御は不要。`UNIQUE(token_id)` で atomic 性をスキーマ層に表現
- §7 (Keychain): `spawnSync` 配列渡しで shell 非経由、macOS 限定分岐、`KEYCHAIN_TEST_MODE=1` で in-memory Map fallback
- §7.3 (security コマンド): 試行 A (`-w` 無指定 + stdin) ではなく **試行 B (`-w <token>` args 渡し)** を採用
  - 理由: `-U` と `-w` 無指定の併用動作が macOS バージョン依存で不安定 (`man security` では `-w` に値が必要と読める)。args 配列渡しは shell を介さないため metacharacter 耐性は確保される。トークン値が短時間 `ps` 上に見える点は **R3 の token マスク** (下記) で Error オブジェクトに残さないことで緩和
- §8.3 (A019 検証表の疑義): **plan.md の指示通り「式を正」** として ケース 1=100% / ケース 3=~50% / ケース 4=~50% を期待値としてテスト化。コメントで A019 表と不整合である旨を明記
- §10 (TDD 手順): 1→10 の順序で Red→Green を確認しながら実装

## review.md 推奨改善事項 (R1-R3) の取り込み状況

| # | 改善事項 | 取り込み | 備考 |
|---|---|---|---|
| **R1** | `KEYCHAIN_TEST_MODE=1` 時の `isKeychainSupported()` 整合性 | 取り込まず (plan.md 案 (b) 維持) | plan.md の既定動作「test-mode では `isKeychainSupported() === false`」を維持。後続タスクで pool 統合テストが必要になったら再検討 |
| **R2** | `KeychainNotFoundError` 型追加 | **採用** | `retrieveTokenFromKeychain` は not-found を `KeychainNotFoundError` で throw。`instanceof` 判別可能。テストも `toThrow(KeychainNotFoundError)` で検証 |
| **R3** | `KeychainCommandError` の stdout/stderr に token が混入しない保証 | **採用** (部分) | `storeTokenInKeychain` のエラー経路で `maskToken()` ヘルパで `stdout` / `stderr` 内の token 文字列を `***` に置換してから `KeychainCommandError` に詰める。`retrieveTokenFromKeychain` / `deleteTokenFromKeychain` は token 値を引数に取らないため対象外 |
| R4 | A019 検証表 数値不整合の扱い | plan.md 指示通り処理済み (§8.3) | テストコメントに不整合の旨を記録 |
| R5 | `leases` PK + UNIQUE の冗長性 | 取り込まず (plan.md 判断維持) | `PRIMARY KEY (token_id, holder)` + `UNIQUE(token_id)` を両方維持。plan.md の「冗長な保険」としての意図を尊重 |

## Master 報告事項

### A019 §pool_capacity 検証表との数値不整合

plan.md §8.3 / 付録で詳述されている通り、A019 §pool_capacity §ユーザー例での検証の 6 ケースのうち **ケース 1 / 3 / 4 が式 (`min(flow_5h, flow_7d)`) と一致しません**:

| # | A019 表 | 式基準 (実装) |
|---|---|---|
| 1 (x20 満タン reset 5h) | 672% | **100%** |
| 3 (x20 10% 残 reset 30min) | 336% | **~50%** |
| 4 (x20 10% 残 reset 3h) | 112% | **~50%** |

他 3 ケース (2, 5, 6) は一致。

**実装は式を正として Green。** どちらを正とするかの最終判断は Master に委ねます:

- **A**: 式が正 → A019 §pool_capacity §検証表の数値を修正する (後続 artifact 更新タスクを起票)
- **B**: 表が正 → 式を「5h window 優先」「5h に余裕があれば min を取らない」などに変更する

現状は A 採用でテスト Green のため、後続タスク (T319 以降) では本実装の式が前提になります。

## 完了条件チェック

| # | 条件 | 状態 |
|---|---|---|
| 1 | `skills/cmux-team/manager/token-store.ts` が plan.md の export 仕様を満たして実装されている | ✅ |
| 2 | `skills/cmux-team/manager/token-store.test.ts` が plan.md §9 のテスト計画を満たして実装されている | ✅ |
| 3 | `bun test skills/cmux-team/manager/token-store.test.ts` が 0 fail で通る | ✅ 57 pass / 1 skip / 0 fail |
| 4 | `bunx tsc --noEmit` が新規エラー 0 件 | ✅ exit 0 |
| 5 | `bun test --timeout 60000`(全体) で既存テストの regression が無い | ✅ 1295 pass / 1 skip / 0 fail |
| 6 | `impl-result.md` が書き出されている | ✅ 本ファイル |

全完了条件を満たしました。以降の commit / push は Conductor が担当します。
