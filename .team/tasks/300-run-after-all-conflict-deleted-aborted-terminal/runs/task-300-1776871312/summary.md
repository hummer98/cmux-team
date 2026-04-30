# T300 Summary

## タスク

run_after_all conflict チェックが `deleted` / `aborted` を terminal として扱っていなかった不整合の修正。
`scanTasks` は `closed | aborted | deleted` の 3 状態を terminal と扱う一方、`createTaskProgrammatic` の競合チェックは `closed` のみを見ていた。

## 完了フェーズ

- Phase 1 Plan: ✅ plan.md 作成
- Phase 3 Impl (TDD): ✅ Red → Green で実装
- Phase 4 Inspection: ✅ **GO**

## 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/task.ts` | `isTerminalStatus(status): boolean` を新規 export 追加。`createTaskProgrammatic` の run_after_all 競合判定を `!isTerminalStatus(t.status)` に変更 |
| `skills/cmux-team/manager/daemon.ts` | `task.ts` 既存 import 行に `isTerminalStatus` を追加。`scanTasks` の closed Set 構築 / openTasksList フィルタを `isTerminalStatus` 経由に統一 |
| `skills/cmux-team/manager/task.test.ts` | `isTerminalStatus` ユニット（7 ケース）+ `createTaskProgrammatic run_after_all conflict` 統合（9 ケース）を新規追加 |
| `package-lock.json` | v4.5.1 への version フィールド自動同期（HEAD の release 漏れの是正、ロジック影響なし） |

## 設計判断

`isTerminalStatus` ヘルパを `task.ts` 側に配置（daemon.ts への import は 1 行追加のみ、循環依存なし）。
新規ファイル分割や Set 定数化ではなく関数 export を選択（将来の terminal 状態追加時に 1 箇所修正で 3 箇所同期）。
`daemon.ts` の `closedMetas`（表示用リスト）は plan 通り意図的に対象外（UI 挙動変更は T300 のスコープを超えるため）。

## テスト結果

- `bun test`: **1083 pass / 0 fail** (2528 expect() calls)
- `bunx tsc --noEmit`: T300 起因の新規エラー **0 件**（baseline 既存 3 件 `conductor.ts:201` / `daemon.test.ts:3870` / `daemon.ts:1598` は T300 と独立）

## exclusive との組み合わせ

既存 `aborted` / `deleted` の行は exclusive 組み合わせによらず一律許可に整理。
`ready` / `assigned` 側のセマンティクス（非排他同士不可・exclusive 同士可・非排他 ⇔ exclusive 不可）は従来通り。

## マージコミット / PR URL

- ローカル main へ ff-only マージ: `15665ed` (`fix(task): treat aborted/deleted as terminal in run_after_all conflict check (T300)`)
- 納品方式: `merged` / into `main` / merge-sha `15665ed`

## 次段のアクション

納品: ローカル main に ff-only マージ（指示通り）。
