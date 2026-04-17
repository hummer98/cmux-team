# T241 実装計画: depends_on 親 abort/deleted 時の ready→draft cascade

## 1. 課題分析

### 1.1 現状の依存解決ロジック

`daemon.ts:1728-1732` の `scanTasks` で closed Set を構築している:

```typescript
const closed = new Set(
  Object.entries(taskState)
    .filter(([_, s]) => s.status === "closed" || s.status === "aborted" || s.status === "deleted")
    .map(([id]) => id)
);
```

そして `task.ts:193` の `filterExecutableTasks` が `task.dependsOn.every((dep) => closedIds.has(dep))` で判定する。つまり**親が `aborted` / `deleted` でも closed と同列に扱われ、子は自動 assigned される**。

### 1.2 なぜ危険か

- `closed` = 正常完了 → 子の前提は満たされている
- `aborted` / `deleted` = 中断・破棄 → **子の前提は崩れている可能性が高い**
- AND 条件（全依存が解決）なので、複数 depends_on のうち 1 つでも中断すれば前提全体が崩れる
- それでも子が自動起動してしまう = 人間の再判断を奪い、誤った作業を走らせるリスク

### 1.3 仕様（task.md より）

タスク X が `aborted` / `deleted` に遷移した瞬間、`depends_on` に X を含む open な子に対し:

| 子の状態 | 処理 |
|---|---|
| `draft` | 変更なし |
| `ready` | **`draft` に戻す** |
| `assigned` | 変更なし（走っている作業は止めない） |
| `closed` / `aborted` / `deleted` | 変更なし |

補足:
- 子 journal に `parent_aborted: <parentTaskId>` を追記
- 複数 depends_on のうち 1 つでも abort したら draft に戻す
- `deleted` も同様
- ログ: `child_reverted_to_draft parent=<X> child=<Y> reason=parent_aborted`

### 1.4 影響範囲（5 経路）

| # | 経路 | 現コード位置 | 役者 |
|---|---|---|---|
| 1 | 明示 abort（`abort-task` CLI） | `main.ts:2988-2994` / `main.ts:3012-3018` | CLI (main.ts) |
| 2 | Conductor forced close | `daemon.ts:2138-2168`（`forceCloseDisconnectedConductor`） | daemon |
| 3 | user_clear（手動 /clear で running を abort） | `daemon.ts:1664-1681` | daemon |
| 4 | assign_failed（worktree 作成失敗等） | `daemon.ts:1815-1829` | daemon |
| 5 | `delete-task` CLI | `main.ts:3257-3262` | CLI (main.ts) |

いずれも **task-state.json を直接書き換える同期処理**。daemon 内 3 経路 + CLI 2 経路。

## 2. 技術アプローチ

### 2.1 関数配置: `task.ts` に置く

**Decision D1**: cascade 関数は `task.ts` に置く（D1 詳細は §8）。

理由:
- task-state / task meta を受け取る純粋関数であり daemon 依存がない
- daemon.ts と main.ts の両方から呼ぶため、共通レイヤー (`task.ts`) に置くのが自然
- task.ts は依存が少なく副作用が限定的（`logger` のみ）

### 2.2 関数シグネチャ

```typescript
// skills/cmux-team/manager/task.ts に追加

export interface CascadeAbortResult {
  /** ready → draft に戻した子タスク ID のリスト */
  revertedChildren: string[];
}

/**
 * 親タスクが aborted / deleted に遷移した直後に呼び出し、depends_on に親を
 * 含む ready 子タスクを draft に戻す。TaskStateMap はミュータブルに更新され
 * るため、呼び出し側で saveTaskState を呼ぶこと。
 *
 * 仕様:
 * - 子が "ready" の場合のみ "draft" に戻す（draft/assigned/closed/aborted/deleted は変更なし）
 * - 子 journal に `parent_aborted: <parentTaskId>` を追記（既存 journal は `; ` で連結）
 * - 複数 depends_on のうち 1 つでも親が abort/deleted なら cascade 対象
 *   （呼び出し側が「自身の遷移」起点で呼ぶので、ここではその 1 親との関係のみ判定）
 *
 * 返り値:
 * - revertedChildren: draft に戻した子 ID 群（呼び出し側がログ・notify に使う）
 */
export function cascadeAbortToChildren(
  state: TaskStateMap,
  tasks: TaskMeta[],
  parentTaskId: string
): CascadeAbortResult {
  const reverted: string[] = [];
  for (const t of tasks) {
    if (!t.dependsOn.includes(parentTaskId)) continue;
    const current = state[t.id];
    if (current?.status !== "ready") continue;

    const prev = current.journal ?? "";
    const appended = `parent_aborted: ${parentTaskId}`;
    state[t.id] = {
      ...current,
      status: "draft",
      journal: prev ? `${prev}; ${appended}` : appended,
    };
    reverted.push(t.id);
  }
  return { revertedChildren: reverted };
}
```

**ログは呼び出し側で出す**（task.ts は logger 依存済みだが、ログ文の文脈=どの経路から呼ばれたかが呼び側にある）。

### 2.3 呼び出しプロトコル

各 abort/delete 経路で以下の順序を守る:

```typescript
// 1. 親タスクを aborted / deleted に遷移（既存処理）
ts[parentId] = { ...current, status: "aborted", ... };

// 2. tasks meta を loadTasks で取得（既に取得済みなら再利用）
const { tasks } = await loadTasks(projectRoot);

// 3. cascade 実行（state をミュータブル更新）
const { revertedChildren } = cascadeAbortToChildren(ts, tasks, parentId);

// 4. まとめて保存（親遷移 + cascade 結果）
await saveTaskState(projectRoot, ts);

// 5. ログ + TUI 通知
for (const childId of revertedChildren) {
  await log("child_reverted_to_draft",
    `parent=${parentId} child=${childId} reason=parent_aborted`);
}
// daemon 経路では notifyStateChanged、CLI 経路では TASK_UPDATED postMessage で TUI 反映
```

### 2.4 closed Set の扱い（仕様解釈）

**Decision D3**: `daemon.ts:1728-1732` の closed Set は **変更しない**。

理由:
- cascade が発動すれば ready 子は draft になるため、`filterExecutableTasks` の `status !== "ready"` 判定で自然に弾かれる
- closed Set から aborted/deleted を除外すると、既に assigned 済みの子（前提が崩れていても進んでしまう可能性があるケース）や draft 遷移済みの子との重複で副作用が出る
- cascade は「状態遷移の瞬間に一度だけ」子の ready を draft に倒せば足りる。恒久的な Set 判定変更は不要

ただし 1 箇所だけ意図確認: `sortOpenTasksForDisplay` 対象（`openTasksList`）や `dependsOn.filter(dep => !closed.has(dep))`（1769 行）等の TUI 表示側は現状維持で問題ない。子が draft になっても依存表示は parentId を残すので、操作者から見た「どの親が前提か」は保たれる。

### 2.5 cascade 発動前の assign レース検証

`scanTasks` の assign フローは同一イベントループ内で `assignedIds.add` → `assignTask` を同期的に実行する。cascade は**親遷移と同じ同期ブロック内**で発動するため、その tick 中の後続 assign で ready→draft 済みの子は拾わない。

外部 tick で子が ready で先に assign されていた場合: 子は既に `assigned` 状態であり、本仕様では「変更なし」。タスクは走り切るが、親の abort 情報は journal に残らない（assigned 子には journal 追記しない設計）。**この挙動は仕様の表通り**（assigned は止めない）なので問題なし。

### 2.6 代替案と却下理由

| 代替案 | 却下理由 |
|---|---|
| closed Set から aborted/deleted を除外 | 既存 assigned 子の扱いが曖昧・正常系回帰リスク |
| daemon に集約（TASK_UPDATED を daemon が diff 検知） | TASK_UPDATED は status 差分を運ばない。daemon 側で前後 snapshot を持つと複雑化 |
| cascade 関数を daemon.ts 内に置く | main.ts からも呼ぶ必要があり、daemon.ts import は重すぎる（logger/watcher 等の副作用） |
| 新メッセージ `TASK_ABORTED` を追加 | 5 経路のうち 3 は daemon 内処理で post → self-handle は冗長。CLI 2 経路も同期呼び出しで足り、message 経由にすると遅延が発生 |

## 3. 変更対象

### 3.1 ファイル一覧

| ファイル | 変更内容 | 行数目安 |
|---|---|---|
| `skills/cmux-team/manager/task.ts` | `cascadeAbortToChildren` 追加 + `CascadeAbortResult` 型 export | +40 |
| `skills/cmux-team/manager/daemon.ts` | 3 経路（user_clear / forceClose / assign_failed）で cascade 呼び出し | +60 |
| `skills/cmux-team/manager/main.ts` | 2 経路（cmdAbortTask / cmdDeleteTask）で cascade 呼び出し | +40 |
| `skills/cmux-team/manager/daemon.test.ts` | 統合テスト 5 ケース追加 | +180 |
| `skills/cmux-team/manager/task.test.ts` | pure function テスト（cascade のエッジケース） | +90 |
| `CLAUDE.md` | 「エラーリカバリ」表の追加行 + cascade 挙動明記 | +15 |

### 3.2 daemon.ts の詳細

#### 経路 3: user_clear（`daemon.ts:1664-1681`）

現コード:
```typescript
if (conductor && conductor.status === "running") {
  const taskId = conductor.taskId;
  if (taskId) {
    try {
      const ts = await loadTaskState(state.projectRoot);
      const current = ts[taskId];
      if (current?.status !== "closed" && current?.status !== "aborted" && current?.status !== "deleted") {
        const journal = `user_clear: ...`;
        ts[taskId] = { ...current, status: "aborted", abortedAt: ..., journal };
        await saveTaskState(state.projectRoot, ts);
        await log("task_aborted", `task_id=${taskId} reason=user_clear`);
      }
    } catch (e: any) { ... }
  }
  ...
}
```

変更: `saveTaskState` 直前に cascade を挿入。

```typescript
if (current?.status !== "closed" && current?.status !== "aborted" && current?.status !== "deleted") {
  const journal = `user_clear: ...`;
  ts[taskId] = { ...current, status: "aborted", abortedAt: ..., journal };

  // T241: depends_on 親 abort → ready 子を draft に戻す
  const { tasks } = await loadTasks(state.projectRoot);
  const { revertedChildren } = cascadeAbortToChildren(ts, tasks, taskId);

  await saveTaskState(state.projectRoot, ts);
  await log("task_aborted", `task_id=${taskId} reason=user_clear`);
  for (const childId of revertedChildren) {
    await log("child_reverted_to_draft",
      `parent=${taskId} child=${childId} reason=parent_aborted`);
  }
  if (revertedChildren.length > 0) {
    notifyStateChanged("daemon.ts:handleMessage:session-clear-cascade");
  }
}
```

#### 経路 2: forceCloseDisconnectedConductor（`daemon.ts:2138-2168`）

同一パターン。`saveTaskState` の直前に cascade 呼び出し + ログ + `notifyStateChanged("daemon.ts:forceCloseDisconnectedConductor:cascade")` を挿入。

#### 経路 4: assign_failed（`daemon.ts:1815-1829`）

```typescript
if (e.kind === "task") {
  const ts = await loadTaskState(state.projectRoot);
  ts[task.id] = { ...ts[task.id], status: "aborted", abortedAt: ..., journal: `assign_failed: ...` };

  // T241: cascade
  // 注: scanTasks 冒頭で loadTasks 済みだが、tasks は local const。
  //     ここでは e.kind === "task" 分岐が頻度低いので再 loadTasks で実装の単純化を優先。
  const { tasks: currentTasks } = await loadTasks(state.projectRoot);
  const { revertedChildren } = cascadeAbortToChildren(ts, currentTasks, task.id);

  await saveTaskState(state.projectRoot, ts);
  await log("task_aborted", `task_id=${task.id} ...`);
  for (const childId of revertedChildren) {
    await log("child_reverted_to_draft",
      `parent=${task.id} child=${childId} reason=parent_aborted`);
  }
  // scanTasks は直後にループ次 iteration に入るため、notifyStateChanged は省略可
  // （同 tick 終盤で state.taskList が差分検出される）。保険で呼んでおく。
  if (revertedChildren.length > 0) {
    notifyStateChanged("daemon.ts:scanTasks:assign-failed-cascade");
  }
  ...
}
```

**最適化案**（実装時検討）: `scanTasks` 冒頭で既に `const { tasks, taskState } = await loadTasks(...)` を実行している。その `tasks` を分岐内で使い回せば再 loadTasks 不要。ただし分岐内で `ts = await loadTaskState(...)` を新規取得しているため、タスクメタは同期でよい。シンプル性優先で再 loadTasks とするか、既存 `tasks` を引き回すかは実装者判断（Decision D4、§8）。

### 3.3 main.ts の詳細

#### 経路 1: cmdAbortTask（`main.ts:2988-2994` と `main.ts:3012-3018`）

abort-task は「Conductor 不在」と「Conductor 有り」の 2 分岐で task-state を aborted にする。**両方**に cascade 追加。

`main.ts:2988-2994`（Conductor 不在）:
```typescript
taskState[taskId] = { ...taskState[taskId], status: "aborted", abortedAt: ..., journal };

// T241: cascade
const { tasks } = await loadTasks(PROJECT_ROOT);
const { revertedChildren } = cascadeAbortToChildren(taskState, tasks, taskId);

await saveTaskState(PROJECT_ROOT, taskState);
await log("task_aborted", ...);
for (const childId of revertedChildren) {
  await log("child_reverted_to_draft",
    `parent=${taskId} child=${childId} reason=parent_aborted`);
}
```

`main.ts:3012-3018`（Conductor 有り）: 同一パターン。

`loadTasks` は既に main.ts で import 済み（`task.ts` から）。

#### 経路 5: cmdDeleteTask（`main.ts:3257-3262`）

```typescript
taskState[taskId] = {
  status: "deleted",
  deletedAt: ...,
  journal,
};

// T241: cascade（deleted も同様）
const { tasks } = await loadTasks(PROJECT_ROOT);
const { revertedChildren } = cascadeAbortToChildren(taskState, tasks, taskId);

await saveTaskState(PROJECT_ROOT, taskState);
await log("task_deleted", ...);
for (const childId of revertedChildren) {
  await log("child_reverted_to_draft",
    `parent=${taskId} child=${childId} reason=parent_deleted`);
}
```

**注記**: ログ文言は `reason=parent_deleted`（`aborted` 系は `parent_aborted`）と分けるか、仕様通り全て `parent_aborted` とするか（仕様文は「`parent_aborted: <parentTaskId>`」で統一）。

**Decision D2（§8 参照）**: journal 追記は仕様通り全て `parent_aborted: <parentTaskId>`（deleted も含む）。ログキー `reason=` は運用時に「どちら由来か」を識別したいなら分ける価値があるが、仕様の簡潔さ優先で `parent_aborted` に統一。

### 3.4 import 更新

- `daemon.ts`: 既存 `import { ..., cascadeAbortToChildren } from "./task"` に追加（既に task.ts から複数 import 済み）
- `main.ts`: 同上

### 3.5 CLAUDE.md 更新

「エラーリカバリ」表の直下に以下を追記:

```markdown
### 依存タスクの cascade（T241）

親タスクが `aborted` / `deleted` に遷移したとき、`depends_on` に親を含む
**ready** 状態の子タスクは自動的に `draft` に戻される。

- `draft` 子: 変更なし
- `ready` 子: **`draft` に戻す**（journal に `parent_aborted: <parentId>` 追記）
- `assigned` 子: 変更なし（走行中の作業は止めない）
- `closed` / `aborted` / `deleted` 子: 変更なし

cascade は以下 5 経路で同期的に走る:
1. `cmux-team abort-task` CLI
2. `cmux-team delete-task` CLI
3. Conductor forced close（disconnect timeout）
4. user_clear（手動 /clear で running を abort）
5. assign_failed（worktree 作成失敗等）

ログ: `child_reverted_to_draft parent=<X> child=<Y> reason=parent_aborted`
```

## 4. サブタスク分割

以下の順序で実装する。各サブタスクは単体で commit 可能（テストは最後にまとめる）。

### S1. `cascadeAbortToChildren` 関数を task.ts に追加

- 対象: `skills/cmux-team/manager/task.ts`（末尾付近）
- 完了条件:
  - `CascadeAbortResult` interface と `cascadeAbortToChildren` 関数が export される
  - `bunx tsc --noEmit` が通る
- 検証: `grep -n "cascadeAbortToChildren" skills/cmux-team/manager/task.ts` で関数定義 1 件

### S2. task.test.ts に pure function テストを追加

- 対象: `skills/cmux-team/manager/task.test.ts`
- 完了条件:
  - 以下 6 ケースが pass する:
    - 親 aborted + 子 ready → draft に戻る
    - 親 aborted + 子 draft → 変化なし
    - 親 aborted + 子 assigned → 変化なし
    - 親 aborted + 子 closed → 変化なし
    - 複数 depends_on のうち 1 つだけ呼び出し → ready 子のみ draft
    - 既存 journal がある子 → `; parent_aborted: ...` で追記される
- 検証: `bun test skills/cmux-team/manager/task.test.ts`

### S3. daemon.ts の 3 経路に cascade 呼び出しを追加

- 対象:
  - `daemon.ts:1664-1681`（user_clear）
  - `daemon.ts:2138-2168`（forceCloseDisconnectedConductor）
  - `daemon.ts:1815-1829`（assign_failed）
- 使用パターン: §2.3 の呼び出しプロトコル
- 完了条件:
  - 各箇所で saveTaskState の**直前**に cascade を呼ぶ
  - `child_reverted_to_draft` ログを出す
  - `notifyStateChanged("daemon.ts:<context>:cascade")` を呼ぶ（revertedChildren.length > 0 時）
  - `bunx tsc --noEmit` が通る
- 検証: `grep -n "cascadeAbortToChildren" skills/cmux-team/manager/daemon.ts` で 3 箇所

### S4. main.ts の 2 経路に cascade 呼び出しを追加

- 対象:
  - `main.ts:2988-2994`（cmdAbortTask, no conductor）
  - `main.ts:3012-3018`（cmdAbortTask, with conductor）
  - `main.ts:3257-3262`（cmdDeleteTask）
- 完了条件:
  - 各箇所で saveTaskState の直前に cascade
  - `child_reverted_to_draft` ログ
  - `bunx tsc --noEmit` が通る
- 検証: `grep -n "cascadeAbortToChildren" skills/cmux-team/manager/main.ts` で 3 箇所

### S5. daemon.test.ts に統合テスト 5 ケース追加

- 対象: `skills/cmux-team/manager/daemon.test.ts`
- セクション: 新規 describe ブロック `"depends_on cascade on parent abort/delete (T241)"`
- 使用する既存ヘルパー: `createTask`, `closeTask`, `loadTaskState` import, `scanTasks`
- 追加ヘルパー（必要なら）: `abortTask(id, journal?)`, `deleteTask(id, journal?)` で task-state を直接書き換え
- 完了条件: §5 の 5 ケースが pass
- 検証: `bun test skills/cmux-team/manager/daemon.test.ts`

### S6. CLAUDE.md を更新

- 対象: リポジトリルート `CLAUDE.md` の「エラーリカバリ」セクション直下
- 完了条件: §3.5 の内容が追記されている
- 検証: `grep -n "T241" CLAUDE.md`

### S7. 全体テスト実行

- コマンド: `bun test skills/cmux-team/manager/`
- 完了条件: 全テスト pass
- 既存回帰がないことを確認

## 5. テスト戦略

### 5.1 pure function テスト（task.test.ts, S2）

```typescript
import { cascadeAbortToChildren } from "./task";
import type { TaskMeta, TaskStateMap } from "./task";

function mkTask(id: string, dependsOn: string[] = []): TaskMeta {
  return {
    id, title: `task-${id}`, status: "ready", priority: "medium",
    dependsOn, runAfterAll: false,
    filePath: `/tmp/${id}.md`, fileName: `${id}.md`, createdAt: "2026-04-17T00:00:00Z",
  };
}

describe("cascadeAbortToChildren (T241)", () => {
  test("親 aborted + 子 ready → draft に戻る", () => {
    const tasks = [mkTask("1"), mkTask("2", ["1"])];
    const state: TaskStateMap = {
      "1": { status: "aborted", abortedAt: "..." },
      "2": { status: "ready" },
    };
    const result = cascadeAbortToChildren(state, tasks, "1");
    expect(result.revertedChildren).toEqual(["2"]);
    expect(state["2"]?.status).toBe("draft");
    expect(state["2"]?.journal).toBe("parent_aborted: 1");
  });

  test("親 aborted + 子 draft → 変化なし", () => {
    const tasks = [mkTask("1"), mkTask("2", ["1"])];
    const state: TaskStateMap = {
      "1": { status: "aborted" },
      "2": { status: "draft" },
    };
    const result = cascadeAbortToChildren(state, tasks, "1");
    expect(result.revertedChildren).toEqual([]);
    expect(state["2"]?.status).toBe("draft");
    expect(state["2"]?.journal).toBeUndefined();
  });

  test("親 aborted + 子 assigned → 変化なし", () => {
    const tasks = [mkTask("1"), mkTask("2", ["1"])];
    const state: TaskStateMap = {
      "1": { status: "aborted" },
      "2": { status: "assigned", assignedAt: "..." },
    };
    const result = cascadeAbortToChildren(state, tasks, "1");
    expect(result.revertedChildren).toEqual([]);
    expect(state["2"]?.status).toBe("assigned");
  });

  test("親 aborted + 子 closed/aborted/deleted → 変化なし", () => {
    const tasks = [mkTask("1"), mkTask("2", ["1"]), mkTask("3", ["1"]), mkTask("4", ["1"])];
    const state: TaskStateMap = {
      "1": { status: "aborted" },
      "2": { status: "closed" },
      "3": { status: "aborted" },
      "4": { status: "deleted" },
    };
    const result = cascadeAbortToChildren(state, tasks, "1");
    expect(result.revertedChildren).toEqual([]);
  });

  test("複数 depends_on の子 ready → 1 親 cascade でも draft", () => {
    // 子が [1,2] に依存。1 を abort した瞬間に cascade される
    const tasks = [mkTask("1"), mkTask("2"), mkTask("3", ["1", "2"])];
    const state: TaskStateMap = {
      "1": { status: "aborted" },
      "2": { status: "ready" },
      "3": { status: "ready" },
    };
    const result = cascadeAbortToChildren(state, tasks, "1");
    expect(result.revertedChildren).toEqual(["3"]);
    expect(state["3"]?.status).toBe("draft");
  });

  test("既存 journal がある子 → `; parent_aborted:` で追記", () => {
    const tasks = [mkTask("1"), mkTask("2", ["1"])];
    const state: TaskStateMap = {
      "1": { status: "aborted" },
      "2": { status: "ready", journal: "prev note" },
    };
    cascadeAbortToChildren(state, tasks, "1");
    expect(state["2"]?.journal).toBe("prev note; parent_aborted: 1");
  });
});
```

### 5.2 daemon.test.ts 統合テスト（S5）

既存 `createTask` ヘルパー（`daemon.test.ts:31-72`）に `dependsOn` パラメータが既にあるのでそれを使う。`loadTaskState` import も既存。

セットアップヘルパー追加:
```typescript
async function abortTaskDirect(id: string, journal = "test abort"): Promise<void> {
  const { saveTaskState, loadTaskState } = await import("./task");
  const taskState = await loadTaskState(testDir);
  taskState[id] = { status: "aborted", abortedAt: new Date().toISOString(), journal };
  await saveTaskState(testDir, taskState);
}
async function deleteTaskDirect(id: string, journal = "test delete"): Promise<void> {
  const { saveTaskState, loadTaskState } = await import("./task");
  const taskState = await loadTaskState(testDir);
  taskState[id] = { status: "deleted", deletedAt: new Date().toISOString(), journal };
  await saveTaskState(testDir, taskState);
}
```

5 ケース:

```typescript
describe("depends_on cascade on parent abort/delete (T241)", () => {
  test("ケース1: 親 abort → 子 ready が draft に戻る", async () => {
    // cascadeAbortToChildren を直接呼ぶ形で検証（daemon.ts の経路は別途 E2E で確認）
    // または: assign_failed 経路のテストと同じく scanTasks 経由で発動させる
    await createTask("1", "parent", { status: "ready" });
    await createTask("2", "child", { dependsOn: ["1"], status: "ready" });

    const { tasks: loadedTasks } = await loadTasks(testDir);
    const { loadTaskState, saveTaskState, cascadeAbortToChildren } = await import("./task");
    const ts = await loadTaskState(testDir);
    ts["1"] = { status: "aborted", abortedAt: new Date().toISOString(), journal: "test" };
    const result = cascadeAbortToChildren(ts, loadedTasks, "1");
    await saveTaskState(testDir, ts);

    expect(result.revertedChildren).toEqual(["2"]);
    const after = await loadTaskState(testDir);
    expect(after["2"]?.status).toBe("draft");
    expect(after["2"]?.journal).toBe("parent_aborted: 1");
  });

  test("ケース2: 親 abort → 子 assigned は維持", async () => {
    await createTask("10", "parent");
    await createTask("11", "child", { dependsOn: ["10"] });
    // 子を assigned 状態にする
    {
      const { saveTaskState, loadTaskState } = await import("./task");
      const ts = await loadTaskState(testDir);
      ts["11"] = { status: "assigned", assignedAt: new Date().toISOString() };
      await saveTaskState(testDir, ts);
    }

    const { tasks: loadedTasks } = await loadTasks(testDir);
    const { loadTaskState, saveTaskState, cascadeAbortToChildren } = await import("./task");
    const ts = await loadTaskState(testDir);
    ts["10"] = { status: "aborted", abortedAt: new Date().toISOString() };
    const result = cascadeAbortToChildren(ts, loadedTasks, "10");
    await saveTaskState(testDir, ts);

    expect(result.revertedChildren).toEqual([]);
    const after = await loadTaskState(testDir);
    expect(after["11"]?.status).toBe("assigned");
  });

  test("ケース3: 親 delete → 子 ready が draft に戻る", async () => {
    await createTask("20", "parent");
    await createTask("21", "child", { dependsOn: ["20"] });

    const { tasks: loadedTasks } = await loadTasks(testDir);
    const { loadTaskState, saveTaskState, cascadeAbortToChildren } = await import("./task");
    const ts = await loadTaskState(testDir);
    ts["20"] = { status: "deleted", deletedAt: new Date().toISOString() };
    const result = cascadeAbortToChildren(ts, loadedTasks, "20");
    await saveTaskState(testDir, ts);

    expect(result.revertedChildren).toEqual(["21"]);
    const after = await loadTaskState(testDir);
    expect(after["21"]?.status).toBe("draft");
    expect(after["21"]?.journal).toBe("parent_aborted: 20");
  });

  test("ケース4: 複数 depends_on のうち 1 つが abort でも draft に戻る", async () => {
    await createTask("30", "parent-a");
    await createTask("31", "parent-b");
    await createTask("32", "child", { dependsOn: ["30", "31"] });

    const { tasks: loadedTasks } = await loadTasks(testDir);
    const { loadTaskState, saveTaskState, cascadeAbortToChildren } = await import("./task");
    const ts = await loadTaskState(testDir);
    ts["30"] = { status: "aborted", abortedAt: new Date().toISOString() };
    const result = cascadeAbortToChildren(ts, loadedTasks, "30");
    await saveTaskState(testDir, ts);

    expect(result.revertedChildren).toEqual(["32"]);
    const after = await loadTaskState(testDir);
    expect(after["32"]?.status).toBe("draft");
  });

  test("ケース5: 孫世代 A→B→C で A abort → B=ready は draft、C は変化なし", async () => {
    await createTask("40", "task-A");
    await createTask("41", "task-B", { dependsOn: ["40"] });
    await createTask("42", "task-C", { dependsOn: ["41"] });

    const { tasks: loadedTasks } = await loadTasks(testDir);
    const { loadTaskState, saveTaskState, cascadeAbortToChildren } = await import("./task");
    const ts = await loadTaskState(testDir);
    ts["40"] = { status: "aborted", abortedAt: new Date().toISOString() };
    const result = cascadeAbortToChildren(ts, loadedTasks, "40");
    await saveTaskState(testDir, ts);

    // B のみ revert、C は B が ready のままではないが A の直接の子ではないので変化なし
    expect(result.revertedChildren).toEqual(["41"]);
    const after = await loadTaskState(testDir);
    expect(after["41"]?.status).toBe("draft");
    // C は元の ready のまま（filterExecutableTasks 側で B が draft = not closed なので起動はされない）
    expect(after["42"]?.status).toBe("ready");
  });

  // 追加回帰テスト: 正常系（親 closed → 子 assign される）
  test("回帰: 親 closed → 子 ready はそのまま（cascade は発動しない）", async () => {
    await createTask("50", "parent");
    await createTask("51", "child", { dependsOn: ["50"] });

    await closeTask("50");
    const { tasks: loadedTasks } = await loadTasks(testDir);
    const { loadTaskState, cascadeAbortToChildren } = await import("./task");
    const ts = await loadTaskState(testDir);

    // closed は cascade 対象外（関数は parentTaskId の遷移起点で呼ばれる想定だが、
    //   closed 起点で誤って呼んでも子 ready は**維持される仕様**：
    //   cascadeAbortToChildren は呼ばれた時点で無条件に ready → draft に変換するため、
    //   呼び出し側が「aborted/deleted 遷移時のみ呼ぶ」ことを守る必要がある）
    // このテストは closed パスでは cascade が呼ばれないことを保証する目的では書けない。
    // 代わりに filterExecutableTasks が子 ready を拾うことを確認する。
    const closed = new Set(
      Object.entries(ts).filter(([_, s]) => s.status === "closed").map(([id]) => id)
    );
    const open = loadedTasks.filter(t => t.status !== "closed");
    const { filterExecutableTasks } = await import("./task");
    const executable = filterExecutableTasks(open, closed, new Set());
    expect(executable.map(t => t.id)).toContain("51");
  });
});
```

**補足**: ケース1-5 は cascade 関数を直接呼び、ケース6（回帰）は既存の正常系が壊れていないことを確認する。daemon.ts の各経路の E2E は `scanTasks` 経由で 1 ケース（assign_failed cascade）だけ追加してもよいが、本質は pure 関数テストで十分カバーされるのでスキップ可能（Decision D5 で判断）。

### 5.3 既存テストスタイルとの整合

- `daemon.test.ts`: `beforeEach` で `testDir` を tmpdir に作り `.team/tasks/`, `.team/output/` 等を用意。`createTask` / `closeTask` ヘルパーを再利用。
- import 方式: 動的 import（`const { foo } = await import("./task")`）をテスト内部で使う既存パターンを踏襲。
- アサーション: `expect(...).toEqual(...)` / `expect(...).toBe(...)` / `expect(...).toBeDefined()` / `expect(...).toContain(...)`。

## 6. リスク

### 6.1 既存正常系への回帰リスク

- **親 closed → 子 assigned** 経路: closed Set は**変更しない**ので既存通り動く。§2.4 の通り回帰は発生しない。
- `scanTasks` の `closed` Set は依然として `closed || aborted || deleted` を含む。ただし cascade 後は子が draft になるので、`filterExecutableTasks` の `status !== "ready"` 条件で弾かれる。二重防御。

### 6.2 循環 depends_on での無限ループ

`cascadeAbortToChildren` は `tasks.filter(t => t.dependsOn.includes(parentTaskId))` で**1 親起点の直接の子のみ**を 1 パス走査する。孫世代には再帰しない。循環があっても関数は O(N) で終わる。
孫への伝播は「B が draft になる → C の親 B は draft（= not closed）→ C は起動されない」という**間接的な防御**で実現する。C が起動しない、というだけで C 自身の状態は変わらない。これは仕様通り（ケース5 のアサーション）。

### 6.3 journal 追記の race condition

- daemon 内 3 経路は同一 daemon プロセス内で `loadTaskState` → mutate → `saveTaskState` を同期実行。race なし。
- CLI 2 経路は別プロセスだが、daemon と CLI の書き込みが同時発生するとレース可能性あり。
  - 既存 `saveTaskState` は `writeFile` → `rename`（アトミック）で書くが、load-modify-save の間に daemon 側で書き換えられると loss update 発生。
  - **これは T241 以前から存在する一般的な問題**であり、本タスクで解決対象外。運用上は「user が abort-task を叩くタイミング = ユーザ主導」であり、daemon が同じ task-state を同時に書く可能性は極めて低い（cmdAbortTask は assigned 状態のみ対象で daemon 側は running→aborted を user_clear 等で触る）。
  - 念のため、実装者は既存パターン（load → mutate → save）を守り、新たなレースを導入しないこと。

### 6.4 pendingTasks カウントのずれ

cascade で子が ready → draft になった場合、`state.pendingTasks` の再計算は次の `scanTasks` tick まで遅延する。ただし `notifyStateChanged` を呼んでいれば TUI は次の refresh で正しい値を描画する。**実害なし**。

### 6.5 TASK_UPDATED 不送信による子タスクファイルの TUI 反映遅延

CLI 経路（cmdAbortTask / cmdDeleteTask）は TASK_UPDATED を**親タスクについてのみ** postMessage している。cascade で変更された子については送っていない。daemon 側は task-state.json の変更を ファイル監視で検知する（既存の scanTasks トリガー）ので最終的には反映される。
**対応**: 即時反映が必要なら子についても TASK_UPDATED を送るが、既存の file watcher（`initFileWatcher`）が `.team/task-state.json` を監視しているのでポーリング次第で十分。Decision D6（§8）で「送らない」を選択。

## 7. 既存型エラーの先読み

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-241-1776422261/skills/cmux-team/manager
bunx tsc --noEmit 2>&1 | grep -E "^(daemon\.ts|main\.ts|daemon\.test\.ts|task\.ts)" || true
```

実行結果: **該当なし**（既存型エラーなし）。本タスクの変更で新規型エラーが発生しないよう、S1/S3/S4 各段階で `bunx tsc --noEmit` を回すこと。

### 7.1 本タスクで解消するエラー

| ファイル | エラー | 解消タイミング |
|---|---|---|
| （該当なし） | — | — |

### 7.2 後続タスクに分離するエラー

| ファイル | エラー | 理由 |
|---|---|---|
| （該当なし） | — | — |

## 8. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | cascade 関数の配置先 | `task.ts` | daemon/main 両方から呼ぶ純粋関数。task.ts は依存軽量・副作用限定で適切 |
| D2 | journal フォーマット | `parent_aborted: <parentId>` 文字列（既存 journal には `; ` で連結） | 仕様通り。構造化 JSON は既存 journal と不整合。文字列なら簡素 |
| D3 | 依存解決 Set の扱い | closed Set は**変更しない** | cascade で子 ready → draft となり filterExecutableTasks で弾かれるため二重対策不要。既存 assigned 子への回帰リスク回避 |
| D4 | assign_failed 分岐の tasks 再取得 | 再 loadTasks する（scanTasks の既存 `tasks` を引き回さない） | 分岐頻度が低くシンプル性を優先。将来 scanTasks が tasks を mutate するリファクタが入ってもこの分岐は壊れない |
| D5 | daemon 各経路の E2E テスト | task.test.ts の pure function テストで十分。daemon.test.ts は cascade 関数を直接呼ぶ形 | scanTasks 経由の E2E は設定コストが高い（git worktree 必要等）。cascade ロジック自体はピュアなので単体テストで代替可 |
| D6 | cascade 子の TASK_UPDATED 送信 | 送らない | file watcher が task-state.json を監視。次回 scanTasks で TUI 反映される。即時性要求なし |
| D7 | ログキー `reason=` | `parent_aborted` に統一（delete 経路も同じ） | 仕様文の統一性。運用で区別したくなったら後で分ける |
| D8 | cascade の引数に parentTaskId 1 つだけを取る設計 | そのまま | 各経路の遷移は 1 親単位。まとめて複数 parent を cascade する経路は現状存在しない。YAGNI |

## 9. 完了条件（受け入れ条件の確認）

task.md の受け入れ条件:
- ✅ 親が abort/deleted になった瞬間に、ready 子が自動で draft に戻る → S3/S4 で 5 経路カバー
- ✅ 子の journal / task body から理由が追跡できる → `parent_aborted: <parentId>` 追記
- ✅ 既存の正常系（親 closed → 子 assigned）に回帰なし → D3（closed Set 不変更）+ S5 回帰テスト

## 10. 実装時の注意点（実装者向けメモ）

1. **saveTaskState は親遷移と cascade 結果をまとめて 1 回だけ呼ぶ**。親遷移で save → cascade → 再 save は race/冗長。
2. **ログ順序**: `task_aborted` → `child_reverted_to_draft`（子ごとに 1 行）。追跡時に親→子の順で読める。
3. **notifyStateChanged**: daemon 経路では revertedChildren.length > 0 のときだけ呼ぶ（チラつき防止）。CLI 経路は既存 TASK_UPDATED 送信でカバー。
4. **`conductor-task` テンプレートや Master プロンプトには変更不要**。cascade は state 層の挙動であり、Conductor が動き始めた後の話ではない。
5. **CLI のエラー文言**: cmdAbortTask / cmdDeleteTask の `console.log("OK aborted ...")` 出力に cascade の件数を加えるかは任意（D9 相当、実装者判断）。仕様書は「人間向け可視化」を要求していないので省略可。

---

以上で実装計画は完結。S1 → S2 → S3 → S4 → S5 → S6 → S7 の順に進めること。
