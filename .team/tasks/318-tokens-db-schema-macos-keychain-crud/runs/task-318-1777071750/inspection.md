---
task: T318
inspector: surface:89 (inspector)
target: skills/cmux-team/manager/token-store.{ts,test.ts}
date: 2026-04-25
---

# Inspection: T318

## 総合判定

**GO**

新規 2 ファイル（`token-store.ts` / `token-store.test.ts`）のみで完結。plan.md §3-§10 と A019 DDL への適合性は完全、静的検証・全体 regression ともに 0 fail、セキュリティ要件（0600 / shell-injection / token マスク）を満たす。R2 (`KeychainNotFoundError`) は取り込まれ、R3 (token マスク) も store 経路で実装済み。R1 / R5 は plan.md の既定判断を維持。

## 静的検証結果

| コマンド | 結果 |
|---|---|
| `bun test skills/cmux-team/manager/token-store.test.ts` | **57 pass / 1 skip / 0 fail** (108 expect calls, 964 ms)。skip は非 macOS 用「unsupported platform guard」で現環境 darwin のため `skipIf` で正しく除外 |
| `bunx tsc --noEmit` (`skills/cmux-team/manager/tsconfig.json` から実行) | **exit 0 / 新規エラー 0 件**。impl-result.md §tsc 欄と一致。worktree ルート直下には tsconfig.json がないため、manager 配下で走らせるのが既存パターン |
| `bun test --timeout 60000` (全体) | **1295 pass / 1 skip / 0 fail** (3128 expect calls, 43 files, 53.51 s)。新規 58 件を加えた上で既存 1237 件に regression なし |

## 観点別判定

| # | 観点 | 判定 | 詳細 |
|---|------|------|-----|
| 1 | 静的検証 | OK | token-store / tsc / 全体テスト すべて 0 fail。impl-result.md の数値と一致を再現確認 |
| 2 | plan.md 適合性 | OK | 以下に分解して記載 |
| 3 | セキュリティ | OK | 0600 + shell=false + token マスクで主要 3 観点を網羅 |
| 4 | スコープ厳守 | OK | `git status --short` は `?? token-store.ts` と `?? token-store.test.ts` の 2 行のみ |
| 5 | テスト品質 | OK | 6 ケース / 0600 / 競合 race / UNIQUE 違反 / Keychain 実機 + in-memory すべて網羅 |
| 6 | コード品質 | OK | 単一責務、エラー型は plan + R2 に準拠、コメントは WHY 中心 |

### 観点 2 — plan.md §x 毎の適合性

| §  | 内容 | 判定 | 根拠 |
|---|---|---|---|
| §3 | export 一覧 | OK | `initTokenDB` / `insertToken` / `getTokenByOrganizationId` / `getTokenByHandle` / `listTokens` / `upsertUsageSnapshot` / `getLatestUsageSnapshot` / `acquireLease` / `releaseLease` / `expireLeases` / `listActiveLeases` / `isKeychainSupported` / `storeTokenInKeychain` / `retrieveTokenFromKeychain` / `deleteTokenFromKeychain` / `computePoolCapacity` / `REFERENCE_FLOW` / 型群 / 3 エラー型 すべて定義確認 (token-store.ts:9-650) |
| §4 | DB 初期化フロー 10 ステップ | OK | `resolveDbPath` → `mkdirSync(0o700)` → `existsSync`→`new Database` → `chmodSync(0o600)` → WAL → FK → SCHEMA_V1 → `ensureXxxColumns` × 3 (token-store.ts:148-224)。chmod 失敗は `console.warn` で緩和 |
| §5.1 | v1 DDL (3 テーブル + INDEX) | OK | A019 DDL に対し `UNIQUE(token_id)`（usage_snapshots / leases）と `AUTOINCREMENT` を plan.md §5.1/§6.2/§6.3 通りに追加 (token-store.ts:110-146) |
| §5.2 | `ensureXxxColumns` パターン | OK | 3 テーブルすべてに `PRAGMA table_info` ベース migration フック設置、v1 で required は空 (token-store.ts:182-224) |
| §6.1 | `insertToken` | OK | JSON.stringify(tags) / selectable 0-1 / `new Date().toISOString()` / `lastInsertRowid` で SELECT → `rowToToken` (token-store.ts:276-306) |
| §6.2 | `upsertUsageSnapshot` (案 A) | OK | `ON CONFLICT(token_id) DO UPDATE SET` で 1 行保持。`recorded_at` は関数内で付与 (token-store.ts:351-393) |
| §6.3 | `acquireLease` (案 c: `INSERT OR IGNORE`) | OK | 前置 DELETE → `INSERT OR IGNORE` → `changes===0` で null 返却。スキーマの `UNIQUE(token_id)` で atomic 性を表現 (token-store.ts:418-440)。`Promise.all(10)` テストで並行時に 1 件のみ成功を実証 |
| §7 | Keychain (macOS 限定 + `KEYCHAIN_TEST_MODE`) | OK | `useInMemory()` で in-memory Map 切替、非 macOS 非 test-mode で `KeychainUnsupportedError` throw、`spawnSync` は常に args 配列で shell=false (token-store.ts:471-573)。試行 B (`-w token`) を選択した点は後述 |
| §8 | `computePoolCapacity` | OK | `remaining × plan_ratio / hours` / `Math.min(candidates)` / `reference = 20/168` / 過去 reset skip / `MIN_HOURS` clamp / 両 window null はフル 7d fallback (token-store.ts:579-627)。A019 検証 6 ケースは **plan.md §8.3「式を正」**のとおりケース 1/3/4 を 100%/~50%/~50% で実装・テスト |

### 観点 3 — セキュリティ詳細

| 項目 | 判定 | 根拠 |
|---|---|---|
| DB ファイル 0600 | OK | 新規作成フラグ時のみ `chmodSync(dbPath, 0o600)` (token-store.ts:160-168)。テストで `__statMode(dbPath) === 0o600` を検証 (token-store.test.ts:86-91) |
| ディレクトリ 0700 | OK | `mkdirSync(dirPath, { recursive: true, mode: 0o700 })` (token-store.ts:158)。WAL の `-wal` / `-shm` は親 0700 で防御 (plan.md §4 方針と一致) |
| shell injection 対策 | OK | 全 Keychain 呼び出しが `spawnSync("security", [ ... ], { stdio: [...] })` で shell オプションなし = 既定 `shell: false`。macOS 実機テストで `@cmux-team-test-<pid>-meta;rm` のような semicolon 入り handle で round-trip 検証 (token-store.test.ts:599-607) |
| token ログ漏洩対策 | OK | `storeTokenInKeychain` の失敗パスで `maskToken(out, token_string).split(token).join("***")` を stdout/stderr に適用してから `KeychainCommandError` に詰める (token-store.ts:482-518)。`retrieveTokenFromKeychain` / `deleteTokenFromKeychain` は token 値を引数に取らないため漏洩経路なし |
| Error メッセージへの token 混入 | OK | `KeychainNotFoundError` / `KeychainUnsupportedError` は token を保持しない。`KeychainCommandError` は store 経路でマスク済み |

### 観点 4 — スコープ厳守

```
$ git status --short
?? skills/cmux-team/manager/token-store.test.ts
?? skills/cmux-team/manager/token-store.ts
```

既存ファイルへの変更は 0。新規 2 ファイルのみ。

### 観点 5 — テスト品質

| チェック項目 | 判定 | 該当テスト |
|---|---|---|
| pool_capacity 6 ケース | OK | ケース 1-6 が個別テストとして存在 (token-store.test.ts:680-788)、期待値は plan.md §8.3 の「式基準」に従いコメントで A019 表との不整合を明記 |
| DB 権限 0600 (`fs.statSync().mode`) | OK | token-store.test.ts:86-91 |
| Keychain in-memory / macOS 実機 切替 | OK | `KEYCHAIN_TEST_MODE=1` suite (token-store.test.ts:506-551) と `process.platform === "darwin"` 実機 suite (556-640) が `beforeAll` で env 切替 |
| lease 競合テスト (同時 acquire 1 件成功) | OK | token-store.test.ts:478-487 で `Promise.all(10)` → successes.length === 1 |
| UNIQUE 制約違反テスト | OK | handle 重複 (token-store.test.ts:231-242) / organization_id 重複 (244-255) を個別に throw 検証 |
| 追加網羅 | OK | FK 違反 UPSERT throw / 過去 reset フル 7d 扱い / MIN_HOURS clamp (1 秒後 reset) / plan_ratio null 除外 など plan.md §9.3 の全項目をカバー |

### 観点 6 — コード品質

| 項目 | 判定 | 根拠 |
|---|---|---|
| 関数責務の単一性 | OK | initTokenDB（init のみ）/ CRUD 関数（row → Token 変換まで）/ Keychain 関数（in-memory と spawnSync のみ）/ `computePoolCapacity`（純粋関数）がきれいに分離 |
| エラー型の準拠 | OK | `KeychainUnsupportedError` / `KeychainCommandError` (plan.md §3) + `KeychainNotFoundError` (review.md R2) |
| コメントのノイズ | OK | 主要コメントは WHY（atomic 前置 DELETE の理由 / 親ディレクトリ 0700 の防御線 / MIN_HOURS clamp の意味 / A019 表との不整合）中心。「task T318 の実装」「handle を保存する」などの WHAT 系コメントは検出されない |
| review.md R1-R3 取り込み | OK | R1 = 非採用 (plan.md 既定 (b) 維持、判断妥当) / **R2 = 採用** / **R3 = 部分採用** (store 経路で `maskToken`、retrieve/delete は token を引数に取らないため対象外) |

## Critical findings

なし（GO のため）。

## Recommendations（任意）

### Rec1. plan.md §7.3「試行 A 最優先」からの乖離を後続タスクで再検討

`storeTokenInKeychain` は plan.md §7.3 の「試行 A（`-w` 無指定 + stdin）を最優先」ではなく「試行 B（`-w <token>` args 渡し）」を選択している。impl-result.md §7.3 に「`-U` と `-w` 無指定の併用動作が macOS バージョン依存で不安定」という選択理由が明示されており、plan.md 自身が「動かなければ B にフォールバック」を許容しているため今回は OK。ただし argv は macOS 既定で他ユーザーにも見えるため、後続タスクで試行 C（ファイル経由）や別ツール（`/usr/libexec/security` の stdin 対応版など）を評価する余地あり。R3 の token マスクで Error オブジェクト側の漏洩は防げているので現状のリスクは短時間 `ps` 露出のみ。

### Rec2. `upsert` の戻り値型が `UsageSnapshot` なのに内部で `UsageSnapshotRow` を直接 return

`upsertUsageSnapshot` (token-store.ts:386-392) と `getLatestUsageSnapshot` (398-404) は `UsageSnapshotRow` を直接返している。`UsageSnapshotRow` は `UsageSnapshot` と構造的に互換なので tsc は通るが、`Token` の rowToToken のように変換レイヤを挟むほうが「DB 表現 / ドメイン表現」の分離が揃う。現状でも仕様上問題なし。機能追加ではないので任意。

### Rec3. Master への A019 検証表の確定報告（既に impl-result.md §Master 報告事項に予約済み）

plan.md §8.3 / impl-result.md §Master 報告事項の通り、A019 §pool_capacity 検証表のケース 1/3/4（672% / 336% / 112%）は `min(flow_5h, flow_7d)` 式と不整合。実装・テストは **式を正**として Green。最終判断は Master が A（A019 表を修正）か B（式を「5h 余裕あり時は min を取らない」などに変更）かを決める必要あり。Inspector 視点としては、plan が `min(flow_5h, flow_7d)` を「悲観寄り・安全寄り」と明言しており、構造的に整合している A が妥当と見立てる。

## 完了

検品完了。本 inspection.md 以外のファイル変更なし。Conductor に引き継ぎ可能。
