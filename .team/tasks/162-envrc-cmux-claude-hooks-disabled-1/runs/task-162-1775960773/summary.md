# Task 162 Summary

## 概要

プロジェクトルートで直接 `claude` を起動した際の cmux claude-hook 通知と cmux-team 通知の重複を防ぐため、daemon 起動時（Master spawn 前・TUI 起動前）に `.envrc` へ `export CMUX_CLAUDE_HOOKS_DISABLED=1` を追記することを対話で提案する機能を追加した。

## フェーズ実行結果

- **Phase 1 (Plan)**: `plan.md` 作成（196行）
- **Phase 2 (Design Review)**: **Approved**。Recommendations（`noop_env_silenced`/`noop_user_silenced` 分割、`cwd: projectRoot` 指定、末尾改行ハンドリング等）を Implementer に伝達
- **Phase 3 (Implementation)**: 新規 2 ファイル + 修正 2 ファイル、テスト 14 件追加、全 95 件 pass
- **Phase 4 (Inspection)**: **GO**。Critical なし

## 変更ファイル

| ファイル | 種別 |
|---------|------|
| `skills/cmux-team/manager/envrc-prompt.ts` | 新規（ensure/appendExportLine/askYNQuestion 等） |
| `skills/cmux-team/manager/envrc-prompt.test.ts` | 新規（14 テストケース） |
| `skills/cmux-team/manager/main.ts` | 修正（`TeamConfig.envrcHookPromptSkipped` 追加、`cmdStart` で `ensureEnvrcHookPrompt` 呼び出し） |
| `skills/cmux-team/manager/daemon.ts` | 修正（default config に `envrcHookPromptSkipped: false` 明示） |
| `package-lock.json` | 修正（version 同期） |

## テスト結果

- `bun test envrc-prompt.test.ts`: **14 pass / 0 fail**
- `bun test` 全件: **95 pass / 0 fail**（既存テスト非破壊）

## 設計判断のポイント

1. **「ツール領域は黙って、ユーザー領域は聞く」原則**: .envrc はユーザー所有なので同意後にのみ追記
2. **挿入位置**: `initInfra` 直後・proxy 起動前・Ink TUI 起動前に同期実行（stdin を奪われる前に対話可能）
3. **Gating**: 5 条件（.envrc 存在 / 既存設定なし / envrcHookPromptSkipped / CMUX_TEAM_NO_PROMPT / TTY）を全て満たす場合のみ対話
4. **direnv 未検出**: warning ログを残しつつ追記は実行（ユーザーが後で有効化可能）
5. **.envrc 末尾改行**: `appendExportLine` で改行保証してから append

## 納品方法

**ローカルマージ**（main ブランチ）

- ブランチ: `task-162-1775960773/task`
- コミット: `a96e1cd feat: 初回起動時に .envrc へ CMUX_CLAUDE_HOOKS_DISABLED=1 追記を対話提案`
- マージコミット: `main` に no-ff マージ済み

## 懸念事項

- 対話プロンプトは TTY 時のみ動作。CI 等の非 TTY 環境では `CMUX_TEAM_NO_PROMPT` 設定不要で自動スキップされる
- `envrcHookPromptSkipped` を再度 `false` に戻す CLI コマンドは未実装（plan.md で将来タスクとして明記）。手動で `.team/config.json` を編集すれば戻せる
