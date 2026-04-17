# T204 完了サマリー — restart-task を aborted 状態からも使えるようにする

## 完了したサブタスク

1. **Phase 1 (Plan)**: planner agent が `plan.md` を作成（§1-7、推奨 3 の採用判断含む）
2. **Phase 3 (Impl)**: implementer agent が main.ts / i18n.ts を編集、型チェック・テスト pass、`impl.md` を出力
3. **Phase 4 (Inspection)**: inspector agent が **GO** 判定、`inspect.md` を出力

## 変更ファイル

| ファイル | 変更行数 | 概要 |
|---|---|---|
| `skills/cmux-team/manager/main.ts` | +88 / -2 | `restartFromAborted` 関数追加 / 状態チェック緩和 / 推奨 3 適用 / `execFile`+`promisify` import 追加 |
| `skills/cmux-team/manager/i18n.ts` | +13 / -9 | en/ja の help 文字列更新（restart-task の対象状態を明示）|

## 主な実装

- `cmdRestartTask` の状態許容を `assigned`/`aborted` の両方に緩和
- aborted 分岐は新規 `restartFromAborted()` に委譲
  - worktree 物理削除（冪等、`existsSync` ガード）
  - `${taskRunId}/task` ブランチ削除（冪等、`-D`）
  - task-state の `worktreePath` / `taskRunId` / `conductorSlot` / `sessionId` / `abortedAt` / `assignedAt` を剥がして `status: ready` に戻す
  - `task_restarted ... from=aborted ...` ログ
  - `TASK_CREATED` 通知のみ（CONDUCTOR_DONE は不要）
- 推奨 3 採用: assigned 通常分岐 + conductor 不在分岐でも resume フィールド 4 つを剥がし、3 分岐の対称性を確保

## テスト結果

- `npx tsc --noEmit`: エラー 0 件
- `bun test`: 272 件 pass / 0 件 fail
- `restart-task --help` en/ja 両方で文字列反映を確認

## 検品結果

**GO 判定**（inspect.md 参照）

主なポイント:
- plan.md §3 の意図を忠実に実装
- 後方互換性維持（既存 assigned 動作は不変）
- 型エラー・テスト回帰なし
- impl.md の乖離点（require→import、examples インライン注釈化、notes 2 行構成、コメント省略）はいずれも妥当
- ケース D の `cleanup_failed` ログ 1 件は plan.md 内部の文言不整合に起因、冪等性方針と整合的、実害なし

## 残課題

- `docs/spec/03-commands.md` の追従（plan.md §7.7、本タスクスコープ外）
- `cleanupAssignedTask` の inline `require()` の統一リファクタ余地
- ケース D の `git rev-parse --verify` による事前チェック化（最適化案、scope 外）

## マージコミット / PR

完了処理ステップで埋める。
