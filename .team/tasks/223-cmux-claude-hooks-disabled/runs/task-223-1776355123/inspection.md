# T223 検品結果 — envrc-prompt の env 変数チェック追加

## 1. 判定

**GO**

## 2. plan.md との整合性

| 項目 | 判定 | 確認内容 |
|------|------|---------|
| 3.1 `EnsureOptions.envOverride` 型拡張 | OK | `envrc-prompt.ts:124` に `CMUX_CLAUDE_HOOKS_DISABLED?: string` が追加済み |
| 3.2 env チェック gating が `CMUX_TEAM_NO_PROMPT` の直後 | OK | `envrc-prompt.ts:146-151`。既存の `noPromptEnv` ブロック直後に配置 |
| 3.2 log reason が `already_in_env` | OK | `envrc-prompt.ts:149` `await log("envrc_check_skipped", "reason=already_in_env")` |
| 3.2 envOverride / process.env 両対応（`??` 解決） | OK | `envrc-prompt.ts:146-147` `options.envOverride?.CMUX_CLAUDE_HOOKS_DISABLED ?? process.env.CMUX_CLAUDE_HOOKS_DISABLED` |
| 3.3 file チェックの log reason が `already_in_envrc` | OK | `envrc-prompt.ts:173` `reason=already_in_envrc` に変更済み |
| 4.1 beforeEach / afterEach で save/restore | OK | `envrc-prompt.test.ts:11`（宣言）, `19-20`（save + delete）, `35-39`（restore）|
| 4.2 新規テスト 2 件追加（envOverride 経路 / 直接 env 経路） | OK | `envrc-prompt.test.ts:92-102` envOverride 経路、`104-111` 直接 env 経路 |
| 4.3 既存 `.envrc` file テスト維持 | OK | `envrc-prompt.test.ts:55-59` が維持されており、実装側も file チェックが残っている |

## 3. タスク要件との整合性

| 項目 | 判定 | 確認内容 |
|------|------|---------|
| `process.env.CMUX_CLAUDE_HOOKS_DISABLED` が truthy で早期 return | OK | `envrc-prompt.ts:148-151` |
| 返り値が `{ action: "noop_already_set", warnings: [] }` | OK | `warnings` は関数先頭 `const warnings: string[] = []` のまま渡され、env gating 時点では空 |
| `EnvrcCheckResult` 型変更なし | OK | `action: EnvrcAction` / `warnings: string[]` のまま |
| 設計判断「両方残す」（plan.md 2.1） | OK | env チェック（146-151）と file チェック（172-175）が共存し、direnv allow 未実行ケースの重複 append を防ぐ |

## 4. テスト品質

| 項目 | 判定 | 確認内容 |
|------|------|---------|
| env リーク防止（afterEach で復元） | OK | `savedHooksDisabled` 保存 → 復元ロジックあり（既存 `savedNoPrompt` と同パターン）|
| 新規テストが実装意図を検証 | OK | envOverride 経路テストは `.envrc` の内容が書き換わっていないことも assert（重複 append 防止の観点が入っている）|
| 既存テストが壊れていない | OK | 19 pass / 0 fail、既存 17 件 + 新規 2 件 |
| 直接 env 経路テストが restore 実装を検証 | OK | 104-111 のテストが afterEach 復元に依存するため、両者の整合性が相互検証される |

## 5. テスト実行結果

```
cd /Users/yamamoto/git/cmux-team/.worktrees/task-223-1776355123/skills/cmux-team/manager
bun test envrc-prompt.test.ts
```

- **19 pass / 0 fail**
- 38 expect() calls
- 実行時間: 約 45ms

## 6. 型チェック結果

```
cd /Users/yamamoto/git/cmux-team/.worktrees/task-223-1776355123/skills/cmux-team/manager
bun x tsc --noEmit
```

- **EXIT=0**（エラー・警告なし）

## 7. 備考

- impl-summary.md の「plan.md からの逸脱なし」宣言と実装の突き合わせ: 一致
- `.envrc` 本体以外（`.envrc.local` / `~/.zshenv` / `source_up` / 外部注入）からの `CMUX_CLAUDE_HOOKS_DISABLED` 反映が env チェックで捕捉されるようになり、タスク背景の課題が解消されている
- ログ区別（`already_in_env` vs `already_in_envrc`）により、運用時にどちらの経路で skip されたか追跡可能
