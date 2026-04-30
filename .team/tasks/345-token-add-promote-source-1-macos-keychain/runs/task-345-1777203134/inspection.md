# 検品結果: T345

## 判定: GO

## チェック項目

### Plan §1.1〜1.4 適合
- [x] readClaudeCredentials 優先順位
  - `token-cli.ts:80-98` で Keychain (`readClaudeCodeKeychain()`) → file (`~/.claude/.credentials.json`) の順序を実装。Keychain JSON 破損 / accessToken 欠損時は file へ fallback する分岐も plan §1.1 通り。
- [x] token-store.ts exports
  - `CLAUDE_CODE_KEYCHAIN_SERVICE` (token-store.ts:113)、`readClaudeCodeKeychain` (token-store.ts:589)、`__setClaudeCodeKeychainForTest` (token-store.ts:946)、`__resetClaudeCodeKeychainForTest` (token-store.ts:958) すべて追加・export 済み。
- [x] フォールバック条件
  - `result.error` (spawn 失敗) と `result.status !== 0` (44 含む全ての非ゼロ exit) を区別せず null を返す (token-store.ts:609-611)。plan §1.2 の「全失敗で fallback」ポリシーに一致。
- [x] in-memory 経路 gate
  - `readClaudeCodeKeychain` 冒頭で `useInMemory()` をチェックし、`KEYCHAIN_TEST_MODE=1` のとき `inMemoryClaudeCodeKeychain` map を参照 (token-store.ts:592-594)。本番経路 (`spawnSync`) には到達しない。

### Plan §2 テスト戦略
- [x] 7 ケース追加
  - `describe("readClaudeCredentials priority (T345)")` 配下に T1〜T5, T7, T8 の 7 件を追加 (token-cli.test.ts:993-1238)。T6 は plan §2.3 通り T1 / T7 / T8 に統合。
- [x] beforeEach 追加
  - `__resetClaudeCodeKeychainForTest()` (token-cli.test.ts:153) と `process.env.USER = "testuser"` (token-cli.test.ts:150) を追加済み。
- [x] originalEnv USER 退避
  - `beforeAll` の originalEnv に `USER` を追加 (token-cli.test.ts:126)。afterEach での復元ロジック (元コード経由) も問題なし。

### Plan §3 文言更新
- [x] エラー文言 3 箇所
  - cmdTokenAdd (L149)、cmdTokenRotate (L382)、cmdTokenPromote (L523) の 3 箇所がすべて新文言「Claude Code credential が見つかりません（macOS Keychain / ~/.claude/.credentials.json のどちらも読めませんでした）」に更新済み。
- [x] UI ラベル 3 箇所
  - cmdTokenAdd (L139) と cmdTokenPromote (L517): `[1] Claude Code credential (macOS Keychain / ~/.claude/.credentials.json)`
  - cmdTokenRotate (L376): `新しい token を貼り付け（または [1] credential から再取得 (macOS Keychain / ファイル)）`
  - すべて plan §3 の対応表通り。

### テスト結果（自分で実行した結果）
- token-cli.test.ts: **31 pass / 4 skip / 0 fail** (130 expect calls, 35 tests)
  - 既存 24 件 + 新規 7 件 = 31 pass。skip 4 件は本タスク外（既存）。
- token-store.test.ts: **96 pass / 1 skip / 0 fail** (176 expect calls)
  - in-memory keychain 系の非回帰確認 OK。
- tsc: **exit=0** (`bunx tsc -p skills/cmux-team/manager/tsconfig.json --noEmit`)

### コード品質
- [x] dead code なし
  - 変更箇所すべてが優先順位ロジック・テスト・文言更新に紐付いており、未使用 export / 未参照 helper は無し。`parseClaudeCredentialJson` も `readClaudeCredentials` から 2 経路で呼ばれているので有効。
- [x] 空 catch なし
  - 新規 catch (token-cli.ts:68-70 / 95-97) はいずれも `return null` で意味のある動作をする。`readClaudeCodeKeychain` は spawn 結果を `if` で確認しているので catch 自体が存在しない。
- [x] yarakai shim なし
  - 後方互換シム・dead branch ともに導入されていない。`readClaudeCredentials` の旧ロジック (file のみ) は完全に置き換えられている。

### 仕様適合チェック
- [x] タスク本文「期待動作」: source=1 で Keychain 由来 token が選ばれ、probe 成功 → `Found credential` までシーケンスが流れる。T1 / T7 / T8 がこの経路を実機相当でカバー。
- [x] 非 macOS 挙動: `readClaudeCodeKeychain` 冒頭で `process.platform !== "darwin"` 早期 return (token-store.ts:595)。Keychain 経路が空 → `readClaudeCredentials` は file path のみを読む。従来挙動を保持。
- [x] Plan §6「やらないこと」遵守: proxy ファイル変更なし、`~/.claude/.credentials.json` への書き込みなし、`mcpOAuth` 触らず、`process.platform` mock していない (in-memory 経路で代替)。

### spawn 失敗時のログ運用について（CLAUDE.md 規約との整合）
- `readClaudeCodeKeychain` は `result.error` / 非ゼロ exit 時に `stderr` を読まずに null を返す。これは plan §1.2 で明示的に「正常系の fallback として扱い、ログ等への記録は不要」と決定済み。Keychain ロック中・44 (errSecItemNotFound) など想定内の状況で stderr を出すと UX が悪化するため、本タスクのスコープでは妥当。`auto-discover` などログが要る別経路は本タスク外。
- 意図された設計判断であり、CLAUDE.md「外部コマンド失敗時は stderr を detail に含める」の例外として plan に記録済み。OK と判断。

## 指摘事項
（NOGO ではないため特になし）

## Fix Required
（NOGO ではないため特になし）

## 補足
- `package-lock.json` の差分は v4.11.0 → v4.12.0 のバージョン同期 (release commit `8d3ad0e` との既存ズレを `npm install` が解消したもの) であり、本タスクと無関係。OK。
- 実機 E2E (plan §5「実機確認手順」) は本タスク完了後にユーザーが手動で 1 回実行する想定なので、Inspector からは未確認。コード・テスト・型チェックレベルで GO 条件を満たしていることを確認した。
