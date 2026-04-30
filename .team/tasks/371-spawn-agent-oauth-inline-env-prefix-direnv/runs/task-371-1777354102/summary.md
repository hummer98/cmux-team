# T371 Summary

## タスク
spawn-agent の OAUTH 注入を inline env prefix に変更（direnv 上書きバグ修正）

## 変更ファイル
- `skills/cmux-team/manager/main.ts`
- `package-lock.json`（worktree 起動時の `npm install` で 4.12.1 → 4.15.0 に lock 整合）

## 修正内容（main.ts）

### 1. 関数スコープに `tokenInjected` フラグ宣言（cmdSpawnAgent 内）
`exportVars` 宣言直後に `let tokenInjected = false;` を追加。token pool が token を注入したかどうかを後段の claudeCmd 組み立てで参照するため。

### 2. token export を中継変数に変更
```diff
-  exportVars.push(`CLAUDE_CODE_OAUTH_TOKEN=${tokenStr}`);
+  exportVars.push(`CMUX_CLAUDE_TOKEN=${tokenStr}`);
+  tokenInjected = true;
```
direnv 管理外の変数名 `CMUX_CLAUDE_TOKEN` で渡し、`.envrc.local` の後続 `export CLAUDE_CODE_OAUTH_TOKEN=...` で消されないようにする。

### 3. `claude` 起動コマンドに inline env prefix を追加
```diff
+  const tokenPrefix = tokenInjected ? `CLAUDE_CODE_OAUTH_TOKEN="$CMUX_CLAUDE_TOKEN" ` : "";
   if (effectivePromptFile) {
-    claudeCmd = `claude ${claudeFlags.join(" ")} '${effectivePromptFile} を読んで指示に従ってください。'`;
+    claudeCmd = `${tokenPrefix}claude ${claudeFlags.join(" ")} '${effectivePromptFile} を読んで指示に従ってください。'`;
   } else {
-    claudeCmd = `claude ${claudeFlags.join(" ")} '${prompt}'`;
+    claudeCmd = `${tokenPrefix}claude ${claudeFlags.join(" ")} '${prompt}'`;
   }
```
execve の env 引数は親 shell の env より優先されるため、direnv が `CLAUDE_CODE_OAUTH_TOKEN` を上書きしていても、claude プロセスには inline prefix で渡した `$CMUX_CLAUDE_TOKEN` の値が届く。

## 互換性
- token 未選択経路（`tokenStr === null` / `selected` 不在）では `tokenInjected = false` のまま、`tokenPrefix === ""` となり、claudeCmd は文字レベルで従来と完全一致 → Master 認証継承の従来挙動を維持
- shell history には変数名のみ残り、token 文字列は出ない（既存と同じく `export CMUX_CLAUDE_TOKEN=...` は send されるが、claude 起動コマンド側には現れない）

## 検証結果（Inspector による）
- `bunx tsc --noEmit`: 新規エラー 0 件
- `bun test --timeout 30000 main.test.ts`: 187 pass / 0 fail
- `bun test --timeout 30000 main-branch.test.ts`: 15 pass / 0 fail
- 仕様適合 5 項目すべて pass、Critical / Major findings なし

## フェーズ
- Phase 1 Plan: surface:508（completed）
- Phase 3 Implementation: surface:515（completed）
- Phase 4 Inspection: surface:516（GO 判定）

## 残課題（手動確認、Master/ユーザー責務）
- Dear のような direnv 利用プロジェクトで spawn-agent し、`cmux-team token list` で `util_5h` の伸びが selectToken の選んだ handle に対応していることを確認
- `tokenPool.enabled: false` プロジェクトで spawn-agent し、Master 認証継承で動くことを確認
