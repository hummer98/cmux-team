# T204 実装計画 — restart-task を aborted 状態からも使えるようにする

## 1. ゴールと非目標

### ゴール
- `cmux-team restart-task --task-id <id>` が **`aborted`** 状態のタスクを `ready` に戻して再キューイングできるようにする
- aborted 化時に残る残骸（worktree、ブランチ、task-state.json の resume 用フィールド）を確実に剥がしてから ready 化する
- 既存の `assigned` からの restart 動作は破壊しない
- 推奨 3（assigned 分岐でも resume フィールドを剥がす）の採否を判断・実行する

### 非目標
- `closed` / `deleted` / `ready` / `draft` 状態からの restart
- restart-task の新オプション追加
- ヘルプの英訳改善や examples 全面リライト
- worktree/branch 削除ロジックの大規模リファクタ

---

## 2. 現状の把握

### 2.1 `cmdRestartTask` 構造（`skills/cmux-team/manager/main.ts:2658-2747`）

```
1. taskId / journal / title 取得
2. taskState を読み、currentStatus !== "assigned" なら exit 1   ← (line 2675)
3. team.json から conductor を taskId で検索
4. conductor 不在分岐 (2690-2708):
     - status: ready, journal 更新, assignedAt 削除
     - log("task_restarted", ... no_conductor=true)
     - TASK_CREATED 通知
     - return
5. 通常分岐 (2710-2746):
     - cleanupAssignedTask(conductor)
     - taskState を ready, assignedAt 削除（resume フィールドは触らない）
     - log("task_restarted")
     - CONDUCTOR_DONE 通知
     - cmux send で conductor 再起動
     - TASK_CREATED 通知
```

**重要な観察**: 既存の 2 分岐とも `worktreePath` / `taskRunId` / `conductorSlot` / `sessionId` を **剥がしていない**。`assignTask` で上書きされるので実害はないが、restart 直後〜再 assign 前の窓では古い resume 情報を読むコードが存在しうる。

### 2.2 `cleanupAssignedTask`（`main.ts:2511-2553`）

- sub-agent surface を `closeSurface` で閉じる
- Conductor PID を `SIGTERM`
- `git worktree remove <path> --force`
- `git branch -D <taskRunId>/task`
- 全操作 try/catch で握り潰し（`cleanup_failed` ログのみ）→ 冪等

### 2.3 `resetConductor`（`skills/cmux-team/manager/conductor.ts:502-564`）

- paneId 経由で sub surface 一掃
- worktree 削除（`--force`）
- branch 削除（**`-d` ソフト**、ここだけ `cleanupAssignedTask` と差がある）
- ConductorState の taskId / taskRunId / worktreePath / agents / disconnectedAt をクリア
- sessionId は触らない（SessionStart hook で追従）

### 2.4 aborted 化される経路

| 経路 | 場所 | 残る情報 |
|------|------|---------|
| `cmdAbortTask` | `main.ts:2555-` | task-state は status=aborted + abortedAt + journal、resume 用フィールドは残置 |
| ユーザー手動 `/clear` | `daemon.ts:1118` | 同上（直後に `resetConductor` で worktree 物理削除） |
| `forceCloseDisconnectedConductor` 系 | `daemon.ts:1246, 1522` | 同上 |
| `assignTask` 失敗 (kind=task) | `daemon.ts:1243-1248` | resume 用フィールドは元から存在しない（assign 前なので） |

つまり aborted 状態のとき:
- **worktree は物理的に削除済みのことが多い**（resetConductor / cleanup 経由）
- ただし task-state.json には `worktreePath` / `taskRunId` / `conductorSlot` / `sessionId` が残骸として残っている
- ブランチも削除済みのことが多いが、削除失敗ログだけ残っているケースもある

→ aborted 分岐の責務は「**残ってるかもしれない物理残骸の冪等削除 + task-state の確実な剥がし**」。

### 2.5 `TaskState` 型（`task.ts:25-37`）

```typescript
interface TaskState {
  status: string;
  assignedAt?: string;
  closedAt?: string;
  abortedAt?: string;
  deletedAt?: string;
  journal?: string;
  worktreePath?: string;
  taskRunId?: string;
  conductorSlot?: string;
  sessionId?: string;
}
```

### 2.6 i18n.ts の help 文字列（修正対象）

- `i18n.ts:371` 英語: `restart a running task`（タイトル）
- `i18n.ts:385` 英語: `Only tasks in assigned (running) state can be restarted`
- `i18n.ts:532` 英語サマリー: `restart a running task`
- `i18n.ts:891` 日本語: `実行中タスクを再実行（ready に戻す）`
- `i18n.ts:906` 日本語: `assigned（実行中）のタスクのみ再実行できます`
- `i18n.ts:1054` 日本語サマリー: `実行中タスクを再実行`

---

## 3. 変更内容

### 3.1 `skills/cmux-team/manager/main.ts` — `cmdRestartTask` 改修

#### 3.1.1 状態チェック緩和（line 2675）

**before:**
```typescript
if (currentStatus !== "assigned") {
  console.error(`Error: task ${taskId} is not assigned (current status: ${currentStatus ?? "unknown"}). Only assigned tasks can be restarted.`);
  process.exit(1);
}
```

**after:**
```typescript
if (currentStatus !== "assigned" && currentStatus !== "aborted") {
  console.error(`Error: task ${taskId} is not assigned or aborted (current status: ${currentStatus ?? "unknown"}). Only assigned or aborted tasks can be restarted.`);
  process.exit(1);
}
```

#### 3.1.2 aborted 分岐の追加（state チェック直後、team.json 読込より前で早期 return）

```typescript
// === aborted 分岐 ===
// すでに Conductor は別タスクに再利用されたか idle のため team.json は引かない。
// task-state に残った worktreePath / taskRunId を頼りに残骸を冪等削除し、
// resume 用フィールドを剥がして ready に戻す。
if (currentStatus === "aborted") {
  const stale = taskState[taskId]!;
  await restartFromAborted(taskId, stale, title, journal, taskFile);
  return;
}
```

`restartFromAborted` の中身:

```typescript
async function restartFromAborted(
  taskId: string,
  stale: TaskState,
  title: string,
  journal: string,
  taskFile: string | null,
): Promise<void> {
  // 1. 物理残骸の冪等削除（cleanupAssignedTask とほぼ同じだが PID kill / sub-agent close は不要）
  if (stale.worktreePath && existsSync(stale.worktreePath)) {
    try {
      const { execFile: execFileCb } = require("child_process");
      const { promisify } = require("util");
      const execFileAsync = promisify(execFileCb);
      await execFileAsync(
        "git",
        ["worktree", "remove", stale.worktreePath, "--force"],
        { cwd: PROJECT_ROOT },
      );
    } catch (e: any) {
      await log(
        "cleanup_failed",
        `restart-task aborted worktree remove: path=${stale.worktreePath} ${formatExecError(e)}`,
      );
    }
  }
  if (stale.taskRunId) {
    const branch = `${stale.taskRunId}/task`;
    try {
      const { execFile: execFileCb } = require("child_process");
      const { promisify } = require("util");
      const execFileAsync = promisify(execFileCb);
      await execFileAsync("git", ["branch", "-D", branch], { cwd: PROJECT_ROOT });
    } catch (e: any) {
      await log(
        "cleanup_failed",
        `restart-task aborted branch delete: branch=${branch} ${formatExecError(e)}`,
      );
    }
  }

  // 2. task-state を ready に戻し、resume 用フィールド + abortedAt + assignedAt を剥がす
  const ts = await loadTaskState(PROJECT_ROOT);  // 念のため再読込（race を避ける）
  ts[taskId] = {
    ...ts[taskId],
    status: "ready",
    journal: `[restart] ${journal}`,
  };
  delete ts[taskId].assignedAt;
  delete ts[taskId].abortedAt;
  delete ts[taskId].worktreePath;
  delete ts[taskId].taskRunId;
  delete ts[taskId].conductorSlot;
  delete ts[taskId].sessionId;
  await saveTaskState(PROJECT_ROOT, ts);

  await log(
    "task_restarted",
    `task_id=${taskId}${title ? ` title=${title}` : ""} from=aborted journal_summary=${journal}`,
  );

  // 3. TASK_CREATED 通知（idle Conductor があれば daemon が拾って割り当てる）
  await postMessage({
    type: "TASK_CREATED",
    taskId,
    taskFile: taskFile ?? "",
    timestamp: new Date().toISOString(),
  });

  console.log(`OK restarted ${taskId} (was aborted, re-queued as ready)`);
}
```

**aborted 分岐で意図的にやらないこと**:
- Conductor 検索（taskId は剥がれているので team.json から見つからない）
- CONDUCTOR_DONE 通知（送り先がない）
- `cmux send` で Conductor 再起動（必要ない、Conductor は別タスク or idle）

#### 3.1.3 assigned 分岐 + conductor 不在分岐の resume フィールド剥がし（推奨 3）

**before（line 2691-2697 conductor 不在分岐）:**
```typescript
taskState[taskId] = {
  ...taskState[taskId],
  status: "ready",
  journal: `[restart] ${journal}`,
};
delete taskState[taskId].assignedAt;
```

**after:**
```typescript
taskState[taskId] = {
  ...taskState[taskId],
  status: "ready",
  journal: `[restart] ${journal}`,
};
delete taskState[taskId].assignedAt;
delete taskState[taskId].worktreePath;
delete taskState[taskId].taskRunId;
delete taskState[taskId].conductorSlot;
delete taskState[taskId].sessionId;
```

**before（line 2714-2720 assigned 通常分岐）:**
```typescript
taskState[taskId] = {
  ...taskState[taskId],
  status: "ready",
  journal: `[restart] ${journal}`,
};
delete taskState[taskId].assignedAt;
```

**after:** 上と同じ 4 行 delete を追加。

→ 結果的に **3 分岐すべてで** resume フィールドの剥がし方が一致する。

### 3.2 `skills/cmux-team/manager/i18n.ts` 修正

| 行 | before | after |
|----|--------|------|
| 371（en title） | `restart a running task (re-queues as ready)` | `restart an assigned or aborted task (re-queues as ready)` |
| 385（en notes） | `Only tasks in assigned (running) state can be restarted` | `Only tasks in assigned or aborted state can be restarted` |
| 386 | `Performs the same cleanup as abort-task (stops agents, removes worktree)` | （aborted の場合は agent 停止は不要なため）`Performs cleanup (stops agents and removes worktree for assigned; removes residual worktree/branch for aborted)` |
| 532（en summary） | `restart a running task` | `restart an assigned or aborted task` |
| 891（ja title） | `実行中タスクを再実行（ready に戻す）` | `assigned または aborted のタスクを再実行（ready に戻す）` |
| 906（ja notes） | `assigned（実行中）のタスクのみ再実行できます` | `assigned（実行中）または aborted のタスクを再実行できます` |
| 907 | `abort-task と同じクリーンアップを実行（エージェント停止、worktree 削除）` | `assigned からは abort-task と同じクリーンアップを実行。aborted からは worktree/branch の残骸のみ削除` |
| 1054（ja summary） | `実行中タスクを再実行` | `assigned または aborted のタスクを再実行` |

#### examples セクションへの追加

`i18n.ts:381-382` (en) と `i18n.ts:902-903` (ja) の examples に 1 行追加:

```
cmux-team restart-task --task-id 035   # works for both assigned and aborted
```

（行数追加は最小限にとどめ、現状の例を流用）

### 3.3 ヘルパー関数の新設は最小限

→ §4 参照。

---

## 4. ヘルパー関数の設計

### 4.1 採用: `restartFromAborted` をモジュール内ローカル関数として追加

`cmdRestartTask` から呼び出すローカル `async function`。aborted 分岐の処理を 1 関数にまとめて `cmdRestartTask` 本体の見通しを保つ。インターフェースは §3.1.2 の通り。

### 4.2 採用しない: worktree/branch 削除の共通化

候補:
- `removeWorktreeAndBranch(worktreePath, taskRunId, projectRoot, opts)` を `main.ts` か別モジュールに切り出す

理由（**今回のスコープでは見送り**）:
- `cleanupAssignedTask`（main.ts）と `resetConductor`（conductor.ts）はそれぞれ独立した責務（cleanup は kill + worktree、reset は pane 一掃 + worktree + state リセット）を持っており、削除ロジックだけ共通化すると呼び出し側に「削除関数を呼ぶ前後で何をやるか」が散逸する
- branch 削除の `-D` vs `-d` 差分（前者は強制、後者はマージ済みのみ）の統一は別タスクで議論すべき設計判断
- 今回追加する aborted 分岐は冪等削除を 2 回（worktree + branch）行うだけで、共通化のうま味が薄い
- `cleanupAssignedTask` を流用しない理由: aborted 状態には Conductor が紐付いていない（taskId が剥がれている）ため `conductor` 引数を作れない

→ 追加する aborted 分岐は `cleanupAssignedTask` の worktree/branch 削除部分を **コピペで写経**する（10 行 × 2 = 20 行程度）。共通化は「3 度目の重複が出た時」に再検討する。

### 4.3 採用しない: `clearResumeFields(state)` ヘルパー

`delete state.worktreePath; delete state.taskRunId; ...` の 4 行を関数化する案。3 箇所で使うので一見良さそうだが:
- 関数化しても 1 行（`clearResumeFields(taskState[taskId])`）で済むだけで読みやすさはほぼ同じ
- 削除する 4 フィールドは `TaskState` 型に密結合しており、フィールド追加時にどちらも編集することになる
- 関数を別ファイル（task.ts）に置くと import が増えてコストの方が大きい

→ **3 箇所に直接 `delete` 4 行を書く**。重複だが許容範囲。

---

## 5. 「推奨 3」の判断と理由

### 結論: **採用する（assigned 分岐 + conductor 不在分岐でも resume フィールドを剥がす）**

### 理由

1. **3 分岐の動作対称性**:
   - aborted 分岐で剥がす以上、assigned/conductor 不在分岐で剥がさないと「restart 後の task-state 形」が分岐ごとに異なる。後で task-state を読むコードが書かれた時に「なぜ aborted から restart したときだけフィールドが消えているのか」を都度把握する必要が生じる。

2. **T203 との親和性**:
   - T203 で sessionId は SessionStart hook 経由で動的に追従する設計に変更された。restart 時点で古い sessionId が残ると、resume 復旧経路や trace 紐付けで「どの sessionId が真か」が曖昧になる。restart の意味論は「過去の実行を完全に忘れて新しく始める」なので、sessionId / taskRunId / conductorSlot / worktreePath はすべて剥がすのが筋。

3. **コスト**:
   - 既存 2 分岐に `delete` 4 行を追加するだけ。差分は最小、テスト負荷もほぼゼロ。

4. **「assignTask が上書きするから実害ない」論への反論**:
   - 実害は確かに小さいが、`status: ready` で `worktreePath` / `taskRunId` が同居している状態は不変条件違反であり、TUI / status / trace 系コードが「ready なのに resume 情報を持つ」と誤認するリスクがゼロではない。
   - assignTask で上書きされるまでには tick 1 周期（最大 10 秒、`CMUX_TEAM_POLL_INTERVAL`）の窓があり、その間に他コードが読む可能性は理論上ある。

### この判断が及ぶ範囲

- **同タスク内で実装する**。別タスクに切らない。
- 影響範囲は `cmdRestartTask` 内のみで局所的。レビューも 1 箇所で済む。

---

## 6. テスト計画（手動）

E2E 自動テストはないので、手動で以下を確認する。

### 6.1 事前準備

```bash
# このリポジトリの worktree でビルド
cd /Users/yamamoto/git/cmux-team
# 別の検証用ディレクトリで cmux-team を起動
cd ~/git/scratch-cmux-team-t204 && cmux-team start
```

### 6.2 ケース表

| # | 起動状態 | 操作 | 期待結果 |
|---|---------|------|---------|
| A | assigned（既存動作） | `restart-task --task-id N` | conductor cleanup → ready → 自動再 assign。`worktreePath` / `taskRunId` / `conductorSlot` / `sessionId` が task-state から消える。|
| B | conductor 不在の assigned（既存動作） | 同上 | エラーなし、ready 化、TASK_CREATED で再 assign。フィールド剥がし確認。|
| C | aborted（worktree 物理残あり） | 任意の方法で worktree を残したまま task-state を aborted にして restart | worktree が `git worktree list` から消える、ブランチも消える、ready 化、自動再 assign。|
| D | aborted（worktree 削除済み） | abort-task で正常に aborted 化された後 restart | エラーなし（existsSync で skip）、ブランチ削除も skip、ready 化、自動再 assign。`cleanup_failed` ログが出ないこと。|
| E | aborted（taskRunId なし） | 古い形式の aborted task-state（手動で taskRunId を抜く）で restart | branch 削除 block を skip、ready 化、自動再 assign。例外なし。|
| F | ready / draft / closed / deleted | restart-task 実行 | 既存どおり exit 1、メッセージに「assigned or aborted」が含まれる。|
| G | i18n 確認 | `cmux-team restart-task --help` を en/ja 両方で実行 | help 文中に "assigned or aborted" / "assigned または aborted" が反映されている。|

### 6.3 確認コマンド

```bash
# ケース C 用 worktree の事前作成（手動 abort 後に worktree が残るような状況をシミュレート）
git worktree list
# task-state の確認
jq '.["NNN"]' .team/task-state.json
# 期待: restart 後は worktreePath / taskRunId / conductorSlot / sessionId / abortedAt が消えている
# manager.log のログ確認
tail -20 .team/logs/manager.log | grep task_restarted
# 期待: from=aborted が含まれる
```

### 6.4 ログ確認ポイント

- `task_restarted task_id=NNN title=... from=aborted journal_summary=...` が aborted 分岐で出力される
- `cleanup_failed` ログが出る場合、原因が把握可能（path / branch がメッセージに含まれる）

---

## 7. リスクと懸念

### 7.1 後方互換性

- **CLI インターフェース**: 既存の `restart-task --task-id ...` 呼び出しは挙動が拡張されるだけで、エラーになっていたケースが成功するようになる方向のみ。**破壊的変更なし**。
- **task-state.json スキーマ**: 既存フィールドの追加・削除はなし（resume フィールドを剥がす方向は assignTask が上書きするので副作用なし）。
- **ログイベント名**: `task_restarted` は既存。新規 detail に `from=aborted` を追加するのみ（`from=` キーは新設、grep する側は追加対応しなくても従来の検索が壊れない）。

### 7.2 冪等性

- aborted 分岐の worktree/branch 削除はすべて try/catch で握り潰し → 残骸が無くても問題なし
- restart を 2 回連続で叩いても、2 回目は ready 状態なのでエラーで弾かれる（既存ガード）→ 安全

### 7.3 race condition

- restart-task の実行中に daemon が同タスクを assign する race: ありえない（aborted のときは assignTask の対象外、再 assign は restart-task が ready 化 + TASK_CREATED 送信した後に始まる）
- `loadTaskState` を 2 回呼ぶ可能性（state チェック時 + restartFromAborted 内）について: race を避けるため restartFromAborted で再読込し最新値で書き戻す
- ただし worktreePath/taskRunId は state チェック時にキャプチャした `stale` から読むので、再読込との不整合は理論上起きうる。実用上はユーザー自身が連続実行しない限り問題ない

### 7.4 worktreePath が他タスクのものを指している危険性

- `worktreePath = .worktrees/task-NNN-TIMESTAMP`、`taskRunId` も同 ID を含むため衝突は事実上ない
- TIMESTAMP（秒精度）が偶然衝突するケースは天文学的に低い
- 万一同名衝突しても削除対象は「自分の worktreePath プロパティ」だけなので他タスクの worktree を誤削除しない

### 7.5 ブランチ削除の `-D`（強制）

- aborted から restart するときに「branch にまだ commit が残っている可能性」がある
- これは intentional: aborted 状態のブランチは「破棄してよい」というユーザー意思表示。`-D` で問題なし
- `cleanupAssignedTask` も `-D` を使っているので一貫性あり

### 7.6 ヘルプ文の英語/日本語の表現揺れ

- `restart a running task` を `restart an assigned or aborted task` に変えると「running」のニュアンスが消える
- 既存の表現を尊重しつつ最小変更にとどめる（§3.2 表参照）

### 7.7 ドキュメント影響

- `docs/spec/03-commands.md` に restart-task のセクションがあれば追従更新が必要かもしれない
- 本 plan のスコープ外だが、実装時に grep で確認することを実装者に申し送り
