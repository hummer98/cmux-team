# T263 実装計画: CONDUCTOR_DONE --success=false 時の worktree/branch を daemon が削除しないようにする

## 1. 課題分析

### 現状の問題点

Conductor が `CONDUCTOR_DONE --success false` を送信した際、daemon の `handleConductorDone`
(`daemon.ts:2577`) が無条件で `resetConductor` を呼び、`resetConductor`
(`conductor.ts:583-601`) が worktree と branch を削除する。

仕様 (`templates/ja/conductor-role.md:471-480`) では以下を保証する必要がある:

- **worktree は削除せず残す**（人間が手動で rebase / 再投入できるよう）
- タスク状態: `assigned` のまま残す
- `close-task` は呼ばない

しかし実装は success 値も task-state も読まず、常に全 cleanup を実行する。

### 根本原因

`handleConductorDone` の責務は「Conductor を idle に戻す」ことだが、`resetConductor` の cleanup
ロジック（siblings close / worktree remove / branch delete）が worktree-ownership を持つ
かどうかの判定を持たない。つまり「Conductor の再利用可能化」と「タスクの物理的後片付け」が
同一関数に融合している。

T262 の事例では以下の順で破綻した:

1. Conductor が Inspector GO 判定まで完走（plan/design/impl/inspection.md が全て残存）
2. 何らかの原因で `CONDUCTOR_DONE --success false` 発行（ログには `reason` なし）
3. `handleConductorDone` → `resetConductor` で worktree 削除 → branch は "not fully merged"
   で削除失敗
4. task-state の T262 は `assigned` のまま孤立
5. 後続の daemon auto-restart で `resume_fallback_to_ready` が発火し、
   既に完了済みのタスクが最初からやり直された

### 影響範囲

- 現在は **success=true / success=false を区別せず** 全経路で worktree / branch を削除
- 影響経路は `CONDUCTOR_DONE` 受信 → `handleConductorDone` → `resetConductor` の 1 本のみ
- その他の `resetConductor` 呼び出し箇所（`CONDUCTOR_CLEAR` / `disconnect_timeout` /
  `SESSION_CLEAR` の user_clear）は今回対象外（下記 1-bis 参照）

### 1-bis. `resetConductor` の他経路の挙動確認

本タスクで守りたい不変条件は「`CONDUCTOR_DONE --success=false` + `assigned` 維持 の場合のみ
worktree を温存する」こと。以下の既存経路は現状維持で問題ないことを改めて確認する。

| 経路 | 呼び出し箇所 | 本タスク後の挙動 |
|------|-------------|-----------------|
| `CONDUCTOR_CLEAR`（clear-conductor CLI） | `daemon.ts:1258` | 現状維持（`preserveWorktree` 省略 → false）。broken 明示クリアは worktree も掃除すべき |
| `disconnect_timeout`（broken 遷移） | `daemon.ts:2571` | 現状維持。Conductor が死んだ以上 worktree は人間がクリーンアップ不能 |
| `SESSION_CLEAR` の user_clear cascade | `daemon.ts:2022` | 現状維持。手動 `/clear` は明示的な破棄意図 |
| `handleConductorDone` success=true | `daemon.ts:2598`（本タスク改修対象） | 従来通り cleanup |
| `handleConductorDone` success=false + `assigned` | `daemon.ts:2598`（本タスク改修対象） | **新規: preserveWorktree=true** |

## 2. 技術アプローチ

### 採用案: `resetConductor` に `preserveWorktree` オプション追加 + `handleConductorDone` 側で判定

最小侵襲で仕様とのギャップを埋められる。

**利点:**
- `resetConductor` のインターフェースに 1 オプション追加するだけ
- 他の `resetConductor` 呼び出し元は引数無しで従来動作を維持
- 判定ロジック（success 値 + task-state）を `handleConductorDone` に局所化でき、責務の境界が明確
- conductor-fsm.ts を経由しなくても成立（T262 で FSM を導入したが merge 前であり、本タスクで依存する必要はない）

### 代替案: `handleConductorDone` を success で早期 return

```ts
if (!message.success) {
  conductor.status = "idle"; conductor.taskRunId = undefined; ...
  return; // resetConductor を呼ばない
}
```

**不採用理由:**
- 状態リセット処理が `resetConductor` とコピー重複する
- siblings（サブ surface）の close は success=false でも実行したい（Agent タブを残すとペイン
  が汚れる）→ 結局 `resetConductor` の一部は呼びたい → オプション化のほうが素直

### 代替案: conductor-fsm.ts に載せる

**不採用理由:**
- fsm は merge 前のブランチ上にのみ存在。導入は別タスクで並行レビューされている
- 本タスクは 1 pane のバグ修正で、抽象化より局所修正を優先

## 3. 変更対象

### 3.1 `skills/cmux-team/manager/conductor.ts`

#### 3.1.1 `resetConductor` のシグネチャ拡張（:541-546）

```ts
export async function resetConductor(
  conductor: ConductorState,
  projectRoot: string,
  workspace?: string,
  opts?: {
    targetStatus?: "idle" | "broken";
    reason?: string;
    preserveWorktree?: boolean;  // ← 追加
  },
): Promise<void>
```

#### 3.1.2 worktree / branch 削除ブロックをガード（:583-601）

```ts
// 2. worktree 削除（冪等: 既に削除済みでもエラーにしない）
if (!opts?.preserveWorktree) {
  if (conductor.worktreePath && existsSync(conductor.worktreePath)) {
    try {
      await execFile("git", ["worktree", "remove", conductor.worktreePath, "--force"], { cwd: projectRoot });
    } catch (e: any) {
      await log("cleanup_failed", `resetConductor worktree remove: path=${conductor.worktreePath} ${formatExecError(e)}`);
    }
    if (conductor.taskRunId) {
      const branch = `${conductor.taskRunId}/task`;
      try {
        await execFile("git", ["branch", "-d", branch], { cwd: projectRoot });
      } catch (e: any) {
        await log("cleanup_failed", `resetConductor branch delete: branch=${branch} ${formatExecError(e)}`);
      }
    }
  }
}
```

`ConductorState` のリセット（:603-619）は従来通り実行する。
つまり `conductor.taskRunId = undefined; conductor.worktreePath = undefined; ...` は呼ぶが、
**fs 上の worktree と git branch は残す**。これにより以下が成立する:

- 人間が当該 worktree に入って `git rebase` / `git merge` を完了できる
- その後 `cmux-team close-task` を手動実行すれば task-state が closed に遷移する
- Conductor 自身は idle に戻り、次の ready タスクを拾える

**注意:** sibling surface（Agent タブ）の close は `preserveWorktree` の影響を受けない
（現状維持）。サブ Agent は既に unresolved 扱いだろうが UI を汚すので閉じる。

#### 3.1.3 ログ行に preserve フラグを付与（:628-631）

```ts
const preserveSuffix = opts?.preserveWorktree ? " preserve_worktree=true" : "";
await log(
  targetStatus === "broken" ? "conductor_broken" : "conductor_reset",
  `${formatSurface(conductor.surface, "C")}${reasonSuffix}${aliveSuffix}${preserveSuffix}`,
);
```

→ 後から grep で「worktree を残した reset」を追跡できる。

### 3.2 `skills/cmux-team/manager/daemon.ts`

#### 3.2.1 `CONDUCTOR_DONE` handler に success + task-state 判定を追加（:1229-1234）

現状:

```ts
const isSuccess = message.success !== false;
await log(
  isSuccess ? "conductor_done_signal" : "conductor_error",
  `${formatSurface(message.surface, "C")}${!isSuccess && message.reason ? ` reason=${message.reason}` : ""}${message.exitCode != null ? ` exit_code=${message.exitCode}` : ""}`
);
await handleConductorDone(state, conductor);
```

変更後（判定とログ分岐を移送）:

```ts
const isSuccess = message.success !== false;
// success 値と task-state を combine して cleanup の種別を決定する（T263）
const ts = await loadTaskState(state.projectRoot);
const taskStatus = conductor.taskId ? ts[conductor.taskId]?.status : undefined;
const unresolved = !isSuccess && taskStatus === "assigned";

await log(
  isSuccess ? "conductor_done_signal" : "conductor_error",
  `${formatSurface(message.surface, "C")}${!isSuccess && message.reason ? ` reason=${message.reason}` : ""}${message.exitCode != null ? ` exit_code=${message.exitCode}` : ""}${taskStatus ? ` task_status=${taskStatus}` : ""}`
);
await handleConductorDone(state, conductor, { unresolved });
```

#### 3.2.2 `handleConductorDone` を拡張（:2577-2599）

```ts
async function handleConductorDone(
  state: DaemonState,
  conductor: ConductorState,
  opts: { unresolved: boolean } = { unresolved: false },
): Promise<void> {
  const { journalSummary } = await collectResults(conductor, state.projectRoot);
  const taskId = conductor.taskId;

  if (!taskId || taskId === "undefined") {
    await log(
      "error",
      `handleConductorDone: conductor.taskId is undefined ${formatSurface(conductor.surface, "C")}`,
    );
  } else if (opts.unresolved) {
    // T263: success=false + task-state=assigned の場合、task-state を closed に遷移させない。
    //       worktree / branch は温存し、人間が rebase / abort を選べるようにする。
    await log(
      "conductor_done_unresolved",
      `task_id=${taskId} ${formatSurface(conductor.surface, "C")}${
        conductor.taskTitle ? ` title=${conductor.taskTitle}` : ""
      } reason=success_false_task_assigned`,
    );
  } else {
    await log(
      "task_completed",
      `task_id=${taskId} ${formatSurface(conductor.surface, "C")}${
        conductor.taskTitle ? ` title=${conductor.taskTitle}` : ""
      }${journalSummary ? ` journal_summary=${journalSummary}` : ""}`,
    );
  }

  await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, {
    preserveWorktree: opts.unresolved,
  });
}
```

### 3.3 `skills/cmux-team/manager/conductor.test.ts` にテスト追加

`preserveWorktree: true` で呼び出すと worktree 削除が実行されないことを検証する 2 ケース:

- **case A**: `preserveWorktree: true` + worktree ディレクトリが存在 → `execFile("git", ["worktree", "remove", ...])` が **呼ばれない** こと（`execFile` を spy）
- **case B**: `preserveWorktree: true` でも ConductorState の taskRunId / worktreePath / status は従来通りリセットされること

### 3.4 `skills/cmux-team/manager/daemon.test.ts` にテスト追加

`handleConductorDone` 単体は export されていないため、`handleMessage` 経由で検証する。

- **case C**: `CONDUCTOR_DONE --success=false` + task-state が `assigned` のまま →
  `conductor_done_unresolved` ログが出ること + worktree remove の execFile が呼ばれないこと
- **case D**: `CONDUCTOR_DONE --success=true` → `task_completed` ログが出ること（従来動作維持の regression guard）
- **case E**: `CONDUCTOR_DONE --success=false` + task-state が `closed`（Conductor が明示的に close-task 済みの状態） → `task_completed` ではなく `conductor_done_unresolved` にもせず、**現状通り** full cleanup パスに入ること（下記 5. 挙動の表 に従う）

## 4. サブタスク分割

1. **T263-1**: `resetConductor` に `preserveWorktree` オプション追加
   - 対象: `skills/cmux-team/manager/conductor.ts:541-635`
   - 完了条件: シグネチャ拡張 + `if (!opts?.preserveWorktree)` ガード + ログに `preserve_worktree=true` 付与
2. **T263-2**: `handleConductorDone` を拡張し `opts.unresolved` を受け取る
   - 対象: `skills/cmux-team/manager/daemon.ts:2577-2599`
   - 完了条件: `unresolved=true` 時に `conductor_done_unresolved` ログ + `preserveWorktree: true` で resetConductor を呼ぶ
3. **T263-3**: `CONDUCTOR_DONE` handler で success + task-state を見て `unresolved` を決定
   - 対象: `skills/cmux-team/manager/daemon.ts:1229-1235`
   - 完了条件: `loadTaskState` を呼んで当該 taskId の status を取得 → `handleConductorDone(state, conductor, { unresolved })` に渡す
4. **T263-4**: `conductor.test.ts` にユニットテスト追加（case A / B）
   - 対象: `skills/cmux-team/manager/conductor.test.ts`
   - 完了条件: `preserveWorktree: true` で execFile が呼ばれないこと + ConductorState がリセットされることを検証
5. **T263-5**: `daemon.test.ts` に統合テスト追加（case C / D / E）
   - 対象: `skills/cmux-team/manager/daemon.test.ts`
   - 完了条件: `handleMessage` 経由で 3 パターンをシミュレートし、ログ分岐と execFile 呼び出し有無を検証
6. **T263-6**: `bun test` 全通過を確認、既存 test が回帰していないことを確認
   - 完了条件: `cd skills/cmux-team/manager && bun test` が green

実装順序: **1 → 2 → 3 → 4 → 5 → 6**（1 は他を block、4/5 は 1-3 に依存）

## 5. 挙動の表

| success | task-state | 期待挙動 | ログ | 実装判定 |
|---------|-----------|---------|------|---------|
| true  | closed | 従来通り full cleanup（worktree/branch 削除、Conductor idle 化） | `task_completed`   | `unresolved=false` |
| true  | assigned | 論理的には異常（Conductor が close-task 忘れ？）だが、success=true を信じて従来通り full cleanup。将来の分析用に `task_status=assigned` をログに残す | `task_completed task_status=assigned` | `unresolved=false` |
| false | closed | Conductor が先に close-task を呼んでから success=false を送信した稀なケース。task-state は既に決着済みなので full cleanup してよい。**(※1)** | `conductor_error task_status=closed` → `task_completed` | `unresolved=false` |
| false | assigned | **今回の対象ケース**。worktree / branch を保持し、task-state を `assigned` のまま残す | `conductor_error ...` → `conductor_done_unresolved task_id=<X>` | `unresolved=true` |
| false | aborted | Conductor がタスクを abort-task 済みなら worktree は掃除してよい（`--exclusive` abort 経路など） | `conductor_error ...` → `task_completed`（task は既に aborted 扱い） | `unresolved=false` |

**(※1)**: success=false + closed の組み合わせは「Conductor が rebase 失敗したが、失敗前に
何らかの理由で既に close-task を呼んでいた」異常だが、task-state が closed であれば既に
結着済みとみなし、worktree は削除する（Conductor の決着を尊重する）。

**判定式** (3.2.1):

```ts
const unresolved = !isSuccess && taskStatus === "assigned";
```

この式は「`assigned` のまま Conductor が白旗を上げたケースのみ保守側倒し」で pinpoint に効く。
他の状態（closed / aborted / deleted / missing）では従来動作を維持する。

## 6. 既存型エラーの先読み

`bunx tsc --noEmit` の事前確認（本タスク改修対象以外）:

```
conductor.ts(197,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3650,9): error TS2322: Type '"new_session"' is not assignable ...
```

- これらは**既存エラー**で本タスクと無関係。implementer は触らない
- 本タスクの新規コードはこのエラー件数を増やさないこと（追加エラー = 回帰）

## 7. リスク

### R1: success=false で close-task 済みのケース

Conductor が close-task を先に呼んでから `--success false` を送信する既知経路は現時点で
確認できていない（rebase 衝突経路では `close-task は呼ばない` と明記）。万が一存在しても、
本実装は task-state が `closed` なら従来通り cleanup するので安全側に倒れる。

### R2: `loadTaskState` が handleMessage 経路で増える

`CONDUCTOR_DONE` は頻度が低い（タスク完了時のみ）ため、1 回の JSON parse 増加は許容範囲。
T263 の改修で他経路に漏らさないよう、`daemon.ts:1229` で 1 回だけ呼んで handleConductorDone に
値を渡す形にする。

### R3: unresolved worktree の蓄積

worktree を保持すると、ユーザーが放置した場合にディスクに残り続ける。これは仕様通りの挙動
（人間の判断を待つ）であり、本タスクのスコープ外。将来 `cmux-team list-unresolved` のような
CLI を追加すれば追跡が容易になる（別タスクとして提案可）。

### R4: resume 経路との相互作用

daemon 再起動時の `layout-restore` が worktree の生存を前提に resume を試みる可能性がある。
ただし本タスクで worktree を残すのは `handleConductorDone --success=false` の経路のみで、
その直後に Conductor は `idle` に遷移して taskRunId/worktreePath を手放す（state 上は解除）。
task-state も `assigned` のまま残るが、resume 対象を引くのは
「conductor.taskId が生きていて task-state が assigned」の組だけなので、restore からは
自動的に外れる（R5 で確認）。

### R5: テスト戦略

- conductor.test.ts: `spyOn(execFile)` で cleanup 処理が **呼ばれない** ことを検証（黒箱的）
- daemon.test.ts: `handleMessage` に `CONDUCTOR_DONE --success=false` を入れて、ログ文字列と
  `conductor.status === "idle"` / `conductor.taskRunId === undefined` を検証
- 実 worktree を使わず、`existsSync` は `true` を返すスタブでよい（conductor.ts 内部のガードが
  短絡することを検証する）

## 8. Decision Log

1. **オプション名は `preserveWorktree`**（`keepWorktree` / `skipCleanup` 等と比較）
   - 「意図の明示」を重視。`preserveWorktree` は「残す」意図を最も自然に表現する

2. **判定ロジックは `handleConductorDone` の呼び出し元（handleMessage）ではなく handleConductorDone 内に置くべきか?**
   - 最終的に `opts.unresolved: boolean` を呼び出し元で決めて渡す形にした
   - 理由: `loadTaskState` は呼び出し元で既に別目的で読む可能性があり、渡したほうが柔軟
   - 副次的に `handleConductorDone` が `state` 以外に外部 I/O を増やさないので純度が保てる

3. **ログ名は `conductor_done_unresolved`**
   - タスク指示 4 で明示された命名
   - ユーザーが `grep conductor_done_unresolved .team/logs/manager.log` で unresolved タスクを
     一覧できるようにする

4. **conductor-fsm.ts 経由にしない**
   - タスク指示「最小侵襲を優先」「fsm は merge 前なので本タスクでは依存しない」に従う
   - fsm マージ後に別タスクで統合する余地は残す

5. **`success=true + task-state=assigned` の扱い**
   - 挙動表では従来通り full cleanup としたが、`task_completed` ログに `task_status=assigned`
     を付与することで将来の分析用に痕跡を残す（追加コスト 1 行）

6. **aborted / deleted / missing task-state の扱い**
   - 判定式 `!isSuccess && taskStatus === "assigned"` により自動的に従来動作に落ちる
   - 過剰にケースを網羅せず、仕様で明示された「assigned のまま残す」のみに pinpoint で介入する

---

**実装担当者へ**: サブタスク 1-3 は依存関係に従って順次実装、4-5 のテストは並行実装可能。
`bun test` 実行時に `conductor.test.ts` と `daemon.test.ts` の既存テストが壊れていないかを
必ず確認すること。
