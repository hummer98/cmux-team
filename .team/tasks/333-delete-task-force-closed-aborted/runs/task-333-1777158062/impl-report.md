# T333 Implementation Report

## 変更ファイル

- `skills/cmux-team/manager/state-machine/events.ts` — `TaskFsmEvent.DELETE` に `force?: boolean` を追加
- `skills/cmux-team/manager/state-machine/task-fsm.ts` — `case "DELETE"` に `force && (closed|aborted)` 分岐を追加（cascade なし、`detail=force=true prev=...`）
- `skills/cmux-team/manager/main.ts` — ヘッダコメントに `[--force]` を追記、`cmdDeleteTask` に `forceFlag` 判定 + 3 段ガード（assigned / deleted / closed|aborted+force）、`usedForce` で log/OK 出力をマーキング
- `skills/cmux-team/manager/i18n.ts` — `help_delete_task` (en/ja) に `--force` の Options / Examples / Notes を追加
- `skills/cmux-team/manager/state-machine/fsm.test.ts` — DELETE describe に T1〜T6 + R2 の合計 8 テストを追加
- `skills/cmux-team/manager/main.test.ts` — TASK_UPDATED postMessage describe に C1〜C5 の 5 テストを追加（C4/C5 に R4 の `not.toContain("Use --force")`）

## 追加テスト

### FSM tests (8 件)

`describe("Task FSM — DELETE (A017 §2.2)")` 末尾に追加:

- T1: `closed + DELETE (force=false) → closed (noop)`
- T2: `closed + DELETE (force=true) → deleted + log(force=true prev=closed)、cascade なし`
- T3: `aborted + DELETE (force=false) → aborted (noop)`
- T4: `aborted + DELETE (force=true) → deleted + log(force=true prev=aborted)、cascade なし`
- T5: `assigned + DELETE (force=true) → assigned (force でも禁止)`
- T6: `deleted + DELETE (force=true) → deleted (terminal state guard)` ← 既存「deleted は終端 state」ループとは独立 test として追加（test name 衝突回避）
- R2-1: `draft + DELETE (force=true) → deleted (force 無視、cascade あり、detail なし)`
- R2-2: `ready + DELETE (force=true) → deleted (同上)`

### CLI tests (5 件)

`describe("TASK_UPDATED postMessage (T183)")` の delete-task ブロック末尾に追加:

- C1 `delete-task: closed タスクは --force なしで reject される` — exit 1 / stderr に "already closed" + "--force" / state 不変
- C2 `delete-task --force: closed タスクが deleted に遷移する` — exit 0 / state[571].status=="deleted" / TASK_UPDATED 1 件
- C3 `delete-task --force: aborted タスクが deleted に遷移する` — exit 0 / state[572].status=="deleted"
- C4 `delete-task --force: assigned タスクは依然 reject される` — exit 1 / stderr に "is assigned" / R4: `not.toContain("Use --force")` / state 不変
- C5 `delete-task --force: deleted タスクは依然 reject される` — exit 1 / stderr に "already deleted" / R4: `not.toContain("Use --force")`

## テスト結果

- `bun test skills/cmux-team/manager/state-machine/fsm.test.ts` → **184 pass / 0 fail / 344 expect()**（既存 173 + 新規 8 件 + 既存 deleted-終端ループ 1 件追加）
- `bun test skills/cmux-team/manager/main.test.ts -t "delete-task"` → **7 pass / 0 fail / 23 expect()**（既存 2 件 + 新規 5 件）
- `bun test skills/cmux-team/manager/main.test.ts -t "TASK_UPDATED"` → **28 pass / 0 fail / 77 expect()**（regression なし）

赤フェーズで `closed/aborted + DELETE (force=true)` の FSM 2 件と CLI C1〜C3 の 3 件が想定通り fail し、緑フェーズで全件 pass を確認。

## TypeScript 型検査

`bunx tsc -p skills/cmux-team/manager/tsconfig.json --noEmit` → **エラー 0 件**（出力なし）。

(`bunx tsc --noEmit` は repo ルートに `tsconfig.json` がなく compiler usage を出力するため、`skills/cmux-team/manager/tsconfig.json` を明示。これは A017 などの既存検証手順と整合。)

## 手動 smoke test

### `delete-task --help`（ja, デフォルト）

```
Options:
  --task-id <id>          タスク ID（必須）
  --journal <text>        削除ジャーナル（任意、デフォルト: "削除: T{id} {title}"）
  --force                 closed / aborted のタスクを強制削除する（assigned は依然 abort-task が必要）
```

### `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 delete-task --help`

```
Options:
  --task-id <id>          task ID (required)
  --journal <text>        deletion journal (optional, default: "Deleted: T{id} {title}")
  --force                 force-delete a closed or aborted task (assigned still requires abort-task)
```

両ロケールで `--force` 行が表示されること、Examples / Notes も同期して更新されていることを確認。

### grep invariant

CLAUDE.md「task-state 書き込みポリシー」の grep invariant が 0 件のまま:

```bash
grep -nE 'taskState\[.*\]\s*='     skills/cmux-team/manager/{daemon,main}.ts   # 0 件
grep -nE 'ts\[[^\]]+\]\s*='        skills/cmux-team/manager/{daemon,main}.ts   # 0 件
grep -n  'saveTaskState('          skills/cmux-team/manager/{daemon,main}.ts   # 0 件
```

実装は `applyTaskEvent({ type: "DELETE", force: forceFlag })` 経由で完結しており、`task-state.json` への直接書込みは追加していない。

## 取り込んだレビュー指摘

- **R1**: ✓ `usedForce = forceFlag && (currentStatus === "closed" || "aborted")` で log / OK 出力の `force=true prev=...` マーカを closed/aborted 起点限定に絞った。draft/ready + `--force` 経由ではマーカは出ない（reducer 側 detail と semantics 一致）。
- **R2**: ✓ `draft + DELETE (force=true)` / `ready + DELETE (force=true)` の 2 テストを fsm.test.ts に追加。`cascade_children` が emit され、`detail` が undefined になることを assert。
- **R3**: 実装変更なし。`task_deleted` ログの reducer + main.ts 二重 emit は既存仕様を踏襲（reducer = FSM 監査用 / main.ts = ユーザ可読 ID + title 付き）。force マーカも両方に出るが、検索性のため許容。
- **R4**: ✓ C4 (`assigned + --force`) と C5 (`deleted + --force`) の stderr に `expect(r.stderr).not.toContain("Use --force")` を追加し、誤誘導しないことを保証。
- **R5**: 実装変更なし。`taskState[taskId]` が undefined のとき `currentStatus` も undefined になり、3 段ガードのいずれにもヒットせず `applyTaskEvent` に渡る → store 側の prev=draft フォールバックで通常削除（force 無視）になる。既存フォールバック経路と整合。
- **R6**: ✓ `deleted + DELETE (force=true)` は既存 events 配列ループ（`describe("Task FSM — deleted は終端 state")`）への追加ではなく独立 test として追加。test name (`deleted + DELETE`) が既存ループと衝突しないようコメントで明示。

## 残課題・懸念

なし。CLAUDE.md ガードレール（cmux tree 利用は本タスクで触らない / EventBus / task-state 経路 / hook / ログ）すべて遵守。`--force` の判定は既存パターン (`hasFlag("force")`) を踏襲しており、振る舞いの差分（terminal-ish state からの前進）のみが本タスク固有。
