# T212 Completion Summary

## タスク

`.envrc` 依存をオプション化し、worktree への `source_up` 生成経路を削除する。
`CMUX_CLAUDE_HOOKS_DISABLED=1` の伝播を spawn 時 explicit export に一本化。

## 結果: Inspection GO

## 変更ファイル

| ファイル | 変更概要 |
|---|---|
| `skills/cmux-team/manager/conductor.ts` | worktree `.envrc` 生成ブロック + `direnv allow` ブロック削除、`writeFileSync` import 除去 |
| `docs/spec/05-install-and-infrastructure.md` | `.envrc` 記述を optional 化(cmux-team spawn では不要、`claude` 直接起動時の親切機能) |
| `.team/artifacts/A007-cmux-sidebar-status-api.md` | L108: spawn 時 explicit export + T212 補足 |
| `package-lock.json` | worktree ブートストラップ時の `npm install` で 3.47.1 → 3.48.0 の 2 行差分(誤変更ではない) |
| (worktree ルート) `.envrc` | 削除(generated, untracked) |

## 削除行数

- `conductor.ts`: net -13 行(生成ブロック 6 行 + direnv allow ブロック 9 行 + import 変更)
- `docs/spec/05-install-and-infrastructure.md`: +12 / -9
- `A007-cmux-sidebar-status-api.md`: +1 / -1

## 検証

| 検証項目 | 結果 |
|---|---|
| `conductor.ts` 対象ブロック削除 | PASS |
| `writeFileSync` import 削除(他所参照なし確認) | PASS |
| `envrc_generated` / `direnv_allowed` ログ削除 | PASS |
| docs/spec の optional 化記述 | PASS |
| worktree ルートの `.envrc` 削除 | PASS |
| `bunx tsc --noEmit`(`skills/cmux-team/manager/`) | exit 0 |
| 保持対象(envrc-prompt.ts / main.ts / conductor.ts:107)無変更 | PASS |
| 静的 rg チェック残存は全て意図的 | PASS |

## 残存が意図的な箇所(plan 指示どおり保持)

- `envrc-prompt.ts` 本体 / `envrc-prompt.test.ts`: `claude` 直接起動用 optional 機能
- `main.ts:1674` `cmux send 'direnv allow 2>/dev/null\n'`: Master spawn 経路の no-op-safe 呼び出し
- `templates/{en,ja}/conductor.md:35` のコメント: Conductor prompt 内の例示(ドキュメント扱い)

## 懸念・残課題

- `templates/{en,ja}/conductor.md:35` の `direnv allow` コメント例示は、今回の scope 外として残存。後続タスクで optional 化の明記 or 削除を検討しても良い(Inspector の Minor note)
- `docs/spec/05-install-and-infrastructure.md` の historical な L40 / L387 / L396 周辺の記述が今後の仕様変更で陳腐化しないよう、docs-sync 周期で確認が望ましい

## マージ

- ブランチ: `task-212-1776272124/task`
- 納品方法: ローカルマージ(`main` へ)
- マージコミット URL: 後段で追記
