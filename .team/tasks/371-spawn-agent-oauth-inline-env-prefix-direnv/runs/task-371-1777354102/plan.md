# T371 実装計画書 — spawn-agent OAuth token を inline env prefix で渡す

## 目的

`spawn-agent` で token pool が選んだ `CLAUDE_CODE_OAUTH_TOKEN` が、worktree 移動直後の `direnv allow` による `.envrc.local` ロードで上書きされる問題を解消する。

`claude` 起動コマンドに **inline env prefix** を付与し、execve の env 引数で親 shell の `CLAUDE_CODE_OAUTH_TOKEN`（direnv 由来）を確実に override する。

## 修正対象ファイル

- `skills/cmux-team/manager/main.ts` のみ
- 修正範囲: `cmdSpawnAgent` 関数内の **L2663 - L2796** の token 注入経路と claude 起動部分のみ

他ファイル（daemon.ts、direnv-check.ts、config.ts、token-store.ts 等）への変更なし。

## 修正内容

### 1. `tokenInjected` フラグを外側スコープに宣言（L2663 付近）

`exportVars` 宣言の直後に `let tokenInjected = false;` を追加する。

**変更前（L2663-2670）:**
```ts
const exportVars = [
  `ROLE=${role}`,
  `PROJECT_ROOT=${PROJECT_ROOT}`,
  `CMUX_SURFACE=${surface}`,
  `CMUX_NO_RENAME_TAB=1`,
  `CMUX_CLAUDE_HOOKS_DISABLED=1`,
  `CMUX_TEAM_SKIP_SYNC_CHECK=1`,
];
```

**変更後:**
```ts
const exportVars = [
  `ROLE=${role}`,
  `PROJECT_ROOT=${PROJECT_ROOT}`,
  `CMUX_SURFACE=${surface}`,
  `CMUX_NO_RENAME_TAB=1`,
  `CMUX_CLAUDE_HOOKS_DISABLED=1`,
  `CMUX_TEAM_SKIP_SYNC_CHECK=1`,
];
// T371: token pool 注入の有無を claude 起動コマンドの inline env prefix 判定に使う。
// direnv の .envrc.local が CLAUDE_CODE_OAUTH_TOKEN を上書きするため、
// `CLAUDE_CODE_OAUTH_TOKEN="$CMUX_CLAUDE_TOKEN" claude ...` の形で execve env を渡す。
let tokenInjected = false;
```

**根拠:** `exportVars` と同じスコープに置くことで、内側 try ブロックでの set / 外側での参照の関係が一目で読み取れる。フラグ立ては `tokenStr` が non-null の分岐 1 箇所だけで、命名 `tokenInjected` は「inline prefix を付けるべきか」という意図と一致する。

### 2. `exportVars.push` で渡す env 名を変更（L2712）

**変更前:**
```ts
if (tokenStr) {
  exportVars.push(`CLAUDE_CODE_OAUTH_TOKEN=${tokenStr}`);
  await log(
    "token_pool_assigned",
    ...
  );
}
```

**変更後:**
```ts
if (tokenStr) {
  // T371: direnv の .envrc.local が CLAUDE_CODE_OAUTH_TOKEN を上書きするため、
  // ここでは中継変数 CMUX_CLAUDE_TOKEN として export し、claude 起動時に
  // inline env prefix で CLAUDE_CODE_OAUTH_TOKEN にリネームする。
  exportVars.push(`CMUX_CLAUDE_TOKEN=${tokenStr}`);
  tokenInjected = true;
  await log(
    "token_pool_assigned",
    ...
  );
}
```

**根拠:** `CMUX_CLAUDE_TOKEN` は `.envrc.local` の管理対象外（既存プロジェクトで定義されていない）なので、direnv allow で消えない。値は子プロセスの env として残り続け、L2797 の inline prefix `CLAUDE_CODE_OAUTH_TOKEN="$CMUX_CLAUDE_TOKEN"` で展開される。`token_pool_assigned` ログ等の他のログメッセージは変更不要。

### 3. `claudeCmd` の組み立てに `tokenPrefix` を導入（L2791-2796）

**変更前:**
```ts
let claudeCmd: string;
if (effectivePromptFile) {
  claudeCmd = `claude ${claudeFlags.join(" ")} '${effectivePromptFile} を読んで指示に従ってください。'`;
} else {
  claudeCmd = `claude ${claudeFlags.join(" ")} '${prompt}'`;
}
await cmux.send(surface, claudeCmd + "\n");
```

**変更後:**
```ts
// T371: token pool が token を注入した経路だけ inline env prefix を付ける。
// direnv の .envrc.local が CLAUDE_CODE_OAUTH_TOKEN を export していても、
// この prefix は execve env として優先される。
const tokenPrefix = tokenInjected ? `CLAUDE_CODE_OAUTH_TOKEN="$CMUX_CLAUDE_TOKEN" ` : "";
let claudeCmd: string;
if (effectivePromptFile) {
  claudeCmd = `${tokenPrefix}claude ${claudeFlags.join(" ")} '${effectivePromptFile} を読んで指示に従ってください。'`;
} else {
  claudeCmd = `${tokenPrefix}claude ${claudeFlags.join(" ")} '${prompt}'`;
}
await cmux.send(surface, claudeCmd + "\n");
```

**根拠:**
- `tokenInjected === false` のときは prefix が空文字列なので、Master 認証継承（token pool 無効 / `selected` 不在 / Keychain 不在）の経路は従来と完全に同一の起動コマンド。
- shell quote: `"$CMUX_CLAUDE_TOKEN"` は double-quote で `$CMUX_CLAUDE_TOKEN` を変数展開させ、prompt 部分の single-quote と干渉しない。
- `worktreePath` での `cd` と `direnv allow` は L2751-2756 で先に実行されているため、`direnv allow` 後の env 上に `CMUX_CLAUDE_TOKEN` が残っており、その時点で `claude` を叩く構造になっている。direnv は `CMUX_CLAUDE_TOKEN` を unset しない（`.envrc.local` の管理対象外なので unload 対象に入らない）。

## 影響範囲

| 経路 | 影響 | 説明 |
|---|---|---|
| spawn-agent（token pool 有効 + token 選択成功） | **変更あり** | `exportVars` の env 名変更 + claudeCmd に inline prefix |
| spawn-agent（token pool 無効 / 候補なし / Keychain 不在） | 変更なし | `tokenInjected = false` のまま、prefix 空文字列 |
| AGENT_TOKEN_BOUND post（L2727-2733） | 変更なし | `tokenStr` 有無に依存しないロジック（既存通り） |
| daemon / Conductor / Master spawn 経路 | 変更なし | これらは `cmdSpawnAgent` を呼ばない |
| direnv-check / envrc-prompt | 変更なし | 検査経路にのみ関係し、token 注入には触らない |
| token pool 関連 CLI（`cmux-team token list` 等） | 変更なし | 集計は token-store 側の責務 |

## テスト方針

### 既存テストの再実行（必須）

```bash
cd skills/cmux-team/manager
bun test --timeout 30000 main.test.ts
```

`bun test` 全体実行は禁忌（CLAUDE.md 既知の注意点）。main.test.ts の他に直接的な依存が出るテストは無い見込みだが、念のため以下も個別に再実行する:

```bash
for f in token-cli.test.ts token-store.test.ts pool-throttle.test.ts direnv-check.test.ts envrc-prompt.test.ts; do
  bun test --timeout 30000 "$f"
done
```

**期待:** 全 pass。

**根拠:**
- `main.test.ts` の spawn-agent テスト（L2213-2268）は `--role` バリデーション（exit code + stderr 文字列）のみで、`exportVars` や `claudeCmd` の send 内容を assert していない。
- 他のテストファイルにも `CLAUDE_CODE_OAUTH_TOKEN` / `CMUX_CLAUDE_TOKEN` を assert する箇所は無い（grep 確認済み）。
- したがって、内部実装の env 名変更と inline prefix 追加だけでは既存 assertion を破らない。

### 新規 unit test の追加（不採用）

プロンプトの指示通り **追加しない**:
- 既存テストが直接の send 文字列 assertion を持たない以上、`cmdSpawnAgent` 内のロジックに対して新規 unit test を書くには (a) 該当部分の純粋関数化または (b) `cmux.send` の DI が必要で、両者とも今回スコープを大きく超える。
- inline env prefix の挙動は OS の execve 仕様に依存するため、ロジックを純粋関数で表現してもアサーションが「文字列が期待形式か」レベルになり、実利用上のバグ（direnv との後勝ち問題）は別レイヤで起きる。
- 構造的回帰防止は手動確認（下記）で担保する。

### 手動確認

1. **direnv 有り + token pool 有効プロジェクト（Dear など業務系）**
   - `cmux-team spawn-agent --role planner --conductor-surface surface:N --prompt 'echo $CLAUDE_CODE_OAUTH_TOKEN | head -c 12'` 相当で起動し、Agent 環境内で `CLAUDE_CODE_OAUTH_TOKEN` の prefix が `selectToken` の選んだ handle のものになっているか確認。
   - `cmux-team token list` で `util_5h` の伸びが、選ばれた handle に対応していることを確認（rate limit が他テナントに引きずられないこと）。
2. **token pool 無効プロジェクト（`tokenPool.enabled: false` または config 未設定）**
   - spawn-agent して Master 認証継承で起動できることを確認（claudeCmd に prefix が付かない）。
3. **token pool 有効だが Keychain 不在（`tokenStr === null` 経路）**
   - `token_pool_fallback reason=keychain_missing` ログが出て、env 注入なしで claude が起動することを確認。

## リスク・トレードオフ

| リスク | 評価 | 対応 |
|---|---|---|
| inline prefix の shell quote ミスで claude が起動できない | 低 | `"$CMUX_CLAUDE_TOKEN"` は単純な double-quote。prompt 部分の single-quote と干渉しない。手動確認で検証 |
| `CMUX_CLAUDE_TOKEN` 名が将来 `.envrc.local` に書かれる可能性 | 極低 | 命名は `cmux-team` の専用 prefix。ユーザーが意図的に上書きしない限り衝突しない |
| direnv が `CMUX_CLAUDE_TOKEN` を予期せず unset する | 極低 | direnv は `.envrc` で `export` した変数のみ管理対象。export 元 shell の env を unset しない |
| token pool 無効経路の互換性 | 極低 | `tokenInjected = false` のとき prefix は空文字列で、claudeCmd は文字レベルで従来と完全一致 |
| `AGENT_TOKEN_BOUND` post の handle 報告とのズレ | なし | `tokenStr` 有無の分岐構造は既存通り。tokenInjected フラグは送信側のみで参照 |

## チェックリスト（Implementer 用）

- [ ] L2663 直後に `let tokenInjected = false;` + コメント追加
- [ ] L2712 の `exportVars.push(\`CLAUDE_CODE_OAUTH_TOKEN=${tokenStr}\`)` を `CMUX_CLAUDE_TOKEN=${tokenStr}` に変更
- [ ] L2712 の直後に `tokenInjected = true;` を追加
- [ ] L2791 直前に `const tokenPrefix = tokenInjected ? \`CLAUDE_CODE_OAUTH_TOKEN="$CMUX_CLAUDE_TOKEN" \` : "";` を追加
- [ ] L2793 / L2795 の `claudeCmd = \`claude ...\`` を `claudeCmd = \`${tokenPrefix}claude ...\`` に変更
- [ ] `bun test --timeout 30000 main.test.ts`（および上記の追加テスト）が全 pass
- [ ] 修正コミット（コミットメッセージ例: `fix(spawn-agent): pass OAuth token via inline env prefix to survive direnv allow (T371)`）
