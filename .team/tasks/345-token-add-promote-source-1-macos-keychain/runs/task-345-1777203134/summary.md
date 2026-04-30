# T345 完了サマリー

## タスク

`cmux-team token add` / `token promote` の source=1（Claude Code credential）が、macOS で
**Keychain (`Claude Code-credentials` / account=`$USER`) を優先**して読むようにする。
`~/.claude/.credentials.json` は stale snapshot のため probe 401 → "organization_id を取得できませんでした"
で失敗するバグを解消する。

## 完了したサブタスク

1. Plan: Keychain 優先化の実装計画策定（plan.md）
2. Implementation: TDD で `readClaudeCredentials` を Keychain → file 順に改修
3. Inspection: 全 GO（テスト 31 pass / tsc 0 / 文言更新確認）

## 変更ファイル

| ファイル | 種別 | 内容 |
|---|---|---|
| `skills/cmux-team/manager/token-store.ts` | 追加 | `CLAUDE_CODE_KEYCHAIN_SERVICE` 定数 / `readClaudeCodeKeychain(account?)` / `__set/__resetClaudeCodeKeychainForTest`（in-memory test mode）|
| `skills/cmux-team/manager/token-cli.ts` | 修正 | `readClaudeCredentials` を Keychain → file 優先に / `parseClaudeCredentialJson` 切り出し / エラー文言 3 箇所・UI ラベル 3 箇所更新 |
| `skills/cmux-team/manager/token-cli.test.ts` | 追加 | `describe("readClaudeCredentials priority (T345)")` で 7 ケース追加 / beforeEach に `__resetClaudeCodeKeychainForTest()` と `process.env.USER="testuser"` |
| `package-lock.json` | 同期 | v4.11.0 → v4.12.0（直近 release commit との既存ズレ。本タスク無関係だが `npm install` が解消）|

## 設計判断

- **関数の所在**: `readClaudeCodeKeychain` は `token-store.ts` に追加（既に `spawnSync` で Keychain CRUD があり、`useInMemory()` 経路を再利用できる）
- **テスト戦略**: 既存 `KEYCHAIN_TEST_MODE=1` を流用し、`inMemoryClaudeCodeKeychain` map を別途持つ。`spawnSync` を mock せず in-memory 経路で代替
- **フォールバック条件**: `security` の全失敗（spawn 失敗 / 非ゼロ exit / 44 errSecItemNotFound）で file へ fallback。stderr ログは出さない（plan §1.2 に明記、CLAUDE.md「stderr を detail に」の例外として正常系の fallback 扱い）
- **非 macOS**: `process.platform !== "darwin"` 早期 return → Keychain 経路 null → file fallback で従来挙動を保持

## テスト結果

```
$ cd skills/cmux-team/manager && bun test --timeout 30000 token-cli.test.ts
 31 pass, 4 skip, 0 fail (130 expect calls)

$ bun test --timeout 30000 token-store.test.ts
 96 pass, 1 skip, 0 fail (176 expect calls)

$ bunx tsc -p skills/cmux-team/manager/tsconfig.json --noEmit
 exit 0
```

skip 4 件は本タスク外（既存 R1/R2/R3 の main 制約による移植不能ケース）。

## 追加テストケース（7 件）

| # | 内容 |
|---|---|
| T1 | macOS Keychain 成功 → Keychain 値が使われる（file 値は無視） |
| T2 | Keychain 未登録 → file fallback |
| T3 | 両方失敗 → exit 1（新エラー文言）|
| T4 | Keychain JSON 破損 → file fallback |
| T5 | Keychain JSON は valid だが accessToken 欠損 → file fallback |
| T7 | `cmdTokenPromote` 経路でも Keychain 優先 |
| T8 | `cmdTokenRotate` 経路でも Keychain 優先 |

## 文言更新

- エラー: `Error: ~/.claude/.credentials.json が見つからないか accessToken がありません` → `Error: Claude Code credential が見つかりません（macOS Keychain / ~/.claude/.credentials.json のどちらも読めませんでした）`（3 箇所）
- UI: `[1] Claude Code credential (~/.claude/.credentials.json)` → `[1] Claude Code credential (macOS Keychain / ~/.claude/.credentials.json)`（cmdTokenAdd / cmdTokenPromote）
- UI: `新しい token を貼り付け（または [1] credential ファイルから再取得）:` → `... [1] credential から再取得 (macOS Keychain / ファイル)`（cmdTokenRotate）

## 残課題

- 実機 E2E（plan §5）は手動確認推奨。期限切れ `.credentials.json` を放置した状態で `cmux-team token add` → source=1 → probe 成功までを 1 回流すこと

## マージ

ローカル ff-only マージ（main へ）。
