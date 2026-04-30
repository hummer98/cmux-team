---
id: 371
title: spawn-agent の OAUTH 注入を inline env prefix に変更（direnv 上書きバグ修正）
priority: high
created_by: surface:230
created_at: 2026-04-28T05:23:04.398Z
---

## タスク
## 背景

token pool で `@kami` を選択した spawn-agent が、実際には `@tayo` の rate limit 枠で実行されてリミットに引っかかる現象が発生（Dear/A[428]）。

調査の結果、`tokens.db` の `auth_hash` と Keychain の sha256 prefix は完全一致しており、Keychain の中身は正しい。問題は **direnv が main.ts の export を後勝ちで上書きしている** こと。

### 現状の流れ（main.ts cmdSpawnAgent 末尾、2747-2797 行）

1. `cmux send`: `export CLAUDE_CODE_OAUTH_TOKEN=<選択 token> ...`
2. `cd <worktree>`
3. `direnv allow 2>/dev/null`
4. direnv が `.envrc` をロード → `source_env_if_exists .envrc.local` を経由して `.envrc.local` 内の `export CLAUDE_CODE_OAUTH_TOKEN=...`（プロジェクト固定 token）を再 export
5. `claude --dangerously-skip-permissions ...` を起動 → 親 shell の env（= direnv が上書きした値）が継承される
6. dashboard / team.json には selectToken が選んだ handle がそのまま残り、表示と実体が乖離

## 修正方針（A 案: inline env prefix）

`claude` 起動コマンドに `CLAUDE_CODE_OAUTH_TOKEN=$CMUX_CLAUDE_TOKEN claude ...` の形で **inline env prefix** を付ける。

- `exportVars` には `CLAUDE_CODE_OAUTH_TOKEN=` を入れず、代わりに `CMUX_CLAUDE_TOKEN=<token>` を export（direnv 管理外なので生き残る）
- `claudeCmd` を `CLAUDE_CODE_OAUTH_TOKEN="$CMUX_CLAUDE_TOKEN" claude ${claudeFlags.join(" ")} '...'` に変更
- token が選択できなかった経路（`selected` 不在 / Keychain 不在 = `tokenStr === null`）では `CMUX_CLAUDE_TOKEN` を export せず、claudeCmd も従来通り inline prefix なしで起動（Master 認証継承）

### 期待動作

- direnv の `.envrc.local` が `CLAUDE_CODE_OAUTH_TOKEN` を上書きしても、`claude` プロセスの env としては inline で渡した `$CMUX_CLAUDE_TOKEN` の値が優先される（execve の env 引数は親 shell の env より優先）
- shell history には変数名のみが残り、token 文字列は出ない
- token 未選択時は現状動作を維持

## 実装場所

- `skills/cmux-team/manager/main.ts`
  - 2712 行: `exportVars.push(\`CLAUDE_CODE_OAUTH_TOKEN=\${tokenStr}\`)` → `exportVars.push(\`CMUX_CLAUDE_TOKEN=\${tokenStr}\`)` に変更
  - 2791-2796 行: `claudeCmd` の組み立てを以下に変更
    ```ts
    const tokenPrefix = tokenInjected ? \`CLAUDE_CODE_OAUTH_TOKEN="$CMUX_CLAUDE_TOKEN" \` : "";
    if (effectivePromptFile) {
      claudeCmd = \`\${tokenPrefix}claude \${claudeFlags.join(" ")} '\${effectivePromptFile} を読んで指示に従ってください。'\`;
    } else {
      claudeCmd = \`\${tokenPrefix}claude \${claudeFlags.join(" ")} '\${prompt}'\`;
    }
    ```
  - `tokenInjected` フラグは selectToken ブロック内で `tokenStr` が non-null だった場合に true にしてブロック外で参照（または `exportVars` に CMUX_CLAUDE_TOKEN を含むかで判定）

## テスト

1. **既存テストが壊れないこと** — `bun test --timeout 30000 main.test.ts` 等（CLAUDE.md の通り `bun test` 全体実行は禁止、ファイル単位で実行）
2. **direnv 有りプロジェクトでの動作確認** — Dear のような `.envrc.local` で `CLAUDE_CODE_OAUTH_TOKEN` を export しているプロジェクトで spawn-agent し、Anthropic 側のアカウント（util_5h の伸び）が selectToken の選んだ handle に対応していることを `cmux-team token list` で確認
3. **token 未選択経路** — `tokenPool.enabled: false` のプロジェクトで spawn-agent し、従来通り Master 認証で動くことを確認

## 関連

- 観察: cmux-team workspace 上で 2026-04-28 13:10:25 に Dear A[428] が `handle=@kami` で assigned されたが、ユーザーが「リミッターにひっかった」と報告（@tayo は util_7d=91% でリミット間近、@kami は 18% で余裕あり）
- 参考: `docs/spec/09-token-pool.md` のデータフロー section
- 起票元会話: cmux-team Master surface:230 (2026-04-28)
