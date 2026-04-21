# T263 実装計画: CONDUCTOR_DONE --success=false 時の worktree/branch 保持

## 1. 課題分析

### 1.1 T262 での事象（再構成）

1. Conductor は Inspector GO 判定まで完了し、`.team/output/task-262-1776560393/` 配下に
   `plan.md` / `design.md` / `impl-summary.md` / `inspection.md` が全て残存していた。
2. 何らかの理由で Conductor が `cmux-team send CONDUCTOR_DONE --success false` を送信
   （`manager.log` では `conductor_error C[192]` が記録、reason 欄は空）。
3. daemon の `handleConductorDone` が `resetConductor` を呼び、
   `conductor.ts:600-618` の worktree remove + branch delete を**無条件に**実行。
4. worktree は削除成功、branch は `not fully merged` で削除失敗（merge 前だった）。
5. `task-state.json` 上の T262 は `assigned` のまま取り残される
   （`handleConductorDone` は close-task を呼ばない設計）。
6. その後 daemon.ts 編集による auto-restart + `resume_fallback_to_ready` が発火し、
   T262 は「最初から」やり直し。既に GO 判定まで到達していた成果物は破棄された。

### 1.2 仕様と実装の矛盾ポイント

| 観点 | 仕様（conductor-role.md Step 9.5） | 現状実装 |
|---|---|---|
| rebase 衝突時 | worktree は削除せず残す（人間が再投入・中止を判断） | `resetConductor` が無条件削除 |
| rebase 衝突時 | タスク状態 `assigned` のまま | 実装は一致（close-task は呼ばない） |
| rebase 衝突時 | `CONDUCTOR_DONE --success false` で通知 | 実装は一致 |

**乖離の本質:** `CONDUCTOR_DONE` の受信側（daemon）は **success 値を見ず**、
`task-state` も見ずに `resetConductor` を呼ぶ。結果として仕様が要求する
「worktree 温存 + 人間判断待ち」状態に達する経路が物理的に存在しない。

### 1.3 なぜ success=false で worktree を消してはならないか

- 判断必要レポートを受け取った人間が `cd <worktree>` して手動 rebase/diff したい
- branch が `not fully merged` エラーで残っても、worktree が無いと `git checkout` 経由の
  調査が難しい（detached HEAD で覗く事になる）
- success=false の documented な経路は今のところ rebase 衝突のみ。将来的に他の
  「人間判断が必要なケース」でも同じ扱い（worktree 温存）が望ましい

## 2. 技術アプローチ

### 2.1 設計方針

**最小侵襲**。以下を満たすこと:

- `resetConductor` の既存呼び出し元の挙動は変えない（CONDUCTOR_CLEAR /
  `forceCloseDisconnectedConductor` / user_clear SESSION_CLEAR 経路は従来通り）
- 新しい分岐は `handleConductorDone` の 1 箇所だけに入れる
- ConductorState のリセット（status=idle, taskRunId=undefined 等）は `preserveWorktree`
  であっても**必ず行う**。さもないと次のタスク割り当てができなくなる

### 2.2 `resetConductor` シグネチャ拡張

```ts
export async function resetConductor(
  conductor: ConductorState,
  projectRoot: string,
  workspace?: string,
  opts?: {
    targetStatus?: "idle" | "broken";
    reason?: string;
    preserveWorktree?: boolean;  // ★新設
  },
): Promise<void>
```

`conductor.ts:600-618` の以下ブロックを `if (!opts?.preserveWorktree) { ... }` で囲む:

```ts
// 2. worktree 削除（冪等: 既に削除済みでもエラーにしない）
if (conductor.worktreePath && existsSync(conductor.worktreePath)) {
  try { await execFile("git", ["worktree", "remove", ...]) } catch ...
  if (conductor.taskRunId) {
    const branch = `${conductor.taskRunId}/task`;
    try { await execFile("git", ["branch", "-d", branch], ...) } catch ...
  }
}
```

- ConductorState リセット（line 620-645）は preserveWorktree と**無関係に実行**する。
  `conductor.worktreePath` / `conductor.taskRunId` / `conductor.taskId` / `agents`
  などは全て undefined / `[]` に落ちる。
- ログは従来通り `conductor_reset` / `conductor_broken` が発行される。`preserveWorktree`
  が true の場合は `reasonSuffix` の手前に ` worktree_preserved=true` 等の
  補助フィールドを追加する（grep しやすくするため）。

### 2.3 `handleConductorDone` の分岐ロジック

`daemon.ts:2715-2737` を以下のように書き換える:

```ts
async function handleConductorDone(
  state: DaemonState,
  conductor: ConductorState,
  opts?: { success?: boolean; reason?: string },  // ★引数追加
): Promise<void> {
  const { journalSummary } = await collectResults(conductor, state.projectRoot);
  const taskId = conductor.taskId;
  const success = opts?.success !== false;

  // 現在の task-state を読む
  const taskState = await loadTaskState(state.projectRoot);
  const currentStatus = taskId ? taskState[taskId]?.status : undefined;
  const unresolved =
    success === false &&
    currentStatus !== "closed" &&
    currentStatus !== "aborted" &&
    currentStatus !== "deleted";

  if (taskId && taskId !== "undefined") {
    if (unresolved) {
      await log(
        "conductor_done_unresolved",
        `task_id=${taskId} ${formatSurface(conductor.surface, "C")}` +
        ` task_state=${currentStatus ?? "missing"}` +
        ` reason=${opts?.reason ?? "-"}` +
        ` worktreePath=${conductor.worktreePath ?? "-"}` +
        (conductor.taskTitle ? ` title=${conductor.taskTitle}` : "") +
        (journalSummary ? ` journal_summary=${journalSummary}` : "")
      );
    } else {
      await log(
        "task_completed",
        `task_id=${taskId} ${formatSurface(conductor.surface, "C")}` +
        (conductor.taskTitle ? ` title=${conductor.taskTitle}` : "") +
        (journalSummary ? ` journal_summary=${journalSummary}` : "")
      );
    }
  } else {
    await log("error", `handleConductorDone: conductor.taskId is undefined ${formatSurface(conductor.surface, "C")}`);
  }

  await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, {
    preserveWorktree: unresolved,
  });
}
```

- `CONDUCTOR_DONE` ハンドラ（`daemon.ts:1310`）の呼び出しを
  `await handleConductorDone(state, conductor, { success: message.success, reason: message.reason });`
  に変更する
- success 判定は呼び出し側（handler）で `message.success !== false` を再計算せず、
  `message.success` を素のまま渡して handleConductorDone 内で判断（コードの重複を避けるため）

### 2.4 挙動判定テーブル

| # | message.success | task-state 現在値 | preserveWorktree | ログイベント | 期待動作 |
|---|---|---|---|---|---|
| 1 | true | closed | false | `task_completed` | 従来通り。Conductor の明示的完結 |
| 2 | true | aborted | false | `task_completed` | 従来通り。Conductor 側で abort-task 経由で確定済み |
| 3 | true | deleted | false | `task_completed` | 従来通り。極端 race ケース（途中で delete された） |
| 4 | true | assigned | false | `task_completed` | **想定外**だが従来動作維持（Conductor は close-task 呼び忘れ？ 診断用ログは `task_completed` のまま） |
| 5 | true | missing / undefined | false | `error` / `task_completed` | taskId 欠落は `error` ログ。task-state に entry 無しの場合は従来通り `task_completed` |
| 6 | false | closed | false | `task_completed` | Conductor が先に close-task → 後で success=false 送信した変則ケース。既に完結しているので worktree は消して良い |
| 7 | false | aborted | false | `task_completed` | 同上。abort-task 経由で既に確定済み |
| 8 | false | deleted | false | `task_completed` | 同上 |
| 9 | false | **assigned** | **true** | **`conductor_done_unresolved`** | **本タスクの本命ケース**（rebase 衝突等）。worktree/branch を温存し、人間判断に委ねる |
| 10 | false | missing | false | `conductor_done_unresolved` | taskId はあるが task-state entry がない race。念のため unresolved 扱いで温存 |

**補足:**
- ケース 4 (success=true && assigned) は現状バグの可能性があるが、本タスクのスコープ外。
  現状の挙動（full cleanup）を維持する。将来的に `close-task` を daemon が自動呼び出し
  するかは別タスクで検討。
- ケース 10（success=false && task-state entry なし）は保守的に unresolved 扱いに倒す
  （worktree を残しても悪影響はない）。

### 2.5 ログフォーマット規約

`conductor_done_unresolved` ログには grep で追跡可能な情報を盛り込む:

```
[TS] conductor_done_unresolved task_id=262 C[192] task_state=assigned reason=- worktreePath=/Users/.../.worktrees/task-262-1776560393 title=...
```

- `task_state=<現在値>` — 現 task-state（`assigned` / `missing` 等）
- `reason=<message.reason ?? "-">` — Conductor 側が明示した reason（なければ `-`）
- `worktreePath=<path>` — 温存された worktree の絶対パス（人間がそのまま `cd` できる）

これで `grep conductor_done_unresolved .team/logs/manager.log` だけで「要人間判断」
なタスクが列挙できる。

## 3. 変更対象ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/conductor.ts` | `resetConductor` に `preserveWorktree` オプション追加、worktree/branch 削除を条件分岐で囲む、ログに `worktree_preserved=true` を追加 |
| `skills/cmux-team/manager/daemon.ts` | `handleConductorDone` 引数追加 + task-state 読込み分岐 + `conductor_done_unresolved` ログ発行。`CONDUCTOR_DONE` handler (line 1310) の呼び出しを更新 |
| `skills/cmux-team/manager/conductor.test.ts` | `preserveWorktree=true` 時のテスト追加（worktree が残ること、branch も残ること、ConductorState はリセットされること） |
| `skills/cmux-team/manager/daemon.test.ts` | `handleConductorDone` 挙動テーブルのテストケース追加（必須は #9、余裕があれば #1/#6/#10） |
| `docs/spec/` | **変更しない**（実装詳細の変更のみ、仕様自体は conductor-role.md Step 9.5 の記述通り）。ただし 06-implementation-tasks.md に T263 を追記する場合は別途判断 |

## 4. サブタスク分割

### ST1: `resetConductor` への `preserveWorktree` オプション追加

**対象ファイル:** `skills/cmux-team/manager/conductor.ts`

**変更内容:**
- line 562 の `opts?: { ... }` に `preserveWorktree?: boolean` を追加
- line 600-618 の worktree/branch 削除ブロック全体を `if (!opts?.preserveWorktree) { ... }` で囲む
- line 652-655 のログ発行で、`preserveWorktree` が true の場合に ` worktree_preserved=true` を suffix に追加

**完了条件:**
- `preserveWorktree=true` で呼ぶと worktree / branch の execFile が 1 回も呼ばれない
- `preserveWorktree=true` でも `conductor.status` / `conductor.taskRunId` / `conductor.agents` はリセットされる
- `preserveWorktree` 未指定（既存呼び出し元）の挙動が完全に同一

**検証コマンド:**
```bash
cd skills/cmux-team/manager && bun test conductor.test.ts
```

### ST2: `conductor.test.ts` に `preserveWorktree` テストケース追加

**対象ファイル:** `skills/cmux-team/manager/conductor.test.ts`

**変更内容:**
describe ブロック `"resetConductor preserveWorktree オプション (T263)"` を追加:

- Case A: `preserveWorktree=true` → worktree ディレクトリが fs 上に残る、
  git branch も残る、ConductorState は完全リセット
- Case B: `preserveWorktree=false`（明示指定）→ 従来通り worktree/branch 削除
- Case C: `preserveWorktree` 未指定 → 従来通り worktree/branch 削除（後方互換）
- Case D: `preserveWorktree=true` && `targetStatus="broken"` の組み合わせも動く
  （保険テスト。disconnect_timeout → success=false は起こらないが、API 契約としては
  許容しておく）

**完了条件:** 4 ケースが bun test で pass

**検証コマンド:**
```bash
cd skills/cmux-team/manager && bun test conductor.test.ts -t "preserveWorktree"
```

### ST3: `handleConductorDone` の task-state 分岐ロジック実装

**対象ファイル:** `skills/cmux-team/manager/daemon.ts`

**変更内容:**
- `handleConductorDone` のシグネチャに `opts?: { success?: boolean; reason?: string }` を追加
- 関数冒頭で `loadTaskState` を呼び、`taskId` から現 status を取得
- `unresolved = (success === false) && (currentStatus !== "closed" && !== "aborted" && !== "deleted")` を算出
- `unresolved` の真偽で `conductor_done_unresolved` / `task_completed` のログを切り替え
- `resetConductor` の呼び出しに `{ preserveWorktree: unresolved }` を渡す
- CONDUCTOR_DONE handler (daemon.ts:1310) の呼び出しを
  `await handleConductorDone(state, conductor, { success: message.success, reason: message.reason });` に変更

**完了条件:**
- 既存の task_completed 系テスト（もしあれば）が破綻しない
- success=false + assigned の組み合わせで conductor_done_unresolved ログが出力される
- success=false + closed の組み合わせでは worktree が削除される

**検証コマンド:**
```bash
cd skills/cmux-team/manager && bun test daemon.test.ts
```

### ST4: `daemon.test.ts` に挙動テーブルのケーステスト追加

**対象ファイル:** `skills/cmux-team/manager/daemon.test.ts`

**変更内容:**
describe ブロック `"handleConductorDone success/task-state 分岐 (T263)"` を追加:

- Case #9 (success=false && assigned): `conductor_done_unresolved` ログ発行、
  `resetConductor` が `preserveWorktree=true` で呼ばれる（spy で確認）
- Case #1 (success=true && closed): 従来通り `task_completed`、worktree 削除
- Case #6 (success=false && closed): `task_completed`、worktree 削除（保守側倒しが
  ケース 9 のみに限定されていることを示す）
- Case #10 (success=false && task-state entry なし): `conductor_done_unresolved` で
  unresolved 扱い

**ログアサーション戦略:**
- `manager.log` のファイルを temp dir に逃がしてから tail して grep する、または
  `logger.ts` を mock する（既存 daemon.test.ts の手法に合わせる）

**完了条件:** 4 ケース pass + 既存テスト全通過

**検証コマンド:**
```bash
cd skills/cmux-team/manager && bun test daemon.test.ts -t "T263"
cd skills/cmux-team/manager && bun test  # 全通過確認
```

### ST5: 動作確認（E2E — 任意）

**対象:** 手動テスト

**手順（mock シナリオ）:**
1. worktree 内で `cmux-team start` して daemon 起動
2. ダミータスクを `ready` で投入 → Conductor が pickup
3. Conductor pane 内で `cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success false --reason "test"` を手動送信
4. `cat .team/logs/manager.log | grep -E "conductor_done_unresolved|task_completed"` で `conductor_done_unresolved` が記録されていることを確認
5. `git worktree list` で worktree が残っていることを確認
6. `git branch | grep task-` で branch が残っていることを確認
7. `cmux-team abort-task --task-id <ID>` で確定 → task-state が aborted になる

**完了条件:** 1〜7 が期待通り

**備考:** E2E は自動化しない（Manager 全体のテスト手段がないため）。
実装後のサニティチェックとして位置づける。

## 5. 挙動表（再掲・決定版）

| # | success | task-state | preserveWorktree | ログイベント | close-task 発動 | worktree |
|---|---|---|---|---|---|---|
| 1 | true | closed   | false | task_completed             | 事前済み      | 削除 |
| 2 | true | aborted  | false | task_completed             | n/a           | 削除 |
| 3 | true | deleted  | false | task_completed             | n/a           | 削除 |
| 4 | true | assigned | false | task_completed             | 発動されない ※| 削除 |
| 5 | true | missing  | false | error or task_completed    | n/a           | 削除 |
| 6 | false| closed   | false | task_completed             | 事前済み      | 削除 |
| 7 | false| aborted  | false | task_completed             | n/a           | 削除 |
| 8 | false| deleted  | false | task_completed             | n/a           | 削除 |
| 9 | **false**| **assigned**| **true** | **conductor_done_unresolved** | **発動されない**（人間判断待ち）| **温存** |
| 10| false| missing  | true  | conductor_done_unresolved  | n/a           | 温存 |

※ ケース 4 は「Conductor が success=true で送ったのに close-task を呼び忘れた」状況。
現状の挙動（worktree 削除 + task-state は assigned のまま）を維持。将来的な改善は
別タスクとする。

## 6. リスク

### R1: 既存 `resetConductor` 呼び出し元への影響

**影響範囲:** 6 箇所（`handleConductorDone` / CONDUCTOR_CLEAR / user_clear
SESSION_CLEAR / `forceCloseDisconnectedConductor` 他）

**対策:** `preserveWorktree` のデフォルトは `false`（= 従来挙動）。変更するのは
`handleConductorDone` の 1 呼び出しのみ。他の呼び出しは引数追加なしでそのまま動く。

### R2: `preserveWorktree=true` でも ConductorState はリセットされる

worktree を温存すると「もう一度 pickup されて同じタスクに assign される」と
誤解するリスクがあるが、

- `conductor.taskRunId` / `conductor.taskId` は undefined に戻るため、
  Conductor は idle 状態になり次の `ready` タスクを受け付けられる
- task-state 側は `assigned` のまま取り残されるので、`countOpenTasks` 上は
  open カウントされ続ける（UI/ログで後追いしやすい副作用）
- task-state を無理に `closed` / `aborted` に倒すことは**しない**（仕様通り、
  人間判断に委ねる）

### R3: worktree/branch の GC タイミング

温存された worktree は `git worktree list` に `[task-<id>/task]` として残り、
人間が `abort-task` で確定する or 手動で `git worktree remove --force` + 
`git branch -D` するまで削除されない。

**緩和策:**
- `cmux-team status` / `team.json` / TUI に「温存 worktree」表示を追加する案は
  本タスク外（別タスクで追加する）
- 当面は `conductor_done_unresolved` ログを grep することで列挙可能

### R4: `loadTaskState` の読み込み失敗

`loadTaskState` が parse 失敗で空オブジェクトを返す場合、`currentStatus` が
undefined になり、ケース #10 ルート（worktree 温存）に入る。保守側倒しなので
安全（誤って worktree を消すより温存する方が被害が小さい）。

### R5: success=true に対する互換性

Conductor 側の標準動線（Step 11 で close-task → CONDUCTOR_DONE --success true）
は何も変わらない。`task_completed` ログもフォーマット同一。

### R6: 冪等性

`resetConductor` は再度呼ばれても worktree 不在時は no-op。`preserveWorktree=true`
で温存された worktree が**後から** `preserveWorktree=false` で呼ばれるケースは
想定されない（`handleConductorDone` で完結するため）。ただし手動で
`cmux-team clear-conductor` を叩いた場合も worktree は削除されない（`CONDUCTOR_CLEAR`
handler は `preserveWorktree` を指定しないため）。人間が手動で
`git worktree remove` する運用想定。

### R7: `conductor-fsm.ts`（T262 で導入済み）との関係

`conductor-fsm.ts` は純粋関数化のためのブランチ上産物であり、本タスクの修正は
`daemon.ts` / `conductor.ts` の直接修正で完結する。fsm 経由にするかは
implementer が判断してよい（本計画では fsm 経由化は範囲外とする）。

## 7. テスト戦略

### 7.1 単体テスト（bun test）

**conductor.test.ts:**
- ST2 の 4 ケース（preserveWorktree true/false/未指定/broken 組み合わせ）

**daemon.test.ts:**
- ST4 の 4 ケース（#9 本命 + #1/#6/#10 の対称ケース）
- 既存の CONDUCTOR_DONE / CONDUCTOR_CLEAR テストが破綻しないこと

### 7.2 統合確認（手動）

- ST5 の E2E シナリオ
- `cmux-team start` → ダミータスク投入 → 手動 success=false 送信 → ログ/worktree/branch 確認

### 7.3 リグレッション確認

- 全 bun test pass（`cd skills/cmux-team/manager && bun test`）
- TypeScript 型チェック（`bun tsc --noEmit` or 既存手順に合わせる）

### 7.4 ログ互換性

- 既存の `task_completed` grep 利用者（もしあれば）に影響しないこと
- `conductor_done_unresolved` は新規追加イベントなので既存 grep には無影響

## 8. Decision Log

| ID | 決定 | 理由 |
|---|---|---|
| D1 | `preserveWorktree` のデフォルトは `false` | 既存 5 呼び出し元の挙動を完全維持するため（最小侵襲） |
| D2 | success=false && task-state=closed は **worktree 削除** | Conductor が先に close-task を呼び終えた状態で後から success=false が来る変則ケース。既に完結しているので温存する理由がない。Case 6-8 を full cleanup に倒す |
| D3 | success=false && task-state=assigned は **worktree 温存** | 本タスクの本命ケース。rebase 衝突等の「人間判断待ち」状態を実装で実現 |
| D4 | success=false && task-state=missing は **worktree 温存**（保守側倒し） | 誤って worktree を消すより温存する方が被害小。race ケースへの保険 |
| D5 | success=true && task-state=assigned は **従来通り worktree 削除**（ケース #4） | Conductor 側の close-task 呼び忘れバグの可能性があるが、本タスクのスコープ外。既存挙動を維持 |
| D6 | ログは `conductor_done_unresolved` の新イベント名 | 既存 `task_completed` grep を汚さず、unresolved タスクだけを列挙可能にする |
| D7 | `resetConductor` 内の ConductorState リセットは `preserveWorktree` と無関係に実行 | taskRunId 等を残すと次タスク割り当てが破綻する。fs 上の worktree だけ残し、in-memory 状態はクリアする分離 |
| D8 | `close-task` は daemon が自動呼び出ししない | 仕様（conductor-role.md Step 9.5）通り、人間判断に委ねる。`abort-task` / 手動 merge の選択肢を残す |
| D9 | task-state を `aborted` に自動遷移させない | D8 と同じ理由。`assigned` のまま残し、人間が `abort-task` で確定する or 再 assign する選択肢を残す |
| D10 | `handleConductorDone` 引数に `success` / `reason` を素渡しする | CONDUCTOR_DONE handler 側の `isSuccess` ロジックと重複させない。決定ロジックは `handleConductorDone` に集約 |
| D11 | `conductor-fsm.ts` 経由化は本タスクのスコープ外 | daemon.ts / conductor.ts の直接修正で完結する。fsm 移行は別タスク |
| D12 | `preserveWorktree=true` 時のログは `resetConductor` 側で `worktree_preserved=true` を suffix 付与 | 既存 `conductor_reset` ログと同じ 1 行に統合し、grep 可能性を維持 |

## 9. 実装順序の推奨

1. **ST1** — conductor.ts の `preserveWorktree` オプション追加（変更少、既存挙動に影響なし）
2. **ST2** — conductor.test.ts で ST1 の単体テスト
3. **ST3** — daemon.ts の `handleConductorDone` 分岐実装
4. **ST4** — daemon.test.ts の挙動テーブルテスト追加
5. 全テスト通過確認（`bun test`）
6. **ST5** — 手動 E2E 確認（任意）

ST1 → ST2 の順で一度テストが通った状態を作ってから ST3 に進むと、
ST3 で回帰が起きた際の切り分けが容易になる。

## 10. 参考ファイル（絶対パス）

- `skills/cmux-team/manager/conductor.ts:558-659` — `resetConductor` 本体
- `skills/cmux-team/manager/daemon.ts:1267-1312` — `CONDUCTOR_DONE` handler
- `skills/cmux-team/manager/daemon.ts:2715-2737` — `handleConductorDone`
- `skills/cmux-team/manager/schema.ts:19-29` — `ConductorDoneMessage` スキーマ
- `skills/cmux-team/manager/task.ts:205-225` — `loadTaskState` / `saveTaskState`
- `skills/cmux-team/templates/ja/conductor-role.md:445-480` — Step 9.5 仕様
- `skills/cmux-team/manager/conductor.test.ts:366-454` — 既存の `resetConductor` テスト
- T262 事例ログ: `.team/logs/manager.log` の `conductor_error C[192]` 付近（11:23 前後）
