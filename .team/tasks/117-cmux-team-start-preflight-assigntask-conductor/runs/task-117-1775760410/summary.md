# task-117 実行サマリー

## タスク概要

`cmux-team start` に preflight チェックを追加し、`daemon.ts:665-670` の assignTask 失敗時処理で健全な Conductor が連鎖的に disconnected になる問題を修正する。

## フェーズ実行

| フェーズ | Agent | 結果 |
|---------|-------|------|
| Phase 1: Plan | planner | Approved（v2 で Design Review の全指摘を反映） |
| Phase 2: Design Review | design-reviewer | v1: Changes Requested（Major 2 件）→ v2: Approved |
| Phase 3: Implementation | impl | 完了（62 pass / 0 fail） |
| Phase 4: Inspection | inspector | GO |

## 変更ファイル

### 新規追加
- `skills/cmux-team/manager/preflight.ts` — git/claude/bun/書込権限を検証する preflight モジュール
- `skills/cmux-team/manager/preflight.test.ts` — 9 テスト
- `skills/cmux-team/manager/conductor.test.ts` — AssignTaskError の task kind 分類テスト 3 件

### 修正
- `skills/cmux-team/manager/main.ts` — `cmdStart()` に preflight 呼び出し挿入
- `skills/cmux-team/manager/conductor.ts`
  - `AssignTaskError` クラス + `AssignFailureKind` 型を追加・export
  - `assignTask` を throw ベースに書き換え（戻り値型 `Promise<ConductorState>`）
  - `cmux.renameTab` を個別 try/catch で包む
  - worktree 作成後に失敗した場合の cleanup（`git worktree remove --force` + `git branch -D`）
  - `spawnConductor` の assignTask 呼び出しを try/catch でラップ
- `skills/cmux-team/manager/daemon.ts`
  - `scanTasks` を export に変更
  - AssignTaskError の kind で task/conductor 分岐
  - task_aborted ログを既存フォーマット（`task_id=`, `title=`, `journal_summary=` キー）で出力
- `skills/cmux-team/manager/daemon.test.ts` — scanTasks 統合テスト 2 件追加

## テスト結果

```
bun test v1.3.11 (af24e281)

 62 pass
 0 fail
 138 expect() calls
Ran 62 tests across 6 files. [655.00ms]
```

型チェック: `bunx tsc --noEmit` は `dashboard.tsx` の既存エラー 2 件のみ残存（本タスクスコープ外）。

## 成果物

- `plan.md` — 実装計画書（v2）
- `design-review.md` — 設計レビュー結果（v2: Approved）
- `implementation-report.md` — 実装レポート
- `inspection.md` — 検品結果（GO）

## 納品方法

**ローカルマージ** — `task-117-1775760410/task` ブランチを `main` にマージ済み（no-ff merge）。

## 期待動作

1. **preflight 失敗時**: daemon / Master / Conductor は一切 spawn されず、即座にユーザーへ明確なエラーメッセージを返して exit 1
2. **preflight 通過後に worktree 失敗**: 該当タスクのみ abort（journal に理由記録）、Conductor は全員 idle のまま動作継続、他のタスクは正常に処理される
