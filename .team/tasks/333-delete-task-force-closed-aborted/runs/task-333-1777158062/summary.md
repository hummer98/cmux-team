# T333 Task Summary

## タスク

`cmux-team delete-task --force` 対応 — closed / aborted のタスクも CLI から強制削除可能にする。

## 完了したサブタスク

- Phase 1 (Plan): `plan.md` 作成 — TDD ステップ・FSM 拡張点・i18n 同期方針を明示
- Phase 2 (Design Review): `design-review.md` Approved（軽微な改善 R1〜R6 を提示）
- Phase 3 (Implementation): R1〜R6 を取り込んで TDD で実装、`impl-report.md` 出力
- Phase 4 (Inspection): `inspection.md` GO 判定（Minor: package-lock.json スコープ外差分のみ → Conductor が commit から除外）

## 変更ファイル

- `skills/cmux-team/manager/state-machine/events.ts` — `TaskFsmEvent.DELETE` に `force?: boolean` 追加
- `skills/cmux-team/manager/state-machine/task-fsm.ts` — `case "DELETE"` に `force && (closed|aborted)` 分岐追加（cascade なし、`detail=force=true prev=...`）
- `skills/cmux-team/manager/main.ts` — ヘッダコメントに `[--force]`、`cmdDeleteTask` に `forceFlag` 判定 + 3 段ガード（assigned / deleted / closed|aborted+force）、`usedForce` で log/OK 出力をマーキング
- `skills/cmux-team/manager/i18n.ts` — `help_delete_task` (en/ja) に `--force` の Options / Examples / Notes を追加
- `skills/cmux-team/manager/state-machine/fsm.test.ts` — DELETE describe に T1〜T6 + R2 = 8 テスト追加
- `skills/cmux-team/manager/main.test.ts` — TASK_UPDATED postMessage describe に C1〜C5 = 5 テスト追加（C4/C5 に R4 の `not.toContain("Use --force")`）

## テスト結果

- `fsm.test.ts`: **184 pass / 0 fail**
- `main.test.ts -t "delete-task"`: **7 pass / 0 fail**
- `main.test.ts -t "TASK_UPDATED"`: **28 pass / 0 fail**
- `bunx tsc -p skills/cmux-team/manager/tsconfig.json --noEmit`: エラー 0 件

## 取り込んだレビュー指摘（design-review.md R1〜R6）

- **R1**: `usedForce = forceFlag && (currentStatus === "closed" || "aborted")` で log/OK 出力を closed/aborted 起点限定にし、reducer 側 detail とセマンティクス一致
- **R2**: `draft + DELETE(force=true)` / `ready + DELETE(force=true)` のテスト追加（cascade あり、detail なし）
- **R3**: 実装変更なし（既存の `task_deleted` 二重 emit パターンを意図的に維持）
- **R4**: C4/C5 に `expect(r.stderr).not.toContain("Use --force")` を追加し、誤誘導しないことを保証
- **R5**: 実装変更なし（`currentStatus === undefined` は store 側 prev=draft フォールバックで通常削除、既存挙動と整合）
- **R6**: `deleted + DELETE(force=true)` を独立テストとして追加（test name 衝突回避）

## マージ先

`main` ブランチへローカル ff-only マージ。
