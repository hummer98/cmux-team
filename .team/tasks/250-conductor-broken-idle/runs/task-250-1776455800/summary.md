# T250 実行サマリー

- タスク: Conductor に broken 状態を導入し、エラーステートを idle に戻さない
- ブランチ: task-250-1776455800/task
- 作業ディレクトリ: /Users/yamamoto/git/cmux-team/.worktrees/task-250-1776455800
- 出力ディレクトリ: /Users/yamamoto/git/cmux-team/.team/tasks/250-conductor-broken-idle/runs/task-250-1776455800

## フェーズ

| フェーズ | Agent | 結果 |
|---------|-------|------|
| Phase 1 Plan | planner (surface:136) | plan.md 作成 (484 行) |
| Phase 2 Review v1 | design-reviewer (surface:137) | Changes Requested (critical 1, major 3, minor 5) |
| Phase 1 Plan v2 | planner (surface:138) | plan.md 改訂 (669 行) |
| Phase 2 Review v2 | design-reviewer (surface:139) | Approved |
| Phase 3 Impl | implementer (surface:140) | 8 ファイル変更 / 522 tests pass (17 追加) / tsc 0 errors |
| Phase 4 Inspection | inspector (surface:141) | GO（minor 1 のみ・修正不要） |

## 変更ファイル

- skills/cmux-team/manager/schema.ts — ConductorStatus に `broken` 追加、`CONDUCTOR_CLEAR` message 型追加
- skills/cmux-team/manager/conductor.ts — resetConductor に `opts: { targetStatus, reason }` 追加、conductor_broken/conductor_reset ログ 1 箇所集約、disconnectedAt は broken 時のみ保持
- skills/cmux-team/manager/daemon.ts — forceCloseDisconnectedConductor を broken 遷移に変更、CONDUCTOR_CLEAR handler 追加、SESSION_STARTED/ACTIVE/IDLE/CLEAR 4 ハンドラに broken early-return 追加、updateTeamJson / initializeLayout で disconnectedAt 永続化・復元
- skills/cmux-team/manager/main.ts — `cmdClearConductor` + `clear-conductor` dispatch 追加
- skills/cmux-team/manager/dashboard.tsx — broken の可視化（赤色 ⨯ マーカー、use clear-conductor ガイド、brokenCount ヘッダー）
- skills/cmux-team/manager/i18n.ts — `help_clear_conductor` key を ja/en 両辞書に追加
- skills/cmux-team/manager/daemon.test.ts — 14 テスト追加 + 既存 1 テスト改訂
- skills/cmux-team/manager/conductor.test.ts — 3 テスト追加

## 検証結果

- `bun test` — 522 pass / 0 fail (+17)
- `bunx tsc --noEmit` (touched files) — 0 errors
- plan.md Decision Log D1〜D13 と Finding R1〜R7 の全項目が実装に反映されていることを Inspector が grep + test で確認

## 主要な設計判断

- CONDUCTOR_DONE 流用をやめ、新 message 型 `CONDUCTOR_CLEAR` を導入（no_task guard を回避）
- resetConductor を 2 種に分けず、`opts: { targetStatus: "idle" | "broken", reason?: string }` で統一
- `log("conductor_broken", ...)` は conductor.ts の 1 箇所で三項演算（status === "broken" ? "conductor_broken" : "conductor_reset"）で集約
- broken は state.conductors に残し、disconnectedAt を UI 用に保持する（idle 経路のみ undefined）
- broken 中は SESSION_* 4 ハンドラ全てで early-return（`session_event_ignored_broken` 観測ログ）
- broken → idle 復帰は常に明示操作（`cmux-team clear-conductor --surface <id>`）。自動復帰は実装しない

## 納品

- commit: T250 merged into main (本サマリー確定後)
- 納品方法: ローカルマージ（タスク本文で指定なし → デフォルト）

## Inspector 最終指摘

- Minor 1 件: ST-14 の round-trip テストが switch 文を手動複製している。
  ロジックは 3 行で書き出し側は実ファイル経由で検証済みのため修正不要。
  改善案（restoreConductors を公開 export 化）は将来タスク。
