# T185 summary

## 完了したサブタスク

- `skills/cmux-team/manager/main.ts` に `--version` / `-v` の先行 dispatch 追加
- `skills/cmux-team/manager/i18n.ts` の `help_main` (en / ja) Usage 先頭に `cmux-team --version` 行追加

## 変更ファイル

- skills/cmux-team/manager/main.ts (+12)
- skills/cmux-team/manager/i18n.ts (+2)

## テスト結果

- `bun main.ts --version` → `cmux-team 3.44.1` ✅
- `bun main.ts -v` → `cmux-team 3.44.1` ✅
- `bun main.ts --help` → Usage に `cmux-team --version` が含まれる ✅

## 納品

- worktree ブランチ `task-185-1776135573/task` を main にマージ済み
- マージコミット: `f69fdc5 Merge branch (T185 --version flag)`
- 実装コミット: d7f11d6 feat(cli): add --version / -v flag to cmux-team
