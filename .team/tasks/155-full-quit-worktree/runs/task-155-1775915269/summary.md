# Task 155: full_quit から worktree 削除を撤廃する — 完了

## 結果: GO (成功)

## 変更内容

1. **full_quit の worktree クリーンアップブロック削除** (main.ts:342-357)
   - `// 4. worktree をクリーンアップ` ブロック全体を削除
   - assigned タスクの worktree が無条件削除される問題を解消

2. **resume_fallback_to_ready ログの詳細化** (main.ts:443)
   - `worktreePath`, `sessionId`, `taskRunId` の情報を追加
   - デバッグ時に resume 失敗の原因を特定しやすくなった

## 変更ファイル

- `skills/cmux-team/manager/main.ts` (+1, -18)

## 検証結果

- `bun build` 成功（348 modules bundled）
- grep で full_quit 内に worktree/git コマンド関連コードがないことを確認

## マージ

- Fast-forward マージ済み: `045ba7a..29b574c`
- ブランチ `task-155-1775915269/task` 削除済み
