# T290 Plan — Aborted 経路の journal/reason 表現統一（markTaskAborted 集約）

**Planner:** planner-1 (task-290-1776804386)
**Date:** 2026-04-22

---

## 1. 現状整理

### 1.1 6 経路の現在コード（grep で確認済みの実行番号）

| # | 経路 | 場所 | 現 journal（on-disk） | 現 log reason | 備考 |
|---|---|---|---|---|---|
| 1 | user_clear | `daemon.ts:2259` | `user_clear: C[XXX] taskRunId=...` | `user_clear` | `handleMessage(SESSION_CLEAR)` の running 分岐 |
| 2 | assign_failed | `daemon.ts:2626` | `assign_failed: ${e.reason}` | `assign_failed` | `scanTasks` の `AssignTaskError(kind="task")` |
| 3 | disconnect_timeout | `daemon.ts:3054` | `disconnect_timeout: C[XXX] taskRunId=... disconnectedAt=...` | `disconnect_timeout` | `forceCloseDisconnectedConductor` |
| 4 | judgment_pending | `daemon.ts:3164` | `conductor_done_unresolved: <reason> (worktree=...) taskRunId=...` | `judgment_pending` ← **journal と不一致** | `handleConductorDone` unresolved 分岐 |
| 5 | abort_task (CLI) | `main.ts:3479, 3519` | i18n 文字列 `中断: TNNN <title>`（ユーザー上書き可） | `abort_task` | `cmdAbortTask` の 2 branches（conductor 不在 / 在りクリーンアップ後） |
| 6 | resume_marked_aborted | `main.ts:840`（経由 `applyResumeTransitions` at `main.ts:341`, `task.ts:buildResumeAbortJournal`） | `[resume] <summary> (taskRunId=X). artifacts preserved at <path>` | `resume_no_session_id` / `resume_no_task_run_id` / `resume_no_worktree` | `cmdStart` 起動時 resume 判定（T264） |

### 1.2 周辺の既存構造

- **TaskState 型**（`task.ts:32-46`）: `journal?: string` — 単純な string。構造化は on-disk 変更を伴う
- **書き込みヘルパー**: `saveTaskState(projectRoot, map)` — JSON 全体書き換え（atomic rename）
- **cascade**: `cascadeAbortToChildren(state, tasks, parentTaskId)` — ready 子を draft に戻し、`journal` に `parent_aborted: <id>` を追記。**state はミュータブル更新**・log と saveTaskState は呼び出し側責務
- **cascadeAbortToChildren の現在の呼び出し箇所**（集約対象）:
  - `daemon.ts:2263` (user_clear) / `2630` (assign_failed) / `3063` (disconnect_timeout) / `3167` (judgment_pending)
  - `main.ts:353` (applyResumeTransitions) / `3482` (abort-task no-conductor) / `3522` (abort-task with-conductor)
  - `main.ts:3778` (**delete-task** — 本タスク対象外、task_deleted のまま)
  - `task.test.ts` / `daemon.test.ts`（テストで直接呼び出し）
- **await-task 表示**（`main.ts:3067, 3101`）: `console.error(\`Task ${id} was aborted: ${st.journal ?? "(no reason)"}\`)` の 2 箇所（初期状態確認 / fs.watch 監視中）
- **printSummaries**（`main.ts:3311-3316`）: `summary.md` が無い場合 `journal` をそのまま stdout に出力
- **show-task CLI**: `manager/main.ts` には **存在しない**。templates / CLAUDE.md が言及しているが未実装 → 本タスクでは新設せず、**await-task の出力改善のみで task.md の「reason が先頭」要件を満たす**
- **TUI dashboard**（`dashboard.tsx:287-292`）: `task_aborted` ログ行から `journal_summary=` を正規表現抽出 → メッセージ表示
- **FSM shadow**（`state-machine/task-fsm.ts:73, 95`）: `task_aborted` 予約 event だが現状 emit されず。detail は既に `reason=${...}` 形式
- **既存テスト**:
  - `daemon.test.ts:821` `journal.toContain("disconnect_timeout")`
  - `daemon.test.ts:2301` `journal.toContain("user_clear")`
  - `daemon.test.ts:4466-4468` `journal.toContain("conductor_done_unresolved" / "rebase_conflict" / "worktree=...")`
  - `main.test.ts:1432` `journals["1"].toContain(".team/tasks/1-foo/runs/task-1-123/")`
  - `toMatch(/task_aborted.*reason=user_clear/)` 等、**log 行の reason= 抽出は既に各経路で一致済み**

### 1.3 問題の構造的要因

- 6 経路で同じ 7 ステップ（load → 冪等ガード → journal 組立 → status=aborted 代入 → cascade → save → task_aborted emit → child_reverted emit）が**手書き複製**されている → 一貫性がグロッシュ検査以外で担保できない
- log の `reason=` と journal 本文の prefix が独立に書かれている → T269 で reason=judgment_pending と journal `conductor_done_unresolved:` が乖離した**同種事故が再発し得る構造**

---

## 2. 設計判断

### D1: journal の on-disk シリアライズ形式 = **案 A（prefix string: `reason=<reason>; <detail>`）**

**選択理由:**
- TaskState.journal は既存 `string | undefined` のまま → **migration 不要**
- `grep "reason=judgment_pending"` で経路別に機械的フィルタ可能（CLAUDE.md §ログポリシー「grep 可能」方針と整合）
- detail 部は既存の人間可読 string（surface / taskRunId / worktreePath）をそのまま保持 → 情報ロスなし
- 案 B（JSON）: `journal` 列の grep 劣化、manager.log の「1 行 1 イベント・空白区切り key=value」ポリシーと矛盾
- 案 C（union 型）: 型安全だが consumer（dashboard / i18n / test 群）にディスパッチ分岐を追加する必要があり、シリアライズ表現は結局 string 1 本の方が薄い

**構造化したい consumer**（await-task / show-task / TUI）には `parseAbortJournal(s)` ヘルパーを提供し、paser で reason / detail を取り出す（下記 D3）。

### D2: markTaskAborted のシグネチャ

```ts
// task.ts
export type AbortReason =
  | "user_clear"
  | "judgment_pending"
  | "assign_failed"
  | "disconnect_timeout"
  | "abort_task"
  | "resume_no_session_id"
  | "resume_no_task_run_id"
  | "resume_no_worktree";

export interface MarkTaskAbortedOptions {
  /** log detail `title=` 用。未指定なら出さない */
  taskTitle?: string;
  /** log detail に付加する追加 key=value（例: `kind=task` / `source=agent`）。空白・`=` を含む value は呼び出し側で正規化済みである前提 */
  extraLogFields?: Record<string, string>;
  /** テスト注入用。デフォルト `() => new Date().toISOString()` */
  now?: () => string;
}

export interface MarkTaskAbortedResult {
  /** ready → draft に戻った子 ID（`child_reverted_to_draft` は内部 emit 済み） */
  revertedChildren: string[];
  /** 実際に書き込んだ journal（呼び出し側の TUI reflection 等用） */
  journal: string;
  /** 既に closed/aborted/deleted で no-op だった場合 true。saveTaskState は呼ばれない */
  idempotentSkip?: true;
  /** 冪等 skip の理由（既存 status）。skip 時のみ埋まる */
  existingStatus?: string;
}

export async function markTaskAborted(
  projectRoot: string,
  taskId: string,
  reason: AbortReason,
  detail: string,
  opts?: MarkTaskAbortedOptions,
): Promise<MarkTaskAbortedResult>;
```

**内部責務（呼び出し順）:**

1. `loadTaskState(projectRoot)` → current 取得
2. **冪等ガード**: `current?.status in {closed, aborted, deleted}` なら `log("task_abort_skipped", ...)` + 早期 return（idempotentSkip=true、saveTaskState なし）
3. journal 組立 = `` `reason=${reason}; ${detail}` ``（detail が空なら `` `reason=${reason}` ``）
4. `taskState[taskId] = { ...current, status: "aborted", abortedAt: now(), journal }`
5. `loadTasks(projectRoot)` + `cascadeAbortToChildren(taskState, tasks, taskId)` で revertedChildren を得る
6. `saveTaskState(projectRoot, taskState)`
7. `log("task_aborted", detail文字列)` emit — **detail は従来互換の `task_id=<id> reason=<reason> [title=<t>] journal_summary=<journal> [extraFields]`**
8. revertedChildren ごとに `log("child_reverted_to_draft", \`parent=${taskId} child=${childId} reason=parent_aborted\`)` emit
9. 結果を return

**責務分離（呼び出し側に残すもの）:**

- `notifyStateChanged(source)` の発火 — EventBus ポリシー「emit = mutation 元の呼び出し位置」を守るため。markTaskAborted 内で emit すると source がヘルパー側になり追跡不能になる
- `TASK_UPDATED` の postMessage（abort-task CLI で必要） — 通信プロトコル責務は CLI 側に残す
- worktree 削除 / pidWatcher 停止 / resetConductor — 副作用スコープ外

**なぜ `task_aborted` と `child_reverted_to_draft` を内部に吸収するか:**

- 現状 6 経路の log emit が「reason 値のラベルの違い」以外ほぼ同一文字列テンプレ → 不一致は歴史的事故（T269）と同根で、構造的に一本化すれば再発しない
- `journal_summary=` を TUI dashboard が正規表現抽出しているため、markTaskAborted 内で必ず同じキーで出すことで TUI 表示の一貫性が担保される

### D3: 後方互換（旧 format journal の読み取り）= `parseAbortJournal` ヘルパーで best-effort 推定

```ts
// task.ts
export interface ParsedAbortJournal {
  /** 新 format から抽出された reason、または旧 format から推定された reason。不明時 undefined */
  reason?: AbortReason | string;
  /** reason prefix を除いた人間可読部分。新/旧問わず「何が起きたか」を記述した string */
  detail?: string;
  /** 元 journal（そのまま） */
  raw: string;
}

export function parseAbortJournal(journal: string | undefined): ParsedAbortJournal;
```

**パース順序:**

1. `journal` が undefined / 空 → `{ raw: "" }`
2. **新 format**: `/^reason=([a-z_]+);\s?(.*)$/s` にマッチ → `{ reason, detail, raw }`
3. **旧 format prefix 推定**（order matters — 先勝ち）:
   | 旧 prefix 正規表現 | 推定 reason |
   |---|---|
   | `/^user_clear: /` | `user_clear` |
   | `/^assign_failed: /` | `assign_failed` |
   | `/^disconnect_timeout: /` | `disconnect_timeout` |
   | `/^conductor_done_unresolved: /` | `judgment_pending` |
   | `/^\[resume\] lost worktree/` | `resume_no_worktree` |
   | `/^\[resume\] missing session id/` | `resume_no_session_id` |
   | `/^\[resume\] missing task run id/` | `resume_no_task_run_id` |
4. どれにもマッチしない（= abort-task CLI の i18n `中断: ...` 文字列や、`[restart] ...` 等） → `{ reason: undefined, detail: journal, raw: journal }`（**reason=unknown にせず undefined** のまま残す）
   - 理由: abort-task のユーザー入力を人工的に `reason=abort_task` と断言すると誤誘導の可能性。await-task 表示側で「reason 不明時は `[abort_task?]` フォールバック」を明示する

### D4: 表示側 API

**`await-task`（`main.ts:3067, 3101`）:**

```ts
// 新ヘルパーを main.ts 内に配置（task.ts は core にとどめる）
function formatAbortedTaskLine(id: string, journal: string | undefined): string {
  const parsed = parseAbortJournal(journal);
  const reason = parsed.reason ?? "unknown";
  const detail = parsed.detail ?? "(no reason)";
  return `Task ${id} was aborted: [${reason}] ${detail}`;
}

// 呼び出し側
console.error(formatAbortedTaskLine(id, st.journal));
```

**`printSummaries`（`main.ts:3311-3316`）:**

同じ `formatAbortedTaskLine` を使い、**aborted status のみ** `[<reason>] <detail>` 形式で出力。closed/deleted は現状通り `console.log(journal)`（status に応じ分岐）。

**TUI 色分け:** 今回対象外（task.md 「nice-to-have」）。dashboard.tsx は `journal_summary=` をそのまま表示するだけ。新 format の `journal_summary=reason=user_clear; C[XXX] ...` でも読める（むしろ `reason=` キーが先頭に出るので視認性向上）。

**`show-task` CLI 新設:** **本タスクでは行わない**（task.md inspection 項目に明示なし・既存 CLI に無い・scope 拡大のリスク）。将来タスクで追加するなら `formatAbortedTaskLine` を再利用できる。

### D5: buildResumeAbortJournal との関係

既存 `buildResumeAbortJournal(taskFile, ts, reason)` は resume 経路で `[resume] <summary> ...` 文字列を返す。markTaskAborted 導入後の動線:

1. `applyResumeTransitions` は従来通り `buildResumeAbortJournal` で **detail 文字列**を生成
2. ただし taskState の書き換えと log emit は markTaskAborted に委譲（applyResumeTransitions の責務から削除）
3. 結果 journal = `reason=resume_no_worktree; [resume] lost worktree (taskRunId=...). artifacts preserved at ...`
4. `resume_marked_aborted` ログは `applyResumeTransitions` の呼び出し側（`cmdStart`）で従来通り emit（reason の source 情報として残す）

これで既存 main.test.ts の `journals["1"].toContain(".team/tasks/1-foo/runs/task-1-123/")` は PASS を維持（detail 内に含まれる）。

---

## 3. 実装ステップ（TDD Red/Green/Refactor）

### Phase 1 — task.ts にヘルパー追加（既存挙動は変えない）

**Step 1.1** `AbortReason` type / `markTaskAborted` / `parseAbortJournal` / `MarkTaskAbortedResult` を `task.ts` に追加

**Step 1.2** `task.test.ts` に新規 describe block を追加:

- `markTaskAborted` 正常系 1: new format `reason=user_clear; C[5] taskRunId=task-1-123`
- `markTaskAborted` 正常系 2: detail 空 → `reason=abort_task`
- `markTaskAborted` 冪等: 既に aborted → `idempotentSkip=true`、abortedAt 不変
- `markTaskAborted` 冪等: closed/deleted でも同様
- `markTaskAborted` cascade: ready 子 → draft（revertedChildren 返却 + child_reverted_to_draft log emit）
- `markTaskAborted` cascade 無し: depends_on 無しタスクは revertedChildren=[]
- `markTaskAborted` log 形式: `task_aborted task_id=1 reason=user_clear title=Foo journal_summary=reason=user_clear; C[5] taskRunId=task-1-123` に全キーを含む
- `parseAbortJournal` new format 4 ケース（reason のみ / reason + detail / detail 空白あり / multi-line detail）
- `parseAbortJournal` 旧 format 推定 6 ケース（各 prefix 1 ケース）
- `parseAbortJournal` 完全未知: `{ reason: undefined, detail: raw, raw }`
- `parseAbortJournal` undefined / 空: `{ raw: "" }`

**Step 1.3** `bun test task.test.ts` で Green を確認。既存経路は未変更のため回帰なし。

### Phase 2 — 6 経路を markTaskAborted に置換（低リスク → 高リスク順）

各ステップで:
1. **Red**: 既存 test の journal 形式 assertion を新 format に追加 `toContain("reason=<X>;")`（古い assertion は detail 部に残るため不変でも OK、ただし新 prefix を追加 assert）
2. **Green**: 該当経路を markTaskAborted 呼び出しに置換
3. **Refactor**: 重複コード（try/catch の ts[id]=... / cascade / saveTaskState / 2 log emit）削除。`notifyStateChanged(source)` と必要な副作用だけ残す

**Step 2.1 — assign_failed（`daemon.ts:2620-2644`）**

```ts
// Before: 約 20 行（手書き）
// After:
try {
  const { revertedChildren } = await markTaskAborted(
    state.projectRoot, task.id, "assign_failed", e.reason,
    { taskTitle: task.title, extraLogFields: { kind: "task" } },
  );
  if (revertedChildren.length > 0) {
    notifyStateChanged("daemon.ts:scanTasks:assign-failed-cascade");
  }
} catch (err: any) {
  await log("error", `markTaskAborted(assign_failed) failed: task_id=${task.id} ${err.message}`);
}
```

Test 影響: 既存 `task_aborted.*reason=assign_failed` log assertion は維持（markTaskAborted が同じ detail テンプレを emit）。

**Step 2.2 — disconnect_timeout（`daemon.ts:3040-3085`）**

detail 文字列の組み立てのみ残し、try/catch 内を markTaskAborted 1 呼び出しに置換:

```ts
const detail = `${formatSurface(conductor.surface, "C")} taskRunId=${taskRunId ?? "-"} disconnectedAt=${conductor.disconnectedAt}`;
const { revertedChildren } = await markTaskAborted(
  state.projectRoot, taskId, "disconnect_timeout", detail,
);
if (revertedChildren.length > 0) {
  notifyStateChanged("daemon.ts:forceCloseDisconnectedConductor:cascade");
}
```

Test 影響: `daemon.test.ts:821` `journal.toContain("disconnect_timeout")` → 新 format でも `reason=disconnect_timeout; ...` に含まれるため PASS。追加で `toMatch(/^reason=disconnect_timeout;/)` を assert。

**Step 2.3 — user_clear（`daemon.ts:2253-2287`）**

detail = `` `${formatSurface(conductor.surface, "C")} taskRunId=${conductor.taskRunId ?? "-"}` ``
reason = "user_clear"

注意: 周辺の `conductor.pid = undefined` / `resetConductor(...)` / `pidWatcherInterval` クリアは **呼び出し側に残す**（markTaskAborted のスコープ外）。

Test 影響: `daemon.test.ts:2301` `journal.toContain("user_clear")` は `reason=user_clear; ...` でも PASS。追加 `toContain("reason=user_clear;")` を assert。

**Step 2.4 — judgment_pending（`daemon.ts:3158-3187`）— T269 の reason/journal 乖離を解消**

従来の journal `conductor_done_unresolved: <reason> (worktree=...) taskRunId=...` は「detail 部」に移動:

```ts
const detail = `conductor_done_unresolved: ${opts?.reason ?? "-"} (worktree=${conductor.worktreePath ?? "-"}) taskRunId=${conductor.taskRunId ?? "-"}`;
const { revertedChildren, idempotentSkip } = await markTaskAborted(
  state.projectRoot, taskId, "judgment_pending", detail,
  { taskTitle: conductor.taskTitle },
);
if (idempotentSkip) {
  await log("conductor_done_unresolved_skip", `task_id=${taskId} reason=already_closed_or_aborted`);
} else if (revertedChildren.length > 0) {
  notifyStateChanged("daemon.ts:handleConductorDone:unresolved-cascade");
}
```

結果 journal = `reason=judgment_pending; conductor_done_unresolved: rebase_conflict (worktree=...) taskRunId=...`

Test 影響: `daemon.test.ts:4466-4468`:
- `expect(journal).toContain("conductor_done_unresolved")` → PASS（detail 部に残る）
- `expect(journal).toContain("rebase_conflict")` → PASS
- `expect(journal).toContain("worktree=...")` → PASS
- 追加: `expect(journal).toMatch(/^reason=judgment_pending;/)` — **これで task.md §問題 1「journal prefix と log reason の乖離」が構造的に解消したことを担保**

**Step 2.5 — abort-task CLI（`main.ts:3472-3500` と `3514-3531` の 2 branches）**

両 branches で重複している「taskState 書き換え + cascade + saveTaskState + task_aborted log + child_reverted log」を markTaskAborted 呼び出しに置換:

```ts
// detail = ユーザー指定 --journal or i18n デフォルト `中断: TNNN <title>`
const { revertedChildren } = await markTaskAborted(
  PROJECT_ROOT, taskId, "abort_task", journal,
  { taskTitle: title },
);
```

2 branches の違いは **conductor cleanup の有無のみ**（cleanupAssignedTask 呼び出し + `abort_signal_sent` ログ）。markTaskAborted 後の postMessage(TASK_UPDATED) は両 branches で残す。

Test 影響: 既存の abort-task ユニットテストは無い（integration 経由）。新規 `main.test.ts` にユニットテストを追加しない（scope 内で十分）。手動 E2E で確認。

**Step 2.6 — resume_marked_aborted（`main.ts:325-357` = `applyResumeTransitions` 内 + `main.ts:831-850` 呼び出し側）**

`applyResumeTransitions` の責務を再定義:
- **継続**: resume 可否判定（`classifyResumeAction`）、detail 文字列の生成（`buildResumeAbortJournal`）
- **削除**: taskState ミューテーション、cascadeAbortToChildren 直接呼び出し、`journals` return 値
- **新規**: 各 aborted 対象ごとに markTaskAborted を呼ぶ（または abort 対象情報だけ集めて cmdStart 側でまとめて markTaskAborted）

**選択**: **cmdStart 側で loop して markTaskAborted を呼ぶ** 形に変更。理由:
- applyResumeTransitions は pure-ish function を保ちたい（main.test.ts でテスト済み）
- 今の実装は taskState を直接 mutate しているが、markTaskAborted は `loadTaskState → save` を完結させるので「呼び出し単位の atomic 書き込み」が 1 task 1 呼び出しで成立する
- ただし複数 aborted がある場合 saveTaskState が N 回走る — cmdStart 起動時の一回限り処理なので性能影響なし

新シグネチャ（破壊的変更）:

```ts
export interface ApplyResumeTransitionsResult {
  resumePlan: ResumePlanItem[];
  /** abort 対象の詳細。cmdStart が loop で markTaskAborted に渡す */
  abortTargets: Array<{
    taskId: string;
    reason: "resume_no_worktree" | "resume_no_session_id" | "resume_no_task_run_id";
    detail: string;  // buildResumeAbortJournal の戻り値
  }>;
}
```

cmdStart 側（`main.ts:831-850`）:

```ts
for (const { taskId, reason, detail } of resumeResult.abortTargets) {
  const ts = taskState[taskId]!; // read-only 参照
  await log(
    "resume_marked_aborted",
    `task_id=${taskId} reason=${reason.replace(/^resume_/, "")} worktreePath=${ts.worktreePath ?? "null"} sessionId=${ts.sessionId ? "present" : "absent"} taskRunId=${ts.taskRunId ?? "null"}`,
  );
  const { revertedChildren } = await markTaskAborted(
    PROJECT_ROOT, taskId, reason, detail,
  );
  // child_reverted_to_draft は markTaskAborted 内で emit 済み
  // （従来 main.ts:844-849 の手動 emit を削除）
}
```

Test 影響: `main.test.ts:1372-1477` 4 テストすべての戻り値構造が変わる。
- `result.abortReasons / result.journals / result.revertedChildrenByParent / result.modified` が無くなる
- 代わりに `result.abortTargets` を assert
- `taskState[x].status === "aborted"` の直接 assertion は、**applyResumeTransitions は mutate しなくなる**ため失敗する → テスト構造を「呼び出し後 markTaskAborted 実行、taskState を再 load して検証」に書き換え

**または**代替案として `applyResumeTransitions` の内部互換を保ち、`main.test.ts` を変更しないまま `cmdStart` 側だけ書き換える選択肢もある（複雑度トレードオフ）。

**Planner の推奨**: **applyResumeTransitions のシグネチャを変更する**（後者の内部互換案は「2 箇所で mutate する重複責任」を生むため、構造的正しさが劣化する）。main.test.ts の 4 ケースはロジックが簡潔なので書き直しコストは小さい（見積 30 分）。

### Phase 3 — 表示側（await-task の stderr / printSummaries）

**Step 3.1** `formatAbortedTaskLine(id, journal)` helper を main.ts 内に追加。parseAbortJournal を import。

**Step 3.2** `main.ts:3067` と `main.ts:3101` の 2 箇所を helper 呼び出しに置換:

```ts
console.error(formatAbortedTaskLine(id, st.journal));
```

**Step 3.3** `printSummaries`（`main.ts:3279-3321`）で、closed/aborted/deleted status に応じて分岐:

```ts
const state = await loadTaskState(PROJECT_ROOT);
const st = state[id];
if (st?.status === "aborted") {
  console.log(formatAbortedTaskLine(id, st.journal));
} else if (st?.journal) {
  console.log(st.journal);  // closed / deleted は現状通り
} else {
  console.log(`Task ${id}: closed (no summary available)`);
}
```

**Step 3.4** 新規 `main.test.ts` describe block（任意）:
- `formatAbortedTaskLine`: 新 format journal → `[user_clear] C[5] taskRunId=...`
- `formatAbortedTaskLine`: 旧 format journal → `[user_clear] user_clear: C[5] taskRunId=...`（推定 reason + raw detail）
- `formatAbortedTaskLine`: 完全未知 journal → `[unknown] <raw>`
- `formatAbortedTaskLine`: journal=undefined → `[unknown] (no reason)`

### Phase 4 — 既存テストの整合（回帰防止）

**Step 4.1** daemon.test.ts の journal 形式 assertion を更新（すべて detail 部への一致は維持されるため**追加 assert のみ**）:
- `:821` `toContain("disconnect_timeout")` → 追加 `toMatch(/^reason=disconnect_timeout;/)`
- `:2301` `toContain("user_clear")` → 追加 `toMatch(/^reason=user_clear;/)`
- `:4466-4468` `toContain("conductor_done_unresolved")` → 追加 `toMatch(/^reason=judgment_pending;/)`

**Step 4.2** main.test.ts の applyResumeTransitions テスト書き換え（Phase 2.6 の副作用）:
- 4 ケースとも `result.abortTargets` の構造を assert
- 各ケースで「applyResumeTransitions 呼び出し → markTaskAborted loop → 最終 taskState 再 load」を実行する補助 test helper を書く

**Step 4.3** `bun test` 全体パス + `bunx tsc --noEmit` で型エラー 0 件を確認。

---

## 4. 影響範囲

### 変更ファイル

| ファイル | 変更内容 | リスク |
|---|---|---|
| `skills/cmux-team/manager/task.ts` | `AbortReason` / `markTaskAborted` / `parseAbortJournal` / `ParsedAbortJournal` / `MarkTaskAbortedResult` / `MarkTaskAbortedOptions` 追加 | 低（純追加） |
| `skills/cmux-team/manager/task.test.ts` | describe("markTaskAborted") + describe("parseAbortJournal") 新規 | 低 |
| `skills/cmux-team/manager/daemon.ts` | 4 経路（user_clear / assign_failed / disconnect_timeout / judgment_pending）を置換。`loadTaskState` / `cascadeAbortToChildren` の直接呼び出しが 4 箇所減る | 中（state mutation 位置変更） |
| `skills/cmux-team/manager/daemon.test.ts` | journal prefix 新 format の追加 assert（置換 assert はなし、既存は維持） | 低 |
| `skills/cmux-team/manager/main.ts` | `applyResumeTransitions` 戻り値型変更、`cmdStart` の resume loop 書き換え、`cmdAbortTask` 2 branches 置換、`cmdAwaitTask` の 2 console.error 置換、`printSummaries` 分岐追加、`formatAbortedTaskLine` helper 追加 | 中（applyResumeTransitions 破壊的変更） |
| `skills/cmux-team/manager/main.test.ts` | applyResumeTransitions の 4 テスト書き直し、`formatAbortedTaskLine` unit test 任意追加 | 中（test rewrite） |

### 非変更

- `skills/cmux-team/manager/dashboard.tsx` — `journal_summary=` 抽出のまま OK（reason=X; detail 形式でもマッチする）
- `skills/cmux-team/manager/state-machine/task-fsm.ts` — 既に `reason=${event.reason}` detail を持つ予約 action、shadow のみなので変更不要
- `skills/cmux-team/manager/i18n.ts` — `abort_journal_default` は abort-task CLI のデフォルト detail 文字列生成のまま（reason prefix は markTaskAborted が付与）
- delete-task 経路（`main.ts:3778`）— task_deleted のまま（本タスク対象外）

### 破壊的変更

1. **TaskState.journal の on-disk 文字列形式**
   - 新規書き込み: `reason=<reason>; <detail>` 形式
   - 既存書き込み: parseAbortJournal が旧 format を best-effort 推定
   - migration 不要（上書きで自然に更新）
2. **`applyResumeTransitions` シグネチャ**（main.ts export 関数）
   - 戻り値型の `abortReasons` / `journals` / `revertedChildrenByParent` / `modified` を削除
   - 代わりに `abortTargets: Array<{ taskId, reason, detail }>` を追加
   - mutation 副作用削除（cmdStart 側で markTaskAborted が担当）
3. **`cmux-team await-task` stderr 出力フォーマット**
   - Before: `Task 1 was aborted: user_clear: C[5] taskRunId=...`
   - After: `Task 1 was aborted: [user_clear] C[5] taskRunId=...`
   - 影響: ユーザー / agent が stderr を正規表現で parse している場合に破壊。ただし `Task N was aborted: ` prefix は維持されるので、前方一致で待機しているものは動作継続

---

## 5. テスト戦略

### 新規 unit test（task.test.ts）

| No | テストケース | 検証対象 |
|---|---|---|
| T1 | markTaskAborted 正常系 | journal 形式 / task_aborted log / abortedAt |
| T2 | markTaskAborted detail 空 | journal = `reason=<r>` のみ（末尾セミコロンなし） |
| T3 | markTaskAborted 冪等 (aborted) | idempotentSkip=true / 二重書き込み防止 / saveTaskState 未呼び出し |
| T4 | markTaskAborted 冪等 (closed) | 同上 |
| T5 | markTaskAborted 冪等 (deleted) | 同上 |
| T6 | markTaskAborted cascade | ready 子 → draft / revertedChildren / child_reverted_to_draft log |
| T7 | markTaskAborted cascade 無し | revertedChildren=[] / log なし |
| T8 | markTaskAborted log detail 完備 | task_id / reason / title / journal_summary / extraLogFields すべて含む |
| T9 | parseAbortJournal new format | `reason=user_clear; detail...` → 正確に分解 |
| T10 | parseAbortJournal 旧 format 6 種 | 各 prefix → 正しい推定 reason |
| T11 | parseAbortJournal 未知 | reason=undefined / detail=raw |
| T12 | parseAbortJournal 空/undefined | `{ raw: "" }` |

### 既存テストへの追加 assertion

| ファイル:行 | 追加 assert | 目的 |
|---|---|---|
| daemon.test.ts:821 | `toMatch(/^reason=disconnect_timeout;/)` | 新 prefix の回帰防止 |
| daemon.test.ts:2301 | `toMatch(/^reason=user_clear;/)` | 同上 |
| daemon.test.ts:4466 | `toMatch(/^reason=judgment_pending;/)` | T269 時の reason/journal 乖離が再発しない構造保証 |

### 既存テストの書き直し（Phase 2.6 起因）

| ファイル:行 | 書き直し内容 |
|---|---|
| main.test.ts:1389-1413 (a) | resumePlan は維持。abortedTaskIds 系 assertion を `abortTargets=[]` に変更 |
| main.test.ts:1415-1438 (b) | 戻り値 `abortTargets[0]={taskId:"1", reason:"resume_no_worktree", detail:...}` を assert。taskState mutation は test helper で markTaskAborted を呼んでから検証 |
| main.test.ts:1440-1461 (c) | 同様。cascade 結果の検証は markTaskAborted 経由 |
| main.test.ts:1463-1476 (d) | 変更なし（abortTargets=[] で済む） |

### 回帰防止 E2E（手動）

1. `cmux-team abort-task --task-id <X>` で abort → `cmux-team await-task --task-id <X>` の stderr に `[abort_task]` が出ること
2. Conductor が自発的に `CONDUCTOR_DONE --success=false` → manager.log の `task_aborted ... reason=judgment_pending` と task-state の `journal: reason=judgment_pending; conductor_done_unresolved: ...` が両方出る
3. daemon 起動時に worktree を手動削除した assigned task → `resume_marked_aborted` + `task_aborted reason=resume_no_worktree` の両 log、journal = `reason=resume_no_worktree; [resume] lost worktree ...`

### CI/自動テスト

- `bun test` 全体（`skills/cmux-team/manager/` 配下）
- `bunx tsc --noEmit`（新規 type `AbortReason` / return type の整合性）
- 既存の `daemon.test.ts` / `main.test.ts` / `task.test.ts` すべて Green

---

## 6. ロールバック戦略

### 6.1 コミット粒度

Phase 単位でコミット:

| コミット | 内容 | 単独 revert 可否 |
|---|---|---|
| C1 | Phase 1 (task.ts + task.test.ts の追加のみ) | 可 — ヘルパー未使用状態に戻る |
| C2 | Phase 2.1 (assign_failed) | 可 — daemon.ts 該当箇所のみ |
| C3 | Phase 2.2 (disconnect_timeout) | 可 |
| C4 | Phase 2.3 (user_clear) | 可 |
| C5 | Phase 2.4 (judgment_pending) | 可 |
| C6 | Phase 2.5 (abort-task CLI) | 可 |
| C7 | Phase 2.6 (resume_marked_aborted + applyResumeTransitions シグネチャ変更 + main.test.ts 書き直し) | 一括 — main.ts / main.test.ts 同時 |
| C8 | Phase 3 (await-task 表示 + printSummaries) | 可 |

### 6.2 on-disk 互換性

- 新 format journal を書いたあと古いバイナリに戻しても、旧 format パーサは単に文字列としてそのまま扱う（crash しない）
- `cmux-team await-task` の stderr は `Task N was aborted: reason=X; ...` と表示されるだけ（機能は失わない）

### 6.3 runtime 互換性

- markTaskAborted 呼び出し中の `loadTaskState` → `saveTaskState` は既存経路と同じ atomic rename を使う → 部分書き込みなし
- 冪等 skip 経路があるため、途中で daemon がクラッシュしても double write しない
- cascade ロジックは既存の `cascadeAbortToChildren` を内部再利用 → 子 cascade の挙動は不変

### 6.4 緊急撤回ガイド

問題発生時、優先順に:
1. 表示側だけの問題（await-task 文字列）→ Phase 3 (C8) を revert
2. 単一経路の問題 → 該当 Phase 2.X (C2-C6) を revert
3. applyResumeTransitions の問題 → Phase 2.6 (C7) を revert（main.ts / main.test.ts が一緒に戻る）
4. 全面撤回 → C8 から順に C1 まで revert。journal 形式は自動で旧 format に戻る（parseAbortJournal は消えるが存在しなくても runtime エラーは起きない）

---

## 7. Inspection 用チェックリスト（grep で機械的に検証）

実装完了時、以下を Inspector が確認する:

### 7.1 集約の徹底

```bash
# A. `status: "aborted"` 直接代入が markTaskAborted 内に 1 箇所のみ
rg -n 'status:\s*"aborted"' skills/cmux-team/manager --type ts | grep -v test
# 期待: task.ts の markTaskAborted 内 1 行 (+ test 内の setup は除外)
# 現状: daemon.ts 3 箇所 + main.ts 3 箇所（計 6 箇所）→ 実装後 1 箇所のみ
```

```bash
# B. `log("task_aborted"` 呼び出しが markTaskAborted 内に 1 箇所のみ
rg -n 'log\("task_aborted"' skills/cmux-team/manager --type ts
# 期待: task.ts 1 箇所のみ
# 現状: daemon.ts 4 箇所 + main.ts 3 箇所（applyResumeTransitions 呼び出し側 + abort-task 2 branches）
```

```bash
# C. cascadeAbortToChildren の直接呼び出しが集約されている
rg -n 'cascadeAbortToChildren\(' skills/cmux-team/manager --type ts | grep -v test
# 期待: task.ts:markTaskAborted 内 1 箇所 + main.ts:cmdDeleteTask 1 箇所 = 計 2 箇所
# 現状: daemon.ts 4 + main.ts 4 = 計 8 箇所
```

### 7.2 journal 形式の一貫性

```bash
# D. 新 format prefix `reason=<snake_case>;` の出現
rg -n 'reason=[a-z_]+;' skills/cmux-team/manager/task.ts
# 期待: markTaskAborted 内の template literal 1 箇所
```

```bash
# E. 旧 format の手書き prefix が残っていない
rg -nE 'journal\s*[=:]\s*`(user_clear|assign_failed|disconnect_timeout|conductor_done_unresolved):' skills/cmux-team/manager --type ts | grep -v test
# 期待: 0 件（detail 生成では prefix を付けない）
```

### 7.3 表示側の reason 先頭表示

```bash
# F. await-task / printSummaries が formatAbortedTaskLine を経由
rg -n 'formatAbortedTaskLine\(' skills/cmux-team/manager/main.ts
# 期待: helper 定義 1 + 呼び出し 3（await-task x2 + printSummaries x1）= 計 4 箇所
```

```bash
# G. 古い Template literal `Task ${id} was aborted: ${st.journal` が残っていない
rg -n 'was aborted:\s*\$\{st\.journal' skills/cmux-team/manager --type ts
# 期待: 0 件（すべて formatAbortedTaskLine 経由）
```

### 7.4 T269 型乖離の構造的解消

```bash
# H. journal の reason prefix と log の reason が必ず一致
# （markTaskAborted 内で同一変数を使っているため構造的に保証。以下は念のため）
rg -n 'reason=judgment_pending' skills/cmux-team/manager --type ts
# 期待: markTaskAborted 呼び出しの第 3 引数（reason）にのみ出現
# 禁止: journal 文字列の手書きリテラル側に出現
```

### 7.5 既存テスト回帰

```bash
# I. 既存の log assertion がそのまま通る
bun test skills/cmux-team/manager/daemon.test.ts
bun test skills/cmux-team/manager/main.test.ts
bun test skills/cmux-team/manager/task.test.ts
# 期待: すべて PASS（新 assert 追加あり、既存 assert は維持）
```

```bash
# J. 型エラー 0 件
bunx tsc --noEmit
# 期待: No errors
```

### 7.6 後方互換性（parseAbortJournal）

```bash
# K. parseAbortJournal の unit test が 6 prefix すべてカバー
rg -n 'parseAbortJournal' skills/cmux-team/manager/task.test.ts
# 期待: 最低 8 ケース（new format 2 + 旧 prefix 6 + 未知 1 + 空 1）
```

---

## 8. 見積もり

| Phase | 作業量 | 主なリスク |
|---|---|---|
| Phase 1 | 1.5h | parseAbortJournal の旧 format 推定ロジック |
| Phase 2.1-2.4 | 計 2h | daemon.ts 4 経路の置換（各 30min 目安） |
| Phase 2.5 | 1h | abort-task 2 branches の一貫した置換 |
| Phase 2.6 | 2h | applyResumeTransitions シグネチャ変更 + main.test.ts 4 テスト書き直し |
| Phase 3 | 1h | formatAbortedTaskLine + 呼び出し 3 箇所 |
| Phase 4 | 1h | 既存 assert の追加 + `bun test` 全体確認 |
| **合計** | **8.5h** | — |

---

## 9. 未解決事項（Implementer が発見する可能性あり）

1. **`handleConductorDone` の Step 2.4 置換時、 既存の `conductor_done_unresolved_skip` ログとの整合**
   - 現状: skip 時は `conductor_done_unresolved_skip` を出す（既に closed/aborted）
   - markTaskAborted は `task_abort_skipped` を出す
   - 選択肢 A: markTaskAborted の skip 時は何も出さず、呼び出し側で `conductor_done_unresolved_skip` を維持
   - 選択肢 B: markTaskAborted が `task_abort_skipped` を出し、呼び出し側は追加 context log を出す
   - **Planner 推奨**: B。`task_abort_skipped task_id=X existing_status=aborted reason=<called_reason>` を markTaskAborted が出す + `handleConductorDone` 側で `conductor_done_unresolved_skip` をそのまま並べる（前後で 2 行出るが情報は失わない）

2. **Phase 2.6 で applyResumeTransitions の変更を避ける代替案**
   - mutable な `taskState` 引数を残し、markTaskAborted を呼ばず旧来通り mutation。cmdStart 側で保存後に markTaskAborted で log emit だけ追加？
   - → saveTaskState が 2 回走る、mutation 担当が 2 箇所になる → **構造劣化**。推奨しない

3. **abort_task CLI のユーザー指定 `--journal` 文字列**
   - 現状: `journal` 変数にそのまま入る（i18n デフォルトまたはユーザー指定）
   - 新 format: `reason=abort_task; <user input>` になる
   - ユーザーが自分で `reason=xxx;` 形式で渡してきた場合の二重 prefix をどうするか
   - **Planner 推奨**: そのまま二重 prefix を許容する（ユーザー入力は detail 扱い）。parseAbortJournal は最初の `reason=` にしかマッチしないので支障なし

4. **FSM shadow との整合（state-machine/task-fsm.ts）**
   - `task_aborted` 予約 action は `detail: reason=${event.reason}` 形式。現 reducer は emit しない
   - markTaskAborted は本番 emit 側。shadow とは独立して動作
   - 将来 P2 で FSM が本番運用に昇格した際、markTaskAborted を reducer の action として吸収する再設計余地がある（今回対象外）

---

**Plan 完了。Implementer / Design Reviewer は上記 7 ステップ + D1-D5 の設計判断に従って実装する。**
