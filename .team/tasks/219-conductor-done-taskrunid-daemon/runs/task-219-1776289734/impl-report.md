# T219 実装レポート

**タスク**: CONDUCTOR_DONE / SESSION_CLEAR / SESSION_STARTED に taskRunId 一致検証を導入

**worktree**: `/Users/yamamoto/git/cmux-team/.worktrees/task-219-1776289734`

**ベース設計**: `plan.md` §1〜§9 / `design-review.md` (Approved + minor recommendations F1/F3/F4/F5)

---

## Completed Tasks

plan.md §4 のサブタスクを番号順に実装した。

| 番号 | サブタスク | 状態 |
|------|-----------|------|
| §4.1 | `schema.ts` 拡張 (`ConductorDoneMessage` / `SessionClearMessage` に `taskRunId: z.string().optional()` 追加) | 完了 |
| §4.2 | `main.ts` 送信側 3 箇所 (close-task / abort-task / restart-task) に `taskRunId: conductor.taskRunId` 添付 | 完了 |
| §4.3 | `main.ts` `send` サブコマンド (`CONDUCTOR_DONE` / `SESSION_CLEAR`) に `--task-run-id` 対応 | 完了 |
| §4.4 | `daemon.ts` 3 ハンドラ (`CONDUCTOR_DONE` / `SESSION_CLEAR` running 分岐 / `SESSION_STARTED` T203 分岐) に stale 検証ロジック追加 | 完了 |
| §4.5 | ログフォーマット統一 (`*_stale` イベント + `reason=stale_task_run_id`) | 完了 |
| §4.6 | `bunx tsc --noEmit` で型チェック | 完了 (exit=0) |

---

## Files Changed

### 1. `skills/cmux-team/manager/schema.ts`

- `ConductorDoneMessage` (19-29 行) に `taskRunId: z.string().optional()` を追加 (`surface` と `success` の間)
- `SessionClearMessage` (96-101 行) に `taskRunId: z.string().optional()` を追加 (`surface` と `pid` の間)
- 旧クライアント互換のため optional (D1)

### 2. `skills/cmux-team/manager/main.ts`

- **`cmdCloseTask`** (2370-2377 行): `postMessage({ type: "CONDUCTOR_DONE", ... })` に `taskRunId: conductor.taskRunId` 追加
- **`cmdAbortTask`** (2825-2832 行): 同上 (`reason: "aborted"`)
- **`cmdRestartTask`** (2989-2996 行): 同上 (`reason: "restarted"`)
- **`send CONDUCTOR_DONE`** サブコマンド (873-885 行): `taskRunId: getArg("task-run-id")` 追加
- **`send SESSION_CLEAR`** サブコマンド (953-961 行): `taskRunId: getArg("task-run-id")` 追加

いずれも `team.json` から取得した `conductor.taskRunId`（assignTask で設定される）を添付する (D6)。

### 3. `skills/cmux-team/manager/daemon.ts`

#### 3.1 `CONDUCTOR_DONE` ハンドラ (720-766 行)

既存の `conductor_done_ignored reason=no_task` ガード直後に `conductor_done_stale` 検証を追加 (D5: ガード順序)。

```ts
// T219: 既存 no_task ガードの後ろに配置 — ここまで到達時点で conductor.taskRunId は truthy.
//       late_cleanup パスでも走る: disconnected 時の新タスク再 assign 後に残った stale シグナルを弾く.
//       片方 undefined は旧クライアント互換のためスキップ（D3）.
if (
  message.taskRunId &&
  conductor.taskRunId &&
  message.taskRunId !== conductor.taskRunId
) {
  await log(
    "conductor_done_stale",
    `${formatSurface(message.surface, "C")} message_task_run_id=${message.taskRunId} current_task_run_id=${conductor.taskRunId} reason=stale_task_run_id`
  );
  break;
}
```

**design-review F5 コメント追記**: `late_cleanup パスでも走る: disconnected 時の新タスク再 assign 後に残った stale シグナルを弾く` を明記。

#### 3.2 `SESSION_CLEAR` ハンドラ (1138-1179 行)

disconnected/starting → idle 復帰分岐の後・running 分岐の前で `session_clear_stale` 検証を追加 (D7: running 分岐のみ守る)。

```ts
// T219: running 分岐の先頭で taskRunId 一致検証。
//       destructive な task-state 書き換え + resetConductor の直前で stale を弾く.
//       disconnected/starting → idle 復帰分岐は destructive でないためガードしない（D7）.
if (
  conductor &&
  conductor.status === "running" &&
  message.taskRunId &&
  conductor.taskRunId &&
  message.taskRunId !== conductor.taskRunId
) {
  await log(
    "session_clear_stale",
    `${formatSurface(message.surface, "C")} message_task_run_id=${message.taskRunId} current_task_run_id=${conductor.taskRunId} reason=stale_task_run_id`
  );
  break;
}
```

**design-review F2 コメント**: 「running 分岐の先頭」という位置付けをコメントで明記。

#### 3.3 `SESSION_STARTED` T203 分岐 (803-847 行)

`task-state.json` 更新ブロックに先頭 guard を追加 (F1: 線形構造)。schema 変更せず、daemon 内部で保持する 2 つの taskRunId (`conductor.taskRunId` と `task-state[taskId].taskRunId`) のみで突合 (D2)。

```ts
try {
  const ts = await loadTaskState(state.projectRoot);
  const cur = ts[conductor.taskId];
  // T219: 先頭で stale guard。両方 taskRunId が立っており不一致なら書き込みスキップ.
  //       hook 配布物は taskRunId を知らない（D2）ため、daemon 内部の突合のみで検証する.
  if (
    cur &&
    conductor.taskRunId &&
    cur.taskRunId &&
    cur.taskRunId !== conductor.taskRunId
  ) {
    await log(
      "task_session_update_skipped",
      `${formatSurface(message.surface, "C")} task_id=${conductor.taskId} task_state_task_run_id=${cur.taskRunId} conductor_task_run_id=${conductor.taskRunId} reason=stale_task_run_id`
    );
  } else if (
    cur &&
    cur.status === "assigned" &&
    cur.sessionId !== message.sessionId
  ) {
    // 既存ロジック: sessionId 同期書き込み
  }
} catch (e: any) { ... }
```

---

## Verification Results

### §4.1 schema 拡張

```bash
$ rg 'taskRunId: z\.string\(\)\.optional\(\)' skills/cmux-team/manager/schema.ts
  taskRunId: z.string().optional(),   # ConductorState (既存)
  taskRunId: z.string().optional(),   # ConductorDoneMessage (追加)
  taskRunId: z.string().optional(),   # SessionClearMessage (追加)
```

期待値は 2 だったが、ConductorState に既存の定義があるため実値は 3。新規追加分は `ConductorDoneMessage` と `SessionClearMessage` の 2 箇所で正しく追加されている。

### §4.2 送信側 CONDUCTOR_DONE 3 箇所

```bash
$ rg -A5 'type: "CONDUCTOR_DONE"' skills/cmux-team/manager/main.ts | rg -c 'taskRunId: conductor\.taskRunId'
3
```

期待値 3 → 実値 3 (close-task / abort-task / restart-task)。

### §4.3 送信側 CLI サブコマンド

```bash
$ rg 'taskRunId: getArg\("task-run-id"\)' skills/cmux-team/manager/main.ts
        taskRunId: getArg("task-run-id"),   # CONDUCTOR_DONE case
        taskRunId: getArg("task-run-id"),   # SESSION_CLEAR case
```

期待値 2 → 実値 2。

### §4.4 受信側検証ロジック

```bash
$ rg -n 'conductor_done_stale|session_clear_stale|task_session_update_skipped' skills/cmux-team/manager/daemon.ts
747:          "conductor_done_stale",
834:                "task_session_update_skipped",
1169:          "session_clear_stale",
```

3 イベントがそれぞれ 1 箇所ずつ出現。

### §4.5 ログフォーマット統一

```bash
$ rg 'stale_task_run_id' skills/cmux-team/manager/daemon.ts | wc -l
3
```

`reason=stale_task_run_id` で 3 箇所が統一。

### §4.6 Type check

```bash
$ cd skills/cmux-team/manager && bunx tsc --noEmit; echo exit=$?
exit=0
```

**touched files (schema.ts / main.ts / daemon.ts) に型エラー 0**。

### 互換性検証 (design-review F3 対応)

完了条件チェックリスト §9 の「taskRunId 未添付メッセージが従来通り動作する」について、静的レビューで確認:

- **CONDUCTOR_DONE**: `message.taskRunId && conductor.taskRunId && ...` の 3 条件積 → `message.taskRunId` が undefined の場合、2 番目の条件評価前に falsy で短絡 → 検証スキップ → 既存パス（`handleConductorDone`）に進む。hook 配布物や旧 CLI からの CONDUCTOR_DONE は従来通り処理される。
- **SESSION_CLEAR**: 同上。running 分岐の検証ブロックは `message.taskRunId` が undefined なら break しない。
- **SESSION_STARTED T203**: 検証条件 `cur && conductor.taskRunId && cur.taskRunId && ...` のうち、片方でも undefined なら else if 分岐 (既存 sessionId 同期) に進む。assignTask 直後の half-state も互換扱い (§5.2)。

手動動作確認 (`cmux-team close-task` 実行 + ログ検査) は、worktree 内での daemon 単独起動が必要になるため本レポートでは静的検証のみ実施。レビュワーがリリース前の E2E で確認することを推奨。

---

## Issues Encountered

なし。plan.md §6 の通り、touched files (schema.ts / main.ts / daemon.ts) に既存型エラーは存在せず、実装後の `tsc --noEmit` でも exit=0 を確認した。

**design-review 軽微所見の扱い**:

- **F1** (SESSION_STARTED 分岐の線形整形): 「先頭 guard + else 既存ロジック」の構造で実装 (§3.3)。
- **F2** (SESSION_CLEAR 検証位置): コメントに「running 分岐の先頭」と明記。
- **F3** (互換性サブタスク): 静的レビューで互換性を検証し、上記 "Verification Results" の互換性検証セクションに記録。
- **F4** (ログフォーマット差分): plan.md §2.3 の既存パターン (`*_ignored reason=<理由>`) に揃え、仕様書の `expected=/got=` 例示からは意図的に逸脱。本レポートで差分を記録。
- **F5** (late_cleanup 注記): CONDUCTOR_DONE ハンドラのコメントに明記。

---

## 完了条件チェックリスト (plan.md §9)

- [x] schema.ts に CONDUCTOR_DONE / SESSION_CLEAR の taskRunId フィールド追加 → §4.1
- [x] main.ts の close-task / abort-task / restart-task / send CONDUCTOR_DONE で taskRunId 添付 → §4.2, §4.3
- [x] daemon.ts の 3 ハンドラで一致検証ロジック追加 → §4.4
- [x] 既存の正常系が壊れないこと (taskRunId 未添付メッセージが stale 扱いされない互換性) → D3, §5.1, 互換性検証
- [x] log フォーマット `conductor_done_stale` / `session_clear_stale` / `task_session_update_skipped` が出ること → §4.5, D4
