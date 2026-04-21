# T264 Plan: `resume_fallback_to_ready` を `resume_marked_aborted` に置き換える（v2）

> **改訂履歴**
> - v1: 初版。`aborted` 遷移化 + journal 記録 + `restartFromAborted` 委譲の骨子
> - **v2 (本版)**: Design Review (design-review.md) の指摘 R1〜R5 を反映
>   - **R1**: `task_aborted` ログを `resume_marked_aborted` と両方 emit する（既存 aborted 化 4 経路と整合）
>   - **R1**: `cascadeAbortToChildren` を呼ぶ（CLAUDE.md §依存タスクの cascade の 5 経路目に加える）
>   - **R2**: `applyResumeTransitions` wrapper で emit/cascade 副作用を検証可能にする
>   - **R3**: S6 に grep 手順を明文化
>   - **R4**: S7 に 3 reason の運用ドキュメント波及を追記
>   - **R5 (採用)**: pure helper の配置先を `resume-classify.ts` 新規から **`task.ts` への追記** に変更（既存 `detectStartupUniqueViolations` と同居）
>   - Decision Log D2 (cascade 呼び出し), D7 (配置先), D11 (`task_aborted` 二重 emit) を改訂・追加

## 1. 課題分析

### 現状

`main.ts:702-718` の起動時 resume 整合性チェック（`cmdStart` 内）は以下のロジック:

```ts
for (const [taskId, ts] of Object.entries(taskState)) {
  if (ts.status !== "assigned") continue;
  const canResume = ts.sessionId
    && ts.worktreePath && existsSync(ts.worktreePath)
    && ts.taskRunId;
  if (!canResume) {
    taskState[taskId] = { ...ts, status: "ready" };   // ← 無条件 ready 差し戻し
    taskStateModified = true;
    await log(
      "resume_fallback_to_ready",
      `task_id=${taskId} reason=${!ts.sessionId ? "no_session_id" : "no_worktree"} ` +
      `worktreePath=${ts.worktreePath ?? "null"} sessionId=${ts.sessionId ? "present" : "absent"} ` +
      `taskRunId=${ts.taskRunId ?? "null"}`
    );
    continue;
  }
  rawResumePlan.push({ ... });
}
```

「**assigned だが worktree が存在しない**」状態が検出されると、即座に `ready` に差し戻されて再実行される。

### 根本原因（T262 の事例）

`.team/tasks/262-conductor/runs/task-262-1776560393/` に Inspector GO 判定済みの成果一式が残っていたにもかかわらず、daemon 再起動時 worktree が消えていた（T263 で修正済みの `success=false` 時の worktree 削除バグ）ため、上記ロジックが発動。`ready` に戻して `worktree_created branch=task-262-1776566705/task`（新 taskRunId）で最初から再実行してしまった。

ログ:
```
11:45:04 resume_fallback_to_ready task_id=262 reason=no_worktree ...
11:45:05 worktree_created branch=task-262-1776566705/task ...
```

### 影響範囲

T263 修正後も以下の残存経路でバグが顕在化する:

1. **旧 state からの起動**: T263 より前に生成された assigned+worktree 不在の state
2. **手動 `git worktree remove --force`** をユーザーが実行した場合
3. **未知のバグで worktree だけ消えた場合**

これらで 1 回目の成果が `.team/tasks/<slug>/runs/<taskRunId>/` にあるのに、人間に通知されず自動再走される危険は残り続ける。

### 本質的な問題

「`canResume` が false」の扱いを **「安全側 = 人間判断を要求」** にしていない。
`resume_fallback_to_ready` は「resume できないなら再割り当てすればいい」という短絡で、
**既に 1 回走った事実と成果物の存在を無視**している。

---

## 2. 技術アプローチ

### 選択したアプローチ: `aborted` 遷移化 + 既存 cascade/emit 慣習に整合

resume 不可（`no_worktree` / `no_session_id` / `no_task_run_id`）を検出したら **即 aborted に倒し**、
journal に旧 taskRunId と runs ディレクトリパスを埋め込む。さらに既存 aborted 化 4 経路と整合するよう:

- `task_aborted` ログを emit（`resume_marked_aborted` と両方）
- `cascadeAbortToChildren` で `depends_on` に該当親を含む ready 子タスクを draft に戻す（CLAUDE.md §依存タスクの cascade の 5 経路目）

再走は `cmux-team restart-task --task-id <X>` でユーザーが明示的に起こす（既存コマンドに aborted → ready 経路あり: `restartFromAborted` main.ts:3314）。ユーザーは journal を読めば既存成果物に直接アクセスできる。

### 既存 aborted 化パスとの整合性

| 経路 | 場所 | emit されるログ | cascade |
|------|------|----------------|---------|
| `user_clear` | daemon.ts:2136 | `task_aborted task_id=X reason=user_clear` | ✔ |
| `disconnect_timeout` | daemon.ts:2685-2688 | `task_aborted task_id=X reason=disconnect_timeout ...` | ✔ |
| `assign_failed` | daemon.ts:2314-2317 | `task_aborted task_id=X reason=assign_failed ...` | ✔ |
| `cmdAbortTask` | main.ts:3225 / 3266 | `task_aborted task_id=X reason=abort_task ...` | ✔ |
| **T264 (新規)** | main.ts:702-718 | `resume_marked_aborted` + `task_aborted task_id=X reason=resume_no_worktree\|resume_no_session_id\|resume_no_task_run_id ...` | ✔ |

### journal フォーマット

```
[resume] <summary> (taskRunId=<old>). artifacts preserved at .team/tasks/<slug>/runs/<taskRunId>/
```

- `[resume]` prefix は T254 `unique_violation:` 風にはせず、`[restart]` prefix と並ぶ既存慣習（prefix 方式）に整合
- summary: `lost worktree` / `missing session id` / `missing task run id`
- `<slug>` は `findTaskFile` の戻り値から `basename(dirname(taskFile))` で抽出。単一ファイル形式（legacy）なら `(runs dir not found — legacy flat task file)`、`findTaskFile` が undefined なら `<unknown>` を埋める

### 代替案と却下理由

| 案 | 却下理由 |
|----|---------|
| A. `ready` に差し戻しつつ journal だけ追加 | 人間が気づかずに再走が走り、T262 再発リスク残る |
| B. `no_session_id` は ready、`no_worktree` だけ aborted | 両ケースとも「実行途中の中断」で成果物が残存する可能性あるため扱いを共通化する方が予測可能（D3 参照） |
| C. `abort-task` を internal API として呼ぶ | cleanup (worktree 削除・Conductor 停止) が不要。起動時 state は「worktree はすでに無い／Conductor はまだ居ない」前提なので cleanup 処理を通すと意味論が崩れる |
| D. journal を絶対パスで保存 | リポジトリを別マシンで開いたとき破綻。相対パス `.team/tasks/<slug>/runs/<taskRunId>/` が安定（D4 参照） |
| E. (v1) `task_aborted` を emit せず `resume_marked_aborted` のみ | **採用しない（v2 で改訂）**。既存 aborted 化 4 経路との観測性整合が崩れ、`rg task_aborted` 監査が漏れる |
| F. (v1) cascade を起動時に呼ばず scanTasks に委ねる | **採用しない（v2 で改訂）**。cascade 不変条件を崩すより 6 経路目として足す方が設計上クリーン |

### タスクスラッグの求め方

`findTaskFile` (main.ts:209) が返すのは `task.md` の絶対パス:

- ディレクトリ形式: `<PROJECT_ROOT>/.team/tasks/262-conductor/task.md` → slug は `basename(dirname(taskFile))` = `262-conductor`
- 単一ファイル形式（legacy）: `<PROJECT_ROOT>/.team/tasks/262.md` → runs ディレクトリは構造上 **ディレクトリ形式にしか存在しない**ため、単一ファイル形式では runs パスを含めず `(runs dir not found — legacy flat task file)` と代替表記
- `findTaskFile` が undefined を返す場合: `.team/tasks/<slug>/` が消失している異常系。`<unknown>` で journal を残す（後日の手動調査用）

既存 `printSummaries` (main.ts:3019-3048) が同じ判定ロジック:
```ts
const taskDir = taskFile.endsWith("/task.md") ? dirname(taskFile) : null;
```
これを流用する。

---

## 3. 変更対象

### 変更するファイル

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/main.ts` | (A) `cmdStart` 内 702-718 を `resume_marked_aborted` + `task_aborted` + `cascadeAbortToChildren` 化、(B) resume 処理を薄い wrapper `applyResumeTransitions` として切り出し export（テスト用）、(C) resume ループ前に `loadTasks(PROJECT_ROOT)` を 1 回だけ呼んで `allTasks` を取得する |
| `skills/cmux-team/manager/task.ts` | (A) `classifyResumeAction` / `buildResumeAbortJournal` を `detectStartupUniqueViolations` の隣に追加・export（R5 採用）、(B) task.ts:94 コメント `resume_fallback_to_ready` → `resume_marked_aborted` に更新 |
| `skills/cmux-team/manager/task.test.ts` | 上記ヘルパの 8 ケースを追加（末尾の `describe("resume classify/journal (T264)")` ブロック） |
| `skills/cmux-team/manager/main.test.ts` | `applyResumeTransitions` の state 変換 + emit + cascade を検証する 4 ケース（下記 S5 参照） |

### 新規作成するファイル

**なし**（R5 採用により `resume-classify.ts` は作らない）。

### 削除するファイル

なし。ログキー `resume_fallback_to_ready` 自体は検索性の維持のため grep 可能な場所（A015 artifact 等）に残る。コード側からは完全撤廃する。

### `resume_overflow_to_ready` の扱い

**変更しない**（main.ts:737-743）。

理由: overflow は「slot 数に対して assigned 数が多すぎる」だけで、
該当タスクの worktree / sessionId は生きている。次サイクルで他タスクが closed になれば
通常通り resume できる。成果物喪失リスクはなく、ready 差し戻しで問題ない。
この区別を Decision Log D1 に記録する。

---

## 4. サブタスク分割

### S1. `classifyResumeAction` / `buildResumeAbortJournal` を `task.ts` に追加（R5 採用）

- **対象ファイル**: `skills/cmux-team/manager/task.ts`（`detectStartupUniqueViolations` の直後、`cascadeAbortToChildren` より前）
- **内容**:
  ```ts
  // ---- T264: resume 不可検出 + journal 生成 ---------------------------------

  import { existsSync as _existsSync } from "fs";
  import { dirname as _dirname, basename as _basename } from "path";
  // ↑ 既存 import に追記（task.ts 先頭を確認し重複しないよう統合）

  export type ResumeClassification =
    | { kind: "resume" }
    | { kind: "abort"; reason: "no_worktree" | "no_session_id" | "no_task_run_id" };

  /**
   * cmdStart 起動時、assigned タスクが resume 可能か判定する。
   * sessionId / taskRunId / worktreePath + 実在 の順に検証し、
   * 最初に欠落した要素を reason として返す（優先順位固定）。
   */
  export function classifyResumeAction(
    ts: TaskState,
    exists: (p: string) => boolean = _existsSync,
  ): ResumeClassification {
    if (!ts.sessionId) return { kind: "abort", reason: "no_session_id" };
    if (!ts.taskRunId) return { kind: "abort", reason: "no_task_run_id" };
    if (!ts.worktreePath || !exists(ts.worktreePath)) {
      return { kind: "abort", reason: "no_worktree" };
    }
    return { kind: "resume" };
  }

  /**
   * resume 不可で aborted 化するタスクの journal を生成する。
   * runs ディレクトリパスは相対パス（.team/tasks/<slug>/runs/<taskRunId>/）で埋める。
   */
  export function buildResumeAbortJournal(
    taskFile: string | undefined,
    ts: TaskState,
    reason: "no_worktree" | "no_session_id" | "no_task_run_id",
  ): string {
    const taskRunId = ts.taskRunId ?? "unknown";
    let artifactsPath: string;
    if (taskFile && taskFile.endsWith("/task.md")) {
      const slug = _basename(_dirname(taskFile));
      artifactsPath = `.team/tasks/${slug}/runs/${taskRunId}/`;
    } else if (taskFile) {
      artifactsPath = "(runs dir not found — legacy flat task file)";
    } else {
      artifactsPath = `.team/tasks/<unknown>/runs/${taskRunId}/`;
    }
    const summary = reason === "no_worktree" ? "lost worktree"
      : reason === "no_session_id" ? "missing session id"
      : "missing task run id";
    return `[resume] ${summary} (taskRunId=${taskRunId}). artifacts preserved at ${artifactsPath}`;
  }
  ```
- **完了条件**: `task.ts` からエクスポートされ、`main.ts` の import に追加できる状態
- **検証コマンド**: `cd skills/cmux-team/manager && bunx tsc --noEmit` で新規エラー 0

### S2. `main.ts` に `applyResumeTransitions` wrapper を切り出し・export する

- **対象ファイル**: `skills/cmux-team/manager/main.ts`（`cmdStart` の resume ループを wrapper 経由に置換）
- **内容**:
  ```ts
  import { classifyResumeAction, buildResumeAbortJournal, cascadeAbortToChildren } from "./task";
  import type { TaskMeta } from "./task";

  export interface ApplyResumeTransitionsDeps {
    findTaskFile: (taskId: string) => Promise<string | undefined>;
    exists?: (p: string) => boolean;
    now?: () => string;
  }

  export interface ApplyResumeTransitionsResult {
    resumePlan: Array<{
      taskId: string;
      taskRunId: string;
      worktreePath: string;
      sessionId: string;
    }>;
    abortedTaskIds: string[];            // 新規 aborted 化された task id
    abortReasons: Record<string, "no_worktree" | "no_session_id" | "no_task_run_id">;
    journals: Record<string, string>;    // taskId → journal
    revertedChildrenByParent: Record<string, string[]>;  // 親 taskId → draft に戻した子 id 群
    modified: boolean;
  }

  /**
   * cmdStart 内の resume 判定ループを純粋に近い wrapper にしたもの。
   * 副作用: taskState ミュータブル書き換え + revertedChildren 計算。
   * ログ emit は呼び出し側（cmdStart）で行う（戻り値を消費して `task_aborted` /
   * `resume_marked_aborted` / `child_reverted_to_draft` を順に emit）。
   */
  export async function applyResumeTransitions(
    taskState: Record<string, TaskState>,
    allTasks: TaskMeta[],
    deps: ApplyResumeTransitionsDeps,
  ): Promise<ApplyResumeTransitionsResult> {
    const exists = deps.exists ?? existsSync;
    const now = deps.now ?? (() => new Date().toISOString());

    const resumePlan: ApplyResumeTransitionsResult["resumePlan"] = [];
    const abortedTaskIds: string[] = [];
    const abortReasons: ApplyResumeTransitionsResult["abortReasons"] = {};
    const journals: Record<string, string> = {};
    const revertedChildrenByParent: Record<string, string[]> = {};
    let modified = false;

    for (const [taskId, ts] of Object.entries(taskState)) {
      if (ts.status !== "assigned") continue;
      const action = classifyResumeAction(ts, exists);

      if (action.kind === "resume") {
        resumePlan.push({
          taskId,
          taskRunId: ts.taskRunId!,
          worktreePath: ts.worktreePath!,
          sessionId: ts.sessionId!,
        });
        continue;
      }

      const taskFile = await deps.findTaskFile(taskId);
      const journal = buildResumeAbortJournal(taskFile, ts, action.reason);
      taskState[taskId] = {
        ...ts,
        status: "aborted",
        abortedAt: now(),
        journal,
      };
      modified = true;
      abortedTaskIds.push(taskId);
      abortReasons[taskId] = action.reason;
      journals[taskId] = journal;

      // cascade: 既存 aborted 化パス (daemon.ts:2134/2312/2683, main.ts:3223/3263/3519) と整合
      const { revertedChildren } = cascadeAbortToChildren(taskState, allTasks, taskId);
      if (revertedChildren.length > 0) {
        revertedChildrenByParent[taskId] = revertedChildren;
        // 子 state も modified
      }
    }

    return { resumePlan, abortedTaskIds, abortReasons, journals, revertedChildrenByParent, modified };
  }
  ```
- **完了条件**: wrapper が純粋側（exists / now を注入可）で、state 変換・cascade 呼び出しを内包し、emit は呼び出し側に委ねる
- **検証コマンド**: `bunx tsc --noEmit`

### S3. `cmdStart` の resume ループを `applyResumeTransitions` 経由に置き換える

- **対象ファイル**: `skills/cmux-team/manager/main.ts`（702-726 付近）
- **内容**:
  ```ts
  // --- T241/T264: cascade 用にタスクメタを 1 回だけロード ---
  //   (現状 cmdStart では line 1173 で loadTasks しているが、それは status 用の
  //    別 loadTasks。resume ループ用はここで先取りする)
  const { tasks: allTasksForResume } = await loadTasks(PROJECT_ROOT);

  // --- T264: resume 不可 → aborted 遷移 + cascade ---
  const resumeResult = await applyResumeTransitions(taskState, allTasksForResume, {
    findTaskFile,
  });
  rawResumePlan.push(...resumeResult.resumePlan);
  if (resumeResult.modified) taskStateModified = true;

  for (const taskId of resumeResult.abortedTaskIds) {
    const reason = resumeResult.abortReasons[taskId];
    const journal = resumeResult.journals[taskId];
    const ts = taskState[taskId];
    await log(
      "resume_marked_aborted",
      `task_id=${taskId} reason=${reason} ` +
      `worktreePath=${ts.worktreePath ?? "null"} ` +
      `sessionId=${ts.sessionId ? "present" : "absent"} ` +
      `taskRunId=${ts.taskRunId ?? "null"}`,
    );
    await log(
      "task_aborted",
      `task_id=${taskId} reason=resume_${reason} journal_summary=${journal}`,
    );
    const revertedChildren = resumeResult.revertedChildrenByParent[taskId] ?? [];
    for (const childId of revertedChildren) {
      await log(
        "child_reverted_to_draft",
        `parent=${taskId} child=${childId} reason=parent_aborted`,
      );
    }
  }
  ```
  - **注意1**: `resume_fallback_to_ready` ログキーは完全撤去。grep で 0 件になることを確認（S6 で検証）
  - **注意2**: `findTaskFile` 呼び出しは abort 経路のみで発生（resume 経路に性能影響なし）
  - **注意3**: `resume_overflow_to_ready` は触らない（D1）
  - **注意4**: `task_aborted` の reason 値は `resume_no_worktree` / `resume_no_session_id` / `resume_no_task_run_id` の 3 種。既存 `reason=user_clear|disconnect_timeout|assign_failed|abort_task` と名前空間が衝突しないことを `rg 'reason=resume_' skills/cmux-team/manager` でレビュー時に確認
  - **注意5**: `loadTasks(PROJECT_ROOT)` は resume ループ前で 1 回呼ぶ。既存 line 1173 の `loadTasks` は status 表示用で別インスタンス。二重ロードではあるが scanTasks の負荷としては許容（頻繁に呼ばれる path ではない）

- **完了条件**: ビルド通過、動作はテスト (S5) で検証
- **検証コマンド**: `cd skills/cmux-team/manager && bunx tsc --noEmit`

### S4. `task.ts` 内ヘルパのユニットテスト追加

- **対象ファイル**: `skills/cmux-team/manager/task.test.ts` に `describe("resume classify/journal (T264)")` を追加
- **テストケース (8 件)**:
  1. `classifyResumeAction`: sessionId なし → `{ kind: "abort", reason: "no_session_id" }`
  2. `classifyResumeAction`: sessionId あり / taskRunId なし → `{ kind: "abort", reason: "no_task_run_id" }`
  3. `classifyResumeAction`: worktreePath なし → `{ kind: "abort", reason: "no_worktree" }`
  4. `classifyResumeAction`: worktreePath 指定あり + `exists=false` → `{ kind: "abort", reason: "no_worktree" }`
  5. `classifyResumeAction`: 3 点揃い + `exists=true` → `{ kind: "resume" }`
  6. `buildResumeAbortJournal`: ディレクトリ形式 taskFile + `no_worktree` → `[resume] lost worktree (taskRunId=task-262-1776560393). artifacts preserved at .team/tasks/262-conductor/runs/task-262-1776560393/`
  7. `buildResumeAbortJournal`: 単一ファイル形式 taskFile → `(runs dir not found — legacy flat task file)` を含む
  8. `buildResumeAbortJournal`: taskFile=undefined + `no_session_id` → `[resume] missing session id (taskRunId=unknown). artifacts preserved at .team/tasks/<unknown>/runs/unknown/`
- **完了条件**: `bun test task.test.ts` 全通過
- **検証コマンド**: `cd skills/cmux-team/manager && bun test task.test.ts`

### S5. `applyResumeTransitions` の統合テスト（emit/cascade 副作用検証含む — R2 反映）

- **対象ファイル**: `skills/cmux-team/manager/main.test.ts` に `describe("T264: applyResumeTransitions (cmdStart resume)")` を追加
- **テストケース (4 件)**:
  1. **(a) assigned + worktree 生存 → resume**
     - `taskState = { "1": { status: "assigned", sessionId: "s", taskRunId: "r", worktreePath: "/tmp/exists" } }`
     - `exists = () => true`
     - 期待: `resumePlan` に 1 件、`abortedTaskIds` 空、`modified=false`、state 不変
  2. **(b) assigned + worktree 不在 → aborted 化 + journal**
     - `taskState = { "1": { status: "assigned", sessionId: "s", taskRunId: "task-1-123", worktreePath: "/tmp/gone" } }`
     - `exists = () => false`, `findTaskFile = async () => "/p/.team/tasks/1-foo/task.md"`
     - 期待: `abortedTaskIds = ["1"]`, `abortReasons["1"] = "no_worktree"`, `journals["1"]` に `.team/tasks/1-foo/runs/task-1-123/` 含む, `taskState["1"].status === "aborted"`, `abortedAt` 設定
  3. **(c) 親 aborted → ready 子 draft に戻す（cascade 検証）**
     - `taskState = { "1": { status: "assigned", sessionId: "s", taskRunId: "t1", worktreePath: "/tmp/gone" }, "2": { status: "ready" } }`
     - `allTasks = [{ id: "1", dependsOn: [] }, { id: "2", dependsOn: ["1"] }]`
     - `exists = () => false`
     - 期待: `abortedTaskIds = ["1"]`, `revertedChildrenByParent["1"] = ["2"]`, `taskState["2"].status === "draft"`, `taskState["2"].journal` に `parent_aborted: 1` 含む
  4. **(d) ready タスクは無影響**
     - `taskState = { "5": { status: "ready" } }`
     - 期待: `resumePlan` 空、`abortedTaskIds` 空、`modified=false`

- **emit 検証の方針**: `applyResumeTransitions` は emit しない設計（呼び出し側の責務）。代わりに戻り値 `abortedTaskIds` / `abortReasons` / `journals` / `revertedChildrenByParent` を検証することで、「呼び出し側が正しい順序で emit できる情報が揃っている」ことを担保する。これにより logger モック不要で副作用検証が成立する
- **完了条件**: 4 ケース全通過、R1 の emit と cascade が wrapper 経由で検証可能であることを示す
- **検証コマンド**: `cd skills/cmux-team/manager && bun test main.test.ts`

### S6. 既存テストへの影響確認 + grep 手順明文化（R3 反映）

- **対象ファイル**: 全 `*.test.ts`
- **完了条件**: `cd skills/cmux-team/manager && bun test` で既存テスト 0 件 regression
- **検証コマンド（実装前後で実行）**:
  ```bash
  cd skills/cmux-team/manager

  # 旧キーがテストから参照されていないか（実装前に 0 件であることを事前確認。実装後も 0 件維持）
  rg 'resume_fallback_to_ready' *.test.ts
  # → 0 件（本 PR 前後で変化なし）

  # 旧キーがランタイムコードから消えているか
  rg 'resume_fallback_to_ready' .
  # → 0 件（A015 artifact など docs は対象外だが skills/ 配下は 0 件）

  # 新キーが実装 + テストで追加されているか
  rg 'resume_marked_aborted' .
  # → 実装 (main.ts) + テスト (main.test.ts) で複数件

  # R1 で task_aborted emit が増えたか
  rg 'task_aborted' *.test.ts
  # → R2 で main.test.ts に新規 1 件以上の参照が増える (wrapper 戻り値検証を通じて間接検証)

  # reason=resume_* が他の reason と衝突していないか
  rg 'reason=resume_' .
  # → main.ts (S3 実装) と main.test.ts (S5 期待値) のみ

  # bun test 全体 green
  bun test
  ```

### S7. ドキュメント同期（R4 反映: 新 reason の波及）

- **対象**:
  - `skills/cmux-team/manager/task.ts:94` のコメント `resume_fallback_to_ready / conductor_taskid_reconciled` を `resume_marked_aborted / conductor_taskid_reconciled` に更新
  - `CLAUDE.md` §依存タスクの cascade（T241）の「5 経路」を **「6 経路」** に更新し、6 番目として `resume_marked_aborted (cmdStart 起動時 resume 不可検出)` を追記
  - `CLAUDE.md` §エラーリカバリ近辺に `resume_marked_aborted` の 3 reason (`no_worktree` / `no_session_id` / `no_task_run_id`) と、`task_aborted` 側の対応する reason (`resume_no_worktree` / `resume_no_session_id` / `resume_no_task_run_id`) を追記
  - `.team/artifacts/A015-fallback-design-policy.md` は歴史的記録なので **更新しない**（当時の議論の証跡として保持）
  - 運用 runbook / grep チートシートがあれば更新（本リポジトリに現状なし — docs/research/* は対象外）
- **完了条件**: `rg 'resume_fallback_to_ready' skills/` 0 件（コード + ランタイムコメント対象）、CLAUDE.md の cascade 経路数が 6 経路に更新済み
- **検証コマンド**: `rg 'resume_fallback_to_ready' skills/` で 0 件、`rg '6 経路' CLAUDE.md` で該当行ヒット

---

## 5. リスク

### 既存機能への影響

| 影響点 | 評価 |
|-------|------|
| `restartFromAborted` (main.ts:3314) | **OK** — aborted → ready 経路は既に存在し、T264 で増える aborted タスクも同ルートで復旧可能 |
| `cmdRestartTask` (main.ts:3376) | **OK** — `currentStatus !== "assigned" && currentStatus !== "aborted"` で守られており、aborted タスクを明示的に受け入れる |
| TUI dashboard | **要確認** — aborted タスクは既に表示されており追加対応不要と想定。`dashboard.tsx` で `aborted` 列が既存か簡単に grep 確認する |
| `team-archive` / `team-task list` | **OK** — 既存 aborted の扱いと同一 |
| `cascadeAbortToChildren` (task.ts:365) | **OK（v2 で変更）** — T241 cascade 5 経路目として T264 resume 経路を追加。cascade 関数自体は pure + 冪等なので副作用なし（D2 参照） |
| 既存 `task_aborted` 監査 (rg 等) | **OK（v2 で変更）** — T264 でも emit するため `rg 'task_aborted'` の網羅性が崩れない。reason 値で `resume_*` を識別（D11 参照） |
| `loadTasks` の二重ロード | **OK** — cmdStart 内で 2 回呼ぶことになるが (S3 新規 + 既存 1173)、いずれもディレクトリ走査のみで副作用なし |

### エッジケース

| ケース | 対応 |
|-------|------|
| `sessionId` 欠損 vs `worktreePath` 不在 の差分 | D3 で共通化（両方 aborted）。reason フィールドで区別 |
| 同時複数タスクが resume 不可 | すべて aborted 化され、それぞれ独立 journal を持つ。cascade も各親 → 各 ready 子独立に走る。順序依存なし |
| 単一ファイル形式 task.md | slug 抽出フォールバックで runs パスは「legacy flat task file」と明記 |
| task.md がない（`findTaskFile` が undefined） | `<unknown>` を埋めて aborted 化は継続（journal で原因追跡可能） |
| slot 超過 (`resume_overflow_to_ready`) 経路 | 本 PR では触らない。D1 参照 |
| 既に aborted なタスク | for ループ冒頭で `ts.status !== "assigned"` で弾かれるので無影響 |
| T254 unique violation で ready に戻された直後のタスク | violation 側は `taskStateModified = true` で既に ready 化しているため、本ループに入った時点で `ts.status !== "assigned"`（← 直前に上書きされた最新値を for 走査が見る）。問題なし |
| ready 子タスクが複数の親に依存し、一方の親だけ resume aborted | `cascadeAbortToChildren` が 1 親との関係のみ判定する仕様のため、子の `depends_on` に abort された親が含まれれば ready → draft。もう一方の親が assigned で生きていても draft に落とすのは既存 T241 の動作と整合 |

### テスト戦略

1. **ユニット**: `classifyResumeAction` / `buildResumeAbortJournal` の 8 ケース（S4）
2. **ふるまい**: `applyResumeTransitions` wrapper の 4 ケース（S5）— 特に (c) で cascade の副作用検証
3. **emit 検証**: wrapper 戻り値 (`abortedTaskIds`, `abortReasons`, `journals`, `revertedChildrenByParent`) を検証することで、呼び出し側が `task_aborted` / `resume_marked_aborted` / `child_reverted_to_draft` を正しく emit できる情報が揃っていることを担保（R2 反映）
4. **regression**: 既存 `bun test` で 全 describe ブロックが緑のまま（S6）
5. **手動検証**: task-state.json に assigned+worktree 不在な行を人工的に仕込んで `cmux-team start` を叩き、ログに `resume_marked_aborted` + `task_aborted reason=resume_no_worktree` + (ready 子がいれば) `child_reverted_to_draft` が順に出ることを確認

### 非リスク

- runs ディレクトリのファイル自体には触らない（journal でパスを指すだけ）
- worktree / branch の掃除もしない（実体がないため必要なし）。将来 `cmux-team restart-task` で再走させれば `restartFromAborted` が既存の残骸を冪等削除する

---

## 6. 既存型エラーの先読み

`bunx tsc --noEmit` ベースライン（2026-04-19 / worktree task-264-1776571981）:

```
conductor.ts(197,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3650,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
```

いずれも T264 の対象ファイルではない既存エラー。本 PR では触らず、
完了条件を「**新規エラーが増えない**」= エラー行数が 2 のまま とする。

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | `resume_overflow_to_ready` も aborted 化すべきか | **変更しない** | overflow は worktree/sessionId が生きているケースで、次サイクルで通常 resume 可能。成果物喪失リスクがない |
| D2 | aborted 化時に `cascadeAbortToChildren` を呼ぶか | **呼ぶ（v2 で改訂）** | ~~v1: 呼ばない~~ → **v2: 呼ぶ**。CLAUDE.md §依存タスクの cascade（T241）は既存 5 経路が全て cascade 呼び出しを行う不変条件を持つ。T264 を例外にすると不変条件を崩し、「起動時に限って親 aborted でも ready 子が残る」という予測不能な挙動が生まれる。cascade は冪等・純粋 (`task.ts:365-386`) で副作用なし、`task-state.json` には全タスク状態がロード済みで検出可能、scanTasks 事後整合に委ねる正当性はない。実装上も `loadTasks(PROJECT_ROOT)` を resume ループ前に 1 度呼ぶだけで済む |
| D3 | `no_session_id` も aborted にするか、ready のままにするか | **両方 aborted** | いずれも「実行途中の中断」で成果物が残存しうる。分岐を増やすより単一ポリシー（resume 不可 → aborted）で予測可能性を高める。reason フィールドで原因を区別 |
| D4 | journal の runs パスを絶対 / 相対どちらで記録するか | **相対（`.team/tasks/<slug>/runs/<taskRunId>/`）** | 別マシンでリポジトリを開いても意味が保てる。相対パスは PROJECT_ROOT からの相対として解釈される慣習 |
| D5 | `resume_marked_aborted` のログキー命名 | **`resume_marked_aborted`** を採用 | タスク仕様で提示された名前。`resume_` prefix で起動時 resume 経路であることが明示され、`marked_aborted` で state 遷移が明示される |
| D6 | journal の `[resume]` prefix | **採用** | `[restart]` と並ぶ既存慣習に整合。`unique_violation:` 形式とは「起動時の自動判定」と「外部操作由来」で区別 |
| D7 | pure function の切り出し先 | **`task.ts` に追記（v2 で改訂）** | ~~v1: `resume-classify.ts` 新規~~ → **v2: `task.ts`**。同種 helper `detectStartupUniqueViolations` が既に `task.ts:96-` に同居しているため、ファイル数を増やさない方が既存配置慣習と揃う。task.ts の責務（状態管理・分類関数）とも整合 |
| D8 | `findTaskFile` を呼ぶタイミング | **abort 経路のみ** | resume 経路には不要。普通は assigned タスクのほとんどが resume 可能なので全体コストはゼロに近い |
| D9 | `abortedAt` フィールドを埋めるか | **埋める** | 既存の `cmdAbortTask` / `cascadeAbortToChildren` との整合。`task_state.json` を読む側（TUI 等）が `abortedAt` の有無で表示を切り替えても影響しない |
| D10 | grep レベルで `resume_fallback_to_ready` が残ることの許容 | **A015 artifact などドキュメントは残す** | 歴史的議論の記録。コード・ランタイムコメントからのみ除去する |
| **D11** | **`task_aborted` を emit するか（v2 新規）** | **emit する（`resume_marked_aborted` と両方）** | 既存 aborted 化 4 経路 (user_clear / disconnect_timeout / assign_failed / cmdAbortTask) が全て `task_aborted` を emit している。観測性の不変条件 (`rg task_aborted` で全 aborted 網羅) を維持する。T264 固有情報は `resume_marked_aborted` で記録、一般的な aborted イベントは `task_aborted reason=resume_*` で記録、という二段構え。reason 値は `resume_no_worktree` / `resume_no_session_id` / `resume_no_task_run_id` の 3 種で既存 reason と名前空間分離 |
| **D12** | **emit 順序（v2 新規）** | **`resume_marked_aborted` → `task_aborted` → `child_reverted_to_draft` ×N** | T264 固有（詳細診断情報）→ 一般 aborted イベント → cascade 副作用 の順で、ログを追う人間が上から順に「何が起きたか」を自然言語的に読み取れる |

---

## 8. 参考: 関連コード箇所のクイックリファレンス

| 何 | どこ |
|---|------|
| resume 判定ロジック（変更対象） | `skills/cmux-team/manager/main.ts:702-718` |
| overflow 処理（変更しない） | `skills/cmux-team/manager/main.ts:737-743` |
| `findTaskFile` | `skills/cmux-team/manager/main.ts:209` |
| `cmdRestartTask`（aborted → ready 経路） | `skills/cmux-team/manager/main.ts:3376-3482` |
| `restartFromAborted`（残骸 worktree/branch 掃除） | `skills/cmux-team/manager/main.ts:3314-3374` |
| `cmdAbortTask`（aborted 化の既存パターン） | `skills/cmux-team/manager/main.ts:3178-3307` |
| `cascadeAbortToChildren`（cascade 本体） | `skills/cmux-team/manager/task.ts:365-386` |
| 既存 `task_aborted` emit 4 箇所 | `daemon.ts:2136 / 2314-2317 / 2685-2688`, `main.ts:3225 / 3266` |
| `detectStartupUniqueViolations`（pure helper 同居先） | `skills/cmux-team/manager/task.ts:96-` |
| `TaskState` 型定義 | `skills/cmux-team/manager/task.ts:32-46` |
| ログキー命名規約 | `CLAUDE.md` §ロギングポリシー |
| cascade 5 経路定義（→ 6 経路へ更新予定） | `CLAUDE.md` §依存タスクの cascade（T241） |
