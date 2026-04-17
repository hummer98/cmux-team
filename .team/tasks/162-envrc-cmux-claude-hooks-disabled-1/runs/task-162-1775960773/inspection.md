# Inspection: task-162

## Verdict

**GO**

## Summary

`.envrc` への `CMUX_CLAUDE_HOOKS_DISABLED=1` 追記の対話確認機能は、plan.md と design-review.md の指示通りに実装されている。新規モジュール `envrc-prompt.ts` への切り出し、TUI 起動前の同期実行、5 種類の gating、Y/n/N の 3 分岐、`appendExportLine` の末尾改行ハンドリング、`direnv allow` の cwd 指定実行、`config.json` への merge 保存まで設計どおり。design-review の Recommendations（`noop_env_silenced` / `noop_user_silenced` の分割、`cwd: projectRoot` の指定、文言ハードコード、末尾改行テスト追加）も全て反映されている。

`bun test` は 95 pass / 0 fail で既存テストも壊れていない。型エラーは `dashboard.tsx` と `main.ts:386` の 3 件のみで、いずれも本タスク導入前から存在する pre-existing なものを確認済み（stash で検証）。

## Checklist

- [x] plan.md の全項目実装済み (gating 5 + 分岐 Y/n/N + 末尾改行 + direnv 検出)
- [x] テスト実行結果: 95 pass / 0 fail (envrc-prompt.test.ts: 14 pass)
- [x] 既存テスト非破壊（同じ 95 件すべて pass）
- [x] 型チェック: 新規エラーなし（pre-existing 3 件は本タスク無関係、stash 検証済み）
- [x] ログイベント名がポリシー準拠（`envrc_check_skipped`, `*_failed`, `*_added` 等）
- [x] 「ユーザー領域は聞く」原則: `.envrc` は同意取得後にのみ追記
- [x] テンプレート編集なし（`templates/*.md` 未変更を git diff で確認）
- [x] 後方互換性: `envrcHookPromptSkipped` は optional、既存ユーザーは `noop_already_set` で無影響
- [x] 対話プロンプト挿入位置: `main.ts:214`（`startDashboard` の line 281 より前、`initInfra` 直後・proxy 起動前）
- [x] コード品質: 命名一貫、不要 import なし、export 範囲が適切

## Findings

### Critical

なし。

### Major

なし。

### Minor

- **`silenceInConfig` 失敗時の戻り値が `skipped_once`**（`envrc-prompt.ts:188`）: ユーザーは `N`（永続スキップ）を選んだのに `skipped_once` が返る。実害はログから判別可能だが、戻り値の意味としてやや misleading。専用 action を追加するか、せめて `console.error` でユーザーに通知するのが理想。Major には至らないので Minor として記録。
- **`.envrc` 読み取り失敗時に `noop_no_envrc` を返す**（`envrc-prompt.ts:153`）: ファイルは存在するが読めなかったケースで「存在しない」扱いの戻り値になる。`log("error", ...)` は出ているので追跡は可能。レアケースかつ実害なし。
- **`PROMPT_TEXT` の i18n 未対応**: 日本語ハードコード。impl.md でスコープ外と明記されているため許容。将来 `t()` 化する場合は別タスク。
- **`Bun.which` の戻り値が `string | null`**: 設計どおり `null` ハンドリングされており問題なし（design-review Recommendation 反映済み）。

## Fix Required

なし（GO）。
