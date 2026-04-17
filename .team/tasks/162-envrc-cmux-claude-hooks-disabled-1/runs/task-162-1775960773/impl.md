# 実装成果: task-162

`.envrc` への `CMUX_CLAUDE_HOOKS_DISABLED=1` 追記を初回起動時に対話的に確認する機能を実装した。

## 変更ファイル一覧

| ファイル | 種別 | 内容 |
|---------|------|------|
| `skills/cmux-team/manager/envrc-prompt.ts` | 新規 | gating（`.envrc` 不在 / 既存設定 / `envrcHookPromptSkipped` / `CMUX_TEAM_NO_PROMPT` / 非 TTY）→ 対話 → 追記 + `direnv allow` または config silence の全ロジック。テスト容易性のため `askYNQuestion` / `appendExportLine` / `EnsureOptions`（ask, envOverride, isTTY, direnvPath, runDirenvAllow）を export。 |
| `skills/cmux-team/manager/envrc-prompt.test.ts` | 新規 | Bun テスト 14 ケース。gating 5 + 対話 6 + `appendExportLine` 末尾改行ハンドリング 3。 |
| `skills/cmux-team/manager/main.ts` | 修正 | `interface TeamConfig` に `envrcHookPromptSkipped?: boolean` を追加。`cmdStart` 内で `initInfra` 直後・proxy 起動前に `await ensureEnvrcHookPrompt(PROJECT_ROOT)` を呼び出し。`ensureEnvrcHookPrompt` を import。 |
| `skills/cmux-team/manager/daemon.ts` | 修正 | `initInfra` のデフォルト `config.json` 生成に `envrcHookPromptSkipped: false` を追加（明示）。 |

## 設計上の判断（plan + design-review Recommendations 反映）

- 戻り値 `action` は plan の `noop_silenced` を `noop_env_silenced` / `noop_user_silenced` に分割（design-review 推奨）。テスト時の検証が明確になる。
- 対話プロンプト文言は `envrc-prompt.ts` 内の `PROMPT_TEXT` 定数にハードコード（i18n はスコープ外。日本語直書き）。
- `direnv allow` は `execFile("direnv", ["allow", projectRoot], { cwd: projectRoot })` で実行（design-review 推奨）。失敗してもログ + warnings のみで継続。
- `appendExportLine` は `.envrc` 末尾の改行を保証してから append。専用 export 関数として切り出しテスト可能に。
- 配置位置は `proxy 起動の前` を採用（design-review 推奨）。`initInfra` 直後・`daemon_started` ログ前。

## ログイベント（CLAUDE.md ロギングポリシー準拠）

| event | detail | 発生条件 |
|-------|--------|---------|
| `envrc_check_skipped` | `reason=env CMUX_TEAM_NO_PROMPT` / `reason=no_tty` / `reason=no_envrc` / `reason=already_set` / `reason=user_silenced` | gating で抜けた |
| `envrc_hook_prompt_shown` | (空) | 対話プロンプト表示 |
| `envrc_hook_prompt_declined` | `reason=once` | n 入力 |
| `envrc_hook_prompt_silenced` | (空) | N 入力 |
| `envrc_hook_disabled_added` | `direnv=true|false` | 追記成功 |
| `envrc_hook_disabled_add_failed` | エラー | 追記失敗（`console.error` でも 1 行通知） |
| `direnv_not_found` | (空) | direnv バイナリなし |
| `direnv_allow_failed` | エラー | `direnv allow` 失敗 |

## テスト結果

```
$ cd skills/cmux-team/manager && bun test envrc-prompt.test.ts
 14 pass
 0 fail
 26 expect() calls

$ cd skills/cmux-team/manager && bun test
 95 pass
 0 fail
 219 expect() calls
Ran 95 tests across 8 files.
```

既存テストも全件パス（既存の壊れていない）。

## テストケース（envrc-prompt.test.ts）

| # | カテゴリ | ケース | 期待 |
|---|---------|--------|------|
| 1 | gating | `.envrc` なし | `noop_no_envrc` |
| 2 | gating | `.envrc` に既存 | `noop_already_set` |
| 3 | gating | `config.envrcHookPromptSkipped=true` | `noop_user_silenced` |
| 4 | gating | `CMUX_TEAM_NO_PROMPT=1` | `noop_env_silenced` |
| 5 | gating | 非 TTY | `noop_no_tty` |
| 6 | 対話 | Y 入力 | `added`、.envrc 追記、config 不変 |
| 7 | 対話 | n 入力 | `skipped_once`、両方不変 |
| 8 | 対話 | N 入力 | `silenced`、config に true |
| 9 | 対話 | Y + direnv なし | `added` + warnings |
| 10 | 対話 | Y + direnv あり | `added`、`direnv allow` が `cwd=projectRoot` で呼ばれる |
| 11 | 対話 | N 入力 + 既存 config に他フィールド | merge される |
| 12 | append | 末尾改行なし | 改行を補って append |
| 13 | append | 末尾改行あり | そのまま append |
| 14 | E2E | ensure 経由で末尾改行なし | 改行を補って追記 |

## 完了条件チェック

- [x] plan.md 全項目を実装
- [x] `cd skills/cmux-team/manager && bun test` がパス（95/95）
- [x] 既存テストが壊れていない
- [x] 対話プロンプトは TUI 起動より前に同期実行
- [x] gating の網羅（5 種類）
- [x] ログイベントが CLAUDE.md ロギングポリシーに準拠
