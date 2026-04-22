# T295 close-task の納品物明示を強制化 — 完了サマリー

**Run**: task-295-1776828703
**Branch**: task-295-1776828703/task
**Base commit**: 4d484d2 (T294 完了)
**判定**: Design Review **Approved** / Inspector **GO**

---

## 完了したサブタスク (S1〜S11 全 11 件)

| # | サブタスク | 状態 |
|---|-----------|------|
| S1 | `schema.ts` に `Deliverable` (zod discriminated union, 4 variant) 追加 | 完了 |
| S2 | `task.ts` に `TaskState.deliverable?` / `loadTaskState` zod 検証 / `formatDeliverable` 追加 | 完了 |
| S3 | `main.ts` `cmdCloseTask` を新仕様に書き換え + `parseCloseTaskArgs` pure 関数 + `getMultiArg` helper | 完了 |
| S4 | `daemon.ts` T274 auto-close 経路で `deliverable: { kind: "none" }` 自動付与 | 完了 |
| S5 | `i18n.ts` `help_close_task` 日英刷新 + `help_trace_task` Output 節追加 | 完了 |
| S6 | `dashboard.tsx` buildTaskRow 3 経路に kind suffix 表示 | 完了 |
| S7 | `main.ts` `cmdTraceTask` に Deliverable 行追加（Base 行 if/else 後で 1 回） | 完了 |
| S8 | Conductor テンプレ ja/en × 3 ファイル = 6 ファイル刷新 | 完了 |
| S9 | docs/spec (01/04/05/07) + CLAUDE.md の close-task 言及更新 + CLAUDE.md に Deliverable 型節追加 | 完了 |
| S10 | main.test.ts / task.test.ts / daemon.test.ts の既存更新 + 新規テスト | 完了 |
| S11 | `bunx tsc --noEmit` + `bun test` + CHANGELOG + impl-report | 完了 |

---

## 変更ファイル（21 ファイル / +782 -45 行）

### 実装コード（6）
- `skills/cmux-team/manager/schema.ts`
- `skills/cmux-team/manager/task.ts`
- `skills/cmux-team/manager/main.ts`
- `skills/cmux-team/manager/daemon.ts`
- `skills/cmux-team/manager/i18n.ts`
- `skills/cmux-team/manager/dashboard.tsx`

### テンプレート（6）
- `skills/cmux-team/templates/{ja,en}/conductor-role.md`
- `skills/cmux-team/templates/{ja,en}/conductor.md`
- `skills/cmux-team/templates/{ja,en}/conductor-task.md`

### ドキュメント（5）
- `docs/spec/01-skill-cmux-team.md`
- `docs/spec/04-templates.md`
- `docs/spec/05-install-and-infrastructure.md`
- `docs/spec/07-state-machine.md`
- `CLAUDE.md`

### テスト（3）
- `skills/cmux-team/manager/main.test.ts`
- `skills/cmux-team/manager/task.test.ts`
- `skills/cmux-team/manager/daemon.test.ts`

### その他（1）
- `CHANGELOG.md`

---

## テスト結果

```
 1064 pass
 0 fail
 2502 expect() calls
Ran 1064 tests across 36 files. [52.74s]
```

- touched-files (main.ts / schema.ts / task.ts / daemon.ts / i18n.ts / dashboard.tsx) からの新規 tsc エラー: **0 件**
- 既存 tsc エラー 3 件（conductor.ts:201 / daemon.test.ts:3870 / daemon.ts:1598）は plan §6 で T295 対象外として明示済み、未変更

---

## 残課題

### T296（follow-up）

Inspector Finding 1 (major) / Finding 2 (minor) として指摘された、README sweep 漏れをフォローアップタスクとして起票済み:

- `README.md` / `README.ja.md` L110 付近の close-task 行
- `skills/cmux-team/templates/{ja,en}/manager.md` L73 付近の例示

いずれもドキュメント hygiene のみで、実装コード / テスト / 主要テンプレ / docs/spec / CLAUDE.md は完全整合。

---

## マージコミット

Step 8 rebase → Step 9 ローカル ff-only マージで main に納品予定。

## 完了通知

```bash
cmux-team close-task --task-id 295 --deliverable-kind merged \
  --merged-into task-295-1776828703/task \
  --merge-sha <HEAD> \
  --journal "T295: close-task に --deliverable-kind 必須化、旧行は後方互換で読める"
```
