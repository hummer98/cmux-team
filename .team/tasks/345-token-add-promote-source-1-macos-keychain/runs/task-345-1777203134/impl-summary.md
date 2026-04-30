# T345 実装サマリー

## 変更ファイル一覧

| ファイル | 種別 | 概要 |
|---|---|---|
| `skills/cmux-team/manager/token-store.ts` | 追加 | `CLAUDE_CODE_KEYCHAIN_SERVICE` 定数、`readClaudeCodeKeychain(account?)` 関数、in-memory map (`inMemoryClaudeCodeKeychain`)、test helper (`__setClaudeCodeKeychainForTest` / `__resetClaudeCodeKeychainForTest`) を追加・export |
| `skills/cmux-team/manager/token-cli.ts` | 修正 | `readClaudeCredentials` を Keychain → file の優先順位ロジックへ差し替え。`parseClaudeCredentialJson` を private helper として切り出し。`readClaudeCodeKeychain` を import。エラー文言 3 箇所 (cmdTokenAdd / cmdTokenRotate / cmdTokenPromote) と UI ラベル 3 箇所 (L106/L484 同文言を replace_all、L343 を個別) を更新 |
| `skills/cmux-team/manager/token-cli.test.ts` | 追加 | `describe("readClaudeCredentials priority (T345)")` で 7 ケース追加。beforeEach に `__resetClaudeCodeKeychainForTest()` と `process.env.USER = "testuser"` 固定、originalEnv に USER 退避を追加 |

## 追加したテストケース

`describe("readClaudeCredentials priority (T345)", ...)` 配下に以下 7 件を追加：

| # | ケース | 期待 |
|---|---|---|
| T1 | macOS Keychain 成功 → Keychain 値が使われる (file 値は無視) | `accessToken=kc-AAA`, plan=`max-x5` で登録される |
| T2 | Keychain 未登録 → `~/.claude/.credentials.json` fallback | `accessToken=file-BBB`, plan=`pro` で登録される |
| T3 | 両方失敗 → exit 1 (新エラー文言を含む) | `Claude Code credential が見つかりません` `macOS Keychain` `.credentials.json` を含む |
| T4 | Keychain JSON 破損 → file fallback | `accessToken=file-CCC`, plan=`max-x20` で登録される |
| T5 | Keychain JSON は valid だが `claudeAiOauth.accessToken` 欠損 → file fallback | `accessToken=file-DDD`, plan=`max-x5` で登録される |
| T7 | promote 経路でも同じ優先順位 (Keychain 優先) | promote 後 `@kddi` の Keychain token が `kc-promote-token`、plan=`max-x20` |
| T8 | rotate 経路でも同じ優先順位 (Keychain 優先で auth_hash 更新) | 新 auth_hash が `Bearer kc-rotate-token` の sha256 prefix と一致、Keychain も `kc-rotate-token` に更新 |

T6（rateLimitTier が Keychain にあれば plan は Keychain 由来で決まる）は T1 / T7 / T8 で plan の確認を兼ねているため統合し、独立ケースとしては追加していない（plan §2.3 の通り）。

## テスト実行結果

`cd skills/cmux-team/manager && bun test --timeout 30000 token-cli.test.ts`:

```
 31 pass
 4 skip
 0 fail
 130 expect() calls
Ran 35 tests across 1 file.
```

- 既存 24 件 + 新規 7 件 = 31 pass。skip 4 件はもとから存在する main 制約による移植不能ケース（R1 / R3 / R2 / R3 — 本タスク外）。
- `bun test --timeout 30000 token-store.test.ts`: 96 pass / 1 skip / 0 fail（in-memory keychain 関連の非回帰確認 OK）

## 型チェック結果

worktree 直下に tsconfig.json は無いため manager の tsconfig を明示指定して実行：

```
$ bunx tsc -p skills/cmux-team/manager/tsconfig.json --noEmit; echo "exit=$?"
exit=0
```

新規エラー 0。

## 想定外の修正

なし。Plan §1〜§4 通りに実装完了。

### 参考: 文言更新の詳細位置（修正後の token-cli.ts 行番号は概ね下記）

| 箇所 | 旧 | 新 |
|---|---|---|
| エラー文言（cmdTokenAdd / cmdTokenRotate / cmdTokenPromote 3 箇所、replace_all で一括置換） | `Error: ~/.claude/.credentials.json が見つからないか accessToken がありません` | `Error: Claude Code credential が見つかりません（macOS Keychain / ~/.claude/.credentials.json のどちらも読めませんでした）` |
| UI ラベル `cmdTokenAdd` / `cmdTokenPromote`（同文言、replace_all で一括置換） | `[1] Claude Code credential (~/.claude/.credentials.json)` | `[1] Claude Code credential (macOS Keychain / ~/.claude/.credentials.json)` |
| UI ラベル `cmdTokenRotate`（個別置換） | `新しい token を貼り付け（または [1] credential ファイルから再取得）:` | `新しい token を貼り付け（または [1] credential から再取得 (macOS Keychain / ファイル)）:` |
