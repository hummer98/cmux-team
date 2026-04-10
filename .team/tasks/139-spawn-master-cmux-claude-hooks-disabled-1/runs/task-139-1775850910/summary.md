# Task 139: spawn-master に CMUX_CLAUDE_HOOKS_DISABLED=1 を追加

## 結果: GO (成功)

## 変更内容

- `skills/cmux-team/manager/main.ts` の `cmdLaunchMaster()` に `process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1";` を1行追加
- conductor, resume, spawn-agent と同じパターンに統一

## 変更ファイル

- `skills/cmux-team/manager/main.ts` (+1 行)

## マージ

- ローカル fast-forward マージ: `873f004`
