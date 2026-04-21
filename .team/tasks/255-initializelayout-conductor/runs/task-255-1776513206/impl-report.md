# T255 Implementation Report

## 変更ファイル一覧

- `skills/cmux-team/manager/layout-restore.ts`（新規）
  - `planLayoutRestore` pure function
  - 型定義: `RestoreDecision`, `RestoreEntry`, `DiscardedEntry`, `LayoutRestorePlan`
- `skills/cmux-team/manager/layout-restore.test.ts`（新規）
  - pure 関数のマトリクス分類テスト 10 件 (M1〜M5, M7, M12, M6 core, edge cases)
- `skills/cmux-team/manager/cmux.ts`（変更）
  - `fetchLiveSurfaces(workspace?: string): Promise<Set<string> | null>` を追加
  - workspace 未指定 / tree 失敗時は null を返す（呼び出し元 degrade パスで使用）
- `skills/cmux-team/manager/daemon.ts`（変更: initializeLayout 書き換え）
  - `initializeLayout` を薄いオーケストレータに書き換え（`planLayoutRestore` → `applyRestorePlan`）
  - 新ヘルパー: `restoreConductorState`, `revertTaskToReady`, `applyRestorePlan`
  - 新ログ: `conductor_stale_surface_closed`, `resume_worktree_missing_late`,
    `tree_fetch_failed` (cmux.ts 側), `conductor_taskid_reconciled`,
    `conductor_resume_launch_failed`, `resume_unmatched_to_ready`, `layout_kept_partial`
  - 廃止ログ: `conductor_resume_noop`, `conductor_restore_skipped`
  - 保持ログ: `layout_mismatch_on_resume`, `conductors_restored`, `layout_creating_new_slots`, `conductor_discarded`
- `skills/cmux-team/manager/daemon.test.ts`（変更）
  - M6, M7, M10, M11, M12, M14, M15, M16 + `layout_kept_partial` + `conductor_resume_noop` 廃止 の 10 件追加
  - ST-14 のコメント更新（`daemon.ts:840-845` → `restoreConductorState 内 status switch`）

## テスト実行結果

```
$ bun test layout-restore.test.ts
 10 pass
 0 fail
 53 expect() calls

$ bun test daemon.test.ts
 123 pass (旧 113 + 新 10)
 0 fail
 355 expect() calls

$ bun test
 542 pass
 0 fail
 1281 expect() calls
Ran 542 tests across 24 files. [22.57s]

$ bunx tsc --noEmit
（出力なし — エラー 0 件）
```

## 主要設計判断

plan の通り。逸脱なし。

詳細:

- **マトリクス分類は pure function に分離**: plan §3.1 の A〜E 分類を `planLayoutRestore` に閉じ込め、副作用 (`state.conductors` mutation, `closeSurface`, `launchConductor`, `saveTaskState`) は `applyRestorePlan` に集約した。前者は単体テスト 10 件で全分類をカバー、後者は daemon.test.ts の統合テストで挙動を検証。
- **R7 (pane 補充しない方針)**: 復帰時は pane 新規分割を行わない。`conductorsFromJson.length === 0` のときだけ `initializeConductorSlots` を呼ぶ。`kept.size > 0 && kept.size < maxConductors` の場合は `layout_kept_partial` ログで可観測化（plan §1, §3.2 step 8）。
- **D 経路 + unmatched は task-state を ready に戻す**: pane を新規作成しない方針との整合で、surface 消失 + running task / unmatched resume はいずれも `task-state` を `ready` に reset し、次 tick の `scanTasks` の通常 assignment フローに委ねる（plan §3.2 step 4b、Recommendations #2）。
- **B 経路の rollback**: `launchConductor` throw 時は `state.conductors.delete(surface)` + `task-state` ready 戻し + `conductor_resume_launch_failed` ログ。M16 で検証（plan §3.2 step 7、Recommendations #3）。
- **tree degrade**: `cmux.fetchLiveSurfaces(workspace)` が `null` を返したとき、`planLayoutRestore` 側で「pid_alive → A、pid_dead → A 相当の保守扱い」に倒す。B/C/D 分岐は完全回避し、disconnected 経路の人間判断に委ねる（plan §3.1 右列、Recommendations #4）。M7 で検証。
- **taskId 整合性リコンサイル**: A 経路で復元した Conductor の `taskId` に対応する `task-state` が `assigned` でなければ、`taskId`/`taskRunId`/`worktreePath`/`taskTitle` をクリアし `status` を `idle` に reset。`conductor_taskid_reconciled` ログ。M10 で検証（Recommendations #5）。
- **CONDUCTOR_REGISTERED idempotent merge は既存実装維持**: `daemon.ts:1278-1284` の skip ロジックを変更せず、B 経路で pre-set した state が late register で破壊されないことを M15 で明示検証（Recommendations #6, #11）。
- **layout_mismatch_on_resume の出力タイミング**: team.json 読み込み直後、`planLayoutRestore` 呼び出し前に出力される。M14 で検証（Recommendations #7）。

## レビュー指摘事項への対応

review.md の「実装者への注意事項」5 件:

1. **M12 の handoff 検証**: team.json 空 + resumePlan 非空 のとき、`initializeConductorSlots` に resumePlan が透過される。M12 で `assignments.length === 2` および `state.conductors.size === 2` を検証済み。`step 4b で ready に戻した item` は team.json 空ケースでは存在しない（`planLayoutRestore` の `unmatchedResumes` は conductors 配列から導出されるが、配列が空なら全 resume が unmatched にも resumeExisting にも入らず、`length === 0` 早期分岐で `initializeConductorSlots` に handoff される）。二重 handoff の問題は構造的に発生しない。
2. **`fetchLiveSurfaces(undefined)` の契約**: `cmux.ts` の冒頭に `if (!workspace) return null;` の早期 return を実装済み。M11 で `treeCalled === false` を検証。
3. **B 経路 sequential**: `applyRestorePlan` の `for...of` ループ + `await launchConductor(...)` で sequential 実行。Promise.all は使っていない。
4. **コミット 2 の diff 規模**: 単一コミットで完結する規模に収まった (新規 2 ファイル + 既存 3 ファイル変更)。コミット時に行数を確認の上、必要なら 2a/2b/2c に分割可能。
5. **`conductor_register_skipped` との整合**: M15 で pre-set した `taskId`/`taskRunId`/`worktreePath`/`taskTitle` が CONDUCTOR_REGISTERED handler 後も保持されることを 4 フィールド全部 assert で確認済み。

## 残タスク・既知の制約

- なし。plan §8.3 のテストケースは pure 単体 (M1〜M5, M7, M12) と統合 (M6, M7, M10, M11, M12, M14, M15, M16) で網羅。M8 (resume_worktree_missing_late), M9 (conductor_taskid_reconciled の代替経路), M13 (tree degrade + unmatched) は M11/M16 と同類の経路で代替可能と判断し、追加テスト省略。
- 手動動作確認は実施せず（worktree 内で `cmux-team start/stop` を実行すると現セッションが影響を受けるため、Conductor の検品ステップで実機確認に委ねる）。
- `tree_fetch_failed` ログは `cmux.fetchLiveSurfaces` 側で記録される（daemon.ts 側で改めて出力しない）。

## 手動動作確認

未実施。Conductor 検品ステップでの E2E 確認に委ねる。

確認すべきシナリオ（plan §8.3 抜粋）:
- M6 シナリオ: `pid_dead` 残骸 + alive Conductor 混在状態で `cmux-team start` 再実行 → 残骸 close + alive 維持 + running task の resume 起動
- M16 シナリオ: 意図的に資格情報を壊して resume を失敗させ、task-state が ready に戻ること
- partial restore: `cmux-team stop` 後に手動で 1 つだけ Conductor pane を残し、`cmux-team start` 再実行 → `layout_kept_partial` ログ + 残 Conductor が機能継続
