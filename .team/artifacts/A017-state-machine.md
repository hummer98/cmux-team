---
id: A017
type: research
title: "Conductor / Task ステート機械: 状態と遷移イベント一覧 (2026-04-20)"
created: 2026-04-20T08:38:45.566Z
author: unknown
task: 277
tags: [state-machine, conductor, task, events]
---

# Conductor / Task ステート機械: 状態と遷移イベント一覧

> 本ドキュメントは cmux-team 4.0.0 時点の `skills/cmux-team/manager/` 実装に基づく現状記述。
> A014（2026-04-18, v3.53.0）の続編で、T250（broken 追加）/ T263 / T269 / T277（in flight）の
> 変更を反映する。引用箇所は `file:line` 形式で裏取り。

## 1. Conductor.status

`schema.ts:264` で定義される 7 値:

```ts
status: "starting" | "assigning" | "idle" | "running" | "asking" | "disconnected" | "broken";
```

### 1.1 各状態に「入る」イベント

| 状態 | 入るトリガー | 主な実装位置 |
|------|-------------|-------------|
| `starting` | `CONDUCTOR_REGISTERED` 受信（初回登録） | daemon.ts handleMessage CONDUCTOR_REGISTERED |
| `idle` | `SESSION_STARTED` / `SESSION_IDLE` / `SESSION_CLEAR` を `starting` または `disconnected` で受信 / `SESSION_ASK` 解決後（`taskRunId` なし）/ `resetConductor` 完了 | daemon.ts:1450, 1823, 1913, 1931, 1935, 2095 / conductor.ts:637 |
| `assigning` | `assignTask` が `/clear` 送信直前にセット | conductor.ts:446 |
| `running` | `SESSION_STARTED(source=clear)` を `assigning` で受信（T232 メイン経路）/ `SESSION_IDLE` を `disconnected` で受信（taskRunId あり）/ `SESSION_ACTIVE` を `disconnected` で受信 / `SESSION_ASK` 解決後（`taskRunId` あり） | daemon.ts:1457, 1820, 1913, 1924, 1940 |
| `asking` | `SESSION_ASK` 受信（AskUserQuestion 検出） | daemon.ts:2011 |
| `disconnected` | `SESSION_ENDED reason!=other` 受信 / `spawnPidWatcher` が PID 不在検出 / `starting` または `assigning` で timeout / `assignTask` 失敗 (kind=conductor) | daemon.ts:1743, 2567, 2766, 2790 |
| `broken` | `disconnected` で `DISCONNECT_TIMEOUT_SEC`（300s 既定）超過 → `forceCloseDisconnectedConductor` → `resetConductor({targetStatus: "broken"})` | daemon.ts:2811, 2890 / conductor.ts:637, 668 |

### 1.2 各状態から「出る」イベント

| 状態 | 出る先 | きっかけ |
|------|--------|---------|
| `starting` | `idle` | `SESSION_STARTED` / `SESSION_IDLE` / `SESSION_CLEAR` 到達 |
| `starting` | `disconnected` | 60s 超過（`STARTING_TIMEOUT_SEC`） |
| `assigning` | `running` | `SESSION_STARTED(source=clear)` 到達（メイン経路） |
| `assigning` | `running` | `SESSION_IDLE` 到達（**T232 R1 保険経路** — T277 で撤去予定） |
| `assigning` | `assigning` 維持 | `SESSION_CLEAR` 到達（daemon 自身の /clear、daemon.ts:2079 で `session_clear_expected`） |
| `assigning` | `disconnected` | 60s 超過（`ASSIGNING_TIMEOUT_SEC`） |
| `idle` | `assigning` | `scanTasks → assignTask` がタスク割り当て |
| `running` | `asking` | `SESSION_ASK` 到達 |
| `running` | `idle` | `CONDUCTOR_DONE --success=true` または `--success=false` で task が `closed/aborted/deleted` → `resetConductor` (T263) |
| `running` | `idle` | `CONDUCTOR_DONE --success=false` で task が `assigned` → `task_aborted reason=judgment_pending`、worktree 温存（T269） |
| `running` | `idle`（task abort 経由） | `SESSION_CLEAR` 到達（`case=user_clear`、daemon.ts:2119）— **T277 race 修正対象** |
| `running` | `disconnected` | `SESSION_ENDED` / PID watcher 不在検出 |
| `asking` | `running` | `SESSION_IDLE` 到達（`taskRunId` あり） |
| `asking` | `idle` | `SESSION_IDLE` 到達（`taskRunId` なし） |
| `disconnected` | `idle` | `SESSION_STARTED` / `SESSION_CLEAR` 到達（taskRunId なし）/ `SESSION_IDLE` 到達（taskRunId なし） |
| `disconnected` | `running` | `SESSION_ACTIVE` 到達 / `SESSION_IDLE` 到達（taskRunId あり） |
| `disconnected` | `broken` | 300s 超過（`DISCONNECT_TIMEOUT_SEC`） |
| `broken` | `idle` | `cmux-team clear-conductor <surface>` 明示実行のみ |

### 1.3 タイムアウト一覧

| 定数 | 値 | 適用状態 | 動作 |
|------|---|---------|------|
| `STARTING_TIMEOUT_SEC` | 60s | `starting` | `disconnected` に倒す |
| `ASSIGNING_TIMEOUT_SEC` | 60s | `assigning` | `disconnected` に倒す（`assigning_window_close via=timeout`） |
| `DISCONNECT_TIMEOUT_SEC` | 300s（env `CMUX_TEAM_DISCONNECT_TIMEOUT_SEC` で上書き可） | `disconnected` | `broken` 化 + task abort + worktree 削除 |

### 1.4 broken の特殊扱い

T250 で導入。`broken` は **どの hook イベントでも自動復帰しない** 終端状態。
`monitorConductors` 冒頭の早期 continue（daemon.ts:2759）で再 timeout を防ぎ、
`SESSION_*` ハンドラ各所（daemon.ts:1378, 1443, 1811, 1898, 2071）で broken
ガードが先頭に置かれ、destructive 処理を全てスキップする。
`broken_conductor_still_alive` ログ（daemon.ts:292）は「broken 化したのに hook
が届いた = プロセスが生きていた疑い」を可視化する診断信号。

## 2. Task.status

`task-state.json` の `status` フィールド（task.ts の `TaskStateEntry`、文字列 enum）。
"draft" | "ready" | "assigned" | "closed" | "aborted" | "deleted" の 6 値。

### 2.1 各状態の意味と入るイベント

| 状態 | 意味 | 入るトリガー |
|------|------|-------------|
| `draft` | 作成直後の下書き | `create-task` の初期値（task.ts:441） / 親 abort cascade（T241、ready → draft、daemon.ts:2138-2150） |
| `ready` | 実行待機中（assignable） | `update-task --status ready` / `restart-task`（assigned/aborted → ready）/ `resume` 失敗フォールバック（daemon.ts:947, 1040, 1075, 1094）/ overflow 戻し（main.ts:833） |
| `assigned` | Conductor に割り当て済 | `scanTasks → assignTask` 内の task-state 更新（daemon.ts:2542） |
| `closed` | 正常完了 | `cmux-team close-task`（daemon.ts:2996, 3356）/ Conductor の `CONDUCTOR_DONE` 経由 |
| `aborted` | 中止（自動 or 明示） | `cmux-team abort-task` / SESSION_CLEAR の user_clear 判定（daemon.ts:2136、T277 修正対象）/ `forceCloseDisconnectedConductor`（daemon.ts:2851）/ `resume_marked_aborted`（T264、ブート時 resume 不可検出、daemon.ts:2480）/ `CONDUCTOR_DONE --success=false` の judgment_pending 経路（T269、daemon.ts:2957） |
| `deleted` | 明示削除（draft/ready のみ） | `cmux-team delete-task`（main.ts:3677） |

### 2.2 各状態から「出る」イベント

| 状態 | 出る先 | きっかけ |
|------|--------|---------|
| `draft` | `ready` | `update-task --status ready` → `TASK_CREATED` メッセージ送信 |
| `draft` | `deleted` | `delete-task` |
| `ready` | `assigned` | `scanTasks` が idle Conductor に割り当て |
| `ready` | `draft` | 親タスク abort/delete の cascade（T241、`child_reverted_to_draft reason=parent_aborted`） |
| `ready` | `deleted` | `delete-task` |
| `assigned` | `closed` | Conductor が `close-task` 実行 |
| `assigned` | `aborted` | `abort-task` / SESSION_CLEAR user_clear（T277 race）/ disconnect timeout (forced close) / resume 不可検出（T264）/ CONDUCTOR_DONE judgment_pending（T269） |
| `assigned` | `ready` | `restart-task`（assigned → ready、worktree クリア） |
| `closed` | （終端） | — |
| `aborted` | `ready` | `restart-task`（aborted → ready、残存 worktree 強制削除） |
| `deleted` | （終端） | — |

### 2.3 cascade ルール（T241）

親タスクが `aborted` または `deleted` に遷移した瞬間、`depends_on` に親を含む
**ready** 状態の子タスクのみ `draft` に戻される（journal: `parent_aborted: <parentId>`）。
`assigned` / `closed` / `aborted` / `deleted` の子は触らない（走行中の作業は止めない）。

cascade 発火経路（7 つ）:

1. `abort-task` CLI
2. `delete-task` CLI
3. Conductor forced close（disconnect timeout）
4. user_clear（手動 /clear）
5. `assign_failed`（worktree 作成失敗）
6. `resume_marked_aborted`（cmdStart 起動時、T264）
7. `handleConductorDone` judgment_pending 分岐（T269）

## 3. Conductor ↔ Task の連動

両者は別レイヤーだが密に連動する:

| 同時遷移パターン | Conductor 側 | Task 側 | 経路 |
|----------------|-------------|---------|------|
| 割当 | `idle → assigning → running` | `ready → assigned` | `assignTask`（conductor.ts）+ task-state 更新（daemon.ts:2542） |
| 正常完了 | `running → idle` | `assigned → closed` | Conductor の `close-task` → CONDUCTOR_DONE → `resetConductor` |
| user /clear（誤検知含む） | `running → idle` | `assigned → aborted` | SESSION_CLEAR の user_clear 分岐（daemon.ts:2119、**T277 race 対象**） |
| disconnect 確定 | `disconnected → broken` | `assigned → aborted` | `forceCloseDisconnectedConductor` |
| 判断保留 | `running → idle` | `assigned → aborted (judgment_pending)` | CONDUCTOR_DONE --success=false（T269）/ worktree は温存 |
| 起動時 resume 不可 | （N/A、まだ未起動） | `assigned → aborted (resume_*)` | cmdStart 起動時検出（T264） |

## 4. 既知の race / 設計上の留意点

### 4.1 SESSION_IDLE と SESSION_CLEAR の配送順 race（T276 で発覚 / T277 で修正予定）

`assigning` 中に `SESSION_IDLE` が `SESSION_CLEAR` より先に到達すると:

1. T232 R1 保険経路（daemon.ts:1937-1955）が assigning → running に倒し、
   `assigning_window_close via=SESSION_IDLE` を発行
2. 直後（数十 ms 〜数秒後）に届く SESSION_CLEAR（daemon /clear 由来）が
   `running` ハンドラ（daemon.ts:2119）に落ちる
3. `case=user_clear decision_reason=running_with_taskid` と判定 → task abort + worktree 削除

**T277 修正方針:** R1 保険経路を撤去し、assigning 中の SESSION_IDLE は no-op にする。
window close は SESSION_STARTED(source=clear) / SESSION_CLEAR / timeout の 3 経路に
一本化する。

### 4.2 broken は手動復帰のみ

意図的に「自動 idle 化を廃止」した設計（T250）。disconnect 後 5 分待って
復帰しなかった Conductor は無条件に broken にする。これは「セマンティック判定で
復活させようとして誤判定する」より「人間が状況を見て `clear-conductor` する」
方が安全という設計判断（A015 のフォールバック設計ポリシーと整合）。

### 4.3 Master surface 別扱い

`SESSION_CLEAR` ハンドラ冒頭（daemon.ts:2064）で Master surface は
state 遷移を起こさず `master_session_clear_ignored` ログのみ残す。Master は
`/clear` で reset しない仕様。

## 5. 仕様との差分 (T279 correction section)

A017 はスナップショットなので、仕様 (`docs/spec/07-state-machine.md`) と乖離したら
ここに追記する。reducer 実装 (`skills/cmux-team/manager/state-machine/`) が正。

### 5.1 T277 反映後の §1.2 (2026-04-20 時点)

`assigning` 中の `SESSION_IDLE` は R1 保険経路が撤去済みで **no-op**。
A017 §1.2 の「`assigning → running` を `SESSION_IDLE` で到達」の行は
T277 修正により **削除** される。reducer (`conductor-fsm.ts`) もこれに合わせて
`assigning + SESSION_IDLE → no-op` を実装している。

### 5.2 T279 shadow 配線による fsm_shadow_diff (2026-04-20 時点)

P1 観測期間に出る可能性のある既知差分:

| 差分 | 原因 | 判定 |
|------|------|------|
| `SESSION_CLEAR` の `manualUserInitiated` 判定が daemon 実装と reducer で乖離 | daemon 側は prev.taskRunId 照合も行うが reducer は prev=`running` 条件のみ | 設計上の既知差分。`fsm_shadow_diff` に落ちたら A017 §5 を更新 |
| `DONE` late_cleanup 経路 (prev != running/asking) | daemon は `resetConductor` で idle に倒すが reducer は no-op | observability only。P2 で daemon 側を reducer と揃えるか検討 |
| `REGISTERED` 新規登録 | daemon 実 state は undefined → starting だが shadow 側は `starting → starting` で no-op | 配線の初期値ノイズ。差分は出ない |

24h 観測で上記 3 分類以外の diff が発生したら A017 §5 に随時追記する。

### 5.3 CLEAR_MANUAL (予約イベント)

reducer は `CLEAR_MANUAL` を exhaustive check のために case 持ちだが、
現時点 (2026-04-20) で daemon 側からは emit されない。`SESSION_CLEAR.manualUserInitiated=true`
で同等セマンティクスを表現している。将来 hook 外経路で user 発 /clear を検出する
用途に残す。この事実は `events.ts` の FsmEvent コメントにも記載済み。

## 関連

- A010: Conductor / Agent ライフサイクル（spawn 〜 cleanup の時間軸）
- A014: Conductor 状態機械 旧版（v3.53.0、broken 追加前）
- A015: フォールバック設計ポリシー（broken 自動復帰廃止の根拠）
- T250: broken 状態追加
- T263 / T269: CONDUCTOR_DONE の state 遷移
- T264: 起動時 resume 不可検出
- T276 / T277: SESSION_IDLE/CLEAR race 修正
- T279: 仕様成文化 + pure reducer + shadow observer（`docs/spec/07-state-machine.md`）
- T280: reducer による daemon 実装置換（shadow 24h 合格後）
