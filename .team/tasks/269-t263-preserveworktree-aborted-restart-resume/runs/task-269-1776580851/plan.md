# T269 実装計画: preserveWorktree 経路でタスクを aborted に倒す

- 作成者: Planner (surface: task-269-1776580851)
- 作成日: 2026-04-19
- 対象タスク: T269

## 0. 前提と Base Branch

**重要:** 本タスクは T263 / T264 / T266 の修正を土台とするが、これらのコミット
(`445d511` / `0279fde` / `c5f5526`) はまだ `main` にマージされていない。現在の
worktree (`task-269-1776580851`) は `main` HEAD (`a705acd`) から分岐しており、
T263 の `preserveWorktree` / `handleConductorDone` 改修、T264 の
`applyResumeTransitions` / `classifyResumeAction`、T266 の Notification hook
集約が source 上に **存在しない**。

Implementer が最初にやること:

1. `git fetch` 後、T266 (`c5f5526`) までを取り込む。推奨手順:
   ```
   git fetch origin task-263-... task-264-... task-266-...
   git rebase c5f5526 task-269-1776580851/task
   ```
   もしくは `origin/main` にこれらがマージ済みであれば
   `git rebase origin/main` で十分。
2. rebase 衝突が起きた場合は Step 8 フォールバックに沿って `--success false`
   で CONDUCTOR_DONE を送信し、worktree を温存する。
3. rebase 後に `bunx tsc --noEmit` と `bun test` が green であることを確認
   してから本タスクの編集に入る。

---

## 1. 課題分析

### 1-1. 現状（T263 + T264 マージ後の状態）

`handleConductorDone(state, conductor, opts: { unresolved })` は
`opts.unresolved === true` のときに次の 2 点のみを行う（445d511
`skills/cmux-team/manager/daemon.ts:2583-2620` 付近）:

- `conductor_done_unresolved` を log
- `resetConductor(..., { preserveWorktree: true })` で ConductorState のみリセット

**task-state.json の status は `assigned` のまま残る。** worktree / branch /
runs ディレクトリは温存され、Conductor は idle に戻る。

### 1-2. T264 の resume 判定との不整合

`applyResumeTransitions` (0279fde `main.ts:260-335`) は daemon 起動時に
`status === "assigned"` のタスクを走査し、`classifyResumeAction` で
以下の 4 要素が揃っていれば resume 対象にする:

- `sessionId`
- `taskRunId`
- `worktreePath`
- `existsSync(worktreePath)`

preserveWorktree 経路で止まったタスクは **4 条件すべて満たす**ので、
意図せず resume plan に載ってしまう。

### 1-3. 実際の事故（T266）

`c5f5526` で T266 が merge されたあと、以下が再現した:

1. 14:04:49 T266 で `conductor_done_unresolved` が発火 → worktree 温存・
   task 状態 assigned 維持
2. 後の `cmux-team start` で daemon 再起動
3. `applyResumeTransitions` は T266 を **resume 可能**と分類
4. `planLayoutRestore` が idle C[192] にマッチング → `cmux-team resume 266`
   送信
5. T267 直後の `/clear` と重なり `user_clear` 検知 → `task_aborted`
   (reason=user_clear)

結果: 「人間の判断を待つべきタスク」が daemon 再起動のたびに勝手に abort
される。ログ上の reason が `user_clear` になるため事故の因果が追いにくい。

### 1-4. 根本原因

T263 は **Conductor 状態 (C[X]) は idle に戻すが task-state は触らない** と
いう中途半端な遷移モデルを導入した。T264 の resume 判定は `assigned + 4 要素
揃い` のみを見るので、この中途半端状態を「走らせ直せる」と誤判断する。

**対策の方向性:** Conductor が自力完遂できなかった事実を task-state に
反映し、`status = aborted` にする。ただし worktree / branch は温存し、
`cmux-team restart-task` で再投入できる状態を維持する（T263 の契約は
これで保たれる）。

### 1-5. 影響範囲

| コンポーネント | 影響 |
|---|---|
| `daemon.ts:handleConductorDone` | unresolved 分岐で task-state を `aborted` に遷移 + cascade 発火 |
| `applyResumeTransitions` | 変更不要。`status === "assigned"` 判定の前段で `aborted` は自然に除外される |
| `daemon.test.ts` T263 Case C (#9) | task-state=aborted 検証の expect 追加 |
| `daemon.test.ts` 統合テスト | 再起動 resume で T269 シナリオを入れる |
| `templates/ja/conductor-role.md` Step 8 | フォールバック後のタスク状態表記を修正 |
| `templates/en/conductor-role.md` Step 8 | ja 版と同期 |
| `CLAUDE.md` T263 関連節 | state 遷移の記述を更新 + `restart-task` 導線追記 |

---

## 2. 技術アプローチ

### 2-1. 選択: user_clear 経路のパターンを `handleConductorDone` 内に inline で再利用する

**理由:**

- `daemon.ts` 内には user_clear (SESSION_CLEAR 経路, `c5f5526` 2118-2152)・
  disconnect forced close (2480-2495)・その他計 3 〜 4 箇所で「task を aborted
  に倒す + cascade を発火する」同一パターンが既に inline で存在する
- `abort-task` CLI (`main.ts:3300-3365`) でも同じパターン
- ヘルパー関数は未抽出。本タスクで新規に抽出すると差分が広がり、T263 の
  挙動変更との分離性が悪化する
- user_clear 経路と同じ 5 ステップ（loadTaskState → status 判定 → ts 書換 →
  cascade → saveTaskState + log）を約 15 行コピペする方針が低リスク

**代替案 A: task.ts に `markTaskAborted(projectRoot, taskId, { reason, journal })`
ヘルパーを新規追加して 5 経路すべてを置換**

- メリット: DRY、将来の機能追加が楽
- 却下理由: 本タスクの受け入れ条件外。既存 4 経路のリファクタを巻き込むと
  レビュー範囲が膨らみ、T263 のバグ修正という本質から焦点がブレる。別タスク
  (T27x 相当) として分離推奨

**代替案 B: `applyResumeTransitions` 側を修正し preserveWorktree 由来の
「assigned + 4 要素揃い」を弾く**

- 却下理由: preserveWorktree と通常の assigned は task-state 上では区別
  できない（フラグが書かれていない）。区別のために task-state に
  `preservedAt` のような新フィールドを足すと破壊的変更になり Migration コスト
  が高い。task-state を aborted に倒すほうが既存 semantics に沿う

### 2-2. reason / journal キーの設計

`abort-task` は `reason=abort_task`、`SESSION_CLEAR` は `reason=user_clear`、
`applyResumeTransitions` は `reason=resume_no_worktree` 等。本経路は:

- ログ reason: `reason=judgment_pending`
- journal: `conductor_done_unresolved: {reason from CONDUCTOR_DONE} (worktree={path})`

`judgment_pending` は「Conductor が success=false を返し、task-state が
assigned のまま = 人間の判断を待つ状態」という意味。task.md の受け入れ条件
「journal / abortReason に `judgment_pending` 相当の識別子が入る」を満たす。

### 2-3. CONDUCTOR_DONE.reason の propagation

T263 の `conductor_done_unresolved` ログは
`reason=success_false_task_assigned` という固定文字列だが、CONDUCTOR_DONE
メッセージには Conductor 側が任意で付けた `message.reason`（例
`rebase_conflict`）が含まれる。本経路の journal にはこの
`message.reason` を埋めて因果追跡を容易にする。

```
journal = `conductor_done_unresolved: ${message.reason ?? "-"} (worktree=${conductor.worktreePath ?? "-"}) taskRunId=${conductor.taskRunId ?? "-"}`
```

`message.reason` を `handleConductorDone` に渡すため、`opts` 引数に
`reason?: string` を追加する（既存呼び出し元は `{ unresolved }` のみなので
互換性は維持）。

### 2-4. Conductor タスクメタのスナップショット

`resetConductor` が先に呼ばれると `conductor.worktreePath` が
`undefined` に戻るため、log / journal に worktree パスを埋めるには
**`resetConductor` の呼び出し前** に値を退避する必要がある。T263 実装
では resetConductor は `handleConductorDone` の末尾にあるので、
task-state 更新をその **直前** に差し込めば `conductor.worktreePath` は
まだ読める。順序を以下のように維持する:

```
1. collectResults(...)
2. taskId ガード
3. opts.unresolved 分岐:
   3a. conductor_done_unresolved ログ
   3b. [NEW] task-state を aborted に遷移 + cascade + ログ
4. その他分岐（task_completed 等）
5. resetConductor(..., { preserveWorktree: opts.unresolved })
```

### 2-5. cascade の波及

`cascadeAbortToChildren(ts, tasks, taskId)` は `ready` の子のみ `draft` に
戻す。T266 のように後続タスクが `ready` で待機していた場合、draft に戻る。
task.md §受け入れ条件 B で「副作用は設計通りだがテストで挙動確認する」と
明記されているので、統合テストでこの分岐も網羅する。

---

## 3. 変更対象

### 3-1. 変更ファイル

| パス | 変更概要 |
|---|---|
| `skills/cmux-team/manager/daemon.ts` | `handleConductorDone` の unresolved 分岐に task-state aborted 化 + cascade + ログを追加。signature に `reason?: string` を追加し、呼び出し側 (`CONDUCTOR_DONE` handler) から `message.reason` を伝搬 |
| `skills/cmux-team/manager/daemon.test.ts` | T263 Case C (`#9`) に `task_aborted reason=judgment_pending` と task-state status=aborted の expect を追加。新規 Case (T269 向け) として「再起動 resume で preserveWorktree 由来の task が applyResumeTransitions に含まれない」統合テストを追加。cascade 波及テストも 1 ケース追加 |
| `skills/cmux-team/templates/ja/conductor-role.md` | Step 8 フォールバック記述を「タスク状態: `assigned` のまま残ります」→「タスク状態: `aborted` になります（worktree / branch は温存）」に修正。再投入導線として `cmux-team restart-task --task-id <TASK_ID>` を明記 |
| `skills/cmux-team/templates/en/conductor-role.md` | ja 版と同期 |
| `CLAUDE.md` | 「T263 関連」節（存在しなければ「異常系」節の近く）を更新。state 遷移表を「closed/assigned/aborted」の 3 パターンに整理し、preserveWorktree 経路は **task=aborted + worktree=preserved** と明記。`cmux-team restart-task` が再投入の正式導線であることを追記 |

### 3-2. 新規作成するファイル

なし。

### 3-3. 削除するファイル

なし。

---

## 4. サブタスク分割

Implementer は上から順に実行する。各サブタスクは単独で完結するコミット
単位にすることを推奨（レビューしやすくするため）。

### S1. ベース更新

**目的:** T263 / T264 / T266 のコードを取り込んだ状態にする。

- 対象: worktree 全体
- 手順:
  1. `git fetch --all`
  2. `git rebase c5f5526`（もしくは `origin/main` に T266 まで merge 済みなら `origin/main`）
  3. 衝突があれば Step 8 フォールバックを使って abort 報告する（実装作業は中止）
- 完了条件:
  - `git log --oneline` に `c5f5526 T266` / `0279fde T264` / `445d511 T263` が含まれる
  - `bunx tsc --noEmit` が green
  - `bun test` が全 pass

### S2. `handleConductorDone` の unresolved 分岐に task-state 遷移を追加

**目的:** preserveWorktree 経路で task を `aborted` に倒す。

- 対象:
  - `skills/cmux-team/manager/daemon.ts` (function `handleConductorDone`, 2583 付近)
  - `skills/cmux-team/manager/daemon.ts` (caller `CONDUCTOR_DONE` handler, 1240 付近)
- 変更点:
  1. `handleConductorDone` の signature を `opts: { unresolved: boolean; reason?: string } = { unresolved: false }` に変更
  2. `CONDUCTOR_DONE` handler で `await handleConductorDone(state, conductor, { unresolved, reason: message.reason })` に差し替え
  3. unresolved 分岐に以下のブロックを追加（既存ログの直後、resetConductor の前）:
     ```ts
     try {
       const ts = await loadTaskState(state.projectRoot);
       const current = ts[taskId];
       if (current?.status !== "closed" && current?.status !== "aborted" && current?.status !== "deleted") {
         const journal = `conductor_done_unresolved: ${opts.reason ?? "-"} (worktree=${conductor.worktreePath ?? "-"}) taskRunId=${conductor.taskRunId ?? "-"}`;
         ts[taskId] = { ...current, status: "aborted", abortedAt: new Date().toISOString(), journal };
         const { tasks } = await loadTasks(state.projectRoot);
         const { revertedChildren } = cascadeAbortToChildren(ts, tasks, taskId);
         await saveTaskState(state.projectRoot, ts);
         await log("task_aborted", `task_id=${taskId} reason=judgment_pending journal_summary=${journal}`);
         for (const childId of revertedChildren) {
           await log("child_reverted_to_draft", `parent=${taskId} child=${childId} reason=parent_aborted`);
         }
         if (revertedChildren.length > 0) {
           notifyStateChanged("daemon.ts:handleConductorDone:unresolved-cascade");
         }
       } else {
         await log("conductor_done_unresolved_skip", `task_id=${taskId} reason=already_closed_or_aborted status=${current?.status}`);
       }
     } catch (e: any) {
       await log("error", `handleConductorDone judgment_pending update failed: task_id=${taskId} ${e.message}`);
     }
     ```
- メソッド制約:
  - 新規ヘルパー関数は作らない。既存 `loadTaskState` / `loadTasks` /
    `cascadeAbortToChildren` / `saveTaskState` / `log` /
    `notifyStateChanged` をそのまま呼ぶ
  - user_clear 経路 (SESSION_CLEAR handler 付近) と同じログキー順・
    同じ guard 条件（closed/aborted/deleted は skip）を使う。reason 文字列のみ
    `user_clear` → `judgment_pending` に差し替える
  - `conductor.worktreePath` は resetConductor の **前** に読むこと
- 完了条件:
  - `bunx tsc --noEmit` が green
  - 既存の T263 テスト (Case C) が fail しない範囲で pass
    （expect 追加は S3 で行うため、ここでは regression なしを確認するだけ）

### S3. T263 Case C テストに expect 追加 + T269 統合テスト追加

**目的:** 仕様変更を検証するテストを追加する。

- 対象: `skills/cmux-team/manager/daemon.test.ts`
- 変更点:
  1. `describe("T263: ...")` 内 Case C (`#9 case C:`) の末尾に以下を追加:
     ```ts
     const tsAfter = await loadTaskState(testDir);
     expect(tsAfter["263"]?.status).toBe("aborted");
     expect(tsAfter["263"]?.abortedAt).toBeDefined();
     expect(tsAfter["263"]?.journal).toContain("conductor_done_unresolved");
     expect(tsAfter["263"]?.journal).toContain("rebase_conflict");
     expect(log).toMatch(/task_aborted task_id=263 reason=judgment_pending/);
     ```
  2. Case D (`#10 case D`) / Case E (`#11 case E`) は regression guard として、
     `task_aborted reason=judgment_pending` が **出ない** expect を追加。
  3. 新 describe `T269: preserveWorktree 経路のタスクが restart 時に resume されない`
     として統合テストを追加:
     - setup: T263 Case C と同じく worktree 温存状態を作る →
       `handleMessage(CONDUCTOR_DONE success=false)` 実行 → task=aborted になる
     - action: `applyResumeTransitions(taskState, tasks, ...)` を直接呼ぶ
     - expect:
       - `result.resumePlan` に該当 taskId が含まれない
       - `result.abortedTaskIds` にも含まれない（既に aborted なので再度 abort
         対象にはならない）
       - `result.modified === false`
  4. 新 describe `T269: cascade 波及` として以下を追加:
     - setup: parent=269 が assigned、child=270 が depends_on:[269] / status=ready
     - action: handleMessage(CONDUCTOR_DONE success=false) for 269
     - expect:
       - `tsAfter["269"]?.status === "aborted"`
       - `tsAfter["270"]?.status === "draft"`
       - ログに `child_reverted_to_draft parent=269 child=270 reason=parent_aborted`
- メソッド制約:
  - `setupRealWorktree` ヘルパーを既存のまま再利用する
  - `applyResumeTransitions` import は `./main` から（既存の他テストが同じ pattern で import していれば合わせる）
  - `createTask` で depends_on を付ける際は既存テストの書き方に従う
- 完了条件: `bun test skills/cmux-team/manager/daemon.test.ts` 全 pass

### S4. `templates/ja/conductor-role.md` Step 8 修正

**目的:** Conductor にフォールバック後のタスク状態と再投入導線を正確に伝える。

- 対象: `skills/cmux-team/templates/ja/conductor-role.md` (Step 8 付近, 477 行あたり)
- 変更点:
  - 「- タスク状態: `assigned` のまま残ります。再投入するか中止する場合は
    `cmux-team abort-task --task-id <TASK_ID>` を実行してください。」を
  - 「- タスク状態: `aborted` に遷移します（worktree / branch は温存）。
    再投入するには `cmux-team restart-task --task-id <TASK_ID>` を実行して
    ください。中止したい場合はそのまま放置するか `cmux-team delete-task
    --task-id <TASK_ID>` で削除します。」に差し替える
- 完了条件: Step 8 のフォールバック説明が実装と矛盾しない

### S5. `templates/en/conductor-role.md` Step 8 修正

**目的:** S4 の英語版同期。

- 対象: `skills/cmux-team/templates/en/conductor-role.md` (同じ Step 8 位置)
- 変更点: S4 と同じ内容の英語訳（既存の翻訳トーンに揃える）
  - 例: "Task state: will transition to `aborted` (worktree / branch preserved).
    To re-run, execute `cmux-team restart-task --task-id <TASK_ID>`. To cancel,
    leave it aborted or run `cmux-team delete-task --task-id <TASK_ID>`."
- 完了条件: ja 版と意味的に同値

### S6. `CLAUDE.md` の T263 関連節を更新

**目的:** プロジェクト全体のドキュメントに最新 semantics を反映。

- 対象: `CLAUDE.md`
- 変更点:
  1. 「## エラーリカバリ」表の下か「## タスク属性」の近くに T263 挙動表を
     1 つ足すか、既存の T263 言及を更新する。state 遷移を以下の 3 パターンで明記:
     | CONDUCTOR_DONE success | task-state before | 挙動 |
     |---|---|---|
     | true | any | task=closed（Conductor 側で close-task 済み）, worktree=deleted, ConductorState=idle |
     | false | closed | task=closed, worktree=deleted, ConductorState=idle（late failure regression guard） |
     | false | assigned | **task=aborted (reason=judgment_pending)**, **worktree=preserved**, ConductorState=idle |
  2. 「preserveWorktree 経路でタスクが aborted になった場合、
     `cmux-team restart-task --task-id <X>` で再投入できる」と追記
  3. 「## 依存タスクの cascade（T241）」の cascade 経路を 6 → **7** に更新
     （T264 で 5→6 になっているのでこれを 6→7 に）。追加経路として
     `handleConductorDone` unresolved 分岐を記述
- 完了条件: CLAUDE.md に preserveWorktree 経路の state 遷移が明記されている

### S7. 最終確認

- `bunx tsc --noEmit` green
- `bun test` 全 pass
- 手動確認（可能なら）: `.team/` が綺麗な環境で Conductor に
  rebase-conflict を擬似的に起こさせ、task-state が aborted になり
  worktree が残り、`cmux-team restart-task` で再投入できることを確認

---

## 5. リスク

### 5-1. 既存機能への影響

| リスク | 緩和策 |
|---|---|
| T263 Case C の既存テストが expect 不足で silently pass しつつ、実態は fail する | S3 で明示的に `expect(tsAfter["263"]?.status).toBe("aborted")` を追加 |
| 既存の abort 経路 (user_clear / disconnect / applyResumeTransitions / abort-task) と、新経路が重複発火する | unresolved 分岐で呼ぶ前に `current?.status !== "closed" && !== "aborted" && !== "deleted"` を guard |
| `notifyStateChanged` を 2 重に emit する可能性 | cascade が空のときは emit しない条件分岐をそのまま踏襲（既存 user_clear 経路と同一） |
| CONDUCTOR_DONE.reason に機密が混入した場合 journal に漏出 | reason は Conductor が自由に付けるが、CLAUDE.md §ロギングポリシー §機密情報 でガイドされているため呼び出し側責務。本タスクでサニタイズはしない |

### 5-2. エッジケース

1. **taskId が undefined のとき**: 既存コード (2593-2597) で error log して早期
   return する。新経路は `else if (opts.unresolved)` 分岐なので taskId が
   存在する保証あり。ただし防御的に `taskId` を再確認する必要はなく、
   早期 return 済み
2. **conductor.worktreePath が undefined のとき**: resetConductor が呼ばれる
   前なのでほぼ無いが、`opts.reason ?? "-"` と同様 `??` で fallback 済み
3. **task-state に taskId が存在しないとき**: `current` が undefined。
   `current?.status !== ...` は `undefined !== "closed"` で `true` になるので
   `ts[taskId] = { ...undefined, status: "aborted", ... }` となり成立する。
   user_clear 経路と同挙動
4. **cascade で子の状態が 1 個以上変わったが saveTaskState が失敗した場合**:
   catch で error log。子の draft 化は in-memory のみで永続化されず、
   次 tick で再計算される（既存 user_clear 経路と同挙動）

### 5-3. テスト戦略

- 単体: daemon.test.ts の T263 Case C / D / E に expect 追加（regression guard
  強化）
- 統合: daemon.test.ts に T269 section を新設し、
  `handleMessage(CONDUCTOR_DONE)` → `applyResumeTransitions` の一連を
  通しで検証
- cascade: 同じ T269 section に親 abort → 子 draft cascade を 1 ケース
- 手動（任意）: 実環境で `cmux-team restart-task` が機能するかを確認

自動テストがない本リポジトリでは bun test の green が主な担保。E2E は
CLAUDE.md §テスト方法に従い手動で確認するが、本タスクは CLI 挙動を変えない
（daemon 内部ロジックのみ）のでスモークで十分。

---

## 6. 既存型エラーの先読み

S1 (rebase) の直後に `bunx tsc --noEmit` を実行し、編集予定ファイル
(`daemon.ts` / `daemon.test.ts` / `conductor-role.md` × 2 / `CLAUDE.md`) に
由来する既存型エラーを把握する。

**予想される既存型エラー:**

- `daemon.ts` 2583 付近の signature 変更で、`handleConductorDone` の既存
  呼び出し元が 1 箇所 (1240 付近)。3 引数目 `{ unresolved }` を
  `{ unresolved, reason: message.reason }` に差し替えるだけなので型不整合は
  起きない想定
- `daemon.test.ts` は bun:test / ConductorState 型を利用。`loadTaskState` の
  import 追加が必要な場合があるが、既存 Case C で同じ import が使われているので
  流用できる
- テンプレート (`.md`) と `CLAUDE.md` は tsc 対象外

**本タスクスコープで解消するもの:**

- `handleConductorDone` signature の `reason?: string` 追加に伴う caller 側の
  warning（`opts?.reason` 参照時の optional chain）

**後続分離するもの:**

- 事前の `bunx tsc --noEmit` で T266 由来の既存型エラーが出た場合（ありそう
  な候補: `notification_hook` 系の新 zod スキーマ）、本タスクのスコープ外
  として別タスクに切り出す。Implementer は `decision_log` に「scope 外として
  保留」と記録してから本タスクに着手する

---

## 7. Decision Log

### D1. `markTaskAborted` ヘルパーは作らない

- 選択: `daemon.ts` 内で user_clear 経路と同じ inline パターンを書く
- 理由:
  - 既存 4 経路（user_clear / disconnect / applyResumeTransitions / abort-task）
    が全部 inline で、同じ 5 ステップを書いている
  - 本タスクで 5 経路目を追加するついでにヘルパー抽出すると、レビュー差分が
    `handleConductorDone` 以外に波及し、T263 のバグ修正という本質から焦点が
    ブレる
  - ヘルパー抽出は別タスクで一括置換するのが合理的（将来 T27x として提案
    しても良い）
- 参考: `.team/memory` の「便利機能は best-effort、過剰なフォールバック不要」
  という方針とも整合

### D2. reason = `judgment_pending`

- 選択: log / journal の reason キーとして `judgment_pending` を採用
- 代替:
  - `conductor_done_unresolved` — 既存ログイベント名と衝突して grep しづらい
  - `success_false` — T263 ログの固定値だが意味が細かすぎる
  - `rebase_conflict` — specific すぎる（CONDUCTOR_DONE.reason は他にも値が
    入りうる）
- 採用理由: task.md §受け入れ条件 A で `judgment_pending` 相当の識別子と
  例示されている。意味的にも「Conductor が自力完遂できず人間判断待ち」と
  直感的にマッチ

### D3. CONDUCTOR_DONE.reason を journal に埋める

- 選択: `handleConductorDone` の `opts` に `reason?: string` を追加し、
  CONDUCTOR_DONE handler から `message.reason` を伝搬
- 代替: journal にプレースホルダー `-` のみ残す
- 採用理由: 事故後に「何故 unresolved になったか」を grep で追いたいので
  reason は重要。T266 事例でも `reason=rebase_conflict` のような値が
  期待される

### D4. resetConductor の前に task-state を更新する

- 選択: task-state 遷移 → resetConductor の順
- 代替: resetConductor → task-state 遷移
- 採用理由:
  - resetConductor は `conductor.worktreePath` を undefined に戻すので、
    journal に worktree path を埋めるなら **前** に実行する必要がある
  - 逆順だと state mutation が中途半端な順になり、冪等性の観点で後から
    見たときに読みにくい

### D5. 統合テストは `applyResumeTransitions` を直接呼ぶ

- 選択: cmdStart 全体の再現ではなく `applyResumeTransitions(taskState, tasks, { findTaskFile: () => undefined })`
- 代替: 実際に daemon を再起動してシミュレートする
- 採用理由:
  - cmdStart 全体は preflight / cmux / master spawn 等の副作用が重く、
    unit テストとして維持コストが高い
  - T264 の main.test.ts でも同じ pattern（wrapper 単体テスト）が採用
    されているので整合性が取れる

### D6. T263 Case D / E にも regression guard を追加

- 選択: Case D (success=true) / Case E (success=false + closed) でも
  `expect(log).not.toMatch(/task_aborted reason=judgment_pending/)` を追加
- 理由: 新 abort 経路が誤って発火しないことを保証する（T263 の既存 regression
  guard と同じ設計思想）

### D7. cascade 波及テストは別 describe に分ける

- 選択: `describe("T269: ...")` で cascade 専用の test を 1 ケース追加
- 理由: cascade は T241/T264 で既にテストされており、本タスクの関心は
  「新経路 → 既存 cascade が発火する」という integration 確認。既存 T263
  section に混ぜるとテストの関心が分散するので分離する

### D8. restart-task は既存コマンドの確認のみ

- 選択: `cmux-team restart-task` は触らない（タスク受け入れ条件より）
- 理由: task.md §受け入れ条件に「既存コマンドの確認のみ」と明記。挙動が
  aborted → ready への遷移を既にサポートしていることを確認する程度で足りる
  （S7 の手動確認）
