# Inspection — T341 implementation

## Verdict: GO

## Summary

AC1〜AC5 はすべて実コード／テストで独立検証でき、4 ファイル（`proxy.test.ts` 43, `token-cli.test.ts` 24+4skip, `token-store.test.ts` 96+1skip, `config.test.ts` 26）すべて green、`bunx tsc --noEmit` exit 0、design-review M1–M4 もすべて反映済み。Critical は 0、Major は 0、Minor は記録のみ。`package-lock.json` の差分は v4.10→v4.11 リリース commit (f4b78d6) への追従であり本タスクと無関係（worktree 起動時から存在）。

## AC Verification

| AC | 実装確認 | テスト確認 | テスト実行 | 判定 |
|----|---------|-----------|-----------|------|
| AC1 | `proxy.ts:147-152` `else if (organizationId)` 直下に `if (!tokenPoolEnabled) return` gate | `proxy.test.ts:1385-1414` T341-P1 (`listTokens(db).length === 0`) | pass | ✓ |
| AC2 | `proxy.ts:153-166` 既存 INSERT ロジックは gate 通過時のみ実行 | `proxy.test.ts:1416-1450` T341-P2 (auto-discover INSERT, selectable=0, plan='unknown') | pass | ✓ |
| AC3 | `token-cli.ts:428-560` `cmdTokenPromote` + `token-store.ts:395-421` `updateTokenPromoteFields(... selectable=1)` + `token-cli.ts:538` `storeTokenInKeychain(newHandle, ...)` | `token-cli.test.ts:699-756` R-promote-1/2 (`@kddi`/plan='max-x20'/selectable=true/Keychain) | pass | ✓ |
| AC4 | `token-store.ts:407-420` `WHERE id = ?` で id 維持の UPDATE | `token-cli.test.ts:888-920` R-promote-8 + `token-store.test.ts:1096-1132` 第 2 ケース | pass | ✓ |
| AC5 | `proxy.ts:110-146` 既知 token branch は gate より前にあり影響なし | `proxy.test.ts:1452-1500` T341-P3 (`getLatestUsageSnapshot` で util_5h/7d 確認) | pass | ✓ |

## Test Results

```
proxy.test.ts        43 pass / 0 fail / 0 skip / 157 expect()
token-cli.test.ts    24 pass / 0 fail / 4 skip / 104 expect()
token-store.test.ts  96 pass / 0 fail / 1 skip / 176 expect()
config.test.ts       26 pass / 0 fail / 0 skip /  52 expect()
```

skip は本タスク前から存在する既存項目（`token-cli.test.ts:410-596` の rotate 補償系 R1/R2/R3、`token-store.test.ts:593-656` の macOS 実機 Keychain 群）。本タスクで新規追加された skip は 0。

## TypeScript Check

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit ; echo $?
0
```

新規エラー 0 件。

## Design Review (M1-M4) Compliance

| ID | 内容 | 対応箇所 | 結果 |
|----|------|---------|------|
| M1 | `updateTokensDB` を options object 化（`{ tokenPoolEnabled, getState? }`） | `proxy.ts:92-99` signature、`proxy.ts:669-676`/`739-746` 呼び出し点 2 箇所 | ✓ |
| M2 | `plan === 'unknown'` で `set-plan` ヒントを出力 | `token-cli.ts:551-556` (R-promote-10 で検証) | ✓ |
| M3 | `newHandle === oldHandle` で「handle は変わりません」info ログ | `token-cli.ts:470-475` (R-promote-9 で検証) | ✓ |
| M4 | proxy.test.ts では `__resetInMemoryKeychainForTest()` を呼ばない | `proxy.test.ts:1325-1538` 内に該当 import / 呼び出しなし | ✓ |

## Findings

### Critical (must-fix before GO)

- なし

### Major (should-fix)

- なし

### Minor (nice-to-have)

- **n1**: `cmdTokenPromote` 内の `try/finally` は `process.exit` 呼び出し時にも `db.close()` を経由する設計だが、Node.js の `process.exit` は finally を走らせてから exit する仕様に依存している。テストでは `process.exit` を `TestExitError` 例外化しているので finally が動き、本番では fd 自動回収もあるため実害はない。挙動は仕様通り。
- **n2**: `proxy.ts:377` の `proxy_token_pool_resolved` ログは `enabled` と `source` 両方を含み、運用時の起動時 1 回キャッシュ判定が観測可能になっている。impl-result の説明と整合。
- **n3**: `docs/spec/09-token-pool.md` の `token promote` セクションに「`plan` は `rateLimitTier` 由来」と明記されており、`token add` の実装（`PLAN_MAP` 経由、probe では plan を取らない）と整合する。plan §6 の「probe で plan を取得」という当初の文言ズレは spec 側に修正反映済み。
- **n4**: 新規テスト 18 件（proxy 4 / store 3 / cli 11）はすべて assertion を持ち、`expect()` の数も `proxy.test.ts: 157`, `token-cli.test.ts: 104`, `token-store.test.ts: 176` と十分。

## Verified Independent Checks

| 観点 | 検証手段 | 結果 |
|------|---------|------|
| `updateTokensDB` の gate 配置 | proxy.ts:147-152 を Read | `else if (organizationId)` 直下、INSERT 前に early return |
| `start()` の起動時 1 回評価 | proxy.ts:372-377 を Read | `await isTokenPoolEnabled(projectRoot)` を fetch handler 設定より前で実行、クロージャに `tokenPoolEnabled` 束縛 |
| 呼び出し点 2 箇所 options object | proxy.ts:669-676 (streaming) / 739-746 (非 streaming) を Read | 両方とも `{ tokenPoolEnabled, getState: opts?.getState }` 形式 |
| `updateTokenPromoteFields` SQL | token-store.ts:407-411 を Read | 1 statement で `handle/auth_hash/plan/plan_ratio/tags/credential_source/selectable=1` を `WHERE id = ?` で UPDATE |
| `cmdTokenPromote` macOS / KEYCHAIN_TEST_MODE ガード | token-cli.ts:436-439 を Read | 既存 `cmdTokenAdd` と同形 |
| `cmdTokenPromote` auto-discover 限定 | token-cli.ts:448-455 を Read | `existing.credential_source !== "auto-discover"` → exit 1 |
| `cmdTokenPromote` org_id 一致検証 | token-cli.ts:516-522 を Read | `probedOrgId !== existing.organization_id` → exit 1 |
| `cmdTokenPromote` newHandle 衝突チェック条件 | token-cli.ts:464-475 を Read | `newHandle !== oldHandle` のときのみ衝突チェック、同一なら info ログ |
| `cmdTokenPromote` Keychain 先 → DB 後 | token-cli.ts:537-546 を Read | `storeTokenInKeychain` → `updateTokenPromoteFields` の順序 |
| `cmdTokenPromote` try/finally | token-cli.ts:441-559 を Read | 全体を `try { ... } finally { db.close(); }` で囲む |
| `cmdTokenPromote` plan='unknown' hint | token-cli.ts:551-556 を Read | 完了メッセージ後に `set-plan` 案内 |
| `main.ts` switch + import + Usage | main.ts:114-120 / 5441 / 5444 を Read | `cmdTokenPromote` import、`case "promote"` 追加、Usage 文言 `add\|list\|remove\|rotate\|set-plan\|promote` |
| ガードレール (`bus.emit` / `bus.on`) | `git diff` 全体に対して grep | 本タスク変更ファイルでの追加なし（既存 `eventBus.ts` のみ） |
| ガードレール (`taskState[...] =` / `saveTaskState(`) | `git diff` 全体に対して grep | 本タスク変更ファイルでの追加なし |
| ガードレール (`tree(...)` workspace 引数) | 変更ファイルに該当呼び出しなし | OK |
| docs auto-discover 節「pool OFF skip」 | `docs/spec/09-token-pool.md:282-291` を確認 | 明記、起動時 1 回キャッシュも併記 |
| docs `token promote` リファレンス | `docs/spec/09-token-pool.md:88-114` を確認 | M2 ヒント・M3 同一 handle 挙動・m6 (rename 余地) 全て記載 |
| 既存テスト non-regression | proxy.test.ts (43 pass, T323 含む) / config.test.ts (26 pass) | OK |
| `package-lock.json` 差分 | `git diff` で確認 | v4.10.0 → v4.11.0 のみ。リリース commit f4b78d6 への worktree bootstrap 由来で本タスクと無関係 |

## Fix Required (NOGO 時のみ)

該当なし（GO 判定）。
