# T255 Summary

## タスク

initializeLayout の Conductor 復帰ロジックを単純化する。team.json + PID alive 一本で判定 → 1 件でも生きていれば早期 return のため部分復元時に `maxConductors` 未達のままになるバグと、PID 死亡 + surface 残骸の掃除不能問題を解消する。

## 完了したサブタスク

| Phase | Agent | 成果 |
|-------|-------|------|
| 1 Plan | Planner (2 回) | plan.md 528 行。Changes Requested → 11 件対応で Approved |
| 2 Design Review | Reviewer (2 回) | review.md 132 → 2nd pass で Approved |
| 3 TDD Impl | Implementer | layout-restore.ts 新規 + daemon.ts / cmux.ts / daemon.test.ts 変更。全 542 テスト pass、tsc エラー 0 |
| 4 Inspection | Inspector | inspection.md GO 判定。Critical finding なし、Non-critical 4 件のみ情報共有 |

## 変更ファイル

- `skills/cmux-team/manager/layout-restore.ts`（新規）— pure function `planLayoutRestore` + 型定義
- `skills/cmux-team/manager/layout-restore.test.ts`（新規）— 10 ケース
- `skills/cmux-team/manager/cmux.ts`（変更）— `fetchLiveSurfaces(workspace)` 追加
- `skills/cmux-team/manager/daemon.ts`（変更）— `initializeLayout` を薄いオーケストレータに書き換え、新ヘルパー `restoreConductorState` / `revertTaskToReady` / `applyRestorePlan` 追加
- `skills/cmux-team/manager/daemon.test.ts`（変更）— M6, M7, M10, M11, M12, M14, M15, M16 + `layout_kept_partial` + 廃止ログ検証の 10 ケース追加

## 主要設計判断

1. **復帰時は pane 新規分割を行わない**（maxConductors 未達でも許容）。`conductorsFromJson.length === 0` のときだけ `initializeConductorSlots` を呼ぶ。監視は `layout_kept_partial` ログで可観測化
2. **unmatched resume / D 経路は新 slot 合流ではなく task-state を ready に戻し次 tick に委ねる**。pane 新規作成をしない方針と整合
3. **B 経路 pre-set → launchConductor throw 時は rollback**（state.conductors.delete + task-state ready）
4. **tree 失敗 (liveSurfaces=null) 時は保守側に倒す** — B/D/C 分岐を全て回避し、次 tick の disconnected 経路で最終的に人間判断に委ねる
5. **A 決定時の task-state 整合性リコンサイル**: `task-state[taskId].status !== "assigned"` なら idle にリセット

## テスト結果

```
bun test:      542 pass / 0 fail / 1281 expect (24 files, 22.57s)
bunx tsc --noEmit: エラー 0
```

## 廃止ログ

- `conductor_resume_noop`
- `conductor_restore_skipped`

## 追加ログ

- `conductor_stale_surface_closed`
- `resume_worktree_missing_late`
- `tree_fetch_failed`（cmux.ts 側）
- `conductor_taskid_reconciled`
- `conductor_resume_launch_failed`
- `resume_unmatched_to_ready`
- `layout_kept_partial`

## Non-critical Findings（Inspector 情報共有）

1. `resume_unmatched_to_ready` ログの reason フィールド形式が plan の推奨と若干異なる（session_id に置換）。外部依存なし
2. `conductors_restored` の surfaces リストに rollback 済み B 経路 surface が含まれる可能性（ログ表示のみ、副作用なし）
3. M8 (`resume_worktree_missing_late`) の専用テスト不在。同経路ロジック自体は 4 行で回帰リスク低
4. `conductor_taskid_reconciled` 時に `taskTitle` も一緒にクリアしている（plan の明示範囲外だが整合性的に妥当）

## 統合履歴

- 旧 T252（PID 死亡 + surface 残骸掃除）を本タスクに統合

## マージ方針

ローカルマージ（CLAUDE.md 規約に従う）。
