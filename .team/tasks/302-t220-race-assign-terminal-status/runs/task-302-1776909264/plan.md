# T302 実装計画: assign 完了書き込み時に terminal status を尊重する（暫定ガード）

## 1. 現状コード読解

### 対象箇所

task.md は `daemon.ts:2698-2709` を指しているが、現行の HEAD（`d6982ac`）での実コードは
`skills/cmux-team/manager/daemon.ts:2646-2658` に該当する（行番号差分は T300 以降のリファクタで前方に詰まったため）。

```ts
// daemon.ts:2635-2658（scanTasks 内、successful assignTask 後）
state.conductors.set(updated.surface, updated);                 // L2636
notifyStateChanged("daemon.ts:scanTasks:conductor-updated");
// T279 shadow: ASSIGN 成功 — idle → assigning。
try {
  const ev: FsmEvent = { type: "ASSIGN", ok: true };
  const cctx: ConductorCtx = { hasTaskRunId: updated.taskRunId != null, now: Date.now() };
  await shadowObserveConductor(updated.surface, shadowPrevAssign, ev, cctx, updated.status);
} catch (se: any) {
  await log("error", `shadow_observe_failed ASSIGN(ok) ${se?.message ?? se}`);
}
// task-state.json に assigned + assignedAt + resume 情報を記録
const ts = await loadTaskState(state.projectRoot);              // L2647 ← ここで race TOCTOU
ts[task.id] = {
  ...ts[task.id],                                               // 既存スプレッド
  status: 'assigned',                                           // ← 無条件に上書き
  assignedAt: new Date().toISOString(),
  worktreePath: updated.worktreePath,
  taskRunId: updated.taskRunId,
  conductorSlot: updated.surface,
  sessionId: updated.sessionId,
};
await saveTaskState(state.projectRoot, ts);                     // L2657
```

### 処理フローとタイミング

`scanTasks` 内 for ループで、1 タスクあたり以下が直列に走る:

| # | 処理 | 所要時間 | 副作用 |
|---|------|---------|-------|
| 1 | `filterExecutableTasks` で ready タスクを抽出 | 〜ms | — |
| 2 | `assignTask(conductor, taskId, ...)` 呼び出し | **数秒〜十数秒** | worktree add / npm install / cmux send /clear / プロンプト送信 |
| 3 | `state.conductors.set(updated.surface, updated)` | 即時 | in-memory |
| 4 | shadow observe (ASSIGN ok=true) | 〜ms | shadow DB |
| 5 | `loadTaskState` → spread → `saveTaskState` | 〜ms | **`task-state.json` 書き換え** |

race window はステップ 2 の全期間（数秒〜十数秒）。この間に `delete-task` CLI が走ると:

- `main.ts:3964` の delete 経路は「`status=assigned` なら拒否」ガードを持つが、**ステップ 2 の時点では `task-state.json` は `status=ready` のまま**（assigned は step 5 で初めて書かれる）→ ガード素通り → delete 成功して `status=deleted` が書かれる。
- その後ステップ 5 が走り、ステップ 5 の `loadTaskState` は `status=deleted` を読むが、直後のスプレッドで `status: 'assigned'` に上書きされて `saveTaskState` される → **`deleted` が `assigned` に巻き戻る**。
- 以降 Conductor が `judgment_pending` 等で `markTaskAborted` に到達すると `aborted` に遷移するが、`deletedAt` フィールドは残ったまま不整合状態（TUI の open/closed 分類がずれる）。

### worktree / /clear / プロンプトの前後関係

ステップ 2 の `assignTask`（conductor.ts:276-581）は既に以下を完了した状態で return する:

- `git worktree add` 成功（`conductor.worktreePath` / `conductor.taskRunId` が set 済み）
- `.claude/settings.local.json` コピー済み
- `npm install` 済み（package.json がある場合）
- プロンプトファイル生成済み（`.team/prompts/<taskRunId>-conductor-task-*.md`）
- `cmux.send(surface, "/clear")` + Return 送信済み
- `cmux.send(surface, "<promptFile> を読んで…")` + Return 送信済み
- trace DB に `event=assigned` 行挿入済み
- `conductor.status = "assigning"` / `conductor.taskId` / `conductor.taskTitle` / `conductor.outputDir` 等 set 済み

つまり**ガード発動時点では、Claude セッションには既に `/clear` + 新プロンプトが送られてしまっている**。この副作用は後述「5. リスクと副作用」で扱う。

## 2. isTerminalStatus の確認

`skills/cmux-team/manager/task.ts:738-747`:

```ts
/**
 * T300: 「terminal（これ以上状態が変化しない）」状態の判定。
 * closed / aborted / deleted を同一視したい 3 箇所（scanTasks の
 * closed Set / openTasksList フィルタ / createTaskProgrammatic の
 * run_after_all 競合チェック）で共有する。
 */
export function isTerminalStatus(status: string): boolean {
  return status === "closed" || status === "aborted" || status === "deleted";
}
```

- シグネチャ: `(status: string) => boolean`
- 対象: `"closed" | "aborted" | "deleted"` の 3 値
- 既に `daemon.ts:20` で import 済み（追加 import 不要）

task.md の「`task.ts` の `isTerminalStatus` がそのまま使える」と一致する。追加の判定関数は作らない。

## 3. 実装方針

**結論: `saveTaskState` の直前に 10〜12 行のインラインガードを追加する。**
ヘルパー関数抽出は「最小修正」方針と T303 で削除予定であることから見送り、単一箇所のインラインとする（テスト容易性は `scanTasks` 経由のブラックボックステストで担保する。後述「4. テスト方針」参照）。

### 3.1 追加コード（daemon.ts:2647 直前に挿入）

```ts
// task-state.json に assigned + assignedAt + resume 情報を記録
const ts = await loadTaskState(state.projectRoot);

// T302 暫定ガード: delete-task / abort-task が assignTask 進行中に割り込むと
// status が terminal(deleted/aborted/closed) に遷移している可能性がある。
// その状態で status:'assigned' を書くと終了状態が巻き戻るため、書き込みを skip し
// worktree/branch/Conductor state を cleanup して idle に戻す。
// TODO(T303): reducer 置換後に削除
const currentStatus = ts[task.id]?.status;
if (currentStatus && isTerminalStatus(currentStatus)) {
  await log(
    "assign_skipped_terminal",
    `${formatSurface(updated.surface, "C")} task_id=${task.id} current_status=${currentStatus} taskRunId=${updated.taskRunId ?? "-"}`
  );
  await resetConductor(updated, state.projectRoot, state.workspace ?? undefined);
  continue;
}

ts[task.id] = {
  ...ts[task.id],
  status: 'assigned',
  assignedAt: new Date().toISOString(),
  worktreePath: updated.worktreePath,
  taskRunId: updated.taskRunId,
  conductorSlot: updated.surface,
  sessionId: updated.sessionId,
};
await saveTaskState(state.projectRoot, ts);
```

### 3.2 各要素の根拠

| 要素 | 決定 | 根拠 |
|------|------|------|
| ガード条件 | `ts[task.id]?.status` が terminal | task-state.json の現行値のみで判定。タスクファイル side は見ない（`cmux-team delete-task` も `status` を書き換えるため一元化できる） |
| worktree cleanup | `resetConductor(updated, state.projectRoot, state.workspace ?? undefined)` | conductor.ts:598-714 の既存関数を再利用。`git worktree remove --force` + `git branch -d <taskRunId>/task` を冪等に実行し、失敗時は `cleanup_failed` ログで継続する（手書きコピペ禁止）。daemon.ts の他 3 箇所（L1355 / L2226 / L3008 / L3163）と同じ呼び出し形式 |
| Conductor idle リセット | 同じく `resetConductor`（targetStatus 省略 → `"idle"`） | status, taskId, taskRunId, worktreePath, outputDir, agents, clearSentAt, promptSentAt, disconnectedAt を全てクリアし、`conductor_reset` ログを集約発行する（daemon.ts 側で個別に書き換えない） |
| state.conductors への反映 | `resetConductor` は引数 `conductor` を**直接ミュート**する参照渡しなので、`state.conductors.get(updated.surface)` は reset 後の値を返す。`state.conductors.set(...)` の再呼び出しは不要 | L2636 で既に set 済み。resetConductor 内の `notifyStateChanged` が TUI 更新をトリガーする |
| ASSIGN 成功 shadow emit の扱い | **修正しない**。T279 shadow に `ASSIGN ok=true` → その後の `"idle"` 復帰は emit しない | T303 の reducer 化で unified FSM に載せる前提。T302 はあくまで暫定ガード。差分の逆伝播を shadow に出すと T303 での破棄コストが増える |
| continue の位置 | `if` ブロック末尾 | 次タスクの処理に進む。この Conductor は idle に戻っているので、次イテレーションで `idleConductor` として再検出される可能性があるが、同一 tick 内では `assignedIds` に `task.id` が既に add されているため再 assign はない |
| ログ format | `assign_skipped_terminal <C[surface]> task_id=<id> current_status=<s> taskRunId=<id>` | CLAUDE.md「ログフォーマット」節に準拠。`formatSurface(updated.surface, "C")` を使い、`conductor_reset` との相関追跡を可能にする |

### 3.3 変更量

- 追加: 約 13 行（ガード本体）+ 6 行のコメント = 19 行
- 既存コードの変更: なし（挿入のみ）
- import 追加: なし（`isTerminalStatus` / `resetConductor` / `formatSurface` は既に import 済み）

## 4. テスト方針

### 4.1 テストファイル

`skills/cmux-team/manager/daemon.test.ts` の末尾（既存 `describe("T250 broken status", …)` と
`describe("crashed → disconnected 遷移 (T121/T195)", …)` の並びに沿う位置）に新規
`describe("T302 assign_skipped_terminal guard", …)` を追加する。

### 4.2 テスト setup 戦略

`assignTask` はテスト環境で成功させるのが困難（cmux / worktree の外部依存）。
代わりに **assignTask の返り値相当の `ConductorState` を fake し、ガード直前の状態を
手動で構築して `scanTasks` を呼ばない経路**を取る。具体的には:

- **方針 A（採用）**: `scanTasks` を呼ばず、ガードロジックをインライン化したままテストする。`scanTasks` 経由ではなく、**task-state.json の状態とガードの`if` 判定・副作用を個別に検証するテスト**で十分カバーする:
  - (a) `isTerminalStatus` の分岐カバレッジは `task.test.ts` で既存 (T300 追加済み) → 追加不要
  - (b) `resetConductor` の冪等性は `conductor.test.ts` に既存
  - (c) **残る責務**: 「loadTaskState が terminal を返したら saveTaskState を skip する」という条件分岐の回帰テスト → これだけは `scanTasks` を動かさず、ガードの判定に相当する小さなヘルパーを `daemon.ts` から export して単体テストするか、`scanTasks` を git 初期化済み repo で動かしてカバーする

- **方針 B（推奨）**: 方針 A で (c) を担保するために **test 用にガードロジックを export helper として括り出す**。最小形で:
  ```ts
  // daemon.ts（既存の assign 完了書き込み直前を helper 化）
  export async function __testApplyAssignCommit(
    state: DaemonState,
    taskId: string,
    updated: ConductorState,
  ): Promise<{ committed: boolean; reason?: "terminal"; currentStatus?: string }> {
    const ts = await loadTaskState(state.projectRoot);
    const currentStatus = ts[taskId]?.status;
    if (currentStatus && isTerminalStatus(currentStatus)) {
      await log(
        "assign_skipped_terminal",
        `${formatSurface(updated.surface, "C")} task_id=${taskId} current_status=${currentStatus} taskRunId=${updated.taskRunId ?? "-"}`
      );
      await resetConductor(updated, state.projectRoot, state.workspace ?? undefined);
      return { committed: false, reason: "terminal", currentStatus };
    }
    ts[taskId] = {
      ...ts[taskId],
      status: 'assigned',
      assignedAt: new Date().toISOString(),
      worktreePath: updated.worktreePath,
      taskRunId: updated.taskRunId,
      conductorSlot: updated.surface,
      sessionId: updated.sessionId,
    };
    await saveTaskState(state.projectRoot, ts);
    return { committed: true };
  }
  ```
  `scanTasks` 側は `const r = await __testApplyAssignCommit(state, task.id, updated); if (!r.committed) continue;` に置換。`__test` prefix は既存 `__testSpawnPidWatcherTick` と同じ testability 用 export 慣習。

- **採否**: **方針 B を採用**。task.md は「最小修正」を要求するが、インラインのままだと assignTask を走らせずにテストする手段が `scanTasks` 全体のモック化しかなく、逆に実装よりもテストが複雑になる。`__testApplyAssignCommit` はインラインの 13 行をそのまま関数に移すだけで実質的な抽象化は増やしていない（呼び出し側も 2 行減るだけ）。T303 reducer 置換時にこの helper ごと削除される点でも負債は最小化される。

### 4.3 追加テストケース（daemon.test.ts 末尾）

```ts
describe("T302 assign_skipped_terminal guard", () => {
  test("task-state が deleted なら saveTaskState skip + worktree cleanup", async () => {
    // 1. task 作成（status=ready で frontmatter 準備のみ）
    await createTask("302", "deleted-race", { status: "ready" });

    // 2. assignTask が完了した直後の状態を再現:
    //    - worktree 用ダミーディレクトリ作成（resetConductor の existsSync ガードを通す）
    //    - Conductor を status=assigning にして state.conductors に登録
    //    - ready → deleted に書き換え（delete-task が race で割り込んだ状態）
    const taskRunId = "task-302-1700000000";
    const worktreePath = join(testDir, ".worktrees", taskRunId);
    await mkdir(worktreePath, { recursive: true });

    const state = await createDaemon(testDir);
    state.mainBranch = "main";
    const conductor: ConductorState = {
      surface: "surface:fake-c302",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "assigning",
      taskId: "302",
      taskRunId,
      worktreePath,
      outputDir: `.team/tasks/000-deleted-race/runs/${taskRunId}`,
    };
    state.conductors.set(conductor.surface, conductor);

    // race 再現: task-state を deleted に書き換え
    const { saveTaskState, loadTaskState } = await import("./task");
    const ts0 = await loadTaskState(testDir);
    ts0["302"] = { status: "deleted", deletedAt: new Date().toISOString() };
    await saveTaskState(testDir, ts0);

    // 3. ガード発動
    const { __testApplyAssignCommit } = await import("./daemon");
    const result = await __testApplyAssignCommit(state, "302", conductor);

    // 4. 検証
    expect(result.committed).toBe(false);
    expect(result.reason).toBe("terminal");
    expect(result.currentStatus).toBe("deleted");

    // task-state は deleted のまま（巻き戻らない）
    const tsAfter = await loadTaskState(testDir);
    expect(tsAfter["302"]?.status).toBe("deleted");
    expect(tsAfter["302"]?.deletedAt).toBeDefined();
    expect(tsAfter["302"]?.assignedAt).toBeUndefined();

    // Conductor が idle にリセット
    expect(conductor.status).toBe("idle");
    expect(conductor.taskId).toBeUndefined();
    expect(conductor.taskRunId).toBeUndefined();
    expect(conductor.worktreePath).toBeUndefined();

    // worktree ダミーディレクトリは cleanup 試行済み
    //   testDir は git init していないので `git worktree remove` は失敗するが、
    //   resetConductor が cleanup_failed ログ経路で握りつぶすため後続に影響しない。
    //   ディレクトリの現物が残っているかは git 失敗経路の都合で不定なので assert しない。
    //   （manager.log を grep して `cleanup_failed` or `conductor_reset` の存在で検証する）
    const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(log).toContain("assign_skipped_terminal");
    expect(log).toContain("current_status=deleted");
    expect(log).toContain("conductor_reset");
  });

  test("task-state が aborted なら同じく skip", async () => {
    await createTask("303", "aborted-race", { status: "ready" });
    const state = await createDaemon(testDir);
    state.mainBranch = "main";
    const conductor: ConductorState = {
      surface: "surface:fake-c303",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "assigning",
      taskId: "303",
      taskRunId: "task-303-1700000001",
      worktreePath: undefined, // worktree cleanup はスキップ経路（existsSync ガードで)
    };
    state.conductors.set(conductor.surface, conductor);

    const { saveTaskState, loadTaskState } = await import("./task");
    const ts0 = await loadTaskState(testDir);
    ts0["303"] = { status: "aborted", abortedAt: new Date().toISOString(), journal: "reason=abort_task;" };
    await saveTaskState(testDir, ts0);

    const { __testApplyAssignCommit } = await import("./daemon");
    const result = await __testApplyAssignCommit(state, "303", conductor);

    expect(result.committed).toBe(false);
    expect(result.reason).toBe("terminal");
    expect(result.currentStatus).toBe("aborted");

    const tsAfter = await loadTaskState(testDir);
    expect(tsAfter["303"]?.status).toBe("aborted");
    expect(tsAfter["303"]?.assignedAt).toBeUndefined();
    expect(conductor.status).toBe("idle");
  });

  test("task-state が ready（通常ケース）なら assigned に更新される", async () => {
    await createTask("304", "normal", { status: "ready" });
    const state = await createDaemon(testDir);
    state.mainBranch = "main";
    const conductor: ConductorState = {
      surface: "surface:fake-c304",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "assigning",
      taskId: "304",
      taskRunId: "task-304-1700000002",
      worktreePath: join(testDir, ".worktrees", "task-304-1700000002"),
      sessionId: "sess-304",
    };
    state.conductors.set(conductor.surface, conductor);

    const { __testApplyAssignCommit } = await import("./daemon");
    const result = await __testApplyAssignCommit(state, "304", conductor);

    expect(result.committed).toBe(true);
    const { loadTaskState } = await import("./task");
    const tsAfter = await loadTaskState(testDir);
    expect(tsAfter["304"]?.status).toBe("assigned");
    expect(tsAfter["304"]?.assignedAt).toBeDefined();
    expect(tsAfter["304"]?.conductorSlot).toBe("surface:fake-c304");
    expect(tsAfter["304"]?.taskRunId).toBe("task-304-1700000002");
    expect(tsAfter["304"]?.sessionId).toBe("sess-304");
  });

  test("task-state 未作成エントリ（undefined status）は通常ケースとして assigned 書き込み", async () => {
    // race の極端ケース: delete-task 側が task-state entry ごと消した場合
    // （現状 delete-task は status=deleted を残すので実環境では発生しないが、
    //  ガードの defensive 挙動としてカバーする）
    const state = await createDaemon(testDir);
    state.mainBranch = "main";
    const conductor: ConductorState = {
      surface: "surface:fake-c305",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "assigning",
      taskId: "305",
      taskRunId: "task-305-1700000003",
      worktreePath: join(testDir, ".worktrees", "task-305-1700000003"),
    };
    state.conductors.set(conductor.surface, conductor);

    const { __testApplyAssignCommit } = await import("./daemon");
    const result = await __testApplyAssignCommit(state, "305", conductor);

    // currentStatus=undefined → ガードは発動せず assigned 書き込み
    expect(result.committed).toBe(true);
    const { loadTaskState } = await import("./task");
    const tsAfter = await loadTaskState(testDir);
    expect(tsAfter["305"]?.status).toBe("assigned");
  });
});
```

### 4.4 既存テストへの影響

- `describe("scanTasks: assignTask エラー分離", …)` の 2 ケース（L357-399）: assignTask 失敗経路なのでガードに到達しない → 影響なし
- `describe("T250 broken status", …)`: Conductor status=broken でスキップされるため scanTasks の assign ループに入らない → 影響なし
- `describe("T220 cascade", …)`（L2700 付近）: assign_failed → aborted → cascade 経路なのでガード通過前に throw される → 影響なし
- 既存 `bun test` 全ケースで passing を確認する（CI 相当のフルラン）

## 5. リスクと副作用

### 5.1 既に送信済みの /clear + プロンプトが Claude セッションで空実行される

ガード発動時点では `assignTask` が既に:
- `cmux.send(surface, "/clear")` 送信済み → Conductor セッションの文脈がクリア済み
- `cmux.send(surface, "<promptFile> を読んで…")` 送信済み → Conductor が新プロンプトの処理に着手している可能性

その後 `resetConductor` が呼ばれて `conductor.status = "idle"` に戻るが、**cmux セッション自体への cancel/割り込みは送らない**（resetConductor は siblings close + worktree remove + state リセットのみ）。

**想定される副作用**:
- Conductor が「存在しない worktree に cd して作業しようとする」→ `cd: no such file or directory` で早期 idle 化
- プロンプトで指示された `plan.md / task.md` パスは既に削除済み（deleted タスクの場合）→ Read で `file not found` → Conductor が異常終了 or `CONDUCTOR_DONE --success=false` を emit
- 結果として hook 経由で SESSION_IDLE / SESSION_ENDED が到達し、既に idle に戻っている Conductor に対する no-op として処理される（handleMessage の idle ガード経路）

**リスク評価**: **受容可**。理由:
1. delete された task の仕事を Conductor が続ける方が有害（作業成果が orphan branch に commit される / tests を走らせて CI 負荷が発生する等）
2. Conductor は自律再起動可能な設計（SESSION_ENDED → scanTasks → 新タスク assign）
3. T303 reducer 置換で構造的解決（assigning 状態を transaction 化して delete-task と mutually exclusive にする）が予定されている

**補強案（採用せず）**: ガード発動時に `cmux.sendKey(surface, "C-c")` 相当の割り込みを送ることも考えたが、
- `cmux.sendKey` の signal 送信セマンティクスは確定的でない（実装確認が必要）
- Claude セッション側で中断後の再 idle 化が保証されない（race が再発する可能性）
- T303 で廃止予定の経路なので投資対効果が低い

### 5.2 race タイミングの網羅性

ガードは `loadTaskState → 判定 → saveTaskState` の間の非同期割り込みを防げない:

```
daemon:  loadTaskState() → status=ready を読む
delete:                                 → saveTaskState(status=deleted)
daemon:  → saveTaskState(status=assigned) ← deleted を上書きする race が再発
```

**評価**: このサブ race の発生確率は本題 race の 10^-3 以下:
- 本題 race: assignTask が数秒〜十数秒かかる → delete-task の割り込み窓が広い
- サブ race: loadTaskState → saveTaskState は同一 tick 内で〜数 ms → 割り込み窓が極狭

**受容する**。T303 reducer 置換で「assigning → assigned 遷移を delete-task との相互排他 transition」として表現することで構造的に解消する（pure reducer はこのクラスの TOCTOU を排除する）。

### 5.3 他テストへの影響

- `markTaskAborted` の冪等 skip（task.ts:585-596）は terminal status に対して no-op を返す。この経路とガードは独立。
- `detectStartupUniqueViolations`（task.ts:104-149）は team.json × task-state の cross-check。ガード発動で task-state が `deleted` のまま維持されれば、team.json 側に残っていた assigned 情報との不整合は `resume_marked_aborted` 経路（daemon.ts の applyResumeTransitions）で拾われる。
- shadow observer（state-machine/shadow）: ASSIGN ok=true の後に reset 相当の event を emit しない選択（3.2 参照）のため、T303 reducer 化までは shadow DB の ASSIGN 行だけが記録される非対称状態が残る。これは「暫定ガード」の既知の不整合として受容。

### 5.4 Conductor 再投入の正常性

ガード発動後、次 tick 以降:
- `state.conductors` の該当 entry は `status=idle`（resetConductor が設定）
- 同 Conductor は次の ready タスクの割当候補として再利用可能
- もし新規タスクが無ければ idle のまま待機

`conductor_reset` ログは既存 TUI dashboard でも表示されるため、オペレータが事象を後追い可能。

## 6. 削除時期

**T303（reducer 置換）完了時にガードと `__testApplyAssignCommit` helper を削除する。**

- コード側マーカー: ガード冒頭のコメントに `// TODO(T303): remove after reducer migration` を付与
- 削除対象:
  - `daemon.ts:2647` 周辺の T302 ガード本体（方針 B で helper 化する場合は `__testApplyAssignCommit` 関数ごと削除し、`scanTasks` にインライン化した reducer dispatch に置き換える）
  - `daemon.test.ts` 末尾の `describe("T302 assign_skipped_terminal guard", …)` 4 ケース
- 削除時の整合性検査:
  - T303 の reducer が terminal status に対する ASSIGN action を reject することを unit test で担保
  - delete-task × assignTask race を再現する integration test（現状未整備）を T303 で追加
- 削除タイミングの判断条件:
  - T303 の reducer が `task-state.json` のすべての status 遷移経路（draft / ready / assigned / closed / aborted / deleted）を覆っている
  - daemon.ts 内の直接 `saveTaskState` 呼び出しが全て reducer dispatch に集約済み
  - CLAUDE.md「タスク属性」節と `docs/spec/07-state-machine.md` が T303 実装と同期済み

---

## 付録: 変更ファイル一覧

| ファイル | 変更量 | 内容 |
|---------|--------|------|
| `skills/cmux-team/manager/daemon.ts` | +約 30 行 / -約 10 行 | `__testApplyAssignCommit` 関数追加、scanTasks 側から元の書き込みブロックを helper 呼び出しに置換、`TODO(T303)` コメント追加 |
| `skills/cmux-team/manager/daemon.test.ts` | +約 150 行 | `describe("T302 assign_skipped_terminal guard", …)` 4 ケース追加 |

import 追加はなし（`isTerminalStatus` / `resetConductor` / `formatSurface` / `log` は全て import 済み）。
