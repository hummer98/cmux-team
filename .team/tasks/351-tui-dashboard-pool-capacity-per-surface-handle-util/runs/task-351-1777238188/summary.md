# T351 結果サマリー

ライブ TUI dashboard に pool capacity ヘッダー + per-surface handle/util 表示を実装。

## フェーズ進行

| Phase | Agent | 結果 |
|---|---|---|
| 1. Plan | Planner (1 度) → Planner rev2 (Reviewer 指摘反映) | plan.md (revision 2) |
| 2. Design Review | Design Reviewer (2 往復) | Changes Requested → Approved |
| 3. Implementation | Implementer (1 度) | 4 commits, 7 files, 968+/77- |
| 4. Inspection | Inspector (1 度) | **GO** |

## 完了したサブタスク

- pool-summary.ts に `buildPoolSummary` / `loadPoolSummary` を切り出し（CLI と dashboard で共有）
- `cmdStatus` の旧 in-line ロジックを `loadPoolSummary` 経由に切替
- `DaemonState.tokenDb` を boot 時 1 度だけ open、`DaemonState.pool` を tick 後に refresh
- `pool-surface-row.ts` に `buildSurfaceRowSuffix` を追加（`[surface]` を含まない suffix UI ノード）
- `dashboard.tsx` に `buildPoolHeader` / `buildConductorRowWithPool` を追加、Master / Conductor / Agent 行に handle/util を表示
- 新規 test (`pool-summary.test.ts` 7 tests, `dashboard-pool.test.tsx` 16 tests)

## 変更ファイル

| ファイル | 種別 |
|---|---|
| `skills/cmux-team/manager/pool-summary.ts` | 新規 |
| `skills/cmux-team/manager/pool-summary.test.ts` | 新規 |
| `skills/cmux-team/manager/dashboard-pool.test.tsx` | 新規 |
| `skills/cmux-team/manager/daemon.ts` | 修正 |
| `skills/cmux-team/manager/main.ts` | 修正 |
| `skills/cmux-team/manager/dashboard.tsx` | 修正 |
| `skills/cmux-team/manager/pool-surface-row.ts` | 修正 |

合計: 7 files changed, 968 insertions(+), 77 deletions(-)

## commit 一覧

```
90bb827 feat(token): pool-summary 共有モジュール切り出し (T351 Step 1)
935b2a3 refactor(cli): cmdStatus を loadPoolSummary 経由に切替 (T351 Step 2)
8696c8b feat(daemon): tokenDb / pool snapshot を DaemonState に追加 (T351 Step 3)
8eaea2a feat(dashboard): pool capacity ヘッダー + per-surface handle/util 表示 (T351 Step 4-6)
```

## テスト結果

- `bunx tsc --noEmit`: **0 errors**
- 個別 file 単位テスト: **74 pass / 0 fail / 180 expect()**
  - pool-summary.test.ts: 7 / 0
  - pool-surface-row.test.ts: 8 / 0
  - dashboard-conductor.test.tsx: 6 / 0 (回帰なし)
  - dashboard-issues.test.tsx: 11 / 0 (回帰なし)
  - dashboard-metrics.test.tsx: 26 / 0 (回帰なし)
  - dashboard-pool.test.tsx: 16 / 0 (新規)

## マージ・close-task

後続ステップで記録。

## 残課題（follow-up）

Inspector の minor 指摘 1 件（`loadPoolSummary` 失敗時 silent 化、旧 `cmdStatus` の `console.log` を喪失）は本タスク DoD 範囲外のため **T356 として起票済み**（status: draft）。

DoD の「マージ後の目視確認推奨」2 項目（pool ON / OFF dashboard の実画面確認）は worktree 内では実プロジェクト dashboard を起動できないため、純関数 test での代替検証に留め、マージ後ユーザー側で 1〜2 分の目視確認を推奨。
