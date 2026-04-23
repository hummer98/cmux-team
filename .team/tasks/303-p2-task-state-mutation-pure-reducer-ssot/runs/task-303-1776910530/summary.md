# T303 実行サマリ

- task_id: T303
- taskRunId: task-303-1776910530
- branch: `task-303-1776910530/task`
- 実行期間: 2026-04-23 11:15 〜 12:34 (JST, 約 1h20m)

## 完了フェーズ

- Phase 1 (Planner): 1 往復 + 差し戻し 1 回
- Phase 2 (Design Review): Changes Requested → 修正 → Approved (2 往復)
- Phase 3 (Implementer): TDD で 9 ステップ実装 — 新規 state-machine/task-state-store.ts + apply-task-actions.ts
- Phase 4 (Inspector): GO 判定 (Critical 0 件)

## 変更ファイル

- CLAUDE.md (+18 行): EventBus ポリシー近辺に task-state-store 書き込み不変条件を追記
- docs/spec/07-state-machine.md (+57 行): REVERT_TO_READY 遷移表 / P2 完了マーク / Mermaid 更新
- skills/cmux-team/manager/state-machine/events.ts (+20 行): REVERT_TO_READY event 追加
- skills/cmux-team/manager/state-machine/task-fsm.ts (+38 行): REVERT_TO_READY case + 遷移テーブル更新
- skills/cmux-team/manager/state-machine/fsm.test.ts (+140 行): REVERT_TO_READY テスト
- skills/cmux-team/manager/state-machine/task-state-store.ts (新規): applyTaskEvent / updateTaskSessionId / createTaskEntry + withTaskStateLock
- skills/cmux-team/manager/state-machine/task-state-store.test.ts (新規)
- skills/cmux-team/manager/state-machine/apply-task-actions.ts (新規): cascade_children + log action handler
- skills/cmux-team/manager/state-machine/apply-task-actions.test.ts (新規)
- skills/cmux-team/manager/daemon.ts (+221/-174): D1〜D7 の mutation を applyTaskEvent / updateTaskSessionId 経由に置換、T302 ガード撤去
- skills/cmux-team/manager/main.ts (+204/-142): M1〜M9 を applyTaskEvent 経由に置換
- skills/cmux-team/manager/daemon.test.ts (+220/-): 一部テストを task-state-store.test.ts に移動、`__testApplyAssignCommit` 依存削除
- skills/cmux-team/manager/task.ts (+76/-): cascadeAbortToChildren を純関数化 + task-state-store 互換

合計: 9 ファイル変更 + 4 新規 (+570/-424 行)

## テスト結果

- `bun test` (skills/cmux-team/manager): **1152 pass / 0 fail** (2717 expect 呼出, 38 ファイル, 48.80s)
- `bunx tsc --noEmit`: エラー 3 件（すべて main 側にも存在する既存エラー、本タスクで新規導入なし）

## grep invariant（Plan §4 Step 8）

- `rg 'taskState\[.*\]\s*=' daemon.ts main.ts`: **0 件**
- `rg 'ts\[[^\]]+\]\s*=\s*\{' daemon.ts main.ts`: **0 件**
- `rg 'saveTaskState\(' skills/cmux-team/manager/` (test 除く): **task.ts / task-state-store.ts のみ**
- `rg 'taskStateModified' skills/cmux-team/manager/`: **0 件**
- `rg 'shadowObserveTask' skills/cmux-team/manager/`: task-state-store.ts / apply-task-actions.ts / shadow.ts のみ（store 内一元化）

## 納品

- 納品方式: ローカルマージ（ff-only）
- マージコミット: （Step 9 で追記）

## 後続タスク候補（Inspector の残課題より）

1. 24h 実稼働観測（fsm_shadow_diff = 0 を確認）
2. file lock による cross-process 保護（24h 観測で diff が出た場合のみ）
3. 未使用 import のクリーンアップ（daemon.ts:20, main.ts:42）
4. task-state-store.ts:207-209 の status override 重複コード削除
5. cmdCloseTask の close 時 resume metadata 残存方針の決定

## Plan から逸脱した判断

- M2 bulk refresh は当面残す (Plan §3.8 / R6 反映)。`refreshTaskStateFromDisk` ヘルパとして保存し、直接 mutation は撤去したが bulk refresh そのものは削除していない
- R4 (patch signature): `{ merge, remove }` 形式で実装（function ではなくオブジェクト形式を選択。restart の field 削除を明示的に表現可能）
- R14 (createTaskEntry vs applyTaskEvent 統合): 別 API のまま残した（plan 最終版で選択済み）
