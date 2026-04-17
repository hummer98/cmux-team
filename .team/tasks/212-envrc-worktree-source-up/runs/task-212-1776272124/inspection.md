# Inspection Report: T212

## 判定: GO

Implementer の成果物は plan.md の指示どおり完全に実行されており、静的検証と型検査もすべて通過している。削除対象・保持対象の境界が正しく守られ、残存は全て意図的な箇所のみ。

## チェック結果

| # | 項目 | 結果 | 備考 |
|---|---|---|---|
| 1-a | conductor.ts の worktree `.envrc` 生成ブロック削除 | PASS | `git diff` で L345 前後の 6 行削除を確認 |
| 1-b | conductor.ts の `direnv allow` ブロック削除 | PASS | `git diff` で L362 前後の 9 行削除を確認 |
| 1-c | `writeFileSync` import 削除 | PASS | `import { existsSync } from "fs"` に縮約。`rg 'writeFileSync' conductor.ts` → 0 件 |
| 1-d | `envrc_generated` / `direnv_allowed` ログ削除 | PASS | conductor.ts 内で grep 0 件 |
| 2-a | `docs/spec/05-install-and-infrastructure.md` の `.envrc` optional 化 | PASS | L40 (authoritative 注入経路を明記), L157 (worktree 生成しない旨), L387 (`envrcHookPromptSkipped` 補足), L394-398 (optional 機能宣言) の 4 箇所を確認 |
| 2-b | cmux-team spawn 経路では `.envrc` 不要と読める | PASS | 「`cmux-team` 経由の spawn には `.envrc` / `direnv` への依存は不要」「T212 で廃止済み」と明記 |
| 3 | worktree ルートの `.envrc` 削除 | PASS | `ls .envrc` → No such file or directory |
| 4-a | conductor.ts に `source_up`/`envrc_generated`/`direnv_allowed` 残存なし | PASS | `rg` 0 件 |
| 4-b | rg-check.txt の残存箇所がすべて意図的 | PASS | 全 32 行の内訳を確認:<br>・`envrc-prompt.ts` 本体/テスト: 保持対象<br>・`main.ts:1674` `direnv allow 2>/dev/null`: Master spawn 経路 no-op-safe、2>/dev/null で握りつぶし済み<br>・`templates/{en,ja}/conductor.md:35`: prompt 内のコメント例示 |
| 5 | `bunx tsc --noEmit` exit 0 | PASS | `cd skills/cmux-team/manager && bunx tsc --noEmit` → exit=0 |
| 6-a | `envrc-prompt.ts` の diff ゼロ | PASS | `git diff HEAD` → 空 |
| 6-b | `envrc-prompt.test.ts` の diff ゼロ | PASS | `git diff HEAD` → 空 |
| 6-c | `main.ts` の `CMUX_CLAUDE_HOOKS_DISABLED=1` 関連が変更されていない | PASS | `git diff HEAD -- main.ts` → 空 |
| 6-d | `conductor.ts:107` の `export CMUX_CLAUDE_HOOKS_DISABLED=1` が残存 | PASS | `await cmux.send(surface, \`export CMUX_SURFACE=${surface} CMUX_CLAUDE_HOOKS_DISABLED=1\n\`);` を確認 |
| 7 | `package-lock.json` の変更内容妥当性 | PASS | diff は `version: 3.47.1 → 3.48.0` の 2 行のみ。worktree ブートストラップ時の `npm install` が package.json (既に 3.48.0) に追随した結果で、誤変更ではない |

## Critical findings

なし。

## Minor notes

- `templates/{en,ja}/conductor.md:35` の `direnv allow  # .envrc がある場合` コメントは、Conductor prompt に `.envrc` 前提の手順が残っていることになる。今回の plan.md では触れない指示だったため変更していないが、`.envrc` / `direnv` 依存が optional になった旨を後続タスクで明示するか、この行自体を削除するかを検討してもよい。cmux-team 経由の起動では `source_up` が生成されなくなったので、このコメントは最早 no-op へのガイドに近い。
- impl-report.md 本文に `.envrc` 削除が "(generated, untracked)" と記載されており、git tracked ではないため commit 対象にはならない点は正しく処理されている（`git status` にも現れていない）。

## 結論

すべての必須チェック項目が PASS。Implementer の成果物は plan.md の要求を満たし、保持対象にも触れていない。**GO。**
