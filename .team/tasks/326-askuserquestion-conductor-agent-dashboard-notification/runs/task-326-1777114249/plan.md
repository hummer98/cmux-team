# Plan: T326 AskUserQuestion 挙動テスト追加

## 概要

AskUserQuestion (SESSION_ASK) 発生時の **(1) Conductor 統合経路 / (2) cmux.notify 呼出有無 / (3) dashboard asking 描画** の 3 層を回帰防止できるテストとして追加する。本実装の挙動は変更しない（純粋追加）。

## 既存コードの調査結果

### Agent ASK の既存テスト構造（モデルにする対象）

- `daemon.test.ts:1352` の `describe("handleMessage: SESSION_STOP (T189)", ...)` 内、`writeTranscript()` ヘルパー (1353-1357) で transcript JSONL を書いた上で `handleMessage(state, { type: "SESSION_STOP", surface: "surface:a1", ... })` を呼ぶ。
- 1359-1401 の Agent / Case A (ASK) テストは:
  - assistant content に `{type:"text", text:"どうしますか?"}` と `{type:"tool_use", name:"AskUserQuestion"}` を入れた transcript を投入
  - `writeAgentDone` の done ファイル `.team/conductors/<C>/agent-done/<A>.done` を読んで `status=ask` / `question=...` を確認
  - `agent.status === "asking"` を確認
- 同 describe ブロック (1403-1437) の Conductor / Case C (IDLE) は **askQuestion を持つ asking 状態の Conductor を仕込んで、IDLE 経路で解除される** 形のため、ASK 経路の入口テストは存在しない。**ここに追加する。**

### Conductor SESSION_ASK 経路の入口

- `daemon.ts:2011-2044` の `case "SESSION_STOP"` で `classifyStopPayload` → `cls.kind === "ASK"` のとき `{type: "SESSION_ASK", surface, question, pid, timestamp}` に再合成して `handleMessage` を再入させる（高速パス、`QueueMessage.parse` を経由しない）。
- 入口テストは **`SESSION_STOP` を投入し、合成 `SESSION_ASK` 経由で `daemon.ts:2167` の `case "SESSION_ASK"` ブロックに到達する** ところまで踏ませる必要がある（既存 Agent ASK テストと完全に同じ入口）。
- Conductor 経路 (2177-2202) で起きる副作用:
  - `conductor.askQuestion = message.question`
  - `conductor.status = "asking"`
  - `conductor.disconnectedAt = undefined`
  - `conductor.lastHookAt = message.timestamp`
  - `notifyStateChanged(...)`
  - `await log("conductor_asking", ...)` → `.team/logs/manager.log` に書き出し
  - shadow observer 呼び出し
  - **cmux.notify は呼ばない**（Agent 側 2226 にしかない）

### dashboard buildConductorRow / buildConductorsSection の export 状況

- 両関数とも **module-internal**（`function buildConductorRow(...)`, `function buildConductorsSection(...)`、`export` 無し、`dashboard.tsx:500 / 673`）。
- 既存テストファイル: `dashboard-issues.test.tsx` / `dashboard-metrics.test.tsx` は `export function buildIssueRows` (924) / `export function buildMetricsRows` をテストしている。
- 既存パターン (`dashboard-issues.test.tsx:73-75`) は `JSON.stringify(rows)` した文字列に対して `toContain` 等で assertion している。Rezi UI の `ui.text` / `ui.row` は `{ type, props, children }` 構造で JSON.stringify 可能。
- **追加 export**: `buildConductorRow` のみを `export` する（`buildConductorsSection` まで踏むと `DaemonState` 全体を組み立てる必要があり overkill）。`buildConductorsSection` は section title カウント (dashboard.tsx:1314) と一体で `startDashboard` 内に直接 inline されているため、`asking` ラベルカウントはそちらでも組まれている → ラベル文字列を抽出できる純関数（例: `formatConductorsSectionLabel(daemon)`) を追加 export する。
- **section title のカウント生成**は dashboard.tsx:1230-1314 周辺で `askingCount`/`startingCount`/`assigningCount`/`runningCount`/`brokenCount` を `[...daemon.conductors.values()]` から `.filter(c => c.status === "...")` で算出している（startDashboard の閉包内）。**そのまま参照できないため、純関数 `formatConductorsSectionLabel(conductors: ConductorState[]): string` を新規 export として dashboard.tsx に追加し、startDashboard 側もそれを使うようにリファクタする**。
  - export 追加は最小限ルールに反しないか確認: 「内部関数の export は最小限」とあるが、**section title のカウント表記をテストするには別途切り出さざるを得ない**。代替案として `buildConductorsSection` を export して呼び出し時に `state.conductors` 経由で渡す方法もあるが、`buildConductorsSection(state)` は `DaemonState` 全体を要求するため fixture が大きくなる。
  - **採用**: 純関数 `formatConductorsSectionLabel(conductors)` を新規 export。startDashboard の inline 文字列構築（dashboard.tsx:1314）を同関数呼び出しに置き換える（細かいリファクタだが、本実装の挙動を変えない）。

### spyOn(cmux, "notify") の可否確認

- `daemon.ts:21` で `import * as cmux from "./cmux"` 形式 → `cmux.notify` を関数参照で呼んでいる (daemon.ts:2226 `void cmux.notify(...)`) ため、`spyOn(cmux, "notify")` で差し替え可能。
- `cmux.ts:296` `export async function notify(surface, title, body?, opts?)` シグネチャ。`opts.subtitle` に `agent.taskTitle ?? agent.role ?? "Agent"` が入る (daemon.ts:2224)。
- 既存テスト (`daemon.test.ts:716`) で `spyOn(cmux, "getPaneForSurface").mockResolvedValue(...)` の前例あり → 同パターンで OK。
- **注意**: `cmux.notify` は `void cmux.notify(...)` の fire-and-forget 呼び出し（daemon.ts:2226）。`spyOn` の `mockImplementation(async () => {})` で握りつぶす形にする。マイクロタスクで実行されるため、`handleMessage` await 後に `await Promise.resolve()` を 1 回挟むか、spy.mock.calls.length を即座に検証できるかは動作確認要 → 実装フェーズで `await new Promise(r => setImmediate(r))` を入れる準備をしておく（懸念事項に記録）。

## Plan 項目 1: daemon.test.ts Conductor SESSION_ASK 統合テスト

### 追加するテストケース

`describe("handleMessage: SESSION_STOP (T189)", ...)` ブロックの **末尾**（既存の Agent ASK / Conductor IDLE / Agent text-only end_turn の隣）に新規 `test()` を **2 つ** 追加する:

1. `test("Conductor / Case A (ASK) → conductor.status='asking' に遷移し conductor_asking ログが出る", ...)`
2. `test("Conductor / Case A (ASK) → cmux.notify は呼ばれない (Agent との非対称性)", ...)` ← Plan 2 を一体化（後述の通り別 describe にせず同 describe 内に置く）

> 既存 Agent ASK テストと並びを揃えるため、純粋追加で `describe` 増設はしない。

### 投入する transcript の最小例

既存ヘルパー `writeTranscript()` をそのまま使う。Agent ASK テスト (1369-1379) と同じ shape:

```ts
const transcriptPath = await writeTranscript([
  {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "どちらにしますか?" },
        { type: "tool_use", name: "AskUserQuestion", input: {} },
      ],
    },
  },
]);
```

### 検証 assertion 一覧 (Case A 本体)

`createDaemon(testDir)` で空 state を作り、Conductor のみ `state.conductors.set("surface:c1", conductor)` で投入。Agent は **持たせない**（Conductor 自身に SESSION_STOP を投げる）:

```ts
const conductor: ConductorState = {
  surface: "surface:c1",
  startedAt: new Date().toISOString(),
  agents: [],
  status: "running",
  taskRunId: "task-X-Y",
  taskId: "999",
  taskTitle: "demo",
  disconnectedAt: new Date(0).toISOString(), // 後で undef にクリアされることを確認
};
state.conductors.set(conductor.surface, conductor);
```

`handleMessage(state, { type: "SESSION_STOP", surface: "surface:c1", pid: 999, timestamp: <fixed ISO>, payload: { transcript_path } })` を await した後:

| assertion | 期待値 |
|---|---|
| `conductor.status` | `"asking"` |
| `conductor.askQuestion` | `"どちらにしますか?"` (transcript 末尾 text 全文) |
| `conductor.disconnectedAt` | `undefined` |
| `conductor.lastHookAt` | 投入した `timestamp` 値と一致 |
| `conductor.pid` | `999` |
| manager.log の内容 | `conductor_asking` を含み、`question=どちらにしますか?` を含む |

manager.log は `await readFile(join(testDir, ".team/logs/manager.log"), "utf-8")` で読む（既存 1591-1593 のパターン）。

### 必要な fixture / mock

- `createDaemon(testDir)` のみ（既存ヘルパー）
- transcript は `writeTranscript()` で生成
- log は `readFile` で直接参照
- `cmux` モジュールの spy は **不要**（Plan 2 の cmux.notify テストで導入）

## Plan 項目 2: cmux.notify spyOn (Plan 1 と同 describe に統合)

### Agent ケース

`Agent / Case A (ASK) → cmux.notify が 1 回呼ばれる` という新規 test を追加:

```ts
const cmux = await import("./cmux");
const { spyOn } = await import("bun:test");
const notifySpy = spyOn(cmux, "notify").mockImplementation(async () => {});
try {
  // 既存 1359-1401 と同じ Conductor + Agent を仕込み、
  // SESSION_STOP を Agent surface に投げる
  // ...
  await handleMessage(state, { type: "SESSION_STOP", surface: "surface:a1", ... });
  // fire-and-forget の解決を待つ
  await new Promise(r => setImmediate(r));

  expect(notifySpy).toHaveBeenCalledTimes(1);
  const call = notifySpy.mock.calls[0]!;
  expect(call[0]).toBe("surface:a1");
  expect(call[1]).toBe("Agent asking");
  expect(call[2]).toContain("どうしますか?"); // body = truncate(question, 200)
  expect(call[3]?.subtitle).toBeDefined(); // taskTitle/role/"Agent" のいずれか
} finally {
  notifySpy.mockRestore();
}
```

agent fixture には `role: "implementer"` または `taskTitle: "demo"` を持たせて subtitle が空文字にならないことを確認する。

### Conductor ケース

Plan 1 の Conductor / Case A 本体テストの **同じ try ブロック内** で `cmux.notify` を spyOn し、`expect(notifySpy).toHaveBeenCalledTimes(0)` を末尾で確認する形に統合する。

> 別テストにすると spy の lifecycle が分かれて読みにくいため、Plan 1 のテスト内で spy → assert すべて → mockRestore とする。

### 注意

- `void cmux.notify(...)` は fire-and-forget。`handleMessage` を await した後でも、内部の `runCmux` 呼び出しがマイクロタスクで pending の可能性がある → 検証前に `await new Promise(r => setImmediate(r))` を 1 回挟む。
- `spyOn(cmux, "notify").mockImplementation(async () => {})` で **必ず本体実行を握りつぶす**（実 cmux バイナリが test 環境で呼ばれるのを防ぐ）。

## Plan 項目 3: dashboard.tsx asking 描画テスト

### 必要な export 追加

dashboard.tsx に最小限の export を追加（本タスクで必要な分のみ）:

1. `export function buildConductorRow(c, repoUrl, spinnerFrame)` — 現状 internal の関数に `export` キーワードを付けるだけ（500 行目）。
2. `export function formatConductorsSectionLabel(conductors: ConductorState[]): string` — 新規追加。`startDashboard` 内 1314 の section title 文字列構築ロジック (`Conductors${...}`) を関数化して切り出し、startDashboard 側もこの関数を呼ぶ形にリファクタする（挙動不変の純関数化）。

> `buildConductorsSection` の export は **しない**（DaemonState 全体を要求し fixture が肥大化するため）。

### 追加するテストファイル名

`skills/cmux-team/manager/dashboard-conductor.test.tsx`（新規）

既存 `dashboard-issues.test.tsx` に倣い、`stringifyRows()` ヘルパーで `JSON.stringify` してから `toContain` 検証する。

### 検証 assertion 一覧

#### A. `buildConductorRow(asking conductor, null, 0)` のテスト

fixture:

```ts
const conductor: ConductorState & { agents: AgentState[]; status: string } = {
  surface: "surface:c1",
  startedAt: new Date(Date.now() - 5_000).toISOString(),
  status: "asking",
  askQuestion: "デプロイ先は本番ですか?",
  taskId: "326",
  taskTitle: "demo",
  agents: [],
};
const row = buildConductorRow(conductor, null, 0);
const json = JSON.stringify(row);
```

assertion:

| 検証 | 期待値 |
|---|---|
| `json` に `"⚠"` を含む | YELLOW 警告アイコン |
| `json` に `"asking"` を含む | ラベル |
| `json` に `"T326"` を含む | taskId 表示 |
| `json` に `"デプロイ先は本番ですか?"` を含む | 質問本文 |
| `fg` に `YELLOW` (= 値定数) が **少なくとも 2 箇所** 出る | ⚠ + asking ラベル + ? 行 |

#### B. 質問本文 truncate（120 char）

fixture: `askQuestion: "あ".repeat(200)`。

assertion: `json.includes("あ".repeat(117) + "...")` が true。`json.includes("あ".repeat(200))` は false。

#### C. Agent asking 行（buildConductorRow 内の Agent サブツリー描画）

fixture:

```ts
const conductor = {
  surface: "surface:c1",
  startedAt: ...,
  status: "running",
  agents: [
    { surface: "surface:a1", spawnedAt: ..., status: "asking", role: "implementer", taskTitle: "fix bug" },
  ],
};
```

assertion:

| 検証 | 期待値 |
|---|---|
| Agent 行に `"?"` マークを含む | YELLOW |
| Agent 行に `"⚙"` (implementer roleIcon) を含む | role icon |
| Agent 行に `"fix bug"` を含む | label |
| Agent 行に `surface:a1` の表示 (`[a1]`) | surface ラベル |

> `buildConductorRow` は親 Conductor + Agent サブツリーをまとめて返すため、JSON 全体に対する `toContain` で十分。

#### D. `formatConductorsSectionLabel` のテスト

fixture: 各 status を 1 つずつ持つ ConductorState 配列を渡す:

```ts
const conductors = [
  { status: "starting", ... },
  { status: "assigning", ... },
  { status: "asking", ... },
  { status: "asking", ... },
  { status: "running", ... },
  { status: "broken", ... },
];
formatConductorsSectionLabel(conductors)
// → "Conductors 1 starting 1 assigning 2 asking 1 running 1 broken" (現実装の連結順)
```

assertion: 戻り値が `"2 asking"` を含む（カウント正確）。`"Conductors"` プレフィックスを含む。0 件の status はラベルに出ない（既存条件演算子で skip される）。

### TypeScript 型問題

`buildConductorRow` の引数型は `ConductorState & { agents: AgentState[]; status: string }`（dashboard.tsx:500）。テスト fixture は同型を満たすよう `as any` ではなく **type assertion を最小限に** 構築する。`AgentState` は `team-types.ts`（または同種）から import。

## TDD 順序

1. **Red**: テストを先に書いて `bun test skills/cmux-team/manager/daemon.test.ts skills/cmux-team/manager/dashboard-conductor.test.tsx` で実行。dashboard-conductor.test.tsx は **export 追加前は import エラー** → fail することを確認。
2. **Green**: dashboard.tsx に `export` を追加 + `formatConductorsSectionLabel` を切り出し → import が通り、Conductor SESSION_ASK / cmux.notify テストも本実装は変えていないので即 pass するはず。
3. **Refactor**: 不要（純粋追加）。

## 懸念事項 / 想定外パターン

- **`void cmux.notify(...)` の非同期解決タイミング**: `await handleMessage(...)` 直後に `notifySpy.mock.calls.length` を見ると 0 のままの可能性がある。`await new Promise(r => setImmediate(r))` を挟む方針で対応するが、内部の `runCmux` がさらに await 連鎖している場合は 2 回挟む必要があるかもしれない。**実装フェーズで実測して必要なら追加**（懸念事項として記録）。
- **`formatConductorsSectionLabel` の切り出しは挙動変更ゼロか**: dashboard.tsx:1314 のテンプレートリテラルを純関数に置き換えるリファクタは、生成文字列が 1 文字も変わらないことを目視＋既存 dashboard 関連テストで担保する必要がある。万一 dashboard を起動するテストが存在すれば snapshot 更新が必要。**実装フェーズで `bun test skills/cmux-team/manager/dashboard*.test.tsx` を実行して既存 pass を確認**。
- **Conductor SESSION_ASK ハンドラに `lastHookAt` の更新がある (daemon.ts:2185)**: 既存 FSM テストでは検証していない副作用なので追加 assertion で初検証。Agent 側ハンドラには `lastHookAt` の更新が **無い**（agent オブジェクトに `lastHookAt` フィールドが無い）ため Agent ASK 側では検証しない。
- **pre-existing で本実装側に潜むバグ**: 発見した場合はこの懸念事項セクションへ追記し、修正は別タスクに切り出す。

## 完了条件

- `bun test skills/cmux-team/manager/daemon.test.ts skills/cmux-team/manager/dashboard-conductor.test.tsx` が全 pass
- `bun test` 全体（既存スイート含む）が全 pass
- 新規追加テストは既存テストと **相互依存なし**:
  - daemon.test.ts 側は新規 `test(...)` を `describe("handleMessage: SESSION_STOP (T189)", ...)` 内に追加するのみ。既存 test は無改変
  - dashboard.tsx の export 追加 / `formatConductorsSectionLabel` 切り出しは挙動不変のリファクタ
  - 新規 dashboard-conductor.test.tsx は独立ファイル
- 既存の Agent ASK テスト・FSM テストには手を入れていない
- 本実装の挙動は変えていない（dashboard.tsx の `formatConductorsSectionLabel` 切り出しは生成文字列が完全一致する純関数化のみ）
