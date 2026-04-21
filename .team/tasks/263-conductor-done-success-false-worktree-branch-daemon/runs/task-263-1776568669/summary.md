# T263 完了サマリー

## タスク概要

`CONDUCTOR_DONE --success=false` を受信したとき、task-state が `assigned` のままなら
worktree / branch を削除せず温存し、人間が手動で rebase / 再投入を選べるようにする。

## 完了したサブタスク

| # | サブタスク | 状態 |
|---|-----------|------|
| T263-1 | `resetConductor` に `preserveWorktree` オプション追加 | ✅ |
| T263-2 | `handleConductorDone` 拡張（`opts.unresolved`） | ✅ |
| T263-3 | `CONDUCTOR_DONE` handler で `unresolved` 判定 | ✅ |
| T263-4 | `conductor.test.ts` ユニットテスト追加（case A/B + regression guard） | ✅ |
| T263-5 | `daemon.test.ts` 統合テスト追加（case C/D/E） | ✅ |
| T263-6 | `bun test` 全通過確認 | ✅ |

## 変更ファイル

- `skills/cmux-team/manager/conductor.ts` — `preserveWorktree` オプション + worktree/branch 削除ガード
- `skills/cmux-team/manager/conductor.test.ts` — 新規テスト 3 件
- `skills/cmux-team/manager/daemon.ts` — `handleConductorDone(opts)` / `CONDUCTOR_DONE` handler での `unresolved` 判定
- `skills/cmux-team/manager/daemon.test.ts` — 新規テスト 3 件

## テスト結果

- `bun test`（全体）: **592 pass / 0 fail**（1386 expect() calls, 25 files）
- 新規テスト 6 件全て green、回帰なし
- touched files の型エラー追加 0 件（既存の conductor.ts:197, daemon.test.ts:3650 の 2 件は無関係）

## 検品

- Inspector Verdict: **GO**
- Critical / Major 指摘なし
- Minor 2 件（未カバー挙動表 row の regression、plan 内部の軽微な整合）は実害なく pass

## 挙動の表（実装後の最終形）

| success | task-state | 挙動 | ログ |
|---------|-----------|------|------|
| true  | closed   | full cleanup | `task_completed` |
| true  | assigned | full cleanup（task_status ログ付与） | `conductor_done_signal task_status=assigned` → `task_completed` |
| false | closed   | full cleanup | `conductor_error task_status=closed` → `task_completed` |
| false | assigned | **worktree/branch 温存**、task-state も assigned のまま | `conductor_error task_status=assigned` → `conductor_done_unresolved ... reason=success_false_task_assigned` |
| false | aborted  | full cleanup | `conductor_error task_status=aborted` → `task_completed` |

## マージ状況

**rebase コンフリクトで停止**（人間の判断待ち）。

- commit SHA: `445d511`（worktree 内 branch `task-263-1776568669/task` に残存）
- origin/main が 2 commit 進んでいた:
  - `a705acd` fix(manager): Master タブ名を SESSION_STARTED で [N] Master に再 rename
  - `84d7a4a` feat(manager): add user_clear decision snapshot and assigning window logs (T261)
- 衝突ファイル（2 件）:
  - `skills/cmux-team/manager/conductor.test.ts`
  - `skills/cmux-team/manager/daemon.test.ts`
- daemon.ts / conductor.ts は auto-merge 成功（conflict なし）
- `git rebase --abort` 済み、worktree は clean state（commit 済み、unstaged 変更なし）

## 判断必要（人間向け）

conductor-role.md Step 9.5 に従い、以下を行ってください:

### 選択肢 A: 手動で rebase を完了させてマージ

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-263-1776568669
git fetch origin main
git rebase origin/main
# 2 つのテストファイルで衝突を解決（<<<<<<< マーカーを除去、両方の変更を統合）
git add skills/cmux-team/manager/conductor.test.ts skills/cmux-team/manager/daemon.test.ts
git rebase --continue

# テスト通過を確認
cd skills/cmux-team/manager && bun test

# main にマージ
cd /Users/yamamoto/git/cmux-team
git merge --ff-only task-263-1776568669/task

# 完了処理
cmux-team close-task --task-id 263 --journal "T263 手動 rebase 後にマージ完了"
git worktree remove .worktrees/task-263-1776568669 --force
git branch -d task-263-1776568669/task
```

### 選択肢 B: 中止（このブランチを破棄してやり直し）

```bash
cmux-team abort-task --task-id 263
cd /Users/yamamoto/git/cmux-team
git worktree remove .worktrees/task-263-1776568669 --force
git branch -D task-263-1776568669/task
```

タスクは `assigned` のまま残るため、上記いずれかを実行してください。

### 補足: 本タスクの意義

皮肉ですが、本タスクで実装した修正そのものが「rebase 衝突時に worktree を温存する」仕様対応です。
マージ後は同じシナリオで daemon 側が自動的に worktree を残すようになります。

