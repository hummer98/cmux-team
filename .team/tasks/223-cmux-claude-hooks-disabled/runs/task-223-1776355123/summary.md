# T223 完了サマリー — envrc-prompt の env 変数チェック追加

## 完了したサブタスク

- Phase 1: Planner Agent で plan.md 作成（GO 判定の計画書）
- Phase 3: Implementer Agent で TDD 実装
- Phase 4: Inspector Agent で検品（GO 判定）

## 変更ファイル

- `skills/cmux-team/manager/envrc-prompt.ts`
- `skills/cmux-team/manager/envrc-prompt.test.ts`

## 主要な変更点

- `ensureEnvrcHookPrompt` の gating に `CMUX_CLAUDE_HOOKS_DISABLED` env チェックを追加（`CMUX_TEAM_NO_PROMPT` 直後）
- env hit 時は log `reason=already_in_env` で早期 return
- 既存の `.envrc` ファイル内容チェックも残し、log reason を `already_in_envrc` に改名（direnv allow 未実行時の重複 append 防止のため両方残す判断）
- `EnsureOptions.envOverride` 型に `CMUX_CLAUDE_HOOKS_DISABLED?: string` 追加
- テスト beforeEach/afterEach に `CMUX_CLAUDE_HOOKS_DISABLED` の save/restore を追加
- 新規テスト 2 件（envOverride 経由 / 直接 `process.env` 経路）

## 検証結果

- `bun test envrc-prompt.test.ts`: **19 pass / 0 fail**
- `bun x tsc --noEmit`: **EXIT=0**

## 納品

- ローカルマージ先: `main`
- マージコミット: 本サマリー作成時点で実施
