# Task 183: update-task の全更新を TUI 即時反映（postMessage 統一）

## 完了状態
- 判定: **GO**（Inspector 承認）
- マージ済み: main ブランチ（コミット `5d6de16` = Merge、実装コミット `d787355`）
- worktree/ブランチ: 削除済み

## 変更ファイル

| ファイル | 概要 |
|---------|------|
| `skills/cmux-team/manager/schema.ts` | `TaskUpdatedMessage` zod スキーマを `QueueMessage` discriminated union に追加 |
| `skills/cmux-team/manager/daemon.ts` | `handleMessage` に `case "TASK_UPDATED"` を追加（`task_updated` ログ + `requestWakeup`） |
| `skills/cmux-team/manager/main.ts` | `cmdUpdateTask`（非 ready 変更時に TASK_UPDATED）、`cmdCloseTask`（conductor 不在時）、`cmdAbortTask`（no-conductor 早期 return パス）、`cmdDeleteTask`（末尾）で postMessage を送信。`cmdSend` にも TASK_UPDATED サポート追加 |
| `skills/cmux-team/manager/i18n.ts` | `help_send` に TASK_UPDATED の説明を追加（英/日） |
| `skills/cmux-team/manager/queue.test.ts` | TASK_UPDATED 送受信テスト追加 |
| `skills/cmux-team/manager/daemon.test.ts` | `handleMessage(TASK_UPDATED)` の単体テスト追加 |
| `skills/cmux-team/manager/main.test.ts` | CLI 統合テスト 7 件追加（update/delete/close/abort + 後方互換） |

変更統計: 7 files changed, 248 insertions(+), 1 deletion(-)

## テスト結果
- `bun test`: **174 pass / 0 fail**（371 expect, 11 files）
- `bunx tsc --noEmit`: 新規エラーなし（既存 5 件のみ）

## 設計判断
**TASK_UPDATED を新設**（TASK_CREATED 再利用ではなく）。理由:
1. `TASK_CREATED` は「新規割り当てトリガー」の意味を持つ（`task_received` ログ・`scanTasks` の新規検出動線）
2. ログの観測性・意味分離が向上
3. 追加コストは schema 1 ケース + handleMessage 1 ケースで小さい

## 抜け漏れの補正（Design Review で判明）
**abort-task の no-conductor 早期 return パス**（`main.ts:2061-2074`）は元々 postMessage を一切送っていなかった。Design Review 1 回目で指摘され、Planner が修正 → 実装に反映。

## 既存挙動の維持
- `update-task --status ready`: 既存通り TASK_CREATED のみ送信（Conductor 割り当てトリガーを維持）
- `notifiedTaskCreated` フラグで二重通知を回避
- 回帰テスト「status=ready では TASK_CREATED のみ」で検証

## 後方互換性
古い daemon（TASK_UPDATED を知らない版）は proxy の zod parse 失敗経路で 400 を返す。CLI 側の `postMessage` は 400 を握りつぶすため、古い daemon + 新 CLI の組み合わせでも成功扱いとなる（統合テストで検証）。

## フロー
- Phase 1 (Planner): plan.md 初版作成
- Phase 2 (Design Review): 1 回目 Changes Requested → abort-task の抜け指摘 → Planner 修正 → 2 回目 Approved
- Phase 3 (Impl): 実装 + テスト追加 + コミット
- Phase 4 (Inspector): GO 判定

## 関連ファイル
- `plan.md` — 実装計画書（修正履歴付き）
- `design-review.md` — Design Review 結果（2 回目）
- `impl-report.md` — 実装レポート
- `inspect.md` — 検品結果
