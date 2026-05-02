# T353 実装計画書: Journal に daemon lifecycle / resume イベントを追加

## 0. 計画の前提（重要な発見）

調査で判明した「task の前提と異なる点」を最初に明示する。実装はこれらを踏まえて進める。

### 0.1 `buildJournalRows` の `isValidTaskId` フィルタ

`dashboard.tsx:985` の `buildJournalRows` が `entries.filter((e) => isValidTaskId(e.taskId))` で taskId 無効なエントリを **表示前に捨てている**。
daemon_started / daemon_stopped / daemon_reload は taskId を持たないため、`parseJournalEntries` に追加するだけでは Journal タブに **1 行も出ない**。

解決方針（後述 §6）:
- `buildJournalRows` の filter 条件を「daemon sentinel taskId（`__daemon__`）も通す」ように緩める
- 描画分岐で「sentinel のときは `T###` を出さない」ようにする

これは task.md には書かれていない非自明な変更点なので、plan の中心テーマとして扱う。

### 0.2 `state.startedAt` は **存在しない**

`DaemonState` (`daemon.ts:61-149`) には `startedAt` フィールドが無い（`ConductorState.startedAt` / `MasterState.startedAt` はある）。
`daemon_stopped` で uptime を出すには **新フィールド `startedAt: string` を `DaemonState` に追加する**必要がある。

### 0.3 既存 `daemon_started` detail に既に「ほぼ」必要な情報がある

`main.ts:667-670`:
```ts
await log(
  "daemon_started",
  `${state.version} pid=${process.pid} poll=${state.pollInterval}ms max_conductors=${state.maxConductors} layout=${state.layout} sleep_prevention=${sleepPrevention}`
);
```
- version は **detail の先頭の bare token**（`v3.45.0` 形式、key=value ではない）
- `restored_conductors=N` / `open_tasks=M` は **未含有**

しかし `daemon_started` ログは `startMaster` / `restoreMasters` / Conductor resume よりも **前に書かれる**。
つまり「daemon_started を 1 行に集約して resumed N conductors / M tasks を併記する」案は **ログ順を変えると E2E (`e2e.ts:269` の `waitForLog("daemon_started", 30_000)`) を壊す**。

### 0.4 既存 `boot_completed` イベントが resume 完了直後に存在する（**重要な再評価**）

`main.ts:1133` に既に `await log("boot_completed");` があり、これは:
- `state.bootPhase = "ready"` が立った直後
- `initializeLayout` → resume 反映ループ完了 → `startMaster`（内部で `restoreMasters`）完了 後

つまり **plan §0.3 で当初検討していた「resume 集約サマリーの emit 地点」とほぼ同位置に既に boot 完了マーカーが存在する**。
現状の detail は **空文字**（`await log("boot_completed");`）。`daemon.test.ts:3720` ではコメントでのみ言及（テスト対象外）。

このため設計選択肢を再列挙する:

| 案 | 概要 | pros | cons |
|---|---|---|---|
| A | `daemon_started` を遅延 emit、detail に集約 | 1 行で完結 | E2E `waitForLog("daemon_started")` の起動同期点を壊す |
| B | `daemon_started` 既存 + 新規 `daemon_resume_summary` 追加 | 既存非破壊 | 行が分散、命名が冗長 |
| C | `daemon_started` 既存 + 新規 `daemon_ready` 追加 | resume 集約を独立 event 名で表現 | 新規 event 名の追加 |
| **D** | `daemon_started` 既存 + **`boot_completed` の detail を拡張** | 既存 event 流用、命名衝突なし、log 検索性高、E2E 非破壊 | event 名 `boot_completed` のセマンティクスが拡張される |

**採用: 案 D**。理由:
- `boot_completed` は既に「boot 完了マーカー」として存在し、emit 地点が plan の要求（resume 反映ループ完了 + master spawn 完了の直後）と一致
- 新 event 名を増やさないことで log 検索性・テスト fixture 命名のブレを防げる
- E2E の `waitForLog("daemon_started")` も `boot_completed` も両方そのまま動き続ける
- 現状 detail が空なので、フォーマットを規定しても regression 影響は無い

Journal の ▲ 行は **`boot_completed` をソースイベント**として描画する。`daemon_started` は **log タブのみ** で利用継続。
仕様の icon `▲` / 色 CYAN / フォーマット文字列は task.md の指定通り。

---

## 1. 既存 emit 箇所の調査結果

### 1.1 `daemon_started`
- 場所: `main.ts:667-670`
- detail: `<version> pid=<N> poll=<N>ms max_conductors=<N> layout=<wide|16x9> sleep_prevention=<true|false>`
- 例: `v3.45.0 pid=12345 poll=2000ms max_conductors=2 layout=16x9 sleep_prevention=true`
- Journal には出さない（log タブのみ）。E2E が `waitForLog("daemon_started")` を握っているため形式変更も避ける

### 1.2 `boot_completed`（**Journal ソース**）
- 場所: `main.ts:1133`
- 現状 detail: **空文字**
- 起動順: `daemon_started` (`main.ts:667`) → infra → `initializeLayout` (`main.ts:1080`, A/B/D + topup の resume を行い `ResumeAssignment[]` を返す) → resume 反映ループ (`main.ts:1101-1120`) → `startMaster` (`main.ts:1127`) → `state.bootPhase = "ready"` → **`boot_completed` (`main.ts:1133`)** → 以降 main loop
- 拡張後 detail: `version=<X> restored_conductors=<N> open_tasks=<M>` （詳細 §3.3）

### 1.3 `daemon_stopped`
- 場所: `main.ts:823`（shutdown 関数内、SIGINT/SIGTERM ハンドラ）
- 現状 detail: **空文字**
- 拡張: `uptime_sec=<N>` を追加（§3.4）

### 1.4 `daemon_reload`
- 場所: `main.ts:838`（onReload コールバック）
- detail: 空。直後に `daemon_reload_target <ts>` を別行で emit (`main.ts:839`)
- reload は親 daemon が `execFileSync("bun", ["run", latestMainTs, "start"])` で子 daemon を起動。子 daemon は通常通り `daemon_started` → ... → `boot_completed` を emit する
- **Journal の `daemon_reload` は出さない** — 後述 M2/§6.2 を参照（task spec の「正常時 3 行以内」を守るため）

### 1.5 `master_restored`
- 場所: `daemon.ts:922-925`（`restoreMasters` 内）
- detail: `<formatSurface(m.surface, "U")> pid=<N> via=pid`
- task.md L33 の集約サマリーに含めるか? → 含めない（§3.3 / M3 で論じる）

### 1.6 `conductor_resume_launch_failed`
- 場所: `daemon.ts:1200-1203`（`applyRestorePlan` の B 経路 catch）
- detail: `task_id=<id> C[<surface>] <error.message>`
- Journal 表示: `✕ resume failed C[121] T350 — launch_error: <reason>` / RED

### 1.7 `resume_worktree_missing_late`
- 場所: `daemon.ts:1145-1148`（`applyRestorePlan` の B 経路、`existsSync(worktreePath)` 失敗時）
- detail: `task_id=<id> C[<surface>] worktree=<path>`
- Journal 表示: `✕ resume failed C[121] T350 — worktree_missing` / RED

### 1.8 `resumeAssignments` の中身（**A 経路 / B 経路の判別**）

`applyRestorePlan` (`daemon.ts:1093-1236`) の戻り値 `ResumeAssignment[]`:
- **A 経路（keep-alive）= `plan.alive`** は `state.conductors.set` のみ行い `assignments.push` **しない** (`daemon.ts:1099-1131`)
- **B 経路（resumeExisting）** は `launchConductor` 成功時のみ `assignments.push` (`daemon.ts:1182-1189`)
- `applyRestorePlan` の後、`initializeLayout` で topup（`initializeConductorSlots`）が呼ばれ、その戻り値 `addl` も `assignments.push(...addl)` される (`daemon.ts:1404-1414`)。`initializeConductorSlots` は `resumeItem` が存在する pane だけ assignment を push (`conductor.ts:241-248`)

つまり `resumeAssignments.length` = 「**実際に launchConductor で再 spawn された resume 数**（B 経路成功 + topup-resume）」。A 経路（既に PID alive）はカウントされない。

→ task.md L40 「resumed 2 conductors」のセマンティクスと整合（=実際に resume launch された数）。**そのまま `restoredConductors = resumeAssignments.length` で良い**。

---

## 2. 既存 `parseJournalEntries` の構造

`dashboard.tsx:338-381`:
- 入力: `lines: string[]`（各行は `[<ISO timestamp>] <event> <detail>`）
- 行ヘッダ regex: `/^\[([^\]]+)\]\s+(\S+)\s*(.*)/`
- イベント別 if-else 分岐:

| 既存イベント | icon (nerd) | fallback | level | iconColor |
|---|---|---|---|---|
| `task_received` | `` | `[+]` | info | CYAN |
| `conductor_started` | `` | `[▶]` | warn | YELLOW |
| `task_completed` | `` | `[✓]` | info | GREEN |
| `task_aborted` | `` | `[✕]` | error | RED |
| `task_deleted` | `` | `[−]` | warn | YELLOW |

抽出パターン:
- `taskId`: `detail.match(/task_id=(\S+)/)?.[1]`
- `title`: `detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1]`
- `journal_summary`: `detail.match(/journal_summary=(.+)/)?.[1]`
- `surface`: `extractSurface(detail)`（旧 `surface=surface:NNN` / 新 `[CAMUS]\[NNN\]`）

無効 taskId（`isValidTaskId`: 空 / `?` / `undefined`）は `continue` で skip。

---

## 3. emit 側の実装手順

### 3.1 `DaemonState` に `startedAt` を追加

`daemon.ts:61` の `DaemonState` インターフェイスに新フィールドを追加:

```ts
/** T353: daemon プロセスの起動時刻（ISO 8601）。daemon_stopped の uptime 計算に使用 */
startedAt: string;
```

初期化箇所: `main.ts` の `cmdStart` で state を構築する箇所（`createInitialState` 等のヘルパが無ければ直接 `state.startedAt = new Date().toISOString()` を `daemon_started` 直前に追加）。

### 3.2 `daemon_started` detail はそのまま温存

既存の version/pid/poll/max_conductors/layout/sleep_prevention は破壊しない（E2E `waitForLog("daemon_started")` 維持）。
集約サマリーは **`boot_completed` の detail** に書く（§3.3）。

### 3.3 `boot_completed` の detail 拡張（**コア実装**）

`main.ts:1133` の `await log("boot_completed");` を以下に置き換える:

```ts
// resume 反映ループ + startMaster 完了時点では state.openTasks は scanTasks 未実行で
//   未確定（必ず 0）。task-state は applyTaskEvent で更新済みなので再 load して確定値を取る
const { tasks: tasksAtBoot } = await loadTasks(PROJECT_ROOT);
const openTasksCount = tasksAtBoot.filter(t => !isTerminalStatus(t.status)).length;
const restoredConductors = resumeAssignments.length;
await log(
  "boot_completed",
  `version=${state.version} restored_conductors=${restoredConductors} open_tasks=${openTasksCount}`,
);
```

ポイント:
- **`state.openTasks` を使わない**: `daemon.ts:2931` の `scanTasks` でのみ更新されるため、boot_completed emit 時点では必ず 0 になる（design-review C2）
- `loadTasks(PROJECT_ROOT)` は既に `main.ts:1011` で 1 度呼ばれているが、resume 反映で taskState (assigned ↔ ready) が変動するため **再 load する**
- `isTerminalStatus` は `daemon.ts:22` で既に `task` から import 済み。`main.ts:64` の import に追加
- `restoredConductors = resumeAssignments.length` は **B 経路成功 + topup-resume の合計**（A 経路 keep-alive は含まない、§1.8）
- `resumeAssignments` 変数は `main.ts:1080` の戻り値として既に in-scope。1133 行から参照可能
- Master 復元数 (`master_restored` の件数) は detail に **含めない**（§M3）

emit 例:
- 起動・resume あり: `boot_completed version=v3.45.0 restored_conductors=2 open_tasks=1`
- 起動・resume なし: `boot_completed version=v3.45.0 restored_conductors=0 open_tasks=0`

### 3.4 `daemon_stopped` detail に `uptime_sec` を追加

`main.ts:823` を以下に変更:

```ts
const uptimeSec = Math.max(
  0,
  Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000),
);
await log("daemon_stopped", `uptime_sec=${uptimeSec}`);
```

`Math.max(0, ...)` で時刻巻き戻り対策（NTP step / clock skew 防御）。

### 3.5 `daemon_reload` / 個別 resume 失敗ログは現状維持

emit 側の変更不要。`daemon_reload` detail は空のまま。`conductor_resume_launch_failed` / `resume_worktree_missing_late` も既存フォーマットを parser がそのまま読む。

---

## 4. parser 側の実装手順（`parseJournalEntries`）

`dashboard.tsx:338-381` の if-else チェーンに **4 ブランチ追加**（`daemon_reload` は M2/§6.2 で Journal 非表示に決定）。

### 4.1 `level` の選択

既存 `level` 型 `"info" | "warn" | "error"` を維持。`"system"` は追加しない（`parseLogLine` / `buildLogRows` への波及を避ける）。割当:

| 新ブランチ | level | 理由 |
|---|---|---|
| `boot_completed` | `info` | 正常起動 |
| `daemon_stopped` | `info` | 正常終了（dim 表示） |
| `conductor_resume_launch_failed` | `error` | 失敗 |
| `resume_worktree_missing_late` | `error` | 失敗 |

### 4.2 各ブランチの実装

```ts
} else if (event === "boot_completed") {
  const version = detail.match(/version=(\S+)/)?.[1] ?? "";
  const restored = parseInt(detail.match(/restored_conductors=(\d+)/)?.[1] ?? "0", 10);
  const openTasks = parseInt(detail.match(/open_tasks=(\d+)/)?.[1] ?? "0", 10);
  const summary = restored === 0
    ? "— fresh start"
    : `— resumed ${restored} conductor${restored === 1 ? "" : "s"} / ${openTasks} open task${openTasks === 1 ? "" : "s"}`;
  const versionStr = version ? ` ${version}` : "";
  result.push({
    time,
    icon: nerdIcon("", "▲"),  // nf-fa-arrow_up / fallback ▲
    taskId: DAEMON_SENTINEL_TASK_ID,
    message: `daemon started${versionStr} ${summary}`.trim(),
    level: "info",
    iconColor: CYAN,
  });
} else if (event === "daemon_stopped") {
  const uptimeSec = parseInt(detail.match(/uptime_sec=(\d+)/)?.[1] ?? "0", 10);
  result.push({
    time,
    icon: nerdIcon("", "▼"),  // nf-fa-arrow_down / fallback ▼
    taskId: DAEMON_SENTINEL_TASK_ID,
    message: `daemon stopped (uptime ${formatUptimeSec(uptimeSec)})`,
    level: "info",
    iconColor: CYAN,
    dim: true,                // §M1: dim?: boolean を JournalEntry に追加し parser 側でセット
  });
} else if (event === "resume_worktree_missing_late") {
  const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
  if (!isValidTaskId(taskId)) continue;
  const surface = extractSurface(detail);
  result.push({
    time,
    icon: nerdIcon("", "✕"),
    taskId,
    message: "resume failed — worktree_missing",
    level: "error",
    surface: surface || undefined,
    iconColor: RED,
  });
} else if (event === "conductor_resume_launch_failed") {
  const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
  if (!isValidTaskId(taskId)) continue;
  const surface = extractSurface(detail);
  // detail 末尾の `<error.message>` を抽出: "task_id=N C[surface] <message>"
  const reason = detail.replace(/^task_id=\S+\s+\S+\s*/, "").trim() || "unknown";
  result.push({
    time,
    icon: nerdIcon("", "✕"),
    taskId,
    message: `resume failed — launch_error: ${reason}`,
    level: "error",
    surface: surface || undefined,
    iconColor: RED,
  });
}
```

新ヘルパ `formatUptimeSec` を `dashboard.tsx` の `formatUptime` 近傍 (`:256`) に追加:

```ts
function formatUptimeSec(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
```

### 4.3 sentinel taskId の扱い

`DAEMON_SENTINEL_TASK_ID = "__daemon__"` を `dashboard.tsx` のローカル定数として定義。`isValidTaskId` は変えない（他箇所のロジックを壊さない）。

### 4.4 nerd font icon の確定

`nerdIcon(<nerd codepoint>, <ascii fallback>)` パターンを使う。**fix する codepoint**:

| 用途 | nerd codepoint | unicode名 | fallback |
|---|---|---|---|
| `boot_completed` ▲ | `` | `nf-fa-arrow_up` (U+F062) | `▲` |
| `daemon_stopped` ▼ | `` | `nf-fa-arrow_down` (U+F063) | `▼` |
| `conductor_resume_launch_failed` ✕ | `` | 既存（nf-fa-times 系、ASCII fallback `[✕]`） | `[✕]` |
| `resume_worktree_missing_late` ✕ | 同上 | 同上 | `[✕]` |

`daemon_reload` 用 ↻ codepoint は **不要**（M2 で Journal 非表示に決定）。

---

## 5. 表示側 (`buildJournalRows`) の改修

`dashboard.tsx:981-994` を以下に修正:

```ts
function buildJournalRows(entries: JournalEntry[], repoUrl: string | null) {
  if (entries.length === 0) {
    return [ui.text("no journal entries", { dim: true })];
  }
  return entries
    .filter((e) => isValidTaskId(e.taskId) || e.taskId === DAEMON_SENTINEL_TASK_ID)
    .map((entry) => {
      const isDaemon = entry.taskId === DAEMON_SENTINEL_TASK_ID;
      const dimStyle = entry.dim ? { dim: true } : {};
      return ui.row({ gap: 1 }, [
        ui.text(entry.time, { dim: true }),
        ui.text(entry.icon, entry.iconColor ? { style: { fg: entry.iconColor }, ...dimStyle } : dimStyle),
        isDaemon ? null : ui.text(`T${entry.taskId.padStart(3, "0")}`, { bold: true }),
        entry.surface ? ui.text(`[${entry.surface.replace("surface:", "")}]`, { dim: true }) : null,
        buildTitleWithLinks(entry.message, repoUrl),
      ]);
    });
}
```

ポイント:
- daemon sentinel は filter を通過させる
- daemon 行は `T###` を出さない（taskId カラムを省略）
- **dim 表示は icon 文字列マッチではなく `entry.dim` boolean フラグで判定**（§M1）

### 5.1 `JournalEntry` 型変更

`dashboard.tsx:244-252` に `dim?: boolean` を追加:

```ts
export interface JournalEntry {
  time: string;
  icon: string;
  taskId: string;
  message: string;
  level: "info" | "warn" | "error";
  surface?: string;
  iconColor?: number;
  /** T353: dim 表示するか（daemon_stopped 用） */
  dim?: boolean;
}
```

`export` 化はテスト fixture の型注釈のために必須（§Mi3）。

---

## 6. 完了条件の検証戦略

### 6.1 既存 task 系 5 イベント表示の regression

`task_received` / `conductor_started` / `task_completed` / `task_aborted` / `task_deleted` の出力 JournalEntry が変わらないことをテストする（§7.4）。

### 6.2 「正常時 3 行以内」の保証 — `daemon_reload` を Journal 非表示に降格（**M2 採用案**）

完了条件 task.md L117「daemon を 1 回起動・停止・再起動した際、Journal に出る行数が **正常時 3 行以内**（startup / shutdown / startup）」を満たすため:

| 案 | 動作 | 採否 |
|---|---|---|
| (a) **`daemon_reload` を Journal に出さず log タブ専用にする** | reload 時: ▼（親 stop）+ ▲（子 boot_completed）の 2 行のみ。1 起動 → 停止 → 再起動 = ▲ + ▼ + ▲ = **3 行**で task spec 満足 | **採用** |
| (b) reload 時は子 daemon の `boot_completed` 由来 ▲ を抑止する | 子 daemon 側で「reload 由来かを判定」する仕組みが必要（親から env / flag を渡す）。実装複雑度が高い | 不採用 |
| (c) task spec 修正提案として plan に書く（4 行を許容） | task spec 緩和を伴う。最小変更で完了させたい | 不採用 |

採用案 (a) の根拠:
- reload は頻度が低く、Journal で見るより log タブで `daemon_reload` / `daemon_reload_target` を grep する方が運用上扱いやすい
- 子 daemon の `boot_completed` は新セッションの開始マーカーとして機能する（ユーザー視点では「reload された結果 daemon が立ち上がった」を ▲ 1 行で表現可能）
- parser 側の実装が 1 ブランチ削減できる（§4.2 で `daemon_reload` ブランチを作らない）

§10 のリスク表に「reload 行数」エントリを追加（§10）。

---

## 7. テスト戦略

新規テストファイル: **`skills/cmux-team/manager/dashboard-journal.test.tsx`**（既存の `dashboard-conductor.test.tsx` のパターンに合わせる）。

理由: `dashboard-conductor.test.tsx` は Conductor row 描画専用なので、Journal parser の単独テストは別ファイルに分けたほうが grep しやすい。

### 7.1 export 化が必要なシンボル

現状 file-local の以下を `export` 化（テストから直接 assertion するため）:
- `parseJournalEntries` (`dashboard.tsx:338`)
- `buildJournalRows` (`dashboard.tsx:981`)
- `JournalEntry` interface (`dashboard.tsx:244`) — fixture / 戻り値の型注釈に必要
- `DAEMON_SENTINEL_TASK_ID` 定数（新規追加）
- `formatUptimeSec` ヘルパ（新規追加）

`buildConductorRow` 等は既に export されており（`dashboard.tsx:849` 参照）、テスト容易性のため export する慣行が確立している。

### 7.2 parser 側のテスト fixture

```ts
test("boot_completed: resumed 2 conductors / 1 open task を集約表示", () => {
  const line = "[2026-05-01T06:11:48Z] boot_completed version=v3.45.0 restored_conductors=2 open_tasks=1";
  const [entry] = parseJournalEntries([line]);
  expect(entry.icon).toMatch(/▲|/);
  expect(entry.iconColor).toBe(CYAN);
  expect(entry.taskId).toBe(DAEMON_SENTINEL_TASK_ID);
  expect(entry.message).toContain("v3.45.0");
  expect(entry.message).toContain("resumed 2 conductors");
  expect(entry.message).toContain("1 open task");
});

test("boot_completed: restored_conductors=0 で fresh start", () => {
  const line = "[2026-05-01T06:11:48Z] boot_completed version=v3.45.0 restored_conductors=0 open_tasks=0";
  const [entry] = parseJournalEntries([line]);
  expect(entry.message).toContain("fresh start");
});

test("boot_completed: 単数 / 複数の表記揺れ (1 conductor / 2 conductors)", () => {
  const line1 = "[...] boot_completed version=v3.45.0 restored_conductors=1 open_tasks=1";
  const line2 = "[...] boot_completed version=v3.45.0 restored_conductors=2 open_tasks=2";
  expect(parseJournalEntries([line1])[0]!.message).toContain("1 conductor / 1 open task");
  expect(parseJournalEntries([line2])[0]!.message).toContain("2 conductors / 2 open tasks");
});

test("boot_completed: detail が拡張前（空文字）でも parser が落ちない（regression）", () => {
  const line = "[2026-05-01T06:11:48Z] boot_completed";
  const entries = parseJournalEntries([line]);
  expect(entries).toHaveLength(1);
  expect(entries[0]!.message).toContain("fresh start");  // restored=0 の path に乗る
});

test("daemon_stopped: uptime_sec=12180 を 3h 23m に整形", () => {
  const line = "[2026-05-01T06:11:48Z] daemon_stopped uptime_sec=12180";
  const [entry] = parseJournalEntries([line]);
  expect(entry.icon).toMatch(/▼|/);
  expect(entry.message).toBe("daemon stopped (uptime 3h 23m)");
  expect(entry.dim).toBe(true);
});

test("daemon_stopped: uptime_sec=0 (即時 SIGINT) は 0s 表示", () => {
  const line = "[2026-05-01T06:11:48Z] daemon_stopped uptime_sec=0";
  const [entry] = parseJournalEntries([line]);
  expect(entry.message).toBe("daemon stopped (uptime 0s)");
});

test("daemon_stopped: detail 欠落 (uptime_sec なし) でも 0s フォールバック", () => {
  const line = "[2026-05-01T06:11:48Z] daemon_stopped";
  const [entry] = parseJournalEntries([line]);
  expect(entry.message).toContain("0s");
});

test("conductor_resume_launch_failed: ✕ + reason 抽出", () => {
  const line = "[2026-05-01T06:11:48Z] conductor_resume_launch_failed task_id=350 C[121] git fetch failed: connection refused";
  const [entry] = parseJournalEntries([line]);
  expect(entry.taskId).toBe("350");
  expect(entry.surface).toBe("surface:121");
  expect(entry.message).toContain("launch_error: git fetch failed: connection refused");
  expect(entry.iconColor).toBe(RED);
});

test("conductor_resume_launch_failed: 空 message で unknown フォールバック", () => {
  const line = "[2026-05-01T06:11:48Z] conductor_resume_launch_failed task_id=350 C[121]";
  const [entry] = parseJournalEntries([line]);
  expect(entry.message).toContain("launch_error: unknown");
});

test("conductor_resume_launch_failed: task_id 欠落は skip", () => {
  const line = "[2026-05-01T06:11:48Z] conductor_resume_launch_failed C[121] something";
  const entries = parseJournalEntries([line]);
  expect(entries).toHaveLength(0);
});

test("resume_worktree_missing_late: ✕ + worktree_missing", () => {
  const line = "[2026-05-01T06:11:48Z] resume_worktree_missing_late task_id=350 C[121] worktree=/tmp/foo";
  const [entry] = parseJournalEntries([line]);
  expect(entry.taskId).toBe("350");
  expect(entry.surface).toBe("surface:121");
  expect(entry.message).toContain("worktree_missing");
  expect(entry.iconColor).toBe(RED);
});

test("daemon_reload は Journal entry を生成しない (log タブ専用に降格、§6.2)", () => {
  const line = "[2026-05-01T06:11:48Z] daemon_reload";
  const entries = parseJournalEntries([line]);
  expect(entries).toHaveLength(0);
});

test("daemon_started は Journal entry を生成しない (boot_completed が代替)", () => {
  const line = "[2026-05-01T06:11:48Z] daemon_started v3.45.0 pid=12345 poll=2000ms max_conductors=2 layout=16x9 sleep_prevention=true";
  const entries = parseJournalEntries([line]);
  expect(entries).toHaveLength(0);
});
```

### 7.3 buildJournalRows の sentinel filter

```ts
test("buildJournalRows: daemon sentinel taskId は表示するが T### 列を出さない", () => {
  const entries: JournalEntry[] = [{
    time: "06:11:48",
    icon: "▲",
    taskId: DAEMON_SENTINEL_TASK_ID,
    message: "daemon started v3.45.0",
    level: "info",
  }];
  const rows = buildJournalRows(entries, null);
  const json = JSON.stringify(rows);
  expect(json).not.toMatch(/T___|T___/);
  expect(json).toContain("daemon started");
});

test("buildJournalRows: dim=true な daemon_stopped は dim style で描画される", () => {
  const entries: JournalEntry[] = [{
    time: "06:11:48",
    icon: "▼",
    taskId: DAEMON_SENTINEL_TASK_ID,
    message: "daemon stopped (uptime 1h)",
    level: "info",
    iconColor: CYAN,
    dim: true,
  }];
  const rows = buildJournalRows(entries, null);
  expect(JSON.stringify(rows)).toContain('"dim":true');
});
```

### 7.4 既存 5 イベントの regression

```ts
test("task_received / conductor_started / task_completed / task_aborted / task_deleted は従来通り", () => {
  const fixtures = [
    "[2026-05-01T...] task_received task_id=350 title=Foo",
    "[...] conductor_started task_id=350 conductor_id=1 surface=surface:121 title=Foo",
    "[...] task_completed task_id=350 title=Foo journal_summary=完了",
    "[...] task_aborted task_id=350 title=Foo",
    "[...] task_deleted task_id=350 title=Foo",
  ];
  const entries = parseJournalEntries(fixtures);
  expect(entries).toHaveLength(5);
  expect(entries[0]!.iconColor).toBe(CYAN);
  expect(entries[1]!.iconColor).toBe(YELLOW);
  expect(entries[2]!.iconColor).toBe(GREEN);
  expect(entries[3]!.iconColor).toBe(RED);
  expect(entries[4]!.iconColor).toBe(YELLOW);
});
```

### 7.5 emit 側のテスト戦略（**§M5 で追加**）

`main.ts` の uptime 計算 / `boot_completed` detail 構築 は単体関数として切り出せない（state を直接参照する shutdown 関数内）。以下のいずれかでカバー:

**(a) ヘルパ抽出 + unit test （推奨）**: `formatUptimeFromStartedAt(startedAtIso: string, now: number = Date.now()): number` を `main.ts` または `daemon.ts` に export し、以下をテスト:

```ts
test("uptime_sec: 通常ケース", () => {
  const start = "2026-05-01T00:00:00.000Z";
  const now = new Date("2026-05-01T03:23:00.000Z").getTime();
  expect(formatUptimeFromStartedAt(start, now)).toBe(3 * 3600 + 23 * 60);
});

test("uptime_sec: 時刻巻き戻りで Math.max(0, ...) がフロアする", () => {
  const start = "2026-05-01T00:00:10.000Z";
  const now = new Date("2026-05-01T00:00:00.000Z").getTime();
  expect(formatUptimeFromStartedAt(start, now)).toBe(0);
});

test("uptime_sec: 起動直後 = 0s", () => {
  const start = "2026-05-01T00:00:00.000Z";
  const now = new Date(start).getTime();
  expect(formatUptimeFromStartedAt(start, now)).toBe(0);
});
```

**(b) 手動検証手順**（unit テスト不要なら plan §8 に記載）:
1. `cmux-team start` で daemon を起動（手元で `.team/logs/manager.log` を tail）
2. 30 秒待機
3. `cmux-team stop` で停止
4. `grep "boot_completed\|daemon_stopped" .team/logs/manager.log` で以下 2 行を確認:
   - `boot_completed version=vX.Y.Z restored_conductors=0 open_tasks=0`
   - `daemon_stopped uptime_sec=30`（±1s 程度）

**採用**: (a) を main 推奨。`formatUptimeFromStartedAt` を export して unit test。

### 7.6 実行方法（CLAUDE.md 制約）

`bun test` 全体実行は禁忌。以下で個別実行:

```sh
cd skills/cmux-team/manager
bun test --timeout 30000 dashboard-journal.test.tsx
bun test --timeout 30000 dashboard-conductor.test.tsx
# 既存 dashboard 関連 test があれば追加
bunx tsc --noEmit
```

---

## 8. 作業順序

実装は以下の順序で進める（前段が後段の前提を作る — 戻りループを避ける）:

1. **emit 側 (1)**: `DaemonState.startedAt` 追加 + `cmdStart` で初期化（`new Date().toISOString()` を `daemon_started` 前に代入）
2. **emit 側 (2)**: `boot_completed` の detail 拡張（`main.ts:1133`、`loadTasks` 再 load + `isTerminalStatus` で count）
3. **emit 側 (3)**: `daemon_stopped` detail に `uptime_sec=N` 追加（`main.ts:823`）
4. **emit 側 (4)**: `formatUptimeFromStartedAt` を export ヘルパとして抽出
5. **parser 側 (1)**: `parseJournalEntries` / `buildJournalRows` / `JournalEntry` を export 化、`formatUptimeSec` ヘルパ追加、`DAEMON_SENTINEL_TASK_ID` 定数追加、`JournalEntry.dim?: boolean` 追加
6. **parser 側 (2)**: 4 つの新ブランチ（`boot_completed` / `daemon_stopped` / `conductor_resume_launch_failed` / `resume_worktree_missing_late`）を if-else チェーンに追加
7. **表示側**: `buildJournalRows` の filter 緩和 + sentinel 用の T### 列スキップ + `entry.dim` を icon style にマージ
8. **テスト**: `dashboard-journal.test.tsx` 新規作成、§7.2-7.4 の case 群を実装。emit 側は §7.5 (a) の unit test を新規ファイル `daemon-uptime.test.ts`（または既存のいずれか）に追加
9. **検証**: `bunx tsc --noEmit` / 個別 `bun test` を pass / 手動で daemon を起動・停止して Journal を目視確認（§7.5 (b) の手順）

---

## 9. 影響範囲ファイル一覧

### 編集
- `skills/cmux-team/manager/daemon.ts` — `DaemonState` interface に `startedAt: string` を追加（interface 定義のみ）
- `skills/cmux-team/manager/main.ts`
  - `import { ..., isTerminalStatus } from "./task";` を追加（既存 import に追加）
  - `cmdStart` で `state.startedAt = new Date().toISOString()` を `daemon_started` emit より前に代入
  - `main.ts:1133` の `boot_completed` emit を detail 付きに拡張（`loadTasks` 再 load + filter）
  - shutdown 関数 (`main.ts:823`) で `daemon_stopped` detail に `uptime_sec` 追加
  - `formatUptimeFromStartedAt(iso, now=Date.now())` を export ヘルパとして追加（テスト用、§7.5 (a)）
- `skills/cmux-team/manager/dashboard.tsx`
  - `parseJournalEntries` / `buildJournalRows` / `JournalEntry` interface を export
  - `formatUptimeSec` ヘルパ追加
  - `DAEMON_SENTINEL_TASK_ID` 定数追加（`"__daemon__"`）
  - `JournalEntry` に `dim?: boolean` 追加
  - if-else チェーンに 4 ブランチ追加（`boot_completed` / `daemon_stopped` / `conductor_resume_launch_failed` / `resume_worktree_missing_late`）
  - `buildJournalRows` の filter 条件緩和 + sentinel 描画分岐 + `entry.dim` の style 反映

### 新規
- `skills/cmux-team/manager/dashboard-journal.test.tsx` — Journal parser / row builder テスト
- `skills/cmux-team/manager/daemon-uptime.test.ts`（または既存の `daemon.test.ts` に追加）— `formatUptimeFromStartedAt` の unit test

### 触らない
- `parseLogLine` / `buildLogRows` (log タブの表示は無変更)
- `daemon.ts` の `restoreMasters` / `applyRestorePlan` の emit 自体（`master_restored` / `conductor_resume_launch_failed` / `resume_worktree_missing_late` の detail フォーマットは現状のまま）
- `daemon_started` / `daemon_reload` / `daemon_reload_target` の emit（既存通り）。E2E (`e2e.ts:269`) の `waitForLog("daemon_started")` を破壊しない

---

## 10. リスクと対応

| リスク | 対応 |
|---|---|
| `boot_completed` detail 拡張が既存 detect 側コードに副作用を与える | `daemon.test.ts` で `boot_completed` を string match している箇所は line 3720 のコメント言及のみ（テスト assertion なし）。実害なし。`grep -rn "boot_completed"` で確認済み |
| `loadTasks` 再 load のコスト | task ファイル数は通常 < 100、`loadTasks` は数十 ms 程度で完了。boot 1 回限りなので無視可能 |
| `state.openTasks` を使ってしまう regression | §3.3 のコードコメントに「scanTasks 未実行のため再 load 必須」と明記。code review 時に指摘 |
| 時刻巻き戻り (NTP step) で uptime が負になる | `Math.max(0, ...)` で 0 にフロア（§3.4）。test も追加（§7.5）|
| nerd font codepoint がフォントによって表示が割れる | `nerdIcon(<nerd>, <ascii fallback>)` で必ず fallback 指定。`▲` `▼` `✕` は ASCII でも視認可能 |
| `conductor_resume_launch_failed` の error message に複数空白を含む場合の reason 抽出 | regex `^task_id=\S+\s+\S+\s*` で先頭マッチを固定し、残り全体を reason とする。改行は emit 側で 1 行化されているはず（`logger.ts` の挙動を実装時に再確認）|
| **reload 行数が 4 行になる** | `daemon_reload` を Journal 非表示に降格（§6.2 案 (a)）。reload 1 回 = ▼（親 stop）+ ▲（子 boot）= **2 行**で吸収。1 起動 → 停止 → 再起動 = 3 行で task spec 満足 |
| Master 復元数 (`restoredMasters`) が detail から抜ける | task.md L33 は L40 サンプル文面と内部矛盾しており、L40 を採用（§M3）。Master 復元数の確認は log タブの個別 `master_restored` で代替可能。将来 `restored_masters=K` を detail に追加するだけで拡張可能 |
| A 経路（keep-alive）の数値が出ない | task.md L40 の文面は「resumed N conductors」のみで A 経路の表記は要求していない。`resumeAssignments.length` は B 経路 + topup-resume = 「実際に再 spawn された数」で意味的に正しい（§1.8）。将来 A 経路件数も出したくなったら `alive_conductors=K` を detail に追加するだけで拡張可能 |
| `boot_completed` の event 名セマンティクス拡張 | event 名は維持、detail のみ拡張なので互換性破壊なし。test fixture でも `boot_completed` の純空 detail (拡張前) でも parser が 0 carry の fresh start に fallback することを確認 (§7.2 regression test) |

---

## Revision History

design-review.md の各指摘への対応:

### Critical
- **C1 (`boot_completed` 既存イベント)**: §0.4 を新設し、案 D（`boot_completed` の detail 拡張）を採用。§3.3 を `boot_completed` ベースに書き換え。Journal 表示のソースイベントを `daemon_ready`（旧案）→ `boot_completed` に変更。新 event 名を増やさず E2E `waitForLog("daemon_started")` も非破壊
- **C2 (`state.openTasks` の取得方法)**: §3.3 の実装サンプルから `state.openTasks` を削除。`loadTasks(PROJECT_ROOT)` 再 load + `isTerminalStatus` filter で確定値を取る方式に固定。理由（`scanTasks` 未実行で必ず 0 になる）をコメント明記

### Major
- **M1 (`dim` 表示の実装方針)**: §5 / §5.1 を更新し `JournalEntry.dim?: boolean` 一本化。icon 文字列マッチ案 (`entry.icon.includes("▼")`) は削除。parser で `daemon_stopped` ブランチに `dim: true` をセット、buildJournalRows で `entry.dim ? { dim: true } : {}` を style にマージ
- **M2 (「正常時 3 行以内」の解釈)**: §6.2 で 3 案 (a)/(b)/(c) を比較、**(a) `daemon_reload` を Journal 非表示に降格** を採用。リスク表 §10 に「reload 行数」エントリを追加。§4.2 から `daemon_reload` ブランチを削除
- **M3 (`master_restored` の扱い)**: §3.3 / §10 / §1.5 で「task.md L33 の restoredMasters 要求は L40 サンプル文面と内部矛盾しており、L40 を採用」と明記。Master 復元数は detail に含めず、将来 `restored_masters=K` 追加で拡張可能と Recommendations として §10 に残す
- **M4 (A 経路 keep-alive)**: §1.8 で `resumeAssignments` の中身を実コードベースで詳細分析。A 経路は assignments に push されないため `restoredConductors = resumeAssignments.length` は **B 経路 + topup-resume のみ**（実際に launchConductor で再 spawn された数）で意味的に正しいと確定。§3.3 / §10 で根拠を明記
- **M5 (emit 側のテスト戦略)**: §7.5 を追加。`formatUptimeFromStartedAt` ヘルパを export して unit test (a) を main 推奨、手動検証手順 (b) も併記。boundary case（巻き戻り / 0s / 通常）をカバー

### Minor
- **Mi1 (nerd font codepoint)**: §4.4 を確定値の表に書き換え。`` (nf-fa-arrow_up, U+F062) / `` (nf-fa-arrow_down, U+F063) を採用。`daemon_reload` 用 ↻ は M2 (a) 採用で不要
- **Mi2 (boundary case のテスト)**: §7.2 に追加。`task_id` 欠落 / 空 reason / `uptime_sec=0` / `restored_conductors=0` で `fresh start` / detail 欠落時のフォールバック / 単数複数の表記揺れ / `boot_completed` 拡張前 (空 detail) regression / `daemon_started` / `daemon_reload` が Journal entry を生成しないこと
- **Mi3 (`JournalEntry` 型 export)**: §5.1 / §7.1 / §9 に追記。`parseJournalEntries` / `buildJournalRows` / `JournalEntry` interface / `DAEMON_SENTINEL_TASK_ID` / `formatUptimeSec` をすべて export 化
