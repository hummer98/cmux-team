# Task 130 Summary: CMUX_CLAUDE_HOOKS_DISABLED=1 を Conductor/Agent spawn 時に設定

## 完了ステータス: GO

## 変更ファイル
- `skills/cmux-team/manager/main.ts` — Agent spawn の exportVars に `CMUX_CLAUDE_HOOKS_DISABLED=1` 追加
- `skills/cmux-team/manager/conductor.ts` — 初回 Conductor 起動（L168）と再spawn（L543）の export に追加

## テスト結果
- TypeScript 型チェック: 今回の変更に起因するエラーなし
- Inspection: GO（全5項目合格）

## マージ
- ローカル fast-forward マージ完了（main ← task-130-1775828141/task）
- コミット: 83384d5
