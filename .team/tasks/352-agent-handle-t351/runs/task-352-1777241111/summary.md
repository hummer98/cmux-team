# T352 Summary: Agent 行のスピナー直後に @handle を配置（T351 後続調整）

## 完了したサブタスク

| Phase | Agent | 成果物 |
|-------|-------|--------|
| Phase 1: Plan | Planner | `plan.md`(15KB) — 設計判断 (A) `includeHandle` フラグ追加方式を採用 |
| Phase 2: Design Review | Design Reviewer | `design-review.md`(9KB) — Approved + 5 件の minor recommendation |
| Phase 3: Implementation | Implementer | `dashboard.tsx` / `dashboard-conductor.test.tsx` / `dashboard-pool.test.tsx` |
| Phase 4: Inspection | Inspector | `inspection-report.md`(7KB) — GO 判定、Fix Required なし |

## 設計判断

**(A) `buildPoolSuffixForSurface` に `includeHandle: boolean = true` 引数追加** を採用。

理由:
- format 層 (`pool-surface-row.ts`) は CLI/dashboard 共通のため触らない
- Master / Conductor 行はデフォルト `true` で T351 挙動を維持、Agent 行のみ `false` を渡す
- (B) 専用ヘルパー新設はコード量が増える割に内部的に同じ helper を再利用するだけで非効率
- (C) `slice(1)` 単独は fragile だが、(A) の枠内で **post-process を helper の責務境界の内側に閉じ込める** + 順序契約テストで担保することで安全化

## 変更ファイル

```
 skills/cmux-team/manager/dashboard-conductor.test.tsx | 242 ++++++++++++++++++++-
 skills/cmux-team/manager/dashboard-pool.test.tsx      |  31 ++-
 skills/cmux-team/manager/dashboard.tsx                |  31 ++-
 3 files changed, 295 insertions(+), 9 deletions(-)
```

- `pool-surface-row.ts` は **無変更**（API 契約維持）

## 主な変更点

1. `dashboard.tsx`
   - `buildPoolSuffixForSurface` に `includeHandle: boolean = true` 引数追加
   - `includeHandle: false` 時は `buildSurfaceRowSuffix(...).slice(1)` で先頭 handle ノードを除く
   - Agent 行 3 status (running / idle / asking) を `roleIcon / @handle / label` の独立 ui.text 構成にリレイアウト
   - idle 行: roleIcon の dim を解除、taskTitle のみ dim 維持（仕様要件）
   - 各 status の handle 色: running CYAN / idle plain / asking YELLOW

2. `dashboard-conductor.test.tsx`
   - T352-1〜T352-8 を追加（running/idle/asking × bound/unbound + pool OFF + 順序）
   - T352-1 (running CYAN) / T352-3 (asking YELLOW) で `style.fg` を RegExp で assertion 化

3. `dashboard-pool.test.tsx`
   - case 8: `(no token)` を **含まない** に反転、`countSurfaceLabel` 検証は維持
   - case 11 (新規): `buildSurfaceRowSuffix` 戻り値順序契約「bound 入力で先頭は必ず `@handle` text node」を 4 入力パターンで固定化

## テスト結果

```
$ cd skills/cmux-team/manager
$ bun test --timeout 30000 dashboard-conductor.test.tsx dashboard-pool.test.tsx \
    dashboard-issues.test.tsx dashboard-metrics.test.tsx
68 pass / 0 fail / 196 expect() calls
```

## tsc 結果

```
$ bunx tsc --noEmit
0 errors
```

## Design Review 5 件の対応

| # | Recommendation | 対応 |
|---|----------------|------|
| 1 | 順序契約テスト必須化 | ✅ case 11 で 4 パターン固定化 |
| 2 | case 8 で `countSurfaceLabel` 残す | ✅ 重複禁止 invariant 維持 |
| 3 | T352-7 (pool OFF) を絞り込み | ✅ `@` / suffix 不在の 4 条件に限定 |
| 4 | T352-8 順方向不等式 | ✅ chained `toBeLessThan` |
| 5 | 色 assertion を含める | ✅ T352-1 / T352-3 で `style.fg` regex assertion |

## 残課題 / 申し送り

- **実機目視確認は未実施**: design-review #5 で必須化推奨されていたが、worktree 内で `cmux-team start` を立ち上げると本物の Manager と競合するため Implementer は省略。色 / dim の検証は test (`style.fg` assertion) + コードレビューで担保。
- `buildPoolSuffixForSurface` のシグネチャは「surface row 整形 + dashboard 表示都合 (handle 抑止)」の 2 責務に薄く広がった。将来 Master 行も含む広範な表示制御が必要になった時点で caller 種別 (`master`/`conductor`/`agent`) で param 化する案 (B) への再リファクタを検討。今回は YAGNI で OK。

## マージコミット

(commit 後に追記)

実マージコミット: `e1ce0ba` (`feat(dashboard): Agent 行のスピナー直後に @handle を配置 (T352)`)
納品方式: ローカル ff-only マージ（`task-352-1777241111/task` → `main`）
