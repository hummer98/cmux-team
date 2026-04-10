# Task 108: ダッシュボード Tasks の並び順を修正

## Status: GO (完了)

## 変更ファイル
- `skills/cmux-team/manager/daemon.ts` — open タスクのソートを priority → createdAt 降順に変更
- `skills/cmux-team/manager/task.ts` — `sortOpenTasksForDisplay` 関数を追加
- `skills/cmux-team/manager/daemon.test.ts` — テスト3ケース追加

## テスト結果
- 16 tests, 0 fail, 27 expect() calls

## マージ
- Fast-forward マージ: `task-108-1775657676/task` → `main`
- コミット: `cdb0f3f`
