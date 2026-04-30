# T302 結果サマリー

## タスク

T220 race 修正（暫定ガード）: `delete-task` が `assignTask` 進行中に割り込むと
`task-state.json` の status が `deleted → assigned → aborted` と巻き戻る race を塞ぐ。

## 実施フェーズ

1. **Phase 1 Plan** (Planner Agent) — plan.md 448 行作成（方針 B: `__testApplyAssignCommit` helper export）
2. **Phase 3 Impl** (Implementer Agent) — TDD で実装、`bun test` 1088/1088 pass / tsc 新規エラー 0 件
3. **Phase 4 Inspection** (Inspector Agent) — **GO** 判定（自分で bun test / tsc / git diff を再実行して検証）

Design Review は skip（タスク本文で修正内容が具体的に指示されており設計判断余地が小さいため）。

## 変更ファイル

| ファイル | 差分 |
|---------|------|
| `skills/cmux-team/manager/daemon.ts` | +64 行 / -12 行（`__testApplyAssignCommit` helper 新設 + scanTasks 側を呼び出しに置換） |
| `skills/cmux-team/manager/daemon.test.ts` | +213 行（`describe("T302 assign_skipped_terminal guard", ...)` 5 ケース追加） |

import 追加なし（`isTerminalStatus` / `resetConductor` / `formatSurface` / `log` / `loadTaskState` / `saveTaskState` は既存 import を再利用）。

## 実装要点

- `daemon.ts` の `scanTasks` 内 assign 完了書き込みブロックを `__testApplyAssignCommit(state, task.id, updated)` 呼び出しに置換
- ガード条件: `ts[taskId]?.status` が `isTerminalStatus`（closed/aborted/deleted）を満たす場合
  - `task-state.json` への書き込みを skip
  - `resetConductor` で worktree cleanup + Conductor idle 化
  - ログ: `assign_skipped_terminal C[<surface>] task_id=<id> current_status=<s> taskRunId=<id>`
- JSDoc / インラインコメント / 要対象に `TODO(T303): remove after reducer migration` マーカーを付与
- T303 reducer 置換時に helper ごと削除する契約を明記

## テスト結果

- `bun test`: **1088 pass / 0 fail**（新規 T302 の 5 ケース含む）
  - T302 フィルタ: `5 pass / 0 fail`
  - 内訳: deleted race / aborted race / closed race / ready normal / undefined status
- `bunx tsc --noEmit`: **新規エラー 0 件**（既存 3 件は本実装と無関係）
- 副作用検証: task-state の status 巻き戻りなし、Conductor idle 復帰、ログ emit を確認

## 受容したリスク（plan.md 5.1 / 5.2）

- ガード発動時点で `/clear` + プロンプトは既送信済み → Claude セッションは空の /clear 後に不在の worktree/path を読みに行って早期 idle 化する。Conductor は自律再起動可能で受容可
- `loadTaskState → saveTaskState` 間の sub race は残る（発生確率は本題 race の 10^-3 以下）。T303 reducer 置換で構造的に解消予定

## 納品方式

ローカルマージ（ff-only）予定。race 修正 + テスト追加で破壊的変更なし、個人プロジェクト管理下のため。

## 完了レポート（Step 12 参照）

次の完了処理でマージコミット SHA を埋める。
