# Plan: T184 EventBus による state 変更の TUI 即時反映（改訂版）

> 改訂版。Design Review の Major 指摘（R1: 実 state mutation 点のみで notify、R2: Step4/Step5 矛盾解消）と Minor 指摘を反映済み。詳細は末尾「改訂履歴」参照。

## 1. ゴール

Manager daemon の `state.conductors` / `state.tasks` への **実 mutation** が発生した時点で、debounce 付き TUI refresh を即座にスケジュールできるようにする。追跡性（grep で emit 箇所を列挙可能）を担保し、将来的な state observer 移行の前提となる疎結合を導入する。

受け入れ基準サマリ:

- `cmux-team update-task --status ready` から **1 秒以内**に TUI Tasks 表示が更新される（目視で即時反映されることを基準とする。詳細は §6）
- Conductor 割当完了の瞬間（`status="running"` 代入直後）に TUI Conductors 表示が `running` に遷移する
- `rg notifyStateChanged skills/cmux-team/manager` で全 emit 箇所を列挙できる（**箇所数の多寡は KPI にしない**）
- `rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts` が **0 件**
- `CMUX_TEAM_TRACE_EVENTS=1` で `manager.log` に `event_emit event=state-changed source=...` が出力される
- `docs/spec/05-install-and-infrastructure.md` に Event Catalog セクションが追加されている
- 既存 `*.test.ts` / e2e が破壊されていない

## 2. 現状分析（コード参照・行番号付き）

### 2.1 TUI refresh フロー（現状）

| 箇所 | 役割 |
|---|---|
| `main.ts:335` | `startDashboard()` から `scheduleRefresh` を受け取る |
| `main.ts:526,528,561,563,569` | boot phase 遷移ごとの明示的 refresh |
| `main.ts:573-598` | メインループ: `tick()` → `updateTeamJson()` → `updateSidebarStatus()` → `scheduleRefresh()` → `sleepUntilWakeup()` |
| `dashboard.tsx:1307-1315` | `scheduleRefresh` の実装（100 ms debounce、`refreshDebounce` フラグで重複排除） |
| `dashboard.tsx:1287-1303` | `spinnerInterval`（既存の独立ポーリング、running/starting 時のみ動作） |
| `dashboard.tsx:1320` 以降 | `cleanup` 関数（`dashboardActive = false` / `clearInterval` を含む） |

**問題**: `scheduleRefresh` はメインループが `tick()` → 一連の同期処理 → `sleepUntilWakeup()` のサイクルを完了するまで呼ばれない。`tick()` 内で `assignTask()` が走ると、worktree 作成・`npm install`・`cmux send` 等の遅延中（数秒〜数十秒）は古い state が描画され続ける。

### 2.2 state mutation 箇所（全洗い出し）

以下は **実際に `ConductorState` / `state.*` を mutate する点**に絞った一覧。「中間処理の完了点」（ローカル変数更新、外部コマンド完了など）は含めない。

#### `conductor.ts`

| 行 | 関数 | 実 mutation 内容 |
|---|---|---|
| 474-481 | `assignTask` | `conductor.taskRunId / taskId / taskTitle / worktreePath / outputDir / startedAt / agents / status="running"` を連続代入（**ブロック末尾で 1 回 emit**） |
| 562-571 | `resetConductor` | `conductor.status = "idle"` + 関連フィールドクリア |

> **R1 対応**: 前版で挿入対象とした L353（ローカル変数 `worktreeCreated`）/ L395（direnv allow 完了）/ L423（prompt file 生成）/ L442（cmux send 完了）/ L559（renameTab 完了）は **ConductorState を mutate しないため emit しない**。これらは中間処理の完了点であり、`getState()` から観測可能な state は変化していない。進捗可視化は別タスクで `ConductorState.phase` を導入する（§9 Open Questions 参照）。

#### `daemon.ts`

| 行 | 関数 | 実 mutation 内容 |
|---|---|---|
| 585-596 | `handleMessage/AGENT_SPAWNED` | `conductor.agents.push` |
| 602-605 | `handleMessage/SESSION_STARTED` (master) | `state.masterPid / masterStatus / masterDisconnectedAt` |
| 612-622 | `handleMessage/SESSION_STARTED` (conductor) | `conductor.status / pid / disconnectedAt` |
| 635-641 | `handleMessage/CONDUCTOR_REGISTERED` | `state.conductors.set()` |
| 649 | `handleMessage/CONDUCTOR_SESSION` | `conductor.sessionId` |
| 666-668 | `handleMessage/SESSION_ENDED` (master) | `state.masterStatus / masterDisconnectedAt / masterPid` |
| 682-684 | `handleMessage/SESSION_ENDED` (conductor) | `conductor.status="disconnected"` |
| 693-694 | 同上 (agent) | `c.agents.splice()` |
| 709-711 | `SESSION_ACTIVE` (master) | `masterStatus / masterDisconnectedAt / masterPid` |
| 717-724 | `SESSION_ACTIVE` (conductor) | `conductor.status` 遷移 |
| 733-735 | `SESSION_IDLE` (master) | 同上 |
| 741-760 | `SESSION_IDLE` (conductor) | 同上 |
| 775-802 | `SESSION_CLEAR` | `conductor.status="idle"` or `resetConductor` 呼び出し |
| 810 | `SHUTDOWN` | `state.running = false` |
| 909-910, 921-922 | `scanTasks` | `idleConductor.status = "disconnected"`（assign 失敗） |
| 926 | `scanTasks` | `state.conductors.set(updated.surface, updated)` |
| 963-965 | `spawnPidWatcher` | `conductor.status="disconnected"` |
| 994-996 | `spawnMasterPidWatcher` | master status="disconnected" |
| 1056-1057 | `monitorConductors` | starting timeout → disconnected |
| 1106-1108 | `monitorConductors` | `treeFailureCount` 加算（UI 表示に影響しないため emit 省略可。§3.5） |
| 1129-1130 | `monitorConductors` | unresponsive threshold → disconnected |
| 1148-1149 | `monitorConductors` | missing → disconnected |
| 1161 | `monitorConductors` | `conductor.agents.splice` |

> **scanTasks の `state.taskList` 再構築（L825-862）は特殊扱い**。tick 毎に無条件に再構築されるため emit すると冗長になる。§3.5 で「差分比較ベースで emit」方針を決める。

#### `main.ts`（CLI コマンド — HTTP 経由で daemon プロセスに postMessage）

CLI 側は **別プロセス**で実行されるため、プロセス内 eventBus では通知できない。既存の `postMessage(TASK_CREATED / TASK_UPDATED / CONDUCTOR_DONE)` → daemon の `handleMessage` → `requestWakeup` → 次 tick → `scanTasks` 内の実 mutation 点で notify される経路に委ねる。**CLI 側には notify を追加しない**（§3.4 で確定）。

### 2.3 T183 との関係

- T183（d787355）で `update-task` / `close-task` / `abort-task` / `restart-task` / `delete-task` の全更新パスで `postMessage TASK_UPDATED` or `TASK_CREATED` が送信される形に統一済み
- `daemon.ts:541-547` の `handleMessage/TASK_UPDATED` は `requestWakeup(state)` を呼ぶだけ。wakeup で `tick()` が走り `scanTasks` が state を更新し、**scanTasks 内部で state が実際に変化した点で notify** する
- **統合方針**: T183 の HTTP → handleMessage → requestWakeup → tick パスは維持する。eventBus は **tick 内部の mutation** と **handleMessage 内部の mutation（ただし実 mutation 点のみ）** を即時 TUI 反映するために追加する

### 2.4 queue.ts の状態

`queue.ts` は本 worktree 時点では削除済み（`queue.test.ts` のみ残存）。メッセージングは `proxy.ts` の HTTP API（`onMessage` コールバック → `handleMessage`）に一本化されている。本タスクで queue.ts に手を入れる必要はない。

## 3. 設計

### 3.1 eventBus.ts の API

採用方針: **案 B（YAGNI）**。MVP では `state-changed` 単一 event のみ、`notifyStateChanged(source: string)` のみを export する。`Event` discriminated union は導入しない。新 event 種別が必要になった時点で型を追加し、その時点で `notifyStateChanged` の signature も `notify(ev: Event)` にリファクタリングする（§3.2 拡張ポリシー参照）。

```ts
// skills/cmux-team/manager/eventBus.ts
import { EventEmitter } from "events";
import { log } from "./logger";

const bus = new EventEmitter();  // module 外に一切 export しない

const TRACE = !!process.env.CMUX_TEAM_TRACE_EVENTS;

export function notifyStateChanged(source: string): void {
  bus.emit("state-changed");
  if (TRACE) {
    log("event_emit", `event=state-changed source=${source}`).catch(() => {});
  }
}

export function onStateChanged(cb: () => void): () => void {
  bus.on("state-changed", cb);
  return () => bus.off("state-changed", cb);
}

// テスト用（prod 経路では未使用）
export function __resetBusForTest(): void {
  bus.removeAllListeners();
}
```

設計ポイント:

- `bus` を module-private に閉じ、`bus.emit` / `bus.on` の直接呼び出しを不可能にする → grep で検知可能
- `source` は必須引数。`"conductor.ts:assignTask:status-running"` のような行名付き文字列を渡す
- logger の `log()` は async だが、notify は fire-and-forget（発火タイミングが UI レイテンシに直結するため await しない）。失敗は無視
- TRACE フラグは **モジュール読み込み時に一度だけ評価**。起動後の切り替えは想定しない（テスト方法は §6 参照）
- **循環依存禁止**: `logger.ts` は `eventBus.ts` を import してはならない。逆方向のみ許可（§R6）

### 3.2 Event 型の扱い

採用: **案 B（YAGNI）**。理由:

- 現時点では `state-changed` 単一で十分、union 型は未使用の孤立型になる（Design Review Minor 指摘 R5）
- 将来 event 種別を増やす際に型駆動リファクタ（Find All References で一括置換）が容易
- `notifyStateChanged(source: string)` の方が callsite が簡潔で実装コストが低い

**拡張ポリシー**（docs/spec に記載）:

- 新 event 種別を追加する時点で `Event` discriminated union を導入し、汎用 `notify(ev: Event)` + 種別ごとのラッパー（`notifyStateChanged` / `notifyTaskAssigned` 等）にリファクタリングする
- subscriber 側は `switch(ev.type)` + `never` チェックで exhaustiveness を担保する

### 3.3 T183 postMessage との役割分担

| 層 | 手段 | 用途 |
|---|---|---|
| プロセス間（CLI → daemon） | HTTP POST `/api/messages` → `handleMessage` | 外部トリガの伝播。`requestWakeup` で次 tick を起こす |
| daemon プロセス内（実 state mutation 点） | `eventBus.notifyStateChanged` | state mutation → TUI refresh の即時通知 |

**結論**: 併存。CLI 側の `postMessage` 呼び出しは削除しない。daemon 側は **実際に state が変化した箇所でのみ notify** する。

### 3.4 TASK_CREATED / TASK_UPDATED 受信時の notify 要否（R2 解消）

- `handleMessage/TASK_CREATED`（L537 付近）と `handleMessage/TASK_UPDATED`（L545 付近）は `requestWakeup(state)` を呼ぶだけで、**state を mutate しない**
- したがって **handleMessage 内では notify を追加しない**
- `requestWakeup` → 次 tick の `scanTasks` 内で state が実際に変化した点（L909/921 の disconnected 遷移、L926 の conductor.set、§3.5 の taskList 差分検出）で notify される
- main.ts CLI コマンドにも notify を追加しない（別プロセスのため到達不能、かつ上記経路で TUI 反映される）

### 3.5 scanTasks `taskList` 再構築時の emit 方針（R3 対応）

scanTasks は tick 毎に `state.taskList` / `state.openTasks` / `state.pendingTasks` を再構築する。内容に変化がなくても tick 毎に emit するとアイドル時にも refresh がスケジュールされ続ける（debounce で 1 回に集約されるが、「アイドル時は止まる」原則と馴染まない）。

**採用方針**: **差分検出ベース**。

- scanTasks 開始時の `state.taskList` / `state.openTasks` / `state.pendingTasks` のスナップショットを取る
- 再構築完了後、以下のいずれかが変化していたら `notifyStateChanged("daemon.ts:scanTasks:task-list-changed")` を呼ぶ:
  - `openTasks` の件数
  - `pendingTasks` の length
  - `taskList` の `JSON.stringify(taskList.map(t => ({ id: t.id, status: t.status, title: t.title })))` ハッシュ（or 直接文字列比較）
- 差分計算コストは tick 頻度（10 秒間隔、タスク数 < 100）では無視できる
- `treeFailureCount` のように UI 未反映のフィールドは notify しない

### 3.6 scheduleRefresh 置換 vs 併存の判断

**併存を採用**。

- 既存 `main.ts:578` の tick 後 `scheduleRefresh()` は **削除せず残す**
- `dashboard.tsx` 側で `onStateChanged(() => scheduleRefresh())` を登録する新経路を追加
- 100 ms debounce が `scheduleRefresh` 側に既に存在するため、notify が短時間に多数発火しても描画は 1 回に集約される（安全側）
- 既存テストや boot phase の明示的 refresh（`main.ts:526` 等）も破壊しない

## 4. 実装手順（順序付き・ファイル単位・テスト可能単位）

### Step 1: eventBus.ts 新規作成

- **ファイル**: `skills/cmux-team/manager/eventBus.ts`（新規）
- **内容**: §3.1 の通り。EventEmitter を module-private に保持、`notifyStateChanged` / `onStateChanged` / `__resetBusForTest` を export
- **テスト**: `eventBus.test.ts`（新規）
  - 基本動作: `notifyStateChanged("x")` → 登録済み callback が呼ばれる
  - unsubscribe: `onStateChanged` の戻り値で off できる
  - `__resetBusForTest` で listener 全削除
  - TRACE フラグ検証（§R7 対応、必要なら別ファイル `eventBus.trace.test.ts`）:
    - TRACE フラグは module load 時に 1 回評価されるため、**動的 import** で検証する
    - 先頭で `process.env.CMUX_TEAM_TRACE_EVENTS = "1"` を設定 → `await import("./eventBus")` で動的ロード
    - notify 後に logger の出力先（tmp dir にリダイレクト）に `event_emit event=state-changed source=xxx` が書かれることを検証
    - 検証後 `delete process.env.CMUX_TEAM_TRACE_EVENTS`
  - logger 出力先の切り替えは `PROJECT_ROOT` 環境変数 or logger 側のモックを使う
- **検収**: `bun test skills/cmux-team/manager/eventBus.test.ts`（および `eventBus.trace.test.ts`）が緑

### Step 2: dashboard.tsx で subscribe

- **ファイル**: `skills/cmux-team/manager/dashboard.tsx`
- **変更箇所**:
  - `return { scheduleRefresh }` の直前（L1316 付近）に `const unsubscribe = onStateChanged(() => scheduleRefresh());` を追加
  - **cleanup 関数（L1320 以降、`dashboardActive = false` / `clearInterval` を含む関数）** の内部で `unsubscribe();` を呼ぶ
  - `unsubscribe` 変数は cleanup 関数から参照可能なスコープ（`startDashboard` 関数内、return オブジェクトの上位）に宣言する
- **import 追加**: `import { onStateChanged } from "./eventBus"`
- **検収**: 既存 dashboard テスト（あれば）が緑。手動で mount → unmount して listener leak がないことを確認（`bus.listenerCount("state-changed")` が 0 に戻る）

### Step 3: conductor.ts に notify を挿入（R1 対応で最小限）

- **対象**: 実 ConductorState mutation 点のみ
  - `conductor.ts:L481` 直後（`assignTask` の `status="running"` を含む一連の代入完了直後）: `notifyStateChanged("conductor.ts:assignTask:status-running")`
  - `conductor.ts:L572` 直後（`resetConductor` の `status="idle"` + フィールドクリア完了直後）: `notifyStateChanged("conductor.ts:resetConductor:status-idle")`
- **挿入しない**:
  - L353（ローカル変数 `worktreeCreated`）
  - L395（direnv allow 完了）
  - L423（prompt file 生成完了）
  - L442（cmux send 完了）
  - L559（renameTab 完了）
  - 理由: §2.2 / §R1 に記載の通り、これらは ConductorState を mutate しないため TUI 描画内容が変わらない
- **import 追加**: `import { notifyStateChanged } from "./eventBus"`

### Step 4: daemon.ts の handleMessage / scanTasks / monitorConductors に notify を挿入

- **tick 終端**: main.ts ループ末尾 `scheduleRefresh()` が既に存在するため、`tick` 自体には挿入不要
- **handleMessage** — 各 case の **実 state mutation 直後**:
  - `TASK_CREATED`, `TASK_UPDATED`: `requestWakeup` のみで state 変更なし → **notify 不要**（§3.4）
  - `CONDUCTOR_DONE` (L578 `handleConductorDone` 後): resetConductor 経由で mutation 発生 → resetConductor 側で既に notify される。ただし done マーカー削除など handleConductorDone 固有の state 変更があれば追加 notify する（実装時に確認）
  - `AGENT_SPAWNED` (L596 直後): `notifyStateChanged("daemon.ts:handleMessage:agent-spawned")`
  - `SESSION_STARTED` master (L605 直後): `notifyStateChanged("daemon.ts:handleMessage:session-started-master")`
  - `SESSION_STARTED` conductor (L622 直後): `notifyStateChanged("daemon.ts:handleMessage:session-started-conductor")`
  - `CONDUCTOR_REGISTERED` (L641 直後): `notifyStateChanged("daemon.ts:handleMessage:conductor-registered")`
  - `CONDUCTOR_SESSION` (L649 直後): `notifyStateChanged("daemon.ts:handleMessage:conductor-session")`
  - `SESSION_ENDED` (L668/684/694 各 mutation 直後): `session-ended-{master|conductor|agent}`
  - `SESSION_ACTIVE` (L711/724): `session-active-{master|conductor}`
  - `SESSION_IDLE` (L735/760): `session-idle-{master|conductor}`
  - `SESSION_CLEAR` (L802): `resetConductor` 経由パスは conductor.ts 側で notify 済み。直接 `status="idle"` を代入するパスがあればそこで notify する
  - `SHUTDOWN` (L810 直後): `notifyStateChanged("daemon.ts:handleMessage:shutdown")`
- **scanTasks**（§3.5 差分検出方針）:
  - 開始時に `{ openTasks, pendingTasks, taskListHash }` スナップショットを取る
  - 再構築後に差分あり → `notifyStateChanged("daemon.ts:scanTasks:task-list-changed")`
  - L909/921 `idleConductor.status = "disconnected"` 直後: `notifyStateChanged("daemon.ts:scanTasks:conductor-disconnected")`
  - L926 `state.conductors.set(updated.surface, updated)` 直後: `notifyStateChanged("daemon.ts:scanTasks:conductor-updated")`（assignTask 内でも notify 済みだが debounce で吸収）
- **monitorConductors**:
  - L1056 starting timeout → disconnected 直後: `monitor:starting-timeout`
  - L1129 unresponsive threshold → disconnected 直後: `monitor:unresponsive-threshold`
  - L1148 missing → disconnected 直後: `monitor:surface-missing`
  - L1161 `conductor.agents.splice` 直後: `monitor:agent-removed`
  - L1106-1108 `treeFailureCount` 加算は UI 未反映 → **notify 不要**
- **spawnPidWatcher** (L965 `status="disconnected"` 直後): `pid-watcher:conductor-disconnected`
- **spawnMasterPidWatcher** (L996 master status="disconnected" 直後): `pid-watcher:master-disconnected`
- **import 追加**: `import { notifyStateChanged } from "./eventBus"`

### Step 5: main.ts CLI コマンドの扱い（R2 対応）

- CLI コマンド（`cmdUpdateTask` 等）は **別プロセス**で実行されるため、そのプロセス内で `notifyStateChanged` を呼んでも daemon 側の TUI には伝わらない
- 既存の `postMessage(TASK_UPDATED 等)` → daemon の `handleMessage` で `requestWakeup` → 次 tick → `scanTasks` 内差分検出 notify（§3.5）で TUI 反映される
- **結論**: `main.ts` CLI コマンドには notify を追加しない。`handleMessage/TASK_CREATED` / `TASK_UPDATED` 受信側にも追加しない（§3.4）。前版の「Step 5 で TASK_UPDATED / TASK_CREATED に notify を追加する」記述は撤回する

### Step 6: docs/spec に Event Catalog 追記

- **ファイル**: `docs/spec/05-install-and-infrastructure.md`
- **配置**: `## Manager Daemon（TypeScript）` セクション配下、末尾に新設サブセクション追加
- **新設サブセクション**: `### Event Catalog（eventBus.ts）`

```markdown
### Event Catalog（eventBus.ts）

daemon プロセス内の **実 state mutation** → TUI refresh を疎結合に接続するための EventEmitter ラッパー。

| event | payload | emitter（実 mutation 点） | subscriber |
|---|---|---|---|
| state-changed | source: string | conductor.ts (assignTask L481, resetConductor L572), daemon.ts (handleMessage 各 case の実 mutation 直後, scanTasks 差分あり時, monitorConductors/pidWatcher の status 遷移) | dashboard.tsx (scheduleRefresh 経由で 100ms debounce 描画) |

**追跡性ガイドライン**:

- `bus.emit` / `bus.on` の直接呼び出しは eventBus.ts 外では禁止（grep で 0 件になることを確認）
- emit は必ず `notifyStateChanged(source)` ラッパー経由。source には `"<ファイル>:<関数>:<理由>"` 形式の文字列を渡す
- emit は **実際に state が mutate した直後のみ**。中間処理完了点（外部コマンド終了、ローカル変数更新）では emit しない
- `CMUX_TEAM_TRACE_EVENTS=1` で起動すると `manager.log` に `event_emit event=state-changed source=...` が記録される（デバッグ用）
- 新 event を追加する場合は `Event` discriminated union を導入し、専用 `notify*` ラッパーを export する
- `logger.ts` は `eventBus.ts` を import してはならない（循環依存禁止）
```

### Step 7: CLAUDE.md にポリシー追記

- **ファイル**: `CLAUDE.md`
- **配置**: 「## ロギングポリシー」直後に「## EventBus ポリシー」を新設
- **内容**:

```markdown
## EventBus ポリシー

daemon 内の **実 state mutation** → TUI refresh は `eventBus.ts` 経由で通知する。

- `notifyStateChanged(source)` / `onStateChanged(cb)` のみ使用可
- `bus.emit` / `bus.on` の直接呼び出しは `eventBus.ts` 外では禁止（`rg "bus\\.(emit|on)\\b" skills/cmux-team/manager | rg -v eventBus.ts` で 0 件を維持）
- emit は **実際に state が変化した直後のみ**。中間処理の完了点（外部コマンド終了、ローカル変数更新）では emit しない。「emit 箇所 = state mutation 箇所」の不変条件を維持する
- source 引数は `"<ファイル>:<関数>:<理由>"` 形式で呼び出し位置を明示する
- `CMUX_TEAM_TRACE_EVENTS=1` で emit ログが `manager.log` に出力される
- `logger.ts` は `eventBus.ts` を import してはならない（循環依存禁止）
```

### Step 8: ビルド・テスト・e2e

- `cd skills/cmux-team/manager && bun test` で既存テスト緑
- `bun run main.ts start` で実機起動、`update-task --status ready` を叩き TUI 即時反映を**目視確認**（1 秒以内を目安）
- `CMUX_TEAM_TRACE_EVENTS=1` で起動し `manager.log` に `event_emit` が出ることを確認
- `rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts` で **0 件**を確認
- `rg notifyStateChanged skills/cmux-team/manager` で emit 箇所が列挙できること（件数は結果であり目標ではない）

## 5. 影響範囲・リスク

### 影響範囲

- 新規: `eventBus.ts`, `eventBus.test.ts`, 必要に応じて `eventBus.trace.test.ts`
- 編集: `conductor.ts`, `daemon.ts`, `dashboard.tsx`, `docs/spec/05-install-and-infrastructure.md`, `CLAUDE.md`
- 既存 `postMessage` 経路・`scheduleRefresh` 経路は**削除しない**

### リスク

| リスク | 対策 |
|---|---|
| notify の発火回数が増え、refresh が頻発して TUI がちらつく | `scheduleRefresh` 内の 100 ms debounce が吸収する（既存実装を流用）。§3.5 の差分検出で idle 時は 0 回に抑制 |
| cleanup 時に listener が残って GC されない | dashboard の cleanup で `unsubscribe()` を呼ぶ（§Step 2 で変数スコープ明示） |
| テスト時に bus の listener が他テストに漏れる | `__resetBusForTest` を export し `beforeEach` で呼ぶ |
| 新人が `bus.emit` を直接書いて追跡性が崩れる | CLAUDE.md に明文化 + grep チェック手順を明記 |
| 「emit 箇所 = mutation 箇所」の不変条件が将来破られる | CLAUDE.md / docs/spec に明記。コードレビュー観点に含める |
| TRACE ログ大量出力で disk 食い潰し | デフォルト無効。オプトインのみ（将来の分離ログ化は §9 Open Questions） |
| 循環依存（logger ↔ eventBus） | eventBus → logger の一方向。logger は eventBus を import しない（ポリシー明記） |

### 後方互換性

- 既存テストに破壊的変更なし（`scheduleRefresh` 経路を残すため）
- `CMUX_TEAM_TRACE_EVENTS` 未設定時の挙動は従来と同じ

## 6. テスト計画

### ユニット

- `eventBus.test.ts`
  - notify → cb 発火
  - unsubscribe で off される
  - `__resetBusForTest` で listener 全削除
- `eventBus.trace.test.ts`（§R7 対応。TRACE フラグが module load 時評価のため別ファイル化）
  - 先頭で `process.env.CMUX_TEAM_TRACE_EVENTS = "1"` 設定 → `await import("./eventBus")` で動的ロード
  - notify 後に logger の出力先（tmp dir）に `event_emit event=state-changed source=xxx` が書かれる
  - テスト終了時に `delete process.env.CMUX_TEAM_TRACE_EVENTS`

### 統合（既存テストへの回帰）

- `conductor.test.ts` / `daemon.test.ts` を既存のまま実行。notify 追加が挙動を変えないこと
- `dashboard` の mount/unmount テストがあれば cleanup 時 unsubscribe 確認（`bus.listenerCount("state-changed")` 0 復帰）

### 手動 e2e（CLAUDE.md の E2E 手順に従う）

1. `cmux-team start` で起動
2. `cmux-team create-task --title "..." --status ready --body "..."` → TUI Tasks に 1 秒以内に反映（目視）
3. Conductor に割り当てられた瞬間（status="running" 代入直後）、TUI Conductors の該当行が `running` に即時遷移
4. `cmux-team abort-task --task-id XXX` → TUI 即時更新
5. `CMUX_TEAM_TRACE_EVENTS=1 cmux-team start` → `.team/logs/manager.log` に `event_emit event=state-changed source=...` 多数

**1 秒以内の測定方法**: 本タスクでは **目視で即時反映されること**を基準とする。厳密なタイミング測定が必要になった場合は別タスクで計測ログ（`refresh_triggered_by_event` 等）を追加する（§9 Open Questions）。

### grep 検査（CI 不要、手動）

```bash
rg notifyStateChanged skills/cmux-team/manager
rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts   # 0 件
```

## 7. ドキュメント更新

| ファイル | 変更 |
|---|---|
| `docs/spec/05-install-and-infrastructure.md` | `### Event Catalog（eventBus.ts）` サブセクション追加（Manager Daemon 配下） |
| `CLAUDE.md` | `## EventBus ポリシー` セクション追加（ロギングポリシー直後。logger 循環依存禁止を含む） |
| `docs/spec/06-implementation-tasks.md` | T184 実装記録を追記（必要なら） |

README の変更は不要。ユーザー向け機能ではないため。

## 8. 受け入れ基準チェックリスト

- [ ] `skills/cmux-team/manager/eventBus.ts` が存在し、`EventEmitter` を module-private に保持している
- [ ] `notifyStateChanged(source)` / `onStateChanged(cb)` / `__resetBusForTest` が export されている（`Event` union は未導入）
- [ ] `rg notifyStateChanged skills/cmux-team/manager` で emit 箇所が列挙でき、**全点が実 state mutation 直後**に配置されている
- [ ] `rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts` が 0 件
- [ ] `CMUX_TEAM_TRACE_EVENTS=1` で起動時に `manager.log` に `event_emit event=state-changed source=...` 行が出る
- [ ] `cmux-team update-task --status ready` 実行から **目視で即時**（1 秒程度の目安内）TUI Tasks 表示が更新される
- [ ] ready タスク → Conductor 割当完了の瞬間（status="running" 代入直後）、TUI Conductors 表示が `running` に遷移する
- [ ] `dashboard.tsx` の cleanup で `onStateChanged` の unsubscribe が呼ばれる（listener leak なし）
- [ ] `docs/spec/05-install-and-infrastructure.md` に Event Catalog セクションが存在する
- [ ] `CLAUDE.md` に EventBus ポリシーが明記され、**logger 循環依存禁止**が含まれている
- [ ] `bun test skills/cmux-team/manager` が緑（既存テストを破壊していない）
- [ ] `eventBus.test.ts`（および必要に応じて `eventBus.trace.test.ts`）が追加され緑
- [ ] scanTasks の notify が **差分検出ベース**（taskList 内容・openTasks 件数・pendingTasks length 比較）で実装されている

## 9. Open Questions（未決事項・別タスク候補）

Design Review で提起された以下の項目は本タスクのスコープ外とし、必要なら別 issue として切り出す:

1. **進捗 phase 可視化**: worktree 作成中〜prompt 送信完了までの中間状態（数秒〜数十秒）を TUI に表示したい場合は、`ConductorState.phase`（`"worktree-creating" | "bootstrapping" | "sending-prompt" | null`）フィールドを追加し、各 phase 遷移で mutate + notify する別タスクとする
2. **scheduleRefresh の完全 event 駆動化**: `main.ts:578` の tick 後 `scheduleRefresh()` を将来削除するかどうか。併存で安定動作を確認してから別タスクで検討
3. **受け入れ基準「1 秒以内」の自動計測**: 目視確認から計測ログ（`refresh_triggered_by_event` 等）ベースに移行するかどうか
4. **grep チェックの CI / pre-commit hook 化**: `rg "bus\.(emit|on)\b" ...` の 0 件確認を自動化するか
5. **TRACE ログの専用ファイル分離**: `manager.trace.log` に分離して `manager.log` 肥大化を防ぐか

## 改訂履歴

### v2（本版）— Design Review 反映

Design Review（Changes Requested）の Major 指摘 2 件と Minor 指摘を反映:

| 指摘 | 反映内容 |
|---|---|
| **R1 [Major]** conductor.ts の notify 挿入点が state mutation 点ではない | §2.2 / §Step 3 を刷新。L353/L395/L423/L442/L559 の notify を削除し、**L481（assignTask status-running）と L572（resetConductor status-idle）のみ**に絞る。§9 Open Questions に phase 可視化を別タスクとして記載 |
| **R2 [Major]** Step 4 と Step 5 の内部矛盾 | §3.4 / §Step 4 / §Step 5 を整合。`TASK_CREATED` / `TASK_UPDATED` は **handleMessage 内でも CLI 側でも notify しない**方針に統一。`requestWakeup` → 次 tick → `scanTasks` 内差分検出で notify される経路に委ねる |
| **R3 [Minor]** scanTasks L851 の notify を差分あり時のみに絞る | §3.5 追加。openTasks 件数 / pendingTasks length / taskList ハッシュの差分検出ベースに変更 |
| **R4 [Minor]** Step 2 の行番号修正 | §2.1 / §Step 2 で cleanup 関数が L1320 以降であることを明記。unsubscribe 変数のスコープ配置も追記 |
| **R5 [Minor]** Event 型と API の整合 | §3.1 / §3.2 で **案 B（YAGNI）採用**を明記。`Event` union は導入せず `notifyStateChanged(source: string)` のみ export。拡張時の手順を明記 |
| **R6 [Minor]** logger 循環依存禁止を CLAUDE.md に追記 | §Step 7 のポリシー文に追加。§Step 6 の Event Catalog にも明記 |
| **R7 [Minor]** TRACE フラグ検証方法の明確化 | §Step 1 / §6 で動的 import + 別ファイル（`eventBus.trace.test.ts`）方式を明記 |
| **受け入れ基準「15 箇所以上」** | 箇所数を目的化しない方針に修正。§1 / §8 から数値基準を削除 |
| **受け入れ基準「1 秒以内」** | 目視確認ベースに緩和。厳密計測は §9 Open Questions へ |

### v1 — 初版

初版 plan（Design Review で Changes Requested）。
