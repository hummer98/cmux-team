---
id: 097
title: TUIダッシュボードでMaster idle時にスピナーが回り続けるバグ修正
priority: high
created_at: 2026-04-06T19:31:51.802Z
---

## タスク
## バグ概要

ダッシュボードのTUIで、Masterの状態が idle になっているにもかかわらずスピナーが回り続けている。

ユーザーの推測: ステート管理の問題、または hook のサイクルがおかしい可能性。

## 調査ポイント

1. **スピナーの表示条件**: dashboard.tsx でスピナーが表示される条件を確認。Master の状態に応じて正しく切り替わるか
2. **ステート管理**: Master の状態（idle/running等）がどのように取得・反映されているか。cmux list-status の結果とTUI表示の整合性
3. **hook サイクル**: useInterval や useEffect 等のフックが不要な再レンダリングを引き起こしていないか
4. **状態更新のタイミング**: idle への遷移時にスピナー状態が正しく更新されるか

## 期待動作

- Master が idle 状態のとき、スピナーは停止（非表示）であること
- Master が running 状態のときのみスピナーが回ること

## 対象ファイル

- skills/cmux-team/manager/dashboard.tsx
- 関連するステート管理ファイル（daemon.ts, master.ts 等）
