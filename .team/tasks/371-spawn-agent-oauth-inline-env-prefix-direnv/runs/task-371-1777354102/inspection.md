# Inspection Report — T371

## Verdict
GO

## Findings
（Critical / Major なし。Minor の所見のみ）

- [Minor] 修正は worktree 内で uncommit のまま（`git status` 上 `modified: skills/cmux-team/manager/main.ts` + `package-lock.json`）。Conductor のコミット工程で確実に commit されること。`git diff main..HEAD` は空だが `git diff` で全変更を確認済み。
- [Minor] `package-lock.json` の差分は `version: 4.12.1 → 4.15.0` の単独行更新のみ。これは worktree 起点（base release）由来のノイズで T371 修正範囲（main.ts）には影響しない。Conductor のコミット時に main.ts 単体でコミットするか、別コミットに分けるかは Conductor 判断。
- [Minor] plan.md は spot test として `token-cli / token-store / pool-throttle / direnv-check / envrc-prompt` の追加実行も推奨しているが、本検品プロンプトの指示範囲は `main*.test.ts` まで。当該ファイル群は token 中継変数名・claudeCmd 文字列を assert しないため、未実行でも回帰の懸念はない（plan.md L147 で grep 確認済との記述）。

## Verification

- **tsc**: PASS（`bunx tsc --noEmit` from `skills/cmux-team/manager/` 出力空＝新規エラー 0 件）
- **tests (関連分)**: PASS
  - `main.test.ts`: 187 pass / 0 fail / 479 expect (14.46s)
  - `main-branch.test.ts`: 15 pass / 0 fail / 20 expect (32ms)
- **仕様適合**: 5項目すべて pass
  1. ✅ export 変更: `exportVars.push` の env 名が `CLAUDE_CODE_OAUTH_TOKEN=${tokenStr}` → `CMUX_CLAUDE_TOKEN=${tokenStr}` に変更されている（L2720 周辺）
  2. ✅ `tokenInjected` フラグ: `exportVars` 宣言直後（L2671）で `let tokenInjected = false;` を関数スコープに宣言。`if (tokenStr)` ブロック内、`exportVars.push` の直後（L2720 直後）で `tokenInjected = true;` をセット
  3. ✅ inline env prefix: `claudeCmd` の組み立て直前に `const tokenPrefix = tokenInjected ? \`CLAUDE_CODE_OAUTH_TOKEN="$CMUX_CLAUDE_TOKEN" \` : "";` を導入し、`${tokenPrefix}claude ${claudeFlags.join(" ")} '...'` の形で claudeCmd の双方分岐（`effectivePromptFile` 有無）に適用されている
  4. ✅ token 未選択経路の保持: `tokenInjected = true` は `if (tokenStr)` の真分岐内のみでセット。`tokenStr === null` / `selected` 不在のときはフラグが false のままで `tokenPrefix === ""` となり、claudeCmd は文字レベルで従来と完全一致する
  5. ✅ 既存挙動への副作用なし: `await cmux.send(surface, \`export ${exportVars.join(" ")}\n\`)` 等の周辺ロジック・`AGENT_TOKEN_BOUND` post・`token_pool_assigned` ログメッセージは変更されていない

## Structural Soundness（B 項目）

- ✅ shell escape: `tokenPrefix` は `tokenInjected` 真偽だけで `"CLAUDE_CODE_OAUTH_TOKEN=\"$CMUX_CLAUDE_TOKEN\" "` か空文字列に決まる固定文字列。ユーザー入力混入なし。double-quote の `"$CMUX_CLAUDE_TOKEN"` は prompt 部分の single-quote `'...'` と直交し干渉しない
- ✅ logging: `token_pool_assigned` の `handle=${selected.token.handle} token_id=${selected.token.id}` 表示は変更されていない（diff 上未変更行）

## Notes for Conductor

- 計画書に新規テスト追加方針が「不採用」と明記されている（plan.md L150-154）ため、新規テストファイルの追加確認は不要。Implementer 側もチェックリスト通り main.ts のみ修正で完了している
- worktree 上で未 commit の状態。Conductor は plan.md L185 のサジェスト通り `fix(spawn-agent): pass OAuth token via inline env prefix to survive direnv allow (T371)` の commit message でコミットする想定
- 実環境での direnv 上書き回避の動作確認（手動）は plan.md L156-165「手動確認」項に記載があるが、これは Master/ユーザー側の責務であり Inspector / Conductor のスコープ外
