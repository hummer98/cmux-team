# T333 実装計画書: `cmux-team delete-task --force` 対応

## 1. 概要

`cmux-team delete-task` に `--force` フラグを追加し、`closed` / `aborted` 状態のタスクも CLI から
`deleted` 状態に強制遷移できるようにする。`assigned` および `deleted` には `--force` を付けても遷移
させない（unsafe / 冪等違反）。

### 設計指針

| 項目 | 方針 |
|------|------|
| state mutation 経路 | 引き続き `applyTaskEvent(... { type: "DELETE", force })` 経由のみ |
| FSM 拡張点 | `TaskFsmEvent.DELETE` に optional `force?: boolean` を追加し、reducer 側で分岐 |
| force 適用範囲 | `closed → deleted` と `aborted → deleted` のみ |
| 禁止経路 | `assigned + DELETE(force)` → `assigned` (noop)、`deleted + DELETE(force)` → `deleted` (noop) |
| cascade | `closed` / `aborted` から deleted への遷移では `cascade_children` を **emit しない** (既に親 abort/close 時にカスケード済みであり、子の状態を再度動かす根拠がない) |
| log 区別 | `closed` / `aborted` 起点の force 削除では `detail: \`force=true prev=${state}\`` を付けて検索性を担保 |
| 既存パターン踏襲 | `--force` の判定は `close-task` 同様 `hasFlag("force")` を使用 (main.ts:206) |

---

## 2. 変更ファイル一覧（行番号レベル）

| # | ファイル | 行 | 変更内容 |
|---|---------|----|---------|
| F1 | `skills/cmux-team/manager/state-machine/events.ts` | 108 | `TaskFsmEvent` の `DELETE` メンバを `{ type: "DELETE"; force?: boolean }` に変更 |
| F2 | `skills/cmux-team/manager/state-machine/task-fsm.ts` | 111-120 | `case "DELETE"` を拡張: `closed` / `aborted` + `event.force` で `deleted` 遷移 + `log(detail=force=true prev=...)` を emit |
| F3 | `skills/cmux-team/manager/main.ts` | 22 | コマンドヘッダコメントの `delete-task` 行に `[--force]` を追記 |
| F4 | `skills/cmux-team/manager/main.ts` | 4303-4372 (`cmdDeleteTask`) | `--force` 判定追加 / status guard を 3 段に分割 / `applyTaskEvent` の event payload を `{ type: "DELETE", force: forceFlag }` に変更 |
| F5 | `skills/cmux-team/manager/i18n.ts` | 466-484 (en) | `help_delete_task` の Options / Notes / Examples に `--force` を追加 |
| F6 | `skills/cmux-team/manager/i18n.ts` | 1254-1272 (ja) | `help_delete_task` (ja) に同等の追記 |
| F7 | `skills/cmux-team/manager/state-machine/fsm.test.ts` | 712-725 (`Task FSM — DELETE` block) | force=true ケース 6 件を追加 |
| F8 | `skills/cmux-team/manager/state-machine/fsm.test.ts` | 604-624 (`deleted は終端 state` block) | `{ type: "DELETE", force: true }` を events 列に追加して deleted noop を再確認（または独立テスト追加） |
| F9 | `skills/cmux-team/manager/main.test.ts` | 795-800 付近 (`TASK_UPDATED postMessage` describe) | `delete-task --force` の CLI 統合テスト 3 件を追加 |

> 行番号は実装着手前のもの。差分適用後はずれる可能性あり。

---

## 3. 実装ステップ（TDD: 先にテスト → 次に実装）

### Step 1. FSM テスト追加（赤）

**File**: `skills/cmux-team/manager/state-machine/fsm.test.ts`

`describe("Task FSM — DELETE (A017 §2.2)", ...)` ブロック (L712-725) の末尾に以下を追加:

```typescript
test("closed + DELETE (force=false) → closed (noop)", () => {
  const { next, actions } = taskReduce(
    "closed",
    { type: "DELETE" },
    tctx({ hasConductor: false }),
  );
  expect(next).toBe("closed");
  expect(actions).toEqual([]);
});

test("closed + DELETE (force=true) → deleted + log(force=true)", () => {
  const { next, actions } = taskReduce(
    "closed",
    { type: "DELETE", force: true },
    tctx({ hasConductor: false }),
  );
  expect(next).toBe("deleted");
  const log = actions.find((a) => a.type === "log" && a.event === "task_deleted");
  expect(log).toBeDefined();
  if (log && log.type === "log") {
    expect(log.detail).toContain("force=true");
    expect(log.detail).toContain("prev=closed");
  }
  // closed → deleted では cascade_children を emit しない
  expect(actions.find((a) => a.type === "cascade_children")).toBeUndefined();
});

test("aborted + DELETE (force=false) → aborted (noop)", () => {
  const { next, actions } = taskReduce(
    "aborted",
    { type: "DELETE" },
    tctx({ hasConductor: false }),
  );
  expect(next).toBe("aborted");
  expect(actions).toEqual([]);
});

test("aborted + DELETE (force=true) → deleted + log(force=true)", () => {
  const { next, actions } = taskReduce(
    "aborted",
    { type: "DELETE", force: true },
    tctx({ hasConductor: false }),
  );
  expect(next).toBe("deleted");
  const log = actions.find((a) => a.type === "log" && a.event === "task_deleted");
  expect(log).toBeDefined();
  if (log && log.type === "log") {
    expect(log.detail).toContain("force=true");
    expect(log.detail).toContain("prev=aborted");
  }
});

test("assigned + DELETE (force=true) → assigned (force でも禁止)", () => {
  const { next, actions } = taskReduce(
    "assigned",
    { type: "DELETE", force: true },
    tctx(),
  );
  expect(next).toBe("assigned");
  expect(actions).toEqual([]);
});

test("deleted + DELETE (force=true) → deleted (terminal state guard)", () => {
  const { next, actions } = taskReduce(
    "deleted",
    { type: "DELETE", force: true },
    tctx({ hasConductor: false }),
  );
  expect(next).toBe("deleted");
  expect(actions).toEqual([]);
});
```

加えて L605-616 の `events: TaskFsmEvent[] = [...]` 配列に `{ type: "DELETE", force: true }` を追加するか、
既存テストとの重複を避けて上記の独立テストに集約する（後者を推奨）。

**期待**: 6 件全て **赤**（reducer 未対応のため `closed/aborted + DELETE(force)` は noop で `closed/aborted` のまま）。

### Step 2. `TaskFsmEvent.DELETE` 型を拡張（緑への準備）

**File**: `skills/cmux-team/manager/state-machine/events.ts:108`

```typescript
| { type: "DELETE"; force?: boolean }
```

これだけで型エラーは出ないが、`task-fsm.ts` 側の case が `event.force` を見ない限り赤のまま。

### Step 3. `task-fsm.ts` の `DELETE` case を拡張（緑）

**File**: `skills/cmux-team/manager/state-machine/task-fsm.ts:111-120`

```typescript
case "DELETE": {
  // delete-task CLI。draft / ready は通常削除（cascade あり）。
  // T333: closed / aborted は --force 指定時のみ削除（cascade なし、log に prev= を残す）。
  // assigned は force でも禁止（abort-task / restart-task 経由）。
  if (state === "draft" || state === "ready") {
    return withActions("deleted", [
      { type: "log", event: "task_deleted" },
      { type: "cascade_children" },
    ]);
  }
  if (event.force && (state === "closed" || state === "aborted")) {
    return withActions("deleted", [
      { type: "log", event: "task_deleted", detail: `force=true prev=${state}` },
    ]);
  }
  return noop(state);
}
```

**期待**: Step 1 の FSM テスト 6 件すべて **緑**。

> `state === "deleted"` の場合は L38 の terminal state guard で早期 return されるため `case "DELETE"`
> 内では考慮不要。テスト「deleted + DELETE (force=true) → deleted」はそのガードで通る。

### Step 4. CLI 統合テスト追加（赤）

**File**: `skills/cmux-team/manager/main.test.ts` の `describe("TASK_UPDATED postMessage (T183)", ...)`
ブロック (L706-) 内に追加。`runCli` / `setupTeamDir` ヘルパーをそのまま流用する。

```typescript
test("delete-task: closed タスクは --force なしで reject される", async () => {
  await setupTeamDir("560", "t-closed", "closed");
  const r = await runCli(["delete-task", "--task-id", "560"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("already closed");
  expect(r.stderr).toContain("--force");
  // task-state は変更されない
  const state = JSON.parse(
    await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
  );
  expect(state["560"].status).toBe("closed");
});

test("delete-task --force: closed タスクが deleted に遷移する", async () => {
  await setupTeamDir("561", "t-closed-force", "closed");
  const r = await runCli(["delete-task", "--task-id", "561", "--force"]);
  expect(r.code).toBe(0);
  const state = JSON.parse(
    await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
  );
  expect(state["561"].status).toBe("deleted");
  expect(receivedMessages.map((m) => m.type)).toEqual(["TASK_UPDATED"]);
});

test("delete-task --force: aborted タスクが deleted に遷移する", async () => {
  await setupTeamDir("562", "t-aborted-force", "aborted");
  const r = await runCli(["delete-task", "--task-id", "562", "--force"]);
  expect(r.code).toBe(0);
  const state = JSON.parse(
    await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
  );
  expect(state["562"].status).toBe("deleted");
});

test("delete-task --force: assigned タスクは依然 reject される", async () => {
  await setupTeamDir("563", "t-assigned", "assigned");
  const r = await runCli(["delete-task", "--task-id", "563", "--force"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("is assigned");
  const state = JSON.parse(
    await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
  );
  expect(state["563"].status).toBe("assigned");
});

test("delete-task --force: deleted タスクは依然 reject される", async () => {
  await setupTeamDir("564", "t-deleted", "deleted");
  const r = await runCli(["delete-task", "--task-id", "564", "--force"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("already deleted");
});
```

**期待**: 5 件すべて **赤**（main.ts 未対応のため）。

### Step 5. `cmdDeleteTask` を更新（緑）

**File**: `skills/cmux-team/manager/main.ts:4303-4372`

差分の要点:

```typescript
async function cmdDeleteTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_delete_task"));
  const taskIdInput = requireArg("task-id");
  const canonical = await resolveCanonicalTaskId(taskIdInput);
  if (!canonical) {
    console.error(`Error: task ${taskIdInput} not found in .team/tasks/`);
    process.exit(1);
  }
  const taskId = canonical;
  const journalArg = getArg("journal");
  const forceFlag = hasFlag("force");                       // ★ 追加

  const taskFile = await findTaskFile(taskId);
  if (!taskFile) {
    console.error(`Error: task ${taskId} not found in .team/tasks/`);
    process.exit(1);
  }

  const taskState = await loadTaskState(PROJECT_ROOT);
  const currentStatus = taskState[taskId]?.status;

  // assigned は force でも禁止
  if (currentStatus === "assigned") {
    console.error(`Error: task ${taskId} is assigned (running). Use abort-task to stop a running task.`);
    process.exit(1);
  }

  // deleted は二重削除 noop。エラーで明示する
  if (currentStatus === "deleted") {
    console.error(`Error: task ${taskId} is already deleted.`);
    process.exit(1);
  }

  // closed / aborted は --force でのみ削除可
  if ((currentStatus === "closed" || currentStatus === "aborted") && !forceFlag) {
    console.error(
      `Error: task ${taskId} is already ${currentStatus}. Use --force to delete a ${currentStatus} task.`,
    );
    process.exit(1);
  }

  // (以降の readFile / journal 計算ブロックはそのまま)
  const taskContent = await readFile(taskFile, "utf-8");
  const titleMatch = taskContent.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const title = titleMatch?.[1] ?? "";
  const journal = journalArg ?? t("delete_journal_default", { id: taskId, title }).replace(/\s+$/, "");

  const deletedAt = new Date().toISOString();
  const result = await applyTaskEvent(PROJECT_ROOT, {
    taskId,
    event: { type: "DELETE", force: forceFlag },           // ★ force を伝搬
    ctx: { hasConductor: false, parentAborted: false },
    patch: (_p, next) =>
      next === "deleted"
        ? { merge: { deletedAt, journal } }
        : {},
  });
  await refreshTaskStateFromDisk(PROJECT_ROOT, taskState);

  await log("task_deleted", `task_id=${taskId}${title ? ` title=${title}` : ""} journal_summary=${journal}${forceFlag ? ` force=true prev=${currentStatus}` : ""}`);
  for (const childId of result.revertedChildren) {
    await log("child_reverted_to_draft", `parent=${taskId} child=${childId} reason=parent_aborted`);
  }

  await postMessage({
    type: "TASK_UPDATED",
    taskId,
    taskFile,
    timestamp: new Date().toISOString(),
  });

  console.log(`OK deleted ${taskId}${forceFlag ? ` (force, prev=${currentStatus})` : ""}`);
}
```

**期待**: Step 4 の CLI テスト 5 件すべて **緑**。

### Step 6. ヘッダコメント / ヘルプ更新

**6-1. `main.ts:22`** — `[--force]` を追記:

```
 *   ./main.ts delete-task --task-id <id> [--journal <text>] [--force]
```

**6-2. `i18n.ts:466-484` (en `help_delete_task`)** — Options に行追加 / Notes 拡張 / Examples 追加:

```
Options:
  --task-id <id>          task ID (required)
  --journal <text>        deletion journal (optional, default: "Deleted: T{id} {title}")
  --force                 force-delete a closed or aborted task (assigned still requires abort-task)

Examples:
  cmux-team delete-task --task-id 035
  cmux-team delete-task --task-id 035 --journal "No longer needed"
  cmux-team delete-task --task-id 035 --force                 # delete a closed/aborted task

Notes:
  - draft / ready tasks can be deleted without --force
  - closed / aborted tasks require --force (assigned must use abort-task first)
  - assigned tasks cannot be deleted with --force; use abort-task / restart-task
  - deleted tasks are terminal; re-deletion is a no-op (rejected with exit 1)
  - Sets status to deleted in task-state.json
  - A record remains in the journal
```

**6-3. `i18n.ts:1254-1272` (ja `help_delete_task`)** — 同等の日本語訳:

```
Options:
  --task-id <id>          タスク ID（必須）
  --journal <text>        削除ジャーナル（任意、デフォルト: "削除: T{id} {title}"）
  --force                 closed / aborted のタスクを強制削除する（assigned は依然 abort-task が必要）

Examples:
  cmux-team delete-task --task-id 035
  cmux-team delete-task --task-id 035 --journal "不要になったため削除"
  cmux-team delete-task --task-id 035 --force                  # closed / aborted を強制削除

Notes:
  - draft / ready のタスクは --force なしで削除できます
  - closed / aborted のタスクは --force が必要です（assigned はまず abort-task で止めてください）
  - assigned のタスクは --force でも削除できません（abort-task / restart-task を使用）
  - deleted は終端状態で、再削除は exit 1 になります
  - task-state.json の status が deleted に設定されます
  - Journal タブに記録が残ります
```

### Step 7. 全体テスト・lint

```bash
bun test skills/cmux-team/manager/state-machine/fsm.test.ts
bun test skills/cmux-team/manager/main.test.ts -t "delete-task"
bun test skills/cmux-team/manager/main.test.ts -t "TASK_UPDATED"
```

> A021 で記録のとおり `bun test` 全体実行はハングする既知問題があるため、関連ファイル単位で実行する。

---

## 4. テスト戦略

### 4.1 FSM 単体テスト（fsm.test.ts）

| # | 状態 | event | 期待 next | 期待 actions |
|---|------|-------|-----------|--------------|
| T1 | closed | DELETE (force=false) | closed | `[]` (noop) |
| T2 | closed | DELETE (force=true) | deleted | `log(task_deleted, detail=force=true prev=closed)`、cascade なし |
| T3 | aborted | DELETE (force=false) | aborted | `[]` (noop) |
| T4 | aborted | DELETE (force=true) | deleted | `log(task_deleted, detail=force=true prev=aborted)`、cascade なし |
| T5 | assigned | DELETE (force=true) | assigned | `[]` (force でも noop) |
| T6 | deleted | DELETE (force=true) | deleted | `[]` (terminal state guard) |

加えて既存の以下が引き続き緑であること（regression check）:
- `draft + DELETE → deleted + cascade_children`
- `ready + DELETE → deleted + cascade_children`
- `assigned + DELETE (force=false) → assigned` (既存)
- `deleted + 全 events → deleted (no-op)` (既存)

### 4.2 CLI 統合テスト（main.test.ts）

| # | setup | invoke | exit | stderr / state |
|---|-------|--------|------|----------------|
| C1 | status=closed | `delete-task --task-id 560` | 1 | "already closed" + "--force" を含む / state 不変 |
| C2 | status=closed | `delete-task --task-id 561 --force` | 0 | state[561].status === "deleted" / `TASK_UPDATED` 1 件 |
| C3 | status=aborted | `delete-task --task-id 562 --force` | 0 | state[562].status === "deleted" |
| C4 | status=assigned | `delete-task --task-id 563 --force` | 1 | "is assigned" を含む / state 不変 |
| C5 | status=deleted | `delete-task --task-id 564 --force` | 1 | "already deleted" を含む |

### 4.3 既存テストの regression 確認

- `delete-task: TASK_UPDATED が送信される` (L795) — `--force` を付けない draft 削除が引き続き 0 で通ること
- `delete-task (T291): slug 渡しで canonical key が deleted に遷移` (L898) — slug 解決経路が壊れていないこと

---

## 5. リスク・注意点

### R1. `assigned` への force 禁止を厳守

`assigned` タスクの強制削除を許してしまうと、Conductor / Agent プロセスを残したまま `task-state.json`
の参照が消え、cleanup 経路（worktree 削除・PID watcher 解除）が走らなくなる。
- FSM レイヤ: `case "DELETE"` の force 分岐に `state === "assigned"` を含めない
- CLI レイヤ: `currentStatus === "assigned"` の reject を `forceFlag` チェックの **前** に置く
- テスト C4 / T5 で二重に検証

### R2. `deleted` への二重削除 noop

`deleted` 状態は terminal で復活経路がない。force でも reject 出力する（T303 の終端不変条件と整合）。
冪等とはせず exit 1 にすることで CI / スクリプト経由の誤操作に気付ける。
- テスト C5 / T6 で検証

### R3. `cascade_children` を closed / aborted 起点では emit しない

`closed` / `aborted` 状態に到達した時点で子タスクは既に親 ABORT/CLOSE 時の cascade 対象として処理済み。
deleted への遷移時に再度 cascade を走らせると、無関係になった子の `ready` を `draft` に巻き戻す副作用が
発生し得る。reducer 側で **明示的に emit しない** ように分岐を分ける。
- テスト T2 で `actions.find((a) => a.type === "cascade_children")` が undefined であることを assert

### R4. task-state.json の直接書込み禁止

CLAUDE.md「実装ルール」に従い、`taskState[taskId] = ...` / `saveTaskState(...)` を直接呼ばない。
必ず `applyTaskEvent` 経由で reducer の決定論に従わせる（T303 制約）。
- 既存実装は既に applyTaskEvent 経由のため、event payload の変更（`force` 追加）のみで足りる

### R5. ヘルプ（en/ja）の同期忘れ

`i18n.ts` の en (L466-484) と ja (L1254-1272) は二重メンテが必要。両方更新したか PR review でチェック。

### R6. 既存「Task FSM — deleted は終端 state」ブロックとの重複

L605-616 の events 配列に force=true 版を追加するとループ内 `expect` が再利用される反面、
test name の表示が混雑する。**独立 test (`test("deleted + DELETE (force=true) → deleted ...")`)**
として T6 を追加する方針で重複と可読性を両立させる。

### R7. `worktree` / `branch` 残骸の扱い

closed / aborted のタスクは通常 worktree が既に削除されているが、何らかの理由で残っている場合
delete-task は **手を出さない**（既存仕様と同じ）。掃除が必要な場合は `cmux-team agents` / 直接の
`git worktree remove` を案内する（ヘルプ Notes に書く必要はない、本タスクのスコープ外）。

---

## 6. 完了条件（チェックリスト）

### コード変更
- [ ] `events.ts:108` の `TaskFsmEvent.DELETE` に `force?: boolean` を追加
- [ ] `task-fsm.ts:111-120` の `DELETE` case を拡張（closed / aborted の force 分岐を追加）
- [ ] `main.ts:22` のヘッダコメントに `[--force]` を追記
- [ ] `main.ts:cmdDeleteTask` に `forceFlag` 判定を追加
- [ ] `main.ts:cmdDeleteTask` の status guard を 3 段（assigned → deleted → closed/aborted+force）に再構成
- [ ] `main.ts:cmdDeleteTask` の `applyTaskEvent` 呼出を `event: { type: "DELETE", force: forceFlag }` に変更
- [ ] `i18n.ts` (en) `help_delete_task` の Options / Examples / Notes に `--force` を追記
- [ ] `i18n.ts` (ja) `help_delete_task` に同等の日本語訳を追記

### テスト
- [ ] `fsm.test.ts` の `Task FSM — DELETE` ブロックに 6 ケース追加（T1〜T5 + T6）
- [ ] `main.test.ts` に CLI 統合テスト 5 件追加（C1〜C5）
- [ ] `bun test skills/cmux-team/manager/state-machine/fsm.test.ts` が全 pass
- [ ] `bun test skills/cmux-team/manager/main.test.ts -t "delete-task"` が全 pass
- [ ] 既存の `delete-task: TASK_UPDATED が送信される` / `delete-task (T291) slug` が引き続き pass

### 動作確認（手動 smoke test、worktree 内で実施）
- [ ] `bun run skills/cmux-team/manager/main.ts delete-task --help` で `--force` が表示される
- [ ] LANG=ja_JP 等で日本語ヘルプにも `--force` が表示される
- [ ] dry-run 的に `closed` タスクへの `delete-task` が "Use --force" メッセージで exit 1
- [ ] `delete-task --force` で `closed` → `deleted` への遷移が成功し `OK deleted XXX (force, prev=closed)` が出力される

### ドキュメント
- [ ] CLAUDE.md / docs/spec の追記は **不要**（task 属性の追加でも new event でもない、既存 event の拡張）
- [ ] PR description で「force でも assigned / deleted は禁止」「closed / aborted から deleted への遷移は cascade なし」を明記

---

## 付録: 既存 `--force` パターン参照表

| コマンド | フラグ判定 | 振る舞い | 参考 |
|---------|-----------|---------|------|
| `close-task --force` | `parseCloseTaskArgs` 内で `argv.includes("--force")` (L3405) | `assigned` を直接 `closed` に遷移可能にする | main.ts:3500-3514 |
| `update-task --force` | `hasFlag("force")` (L3195) | sync state ガード (`diverged` 等) を bypass する | main.ts:3108-3122 |
| `create-task --force` | `hasFlag("force")` (L3329) | 同上（ready 昇格時の sync ガード bypass） | main.ts:3329 |
| **`delete-task --force` (本タスク)** | `hasFlag("force")` | `closed` / `aborted` のみ `deleted` に遷移可能にする（`assigned` / `deleted` は不可） | 新規 |

判定方法は既存と同じ `hasFlag("force")` を踏襲し、振る舞いだけが本コマンド固有のセマンティクス
（terminal-ish state からのさらなる前進）になる点を PR で明示する。
