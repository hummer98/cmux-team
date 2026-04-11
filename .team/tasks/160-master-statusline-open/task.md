---
id: 160
title: Master statusline からコスト表示を削除し open タスク数を表示
priority: low
created_at: 2026-04-11T18:12:35.754Z
---

## タスク
## 背景

Master の statusline にコスト（\$0.00）が表示されているが、Claude Max サブスクでは従量課金が発生しないため無意味。

## やること

`skills/cmux-team/manager/statusline.sh` の master セクション（73-82行付近）:

- COST / COST_ICON の表示を削除
- 代わりに open タスク数（task-state.json の ready + assigned 件数）を表示する
  - 例: `T:3`（open タスク3件）
  - task-state.json を jq で集計

## 表示イメージ

変更前: `♦ Master | opus-4-6 | ctx 12% | \$0.00 |  main`
変更後: `♦ Master | opus-4-6 | ctx 12% | T:3 |  main`
