# T279 実装計画: P1 observe — Conductor/Task state machine の shadow reducer 実装

## 1. 概要

cmux-team v4.0.0 で発生した T255 類の状態遷移バグ（`conductor_discarded` 後の pane 補充漏れ、SESSION_IDLE/CLEAR race、timeout 処理の抜け等）を構造的に解決する第一段階。

Conductor / Task の FSM を **pure function reducer** として `skills/cmux-team/manager/state-machine/` に実装し、daemon.ts の既存 handler 末尾から **shadow mode** で並行呼び出す。副作用は一切実行せず、reducer が計算した「期待次状態」と実 state を比較して `fsm_shadow_diff` ログに記録するのみ。既存 daemon のロジックは一切書き換えない（P2 = T280 予定の仕事）。

併せて、reducer の型定義と 1:1 対応する `docs/spec/07-state-machine.md` を新規作成し、A017 artifact を reducer 実装に合わせて補正する。ゴールは「30+ 箇所に散在する遷移ロジックを 1 箇所に集約する前段として、reducer と実 daemon の差分を定量的に可視化する」こと。

## 2. 新設ファイル構成

以下を `skills/cmux-team/manager/state-machine/` に新設する:

| ファイル | 役割 |
|---|---|
| `events.ts` | Event の discriminated union 型定義 |
| `conductor-fsm.ts` | Conductor reducer の型・実装 |
| `task-fsm.ts` | Task reducer の型・実装 |
| `invariants.ts` | 不変条件の assert 関数群（log-only、throw しない） |
| `shadow.ts` | shadow observer（reducer 呼び + 差分ログ + 別 Map での shadow state 保持） |
| `fsm.test.ts` | A017 §1.2 / §2.2 の全遷移セル table test |

**index.ts（バレル）要否判断: 不要。** 直 import (`import { conductorReduce } from "./state-machine/conductor-fsm"`) で十分。manager/ の他ファイルは daemon.ts が主な import 元で、呼び口は `shadow.ts` 経由に集約されるためシンボル露出が多くない。バレルを足すと循環依存リスクと export 漏れメンテの手間が増えるため省略する。

## 3. Discriminated union 型の設計

### Event 型（`events.ts`）

```ts
export type FsmEvent =
  // hook 由来
  | { type: "SESSION_STARTED"; source: "startup" | "resume" | "clear" | "compact" | undefined; isMasterSurface: boolean }
  | { type: "SESSION_IDLE" }
  | { type: "SESSION_CLEAR"; manualUserInitiated: boolean /* user_clear 判定済み */ }
  | { type: "SESSION_ACTIVE" }
  | { type: "SESSION_ASK" }
  | { type: "SESSION_ENDED"; reason: "stop" | "other" | string | undefined }
  // daemon 由来
  | { type: "TIMEOUT"; kind: "starting" | "assigning" | "disconnected" }
  | { type: "ASSIGN"; ok: boolean; errorKind?: "task" | "conductor" }
  | { type: "DONE"; success: boolean; unresolved: boolean /* handleConductorDone 分岐後 */ }
  | { type: "PID_DIED" }
  | { type: "CLEAR_MANUAL" /* user 起点 /clear を running 中に受けた場合 */ }
  | { type: "REGISTERED" /* CONDUCTOR_REGISTERED */ };
```

Task side は別 union:

```ts
export type TaskFsmEvent =
  | { type: "CREATE" }
  | { type: "UPDATE_STATUS"; to: "draft" | "ready" }
  | { type: "ASSIGN_OK" }
  | { type: "ASSIGN_FAIL"; errorKind: "task" | "conductor" }
  | { type: "CLOSE" }
  | { type: "ABORT"; reason: string }
  | { type: "DELETE" }
  | { type: "RESTART" }
  | { type: "PARENT_ABORTED" /* cascade */ };
```

### Reducer シグネチャ

```ts
export interface ConductorCtx {
  hasTaskRunId: boolean;
  clearSentAtElapsedSec?: number;   // SESSION_CLEAR / timeout 判定に使用
  assigningSetAtElapsedSec?: number;
  disconnectedElapsedSec?: number;
  sessionStartedClearAtExpected?: boolean; // SESSION_CLEAR 後の SESSION_STARTED 合法窓
  now: number; // ms
}

export type ConductorAction =
  | { type: "reset_conductor"; targetStatus: "idle" | "broken"; reason?: string; preserveWorktree?: boolean }
  | { type: "spawn_pid_watcher" }
  | { type: "abort_task"; reason: string }
  | { type: "cascade_children" }
  | { type: "close_task_auto" }          // T274
  | { type: "notify_state_changed"; source: string }
  | { type: "log"; event: string; detail?: string };

export function conductorReduce(
  state: ConductorStatus,
  event: FsmEvent,
  ctx: ConductorCtx,
): { next: ConductorStatus; actions: ConductorAction[] };
```

- **exhaustive check**: `switch (event.type)` 全 case の後ろで `const _exhaustive: never = event;` を置く
- **immutable**: next / actions は常に新しいオブジェクトで返す。state は primitive なので mutation 問題なし
- **P1 では Action を実行しない**。`shadow.ts` は `actions` を `log("fsm_shadow_action", ...)` で出すだけ

### broken 早期 return

`broken` 状態は全イベントで `{ next: "broken", actions: [] }` を返す終端 state（A017 §1.1 既定）。`conductorReduce` 冒頭で `if (state === "broken") return { next: "broken", actions: [] }` を置く。

## 4. ctx (context) の最小要件

reducer は純関数。状態遷移判断に必要な副次情報は呼び出し側（`shadow.ts`）が毎回計算して渡す。肥大化を避けるため、**reducer が決断に使う最小限**だけに絞る:

| ctx field | 用途 | 読み取り元 |
|---|---|---|
| `hasTaskRunId` | `assigning→running` 判定（T232）、running 不変条件 | `conductor.assignedTaskRunId != null` |
| `clearSentAtElapsedSec` | SESSION_CLEAR 後の SESSION_STARTED 合法窓 | `conductor.clearSentAt` との diff |
| `assigningSetAtElapsedSec` | assigning timeout 60s 判定 | `conductor.assigningSetAt` |
| `disconnectedElapsedSec` | disconnected timeout 300s 判定 | `conductor.disconnectedAt` |
| `sessionSource` | SESSION_STARTED の source 分岐 | message.source |
| `isMasterSurface` | Master の SESSION_STARTED は無視 | surface が `state.masters` に含まれるか |
| `now` | timeout 判定の共通タイムスタンプ | `Date.now()` |

Task ctx はさらにシンプル:

```ts
export interface TaskCtx {
  hasConductor: boolean;        // assigned 不変条件
  parentAborted: boolean;       // cascade_children 起点
}
```

**ctx に載せないもの**: conductor 全体オブジェクト、surface、PID 等。それらは Action で外に出して shadow が使うなら shadow 側で解決する。

## 5. shadow 配線方針

### 5.1 shadow observer 本体

```ts
// shadow.ts
export function shadowObserveConductor(
  surface: string,
  prev: ConductorStatus,
  event: FsmEvent,
  ctx: ConductorCtx,
  actualNext: ConductorStatus,
): void {
  try {
    const { next: expectedNext, actions } = conductorReduce(prev, event, ctx);
    if (expectedNext !== actualNext) {
      log("fsm_shadow_diff", `${formatSurface(surface, "C")} event=${event.type} prev=${prev} expected=${expectedNext} actual=${actualNext}`);
    }
    // 不変条件検査（log-only）
    assertInvariants(surface, expectedNext, ctx);
    // shadow 期待値を別 Map に保持（実 state に絶対に重ねない）
    shadowConductorMap.set(surface, expectedNext);
    // actions は P1 では log only
    for (const a of actions) {
      log("fsm_shadow_action", `${formatSurface(surface, "C")} ${a.type} ${JSON.stringify(a)}`);
    }
  } catch (e) {
    // shadow の失敗は既存処理に絶対に影響させない
    log("fsm_shadow_error", `${formatSurface(surface, "C")} ${(e as Error).message}`);
  }
}
```

同様に `shadowObserveTask(taskId, prev, event, ctx, actualNext)` を定義。

### 5.2 shadow state の保持場所

**別 Map で保持する方針を採用**（`shadowConductorMap: Map<surface, ConductorStatus>` / `shadowTaskMap: Map<taskId, TaskStatus>`）。

理由:
- ConductorState / TaskStateEntry に shadow フィールドを加えると schema.ts の zod 変更が必要で、serialize / persistence 経路に波及する
- 副作用を「絶対に既存に伝播させない」原則を守るため、shadow の存在が実 state 型から見えないようにする
- Map は shadow.ts 内に closure で閉じ、外から mutate できない

### 5.3 daemon.ts 配線対象 handler（全て **case 内 break 直前** に挿入）

既存処理を **一切書き換えず**、handler の「末尾」に try/catch で包んだ `shadowObserveConductor(...)` / `shadowObserveTask(...)` を足す。行番号は 2026-04-20 現在の daemon.ts に基づく参考値（実装時に再確認）:

**handleMessage 側（`daemon.ts`）**

| 位置 | イベント変換 |
|---|---|
| handleMessage 冒頭の insertHookSignal 後（1231〜） | 全 hook イベントの prev 記録用フック点（ただし event narrow は case 内でのみ可能なので、実配線は case 末尾に置く） |
| `SESSION_STARTED` case (1407) | `{type:"SESSION_STARTED", source, isMasterSurface}` |
| `CONDUCTOR_REGISTERED` case (1590) | `{type:"REGISTERED"}` |
| `SESSION_ENDED` case (1698) | `{type:"SESSION_ENDED", reason}` |
| `SESSION_ACTIVE` case (1786) | `{type:"SESSION_ACTIVE"}` |
| `SESSION_IDLE` case (1873) | `{type:"SESSION_IDLE"}` |
| `SESSION_ASK` case (1983) | `{type:"SESSION_ASK"}` |
| `SESSION_CLEAR` case (2046) — Master ignored 経路 / broken guard / assigning break / user_clear 経路それぞれの末尾 | `{type:"SESSION_CLEAR", manualUserInitiated}` |
| `CONDUCTOR_DONE` → `handleConductorDone` (2879) 末尾 | `{type:"DONE", success, unresolved}` |

**scanTasks / assignTask 側**

| 位置 | イベント変換 |
|---|---|
| `scanTasks` 内 `assignTask` 成功直後 (2346〜) | Conductor: `{type:"ASSIGN", ok:true}` / Task: `{type:"ASSIGN_OK"}` |
| `assignTask` 失敗（`AssignTaskError` catch）(2346〜) | Conductor: `{type:"ASSIGN", ok:false, errorKind}` / Task: `{type:"ASSIGN_FAIL", errorKind}` |

**monitorConductors / 生存監視側**

| 位置 | イベント変換 |
|---|---|
| `monitorConductors` starting timeout 分岐末尾 (2739〜) | `{type:"TIMEOUT", kind:"starting"}` |
| `monitorConductors` assigning timeout 分岐末尾 | `{type:"TIMEOUT", kind:"assigning"}` |
| `monitorConductors` disconnected timeout 分岐末尾 | `{type:"TIMEOUT", kind:"disconnected"}` |
| `forceCloseDisconnectedConductor` 末尾 (2814) | reducer 的には TIMEOUT 分岐の延長（状態遷移は既に disconnected→broken 確定）。shadow 側は `{type:"TIMEOUT", kind:"disconnected"}` のみで十分 |
| PID watcher が死亡検出 → `disconnected` に遷移する経路末尾 | `{type:"PID_DIED"}` |

**Task CLI 経路（`manager/main.ts` の task コマンド各 handler 末尾）**

| 位置 | イベント変換 |
|---|---|
| `create-task` 末尾 | `{type:"CREATE"}` |
| `update-task` で status 変更時末尾 | `{type:"UPDATE_STATUS", to}` |
| `abort-task` 末尾 | `{type:"ABORT", reason}` |
| `delete-task` 末尾 | `{type:"DELETE"}` |
| `restart-task` 末尾 | `{type:"RESTART"}` |
| `close-task` 末尾 | `{type:"CLOSE"}` |
| `cascadeAbortToChildren` 各子 task 更新末尾 | `{type:"PARENT_ABORTED"}` |

### 5.4 既存処理への非侵襲保証

- 全ての `shadowObserve*` 呼び出しは **呼び出し側でも** `try { shadowObserve...(...) } catch { /* swallowed */ }` で囲む（shadow.ts 内の try/catch と二重化）
- shadow.ts は `log` と `formatSurface` 以外の manager モジュールを import しない（循環依存防止）
- 例外は必ず `log("fsm_shadow_error", ...)` に書く（silent catch しない）
- shadow の計算結果は **return しない**（呼び出し側が shadow 結果を参照しないことを型で保証）

## 6. テスト戦略

### 6.1 fsm.test.ts のカバレッジ方針

A017 §1.2（Conductor 遷移表）と §2.2（Task 遷移表）の **全セル** をテーブル駆動で網羅する。

Conductor:
- states × events = 7 × (12 event variants) ≈ 84 セル（うち broken は終端 1 行で圧縮）
- Master surface 別扱い（SESSION_STARTED with isMasterSurface=true → 遷移なし）
- SESSION_CLEAR の `manualUserInitiated` 二値分岐
- SESSION_STARTED の source 別分岐（startup/resume/clear/compact）
- TIMEOUT の kind 別分岐（starting/assigning/disconnected）

Task:
- states × events = 6 × (9 event variants) ≈ 54 セル（deleted 終端圧縮あり）
- assigned↔closed、aborted↔restart 経路、PARENT_ABORTED の cascade 元（ready→draft）

### 6.2 特定ユースケースの回帰テスト

既知バグ（shadow が検出することをテストで示す）:
- **T255 再現**: `conductor_discarded` 後の `starting` 残留を shadow が broken として検出
- **T263 / T269**: unresolved=true の DONE で `running → idle` かつ task_aborted（worktree 保持）
- **T264**: 起動時 `assigned` タスクの resume 不可検出後 → task ABORT
- **T276 / T277**: SESSION_IDLE/CLEAR race — `assigning` 中の SESSION_IDLE は no-op、SESSION_CLEAR(assigning) は break
- **T232**: `assigning` 中に SESSION_ACTIVE/SESSION_STARTED を受けたら `running`（hasTaskRunId=true 条件付き）
- **T274**: stateMismatchOnSuccess 経路（DONE success=true かつ task state=assigned → auto close_task + idle）
- **broken 終端性**: broken 状態でどの event を受けても broken のまま、actions=[]

### 6.3 不変条件テスト（`invariants.ts`）

- `running ⇒ hasTaskRunId`
- `assigned task ⇒ 必ず conductor に紐付く`（TaskStateEntry.conductorSlot）
- `broken conductor が assignedTaskRunId を持たない`
- 違反時は `log("fsm_invariant_violation", ...)` のみ、throw しない

### 6.4 実行環境

- `cd skills/cmux-team/manager && bun test state-machine/`
- daemon.ts の shadow 配線自体は最小限の smoke テストのみ（daemon.ts は巨大でユニットテスト化が困難）
- reducer 単体の網羅を優先する

### 6.5 テスト数の明示

DoD 記載のため、fsm.test.ts には `describe("Conductor FSM", () => {...})` と `describe("Task FSM", () => {...})` の大ブロックを分け、**少なくとも 84 + 54 = 138 ケース** 以上の `it(...)` を列挙する想定。table test 形式でも `test.each(...)` ごとに 1 ケースとしてカウント可能にする。

## 7. ドキュメント更新

### 7.1 新規: `docs/spec/07-state-machine.md`

章立て:

```
# 07 State Machine
## 概要
  - reducer が正、daemon は shadow 経由で観測（P1）、P2 で置換予定
## Conductor FSM
  ### 状態一覧（7 個）: starting / assigning / idle / running / asking / disconnected / broken
  ### イベント一覧（events.ts と 1:1）
  ### 遷移表（A017 §1.2 と同形式。reducer 実装を正として再掲）
  ### Mermaid 状態遷移図
## Task FSM
  ### 状態一覧（6 個）: draft / ready / assigned / closed / aborted / deleted
  ### イベント一覧
  ### 遷移表（A017 §2.2）
  ### Mermaid 状態遷移図
## Joint 遷移パターン
  - Conductor `assigning → running` は Task `ready → assigned` と 1:1
  - Conductor `broken / disconnected timeout` → Task `assigned → aborted`（cascade 含む）
## 不変条件
  - running ⇒ hasTaskRunId, assigned task ⇒ conductor 紐付き, broken 終端 等
## Action 一覧（Conductor / Task）
  - reducer が返す Action の種類と意味
## 関連タスク
  - T255 / T263 / T269 / T276 / T277 / T232 / T274 への参照
```

Mermaid 図 2 本（Conductor / Task）は state と主要 event を含めるが、全遷移を描くと読めなくなるので「主要経路 + broken への集約」を優先する。全セルは遷移表で表現。

### 7.2 既存更新

- **`A017-state-machine.md`**: shadow 稼働で発見された誤記・漏れを追記する欄を新設（本タスクでは空でも良いが、実装中に気付いたらここに入れる）。セクション名: `## §5 Reducer 実装中に発見された補正事項`
- **`docs/spec/00-project-overview.md`**: 「関連仕様」などの既存リンク節に `07-state-machine.md` を追加
- **`CLAUDE.md`**: 「リポジトリ構造」セクションの `docs/spec/` 一覧に `07-state-machine.md | Conductor / Task FSM 仕様（reducer と 1:1）` 行を挿入

### 7.3 乖離発見時の扱い

A017 と実コード daemon.ts の記述が乖離していたら、**reducer は実装（daemon.ts）に合わせる**。A017 §5 補正欄と impl-report に乖離を列挙する。07-state-machine.md は reducer + A017 補正後を正として書く。

## 8. shadow mode の「稼働と観測」運用

### 8.1 24h 稼働要件の現実的代替

タスク完了条件「shadow mode を 24h 稼働させて diff 統計を取得」は本タスク期間内に達成困難。以下の方針で妥協案を提案する:

**提案**: 24h 観測は **後続タスク T280+（P2）で実施**し、本タスクでは以下で代替する:
1. **fsm.test.ts で A017 全セル網羅**（既存バグの regression tests を含む）
2. **daemon 起動時の自己スモーク（任意）**: `cmdStart` 冒頭で `runSelfSmoke()` を呼び、既知遷移の shadow reducer が期待通りに動くことを log に出す（log only、exit しない）
3. **impl-report に明記**: 「本タスクでは単体テストで A017 全セルを網羅済み。実運用 diff 観測は T280 で `fsm_shadow_diff` ログを一定期間収集した後に着手」

### 8.2 不変条件違反 1 ケース以上検出の要件

既知の T255 類のパターン（`running` 中に `PID_DIED` + `disconnected` 進行せず、`hasTaskRunId=true` のまま broken に至る等）を fsm.test.ts 内で再現シナリオとして記述し、`assertInvariants` がその violation を `log("fsm_invariant_violation", ...)` に書くことをテストで assert する。

## 9. TDD 実装順序（Implementer への指示）

1. **events.ts** の discriminated union 型定義のみ書き、`tsc --noEmit` でコンパイル通す
2. **invariants.ts** 骨格（`assertInvariants(surface, status, ctx)` — log のみ）を書く
3. **fsm.test.ts** に A017 §1.2 / §2.2 全セルを table 形式で書く（まず全部 red）
4. **conductor-fsm.ts** 実装 — Conductor 側のテストを全部 green にする
5. **task-fsm.ts** 実装 — Task 側のテストを全部 green にする
6. **shadow.ts** 実装 — shadowConductorMap / shadowTaskMap と observer 関数
7. **daemon.ts 配線** — §5.3 の handler 末尾に try/catch 付きで shadow 呼び出し挿入（既存コードには 1 行も触れない方針）
8. **bun test** 全 pass 確認 + `tsc --noEmit` 確認
9. **docs/spec/07-state-machine.md** 作成（Mermaid 図含む）
10. **CLAUDE.md / 00-project-overview.md / A017 §5 補正欄** 更新

各ステップで `bun test` / `tsc --noEmit` を常時通す。`daemon` 起動動作確認は step 7 の後に `cmux-team start` で手動確認し、`fsm_shadow_diff` がログに現れることを確認する（差分 0 件でも「配線が動いている」証跡として十分）。

## 10. リスクと緩和策

| リスク | 緩和策 |
|---|---|
| daemon.ts の shadow 挿入で既存処理が壊れる | shadow.ts 内 + 呼び出し側の二重 try/catch。shadow.ts は exception-free で設計し、log 以外の副作用を持たない |
| reducer の ctx 肥大化 | ctx は「reducer が純関数として決断するために最低限必要なもの」だけに絞る。残りは Action で外に出す |
| A017 と実装の乖離 | 発見次第 A017 §5 補正欄 + impl-report に記録。reducer は実装を正とする |
| bun test 環境 | `cd skills/cmux-team/manager && bun test state-machine/` を plan に明記。Implementer が `bun install` 済か確認 |
| shadow state Map のメモリ肥大化 | Map は surface/taskId キー。Conductor は高々数個、Task も数十〜数百で問題にならない。もし taskId ベースで膨張したら `TaskStatus = "deleted"` になった行を削除する。 |
| 24h 観測要件の未達 | §8 で代替案を提案し、本タスクでは impl-report に明記。P2 (T280) で本格観測 |
| 循環 import（daemon.ts ↔ shadow.ts ↔ logger.ts） | shadow.ts は logger の log と formatSurface のみ import。eventBus / schema / task / conductor は import しない |
| notifyStateChanged が shadow 側で重複発火 | shadow は `log` 以外の副作用を絶対に出さない。notifyStateChanged Action は P1 では log only |

## 11. 受入条件 (DoD)

- [ ] `conductor-fsm.ts` / `task-fsm.ts` が全イベントを exhaustive switch で処理し、`const _exhaustive: never = event` でコンパイル時検査が入っている
- [ ] `fsm.test.ts` が A017 §1.2 / §2.2 の全セルを網羅（**138 ケース以上**、describe ごとに cell 数をコメントで明示）
- [ ] `bun test state-machine/` が全 pass
- [ ] `tsc --noEmit` が warning-free で通る
- [ ] `daemon.ts` の shadow 呼び出しが全て try/catch で包まれている（`rg "shadowObserve" skills/cmux-team/manager/daemon.ts` の結果が全行 try block 内）
- [ ] `fsm_shadow_diff` ログが期待フォーマット（`<surface> event=<type> prev=<state> expected=<state> actual=<state>`）で書ける状態
- [ ] 不変条件違反 1 ケース以上を fsm.test.ts で再現し、`fsm_invariant_violation` ログが記録されることを assert
- [ ] `docs/spec/07-state-machine.md` が reducer 実装と 1:1 対応（状態名・イベント名が完全一致、Mermaid 図 2 本が描画可能）
- [ ] `CLAUDE.md` の「リポジトリ構造」セクションに `07-state-machine.md` 行が登場
- [ ] `docs/spec/00-project-overview.md` に `07-state-machine.md` へのリンク追加
- [ ] `A017-state-machine.md` に §5 補正欄が追加されている（空でも節として存在）
- [ ] impl-report に「24h 観測は T280 (P2) で実施、本タスクは単体テスト + 自己スモークで代替」と明記
- [ ] 既存 daemon.ts のロジックが 1 行も書き換わっていない（`git diff main -- skills/cmux-team/manager/daemon.ts` が handler 末尾への shadow 呼び出し挿入 + try/catch のみ）

---

## 付録: A017 と実コードの整合性メモ（Planner 調査時点）

Planner が daemon.ts / A017 を突き合わせた結果、以下の点は整合している:

- SESSION_STARTED handler: broken guard → starting|disconnected→idle → assigning→running (T232 hasTaskRunId 条件付き) → Agent 経路 → master fallback
- SESSION_CLEAR: Master ignored → broken guard → assigning=session_clear_expected break → disconnected|starting→idle → running=user_clear 経路（task_aborted + cascade + reset）
- SESSION_IDLE: broken guard → assigning 中は **no-op（T277 以降）** → asking→idle/running → disconnected→running/idle → starting→idle
- handleConductorDone: judgment_pending (unresolved) / stateMismatchOnSuccess (T274 auto-close) / task_completed 正常系の 3 分岐
- monitorConductors timeout: starting 60s / assigning 60s → disconnected、disconnected 300s → forceClose（broken 化 + task_aborted + cascade + reset）

乖離点は本実装中に発見次第 A017 §5 に追記する。
