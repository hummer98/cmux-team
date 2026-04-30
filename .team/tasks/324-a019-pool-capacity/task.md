---
id: 324
title: A019 pool_capacity 検証表の数値不整合の最終判断
priority: medium
created_by: surface:89
created_at: 2026-04-25T05:08:57.088Z
---

## タスク
## 背景

T318 の pool_capacity 計算実装中に発見された、A019 §pool_capacity 検証表 と式 `flow = min(flow_5h, flow_7d)` の数値不整合の最終判断を Master に求める。

詳細は以下を参照:
- `.team/tasks/318-tokens-db-schema-macos-keychain-crud/runs/task-318-1777071750/plan.md` §8.3
- `.team/tasks/318-tokens-db-schema-macos-keychain-crud/runs/task-318-1777071750/impl-result.md` §Master 報告事項
- `.team/tasks/318-tokens-db-schema-macos-keychain-crud/runs/task-318-1777071750/inspection.md` Rec3
- `.team/artifacts/A019-token-pool-design.md` §pool_capacity 指標 §ユーザー例での検証

## 不整合点

T318 実装は plan.md の指示通り `min(flow_5h, flow_7d)` 式を正として以下を採用:

| ケース | A019 表 | 実装期待値 | 判定 |
|---|---:|---:|---|
| 1: x20 満タン、reset 5h | 672% | **100%** | 不整合 |
| 2: x20 満タン、reset 7d | 100% | 100% | 一致 |
| 3: x20 10% 残、reset 30min | 336% | **~50%** | 不整合 |
| 4: x20 10% 残、reset 3h | 112% | **~50%** | 不整合 |
| 5: Pro 満タン、reset 7d | 5% | 5% | 一致 |
| 6: x20 + Pro 両方満タン 7d | 105% | 105% | 一致 |

## 判断選択肢

- **A**: A019 表を `min(flow_5h, flow_7d)` 式に合わせて再計算・更新する（Inspector 推奨）
- **B**: 式を「5h 余裕あり時は flow_5h を flow_7d より優先する」等に変更し、A019 表に合わせる

## 影響

T319 以降の TUI 表示（`pool capacity: X%`）の意味付けに影響する。

## やること

1. Master が A/B のいずれかを判断
2. 選択 A: A019 §pool_capacity §ユーザー例での検証 を更新
3. 選択 B: token-store.ts の computePoolCapacity と plan.md §8 を新式で更新、テストの期待値を A019 表の値に修正

## 関連

- T318: token-store.ts 実装（merged: 469282f）
- T319-T323: 後続タスク（pool_capacity 表示の意味付けに依存）
