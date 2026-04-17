---
id: 250
title: Conductor に broken 状態を導入し、エラーステートを idle に戻さない
priority: high
created_by: surface:47
created_at: 2026-04-17T18:25:41.371Z
---

## タスク
## 背景

A015（フォールバック動作の設計方針）の実装タスク (c) エラーステート喪失。

現状、`forceCloseDisconnectedConductor` → `resetConductor` で
disconnected が自動的に idle に戻り、エラーがあったこと自体が
追跡不能になる。直近の事例:

- surface 112/113 が PID 死亡 → disconnected → timeout → idle 化
- 次タスクに再利用されて問題がループ

## やること

1. ConductorState の status に `broken` を追加（schema.ts 更新）
2. `forceCloseDisconnectedConductor` (`daemon.ts:2157` 付近) を
   idle 化せず broken 状態で保持するよう変更
3. broken 状態の Conductor は次タスクの割当対象から除外する
   （assignTask の候補から外す）
4. ダッシュボード / status 出力で broken を可視化
5. ユーザーが明示的にクリアする CLI を追加:
   `cmux-team clear-conductor --surface <id>` または
   既存の `restart-task` / `abort-task` パスから明示的に reset

## 判断が必要なポイント

- broken からの回復経路: ユーザーが pane を手動で立て直した場合に
  自動検出して idle に戻すか、常に明示操作を要求するか
- PID 監視は broken 状態でも継続するか（可視化のため継続が望ましい）
- 既存の disconnected との違いを明確化（disconnected = 一時的な通信断、
  broken = 確定した異常状態）

## 参考

- A015 「決定」セクション 2 項
- CLAUDE.md 「エラーリカバリ」
- memory `feedback_error_recovery`
