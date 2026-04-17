# T223 実装サマリー — envrc-prompt の env 変数チェック追加

## 変更したファイル

- `skills/cmux-team/manager/envrc-prompt.ts`
- `skills/cmux-team/manager/envrc-prompt.test.ts`

## 主要な変更点

- `EnsureOptions.envOverride` の型に `CMUX_CLAUDE_HOOKS_DISABLED?: string` を追加
- `CMUX_TEAM_NO_PROMPT` チェックの直後に `CMUX_CLAUDE_HOOKS_DISABLED` env チェック gating を追加（`reason=already_in_env` でログ、`noop_already_set` を返す）
- 既存の `.envrc` ファイル内容チェックの log reason を `already_set` → `already_in_envrc` に変更（env 由来との区別）
- テスト beforeEach/afterEach に `CMUX_CLAUDE_HOOKS_DISABLED` の save/restore を追加
- 新規テスト 2 件追加（envOverride 経由 / `process.env` 直接 mutation 経路）

## テスト結果

- `bun test envrc-prompt.test.ts`: **19 pass / 0 fail**（既存 17 + 新規 2）
- 38 expect() calls

## 型チェック結果

- `bun x tsc --noEmit`: **EXIT=0**（エラー無し）

## 気づいた点・plan.md からの逸脱

- 逸脱なし。plan.md の 3.1 / 3.2 / 3.3 / 4.1 / 4.2 / 4.3 をそのまま実装
- TDD 順序通り：テスト先行 → fail 確認（2 件）→ 実装 → green 確認
- plan.md 4.4 に記載の通り削除テストはなし。返り値 `noop_already_set` および `EnvrcAction` 型は変更不要
- 「両方残す」設計判断（plan.md 2.1）に基づき env 経路と file 経路の両方が機能する。env が無いが `.envrc` に export 行あり（direnv allow 未実行）のケースも引き続き file チェックで skip される
