# T119 実装計画: conductor_crashed 誤検出と cleanup 漏れの修正

## 1. 現状分析

### 1.1 `cmux.ts` — tree / validateSurface

`skills/cmux-team/manager/cmux.ts`

```ts
// L89-94
export async function tree(workspace?: string): Promise<string> {
  const args = ["tree"];
  if (workspace) args.push("--workspace", workspace);
  const { stdout } = await execFile("cmux", args);   // ← timeout 無し
  return stdout;
}

// L113-121
export async function validateSurface(surface: string, workspace?: string): Promise<boolean> {
  try {
    const output = await tree(workspace);
    return output.includes(surface);
  } catch (e: any) {
    await log("error", `validateSurface failed: surface=${surface} ${e.message}`);
    return false;   // ← 一度の失敗で即 false
  }
}
```

参考: `readScreen` は L69 で `{ timeout: 10_000 }` を既に指定している（既存パターンあり）。

### 1.2 `schema.ts` — 型は既に揃っている

`skills/cmux-team/manager/schema.ts:112-130`

```ts
export const ConductorState = z.object({
  taskRunId: z.string().optional(),
  taskId: z.string().optional(),
  taskTitle: z.string().optional(),
  surface: z.string(),
  worktreePath: z.string().optional(),
  outputDir: z.string().optional(),
  startedAt: z.string().datetime(),
  pid: z.number().optional(),
  sessionId: z.string().optional(),
  disconnectedAt: z.string().datetime().optional(),   // ← 既に存在
});

export type ConductorState = z.infer<typeof ConductorState> & {
  agents: AgentState[];
  status: "starting" | "idle" | "running" | "disconnected";  // ← disconnected あり
  paneId?: string;
  pidWatcherInterval?: ReturnType<typeof setInterval>;
};
```

→ schema.ts の変更は **不要**。

### 1.3 `conductor.ts` — checkConductorStatus

`skills/cmux-team/manager/conductor.ts:465-475`

```ts
export async function checkConductorStatus(
  conductor: ConductorState,
  workspace?: string
): Promise<"idle" | "running" | "crashed"> {
  if (conductor.status === "idle") return "idle";
  // surface 消失 → クラッシュ
  if (!(await cmux.validateSurface(conductor.surface, workspace))) return "crashed";
  return "running";
}
```

戻り値型は 3 値のまま据え置きでよい（`crashed` は `disconnected` への遷移トリガーとして使う）。

### 1.4 `conductor.ts` — resetConductor

`skills/cmux-team/manager/conductor.ts:400-461`

副作用:
1. pane 内のサブ surface を close（`paneId` があれば listPaneSurfaces → closeSurface / なければ agents から個別 close）
2. `worktreePath` 存在時: `git worktree remove --force` + `git branch -d <taskRunId>/task`（両方 catch でログのみ — 冪等）
3. `renameTab` で `[<num>] ♦ idle` にリセット
4. `ConductorState` のタスク関連フィールド (`status/taskRunId/taskId/taskTitle/worktreePath/outputDir/agents`) をクリア
5. `conductor_reset` を log

**重要**: `taskRunId` が残っていれば worktree/branch 削除は冪等に動くため、late cleanup でも安全に呼べる。

### 1.5 `daemon.ts` — 修正対象の 3 箇所

#### A. `monitorConductors` の crashed ハンドラ (`daemon.ts:774-820`)

```ts
// L774
async function monitorConductors(state: DaemonState): Promise<void> {
  for (const [surface, conductor] of state.conductors) {
    // starting: タイムアウトチェックのみ
    if (conductor.status === "starting") { /* ... */ continue; }
    if (conductor.status === "idle" || conductor.status === "disconnected") continue;
    // ↑ disconnected は monitor 対象外 → C-2 の timeout もここで扱う必要あり

    const status = await checkConductorStatus(conductor, state.workspace ?? undefined);

    switch (status) {
      case "running": break;
      case "crashed":
        await log("conductor_crashed", `surface=${surface}`);
        conductor.status = "idle";       // ← BUG: taskRunId/worktree 残存
        conductor.taskId = undefined;    // ← taskId だけ undefined
        break;
    }
    // Agent surface 生存チェック（略）
  }
}
```

#### B. `CONDUCTOR_DONE` ハンドラ (`daemon.ts:399-415`)

```ts
case "CONDUCTOR_DONE": {
  const conductor = findConductor(state, message.surface);
  if (!conductor || conductor.status !== "running") {     // ← BUG: running 以外は即捨て
    await log(
      "conductor_done_ignored",
      `surface=${message.surface} status=${conductor?.status ?? "not_found"} taskId=${conductor?.taskId} reason=not_running`
    );
    break;
  }
  const isSuccess = message.success !== false;
  await log(/* ... */);
  await handleConductorDone(state, conductor);
  break;
}
```

#### C. `SESSION_IDLE` ハンドラ (`daemon.ts:549-573`)

```ts
case "SESSION_IDLE": {
  // Master surface チェック（省略）
  const conductor = findConductor(state, message.surface);
  if (conductor) {
    conductor.disconnectedAt = undefined;
    if (message.pid) conductor.pid = message.pid;
    if (conductor.status === "disconnected" || conductor.status === "starting") {
      const event = conductor.status === "starting" ? "conductor_ready" : "conductor_recovered";
      conductor.status = "idle";                        // ← BUG: taskRunId 残存時も idle 直行
      await log(event, `surface=${message.surface} via=SESSION_IDLE`);
    }
    await log("session_idle", `surface=${message.surface}`);
  }
  break;
}
```

同様の問題が `SESSION_ACTIVE` (L525-547), `SESSION_CLEAR` (L575-586), `SESSION_STARTED` (L434-467) にも潜在的にあるが、T119 のスコープは `SESSION_IDLE` に限定する（タスク指示に従う）。

### 1.6 既存テスト構成

- テストフレームワーク: **`bun:test`** (`import { describe, test, expect, beforeEach, afterEach } from "bun:test";`)
- 実行方法: `bun test` (manager/ ディレクトリ内)
- 既存テストはモジュールモック (`mock.module` / `vi.mock` 等) を **一切使わない** — 実ファイルシステム + 実コマンドの統合テスト中心
- `conductor.test.ts` は `assignTask` を直接呼び、`git worktree add` が実際に失敗することで `AssignTaskError` を発生させている
- `daemon.test.ts` は `scanTasks` / `loadTasks` 等を実ファイルシステムで検証
- `proxy.test.ts` のみ `mockState` オブジェクトを使った DI パターンあり

→ `validateSurface` のリトライをテストするにはモジュールモック機構が必要。Bun は `bun:test` の `mock.module()` を公式サポートしているので、これを新規導入する。

---

## 2. 修正 A: validateSurface のリトライ化

### 2.1 変更ファイル: `skills/cmux-team/manager/cmux.ts`

### 2.2 tree に明示 timeout を追加

```ts
// L89 付近
const TREE_TIMEOUT_MS = 5_000;

export async function tree(workspace?: string): Promise<string> {
  const args = ["tree"];
  if (workspace) args.push("--workspace", workspace);
  const { stdout } = await execFile("cmux", args, { timeout: TREE_TIMEOUT_MS });
  return stdout;
}
```

`execFile` は timeout 超過で `ETIMEDOUT` エラーを投げるため、呼び出し元 (`validateSurface`, `getPaneForSurface`, `getPaneIdForSurface`) の catch で捕捉される。

### 2.3 validateSurface のリトライ実装

```ts
// L113 付近
const VALIDATE_SURFACE_RETRY_COUNT = 3;          // 最大試行回数
const VALIDATE_SURFACE_BACKOFF_MS = [200, 400, 800] as const;  // 試行間スリープ

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function validateSurface(surface: string, workspace?: string): Promise<boolean> {
  for (let attempt = 0; attempt < VALIDATE_SURFACE_RETRY_COUNT; attempt++) {
    try {
      const output = await tree(workspace);
      // tree 成功時は即 return — missing は正常系（Agent 終了直後・Conductor 停止直後・initializeLayout の不在チェック等）
      return output.includes(surface);
    } catch (e: any) {
      // 最終試行での失敗のみログを残す（中間失敗はノイズになるため debug 扱い）
      if (attempt === VALIDATE_SURFACE_RETRY_COUNT - 1) {
        await log(
          "validate_surface_failed",
          `surface=${surface} attempts=${attempt + 1} last_error=${e.message}`
        );
        return false;
      }
      await sleep(VALIDATE_SURFACE_BACKOFF_MS[attempt] ?? 800);
    }
  }
  return false;
}
```

**設計ポイント**（Design Review Major 2 反映）:
- **リトライは tree() 例外時のみ** — `ETIMEDOUT` / 一過性 I/O エラーで誤 crash 判定を防ぐのが本タスクの主眼。「tree 成功だが surface 未載」は cmux 描画 race の仮説に過ぎず再現手順も未確認のため、リトライ対象から外す。
- **tree 成功時は即 return** — `output.includes(surface)` の結果をそのまま返す。missing ケース（Agent 終了直後、Conductor 停止直後、`initializeLayout` 起動時の不在チェック等）に 1.4s+ の遅延が載ることを避ける。
- 最終試行の失敗時のみ `validate_surface_failed` をログに残す（中間失敗はログノイズを避ける）。`log` 関数は既存の `logger.ts` のもの。
- 全失敗時は `false` を返す（既存セマンティクスを維持）。
- 呼び出し側 (`daemon.ts:301,811` / `conductor.ts:472,511` / `master.ts:22,50` / `main.ts:931`) は変更不要。

### 2.4 影響を受ける呼び出し元（変更なし）

| ファイル | 行番号 | 呼び出し文脈 |
|---------|-------|------------|
| `daemon.ts:301` | `initializeLayout` で team.json 復元時の surface 生存確認 |
| `daemon.ts:811` | `monitorConductors` の Agent surface 生存チェック |
| `conductor.ts:472` | `checkConductorStatus` の本体 |
| `conductor.ts:511` | `spawnConductor`（レガシー） |
| `master.ts:22,50` | `isMasterAlive` |
| `main.ts:931` | 手動 validate コマンド |

**遅延特性**（Major 2 の修正後）:
- **tree() 成功時**: 即 return（0 リトライ）— `validateSurface` 1 回あたり `execFile("cmux tree")` 1 回分のみ。
- **tree() 例外時のみ**: 最大 `200 + 400 + 800 = 1.4s` のバックオフ + `tree` 3 回分。
- **`initializeLayout` (`daemon.ts:301`) への影響**: 起動時に team.json 復元後、前回セッションで既に消えた Conductor surface を検証する経路。tree 成功時は即 return なので遅延ゼロ（missing 判定が 1 tree 呼び出しで確定）。cmux 側が一過性 I/O 障害を起こしている稀なケースでのみ 1.4s 程度のスタートアップ遅延。体感上の回帰はない。
- **`monitorConductors` (`daemon.ts:811`) の agent ループへの影響**: 後述 §5.3 で tree() 結果を tick 単位でキャッシュする設計を採るため、tick あたり `tree()` 呼び出しは **1 回のみ**。`3 Conductor × 3 Agent = 9 回の missing 判定` が 1 tree 呼び出しで完了し、リトライは tree 例外時（最大 1.4s）に限定される。10s tick に対して十分な余裕。

---

## 3. 修正 B: crashed → disconnected 遷移

### 3.1 変更ファイル: `skills/cmux-team/manager/daemon.ts`

### 3.2 monitorConductors の crashed case を書き換え

```ts
// L793-805
switch (status) {
  case "running":
    break;
  case "crashed":
    await log(
      "conductor_disconnected",
      `surface=${surface} reason=validate_surface_failed kind=crashed taskRunId=${conductor.taskRunId ?? "-"}`
    );
    conductor.status = "disconnected";
    conductor.disconnectedAt = new Date().toISOString();
    // taskRunId / taskTitle / worktreePath / outputDir / agents は意図的に保持
    // → 復活時 (SESSION_ACTIVE/IDLE) または timeout 時 (C-2) に cleanup 判断する
    break;
}
```

**`kind=crashed` について**（Design Review Minor 1 反映）: 既存 `daemon.ts:682` の assignTask エラー経路は `conductor_disconnected ... reason=assign_failed kind=conductor` フォーマットを使っている。新規の monitor 経路は `kind=crashed` を付与してログモニタ/解析ツールの一貫性を保つ。

### 3.3 monitor の対象から disconnected を除外している既存行の扱い

**B 単独時点の暫定形**として `daemon.ts:789` の `if (conductor.status === "idle" || conductor.status === "disconnected") continue;` はそのまま残し、disconnected 状態では再度 checkConductorStatus を呼ばない挙動を維持する。

ただし **C-2 (disconnect timeout) 導入後の最終形は §5.3 を参照**。最終形では `disconnected` 分岐を separate（timeout 判定を行ってから continue）し、`idle` のみの continue ガードに変更する。実装順序は §9 Step 4 → Step 6 の流れに従うこと。

### 3.4 既存復活経路の確認

以下は既に `status === "disconnected"` から回復する経路が実装済み:

| 経路 | 場所 | 挙動 |
|------|------|------|
| SESSION_ACTIVE | `daemon.ts:534-544` | `disconnected → running`, log `conductor_recovered` |
| SESSION_IDLE | `daemon.ts:558-571` | `disconnected → idle`, log `conductor_recovered` (→ C-3 で修正) |
| SESSION_CLEAR | `daemon.ts:575-586` | `disconnected → idle` |
| SESSION_STARTED | `daemon.ts:444-466` | `disconnected → idle`, log `conductor_recovered` |

→ 修正 B によって「生きていたのに disconnected に落とした Conductor」が実際に完走した場合、これらのどれかで復活できる。

### 3.5 assignTask 対象からの除外

`daemon.ts:646` `const idleConductor = [...state.conductors.values()].find(c => c.status === "idle");` — disconnected は候補に入らないため、新規タスク割り当てから自動的に外れる。追加変更不要。

---

## 4. 修正 C-1: CONDUCTOR_DONE late cleanup

### 4.1 変更ファイル: `skills/cmux-team/manager/daemon.ts`

### 4.2 ハンドラ書き換え (L399-415)

```ts
case "CONDUCTOR_DONE": {
  const conductor = findConductor(state, message.surface);
  if (!conductor) {
    await log(
      "conductor_done_ignored",
      `surface=${message.surface} reason=not_found`
    );
    break;
  }
  // running 以外でも taskRunId が残っていれば late cleanup を実行
  if (conductor.status !== "running" && !conductor.taskRunId) {
    await log(
      "conductor_done_ignored",
      `surface=${message.surface} status=${conductor.status} reason=no_task`
    );
    break;
  }
  if (conductor.status !== "running") {
    await log(
      "conductor_done_late_cleanup",
      `surface=${message.surface} status=${conductor.status} taskRunId=${conductor.taskRunId}`
    );
  }
  const isSuccess = message.success !== false;
  await log(
    isSuccess ? "conductor_done_signal" : "conductor_error",
    `surface=${message.surface}${!isSuccess && message.reason ? ` reason=${message.reason}` : ""}${message.exitCode != null ? ` exit_code=${message.exitCode}` : ""}`
  );
  await handleConductorDone(state, conductor);
  break;
}
```

### 4.3 handleConductorDone の振る舞い確認 (`daemon.ts:822-844`)

```ts
async function handleConductorDone(state, conductor) {
  const { journalSummary } = await collectResults(conductor, state.projectRoot);
  // taskId があれば task_completed ログ
  if (!conductor.taskId || conductor.taskId === "undefined") {
    await log("error", `handleConductorDone: conductor.taskId is undefined surface=${conductor.surface}`);
  } else {
    await log("task_completed", `task_id=${conductor.taskId} ...`);
  }
  // Conductor をリセットして idle に戻す
  await resetConductor(conductor, state.projectRoot);
}
```

late cleanup 経路では `taskId` が undefined でも `taskRunId` だけは残っている可能性がある（B 経由で crashed→disconnected になった際、`taskRunId` は保持されるが `taskId` が undefined のままの場合は存在しない ∵ `assignTask` 内で同時にセットされる）。実際には両方セットされているはずだが、defensive に既存の error ログ (`handleConductorDone: conductor.taskId is undefined`) が残っていれば問題ない。

**追加変更不要** — `resetConductor` は `taskRunId` を根拠に冪等に worktree/branch を削除するため、late cleanup でも同じ処理で動作する。

### 4.4 ログイベント整理

| イベント名 | 発火条件 |
|-----------|--------|
| `conductor_done_ignored ... reason=not_found` | conductor が見つからない |
| `conductor_done_ignored ... reason=no_task` | running でもなく taskRunId も残っていない（真の再割り当て後の stale event） |
| `conductor_done_late_cleanup` | running ではないが taskRunId が残っている（本来捨てていたケース） |
| `conductor_done_signal` / `conductor_error` | 既存どおり |

→ 旧 `reason=not_running` ログは廃止（意味的に「not_running」=「taskRunId 残存」と「taskRunId なし」の 2 ケースを混同していたため）。

---

## 5. 修正 C-2: disconnect timeout（永久 dead 判定）

### 5.1 変更ファイル: `skills/cmux-team/manager/daemon.ts`

### 5.2 timeout 定数の配置

既存の `STARTING_TIMEOUT_SEC = 60` (`daemon.ts:772`) と同じスコープに追加:

```ts
/** starting 状態のタイムアウト（秒） */
const STARTING_TIMEOUT_SEC = 60;
/** disconnected 状態のタイムアウト（秒） — 超過で forced cleanup */
const DISCONNECT_TIMEOUT_SEC = 300;  // 5 分
```

5 分は KDG-lab 事例のログを考慮した値:
- 06:33:15 conductor_crashed
- 10:41:17 conductor_done_ignored（約 4 時間後）

→ 数分のネットワーク揺らぎ・長い tree タイムアウトを考慮して 5 分は保守的な値として妥当。

### 5.3 monitorConductors の最終形（完成形）

Design Review の Critical 1 / Major 1 / Major 4 を反映した最終形。以下を一箇所に集約する。実装順序は §9 Step 4（B 単独）→ Step 6（C-2 統合）と段階的に進めるが、**実装完了時点のコードはこの形** になる。

**ポイント**（Design Review 反映）:
- **Major 1 対応（tree() キャッシュ）**: `monitorConductors` の冒頭で `tree(workspace)` を 1 回だけ呼び、その結果を Agent missing 判定に流用する。Agent 検証は `output.includes(surface)` の純粋関数で突き合わせ、tree 呼び出しは 1 tick あたり 1 回に抑える。tree() が失敗した場合のみ従来のリトライ付き `validateSurface` にフォールバック。
- **Major 4 対応（continue 条件の最終形）**: `disconnected` を独立した分岐に分離し、timeout チェックを行ってから continue する。`idle` のみ即 continue。
- **Minor 1 対応**: `conductor_disconnected` ログに `kind=crashed` を付与。

```ts
// daemon.ts L774-820 の最終形
export async function monitorConductors(state: DaemonState): Promise<void> {
  // Major 1: tick 冒頭で tree() を 1 回だけ呼び、結果をキャッシュする
  //   成功時: Conductor / Agent の surface は `treeOutput.includes(surface)` で突き合わせる
  //   失敗時: リトライ付き validateSurface にフォールバックする
  let treeOutput: string | null = null;
  try {
    treeOutput = await cmux.tree(state.workspace ?? undefined);
  } catch (e: any) {
    // tree 失敗 → Conductor/Agent の生存判定は validateSurface 経由で行う
    await log("monitor_tree_failed", `last_error=${e.message}`);
    treeOutput = null;
  }

  const surfaceAlive = async (surface: string): Promise<boolean> => {
    if (treeOutput !== null) return treeOutput.includes(surface);
    // tree() が失敗した場合のみ従来のリトライ付き validateSurface にフォールバック
    return cmux.validateSurface(surface, state.workspace ?? undefined);
  };

  for (const [surface, conductor] of state.conductors) {
    // starting: タイムアウトチェックのみ
    if (conductor.status === "starting") {
      const elapsed = (Date.now() - new Date(conductor.startedAt).getTime()) / 1000;
      if (elapsed > STARTING_TIMEOUT_SEC) {
        conductor.status = "disconnected";
        conductor.disconnectedAt = new Date().toISOString();
        await log(
          "conductor_start_timeout",
          `surface=${surface} elapsed=${Math.round(elapsed)}s`
        );
      }
      continue;
    }

    // disconnected: timeout チェック → forced cleanup。継続チェックはしない
    if (conductor.status === "disconnected") {
      if (conductor.disconnectedAt) {
        const elapsed = (Date.now() - new Date(conductor.disconnectedAt).getTime()) / 1000;
        if (elapsed > DISCONNECT_TIMEOUT_SEC) {
          await log(
            "conductor_disconnect_timeout",
            `surface=${surface} elapsed=${Math.round(elapsed)}s taskRunId=${conductor.taskRunId ?? "-"}`
          );
          await forceCloseDisconnectedConductor(state, conductor);
        }
      }
      continue;
    }

    // idle: 何もしない
    if (conductor.status === "idle") continue;

    // running の場合: Conductor surface の生存確認
    // tree() 成功時は includes、失敗時は validateSurface にフォールバック
    const alive = await surfaceAlive(conductor.surface);
    if (!alive) {
      await log(
        "conductor_disconnected",
        `surface=${surface} reason=validate_surface_failed kind=crashed taskRunId=${conductor.taskRunId ?? "-"}`
      );
      conductor.status = "disconnected";
      conductor.disconnectedAt = new Date().toISOString();
      // taskRunId / taskTitle / worktreePath / outputDir / agents は意図的に保持
      // 復活時 (SESSION_ACTIVE/IDLE) または timeout 時 (C-2) に cleanup 判断
      // running を抜けて Agent チェックには進まない(surface 消失済みなので意味なし)
      continue;
    }

    // Agent surface の生存チェック — tree キャッシュを使う(Major 1)
    for (let i = conductor.agents.length - 1; i >= 0; i--) {
      const agent = conductor.agents[i]!;
      if (!(await surfaceAlive(agent.surface))) {
        conductor.agents.splice(i, 1);
        await log(
          "agent_done",
          `conductor_surface=${surface} surface=${agent.surface} trigger=surface_lost`
        );
      }
    }
  }
}
```

**`checkConductorStatus` との関係**: 従来の `checkConductorStatus` は `conductor.status === "idle"` の早期リターンと `validateSurface` 呼び出しを兼ねていたが、最終形では monitorConductors が tree キャッシュを持つため直接 `surfaceAlive` を使う。`checkConductorStatus` は他の呼び出し元（もしあれば）のために残してよいが、本タスクでは `monitorConductors` 内部では使用しない。

**tick interval 超過リスクの見積もり**:
- 最悪ケース（3 Conductor × 3 Agent = 9 surface 判定）: tree() 1 回（~100ms）+ 9 回の `String.includes`（μs オーダー）= ~100ms 程度。
- tree() 失敗時: リトライ付き `validateSurface` が 9 Agent + 3 Conductor = 最大 12 回呼ばれるが、tree() 側を直接呼び直すだけなので実質 `200+400+800 = 1.4s` + tree 3 回分 = ~1.5s。同じ tick 内で tree() を 2 回以上呼ばないよう、fallback 側の `validateSurface` に入った後も tick 全体の遅延は許容範囲。
- 10s tick に対して十分な余裕（< 15%）。

### 5.3.1 状態遷移の要点

実装後の Conductor status 遷移は以下のようになる（Critical 1 反映）:

```
starting ──(SESSION_STARTED/ACTIVE/IDLE)──> idle
starting ──(STARTING_TIMEOUT)──> disconnected

idle ──(assignTask 成功)──> running
idle ──(assignTask conductor エラー)──> disconnected

running ──(CONDUCTOR_DONE)──> idle  [normal cleanup]
running ──(SESSION_ENDED / pid_watcher / monitor で surface 消失)──> disconnected
                                                                        │
                                                                        │ taskRunId 保持

disconnected + taskRunId + SESSION_IDLE   ──> running  [C-3: cleanup せず running 復帰(本タスクで変更)]
disconnected + taskRunId + SESSION_ACTIVE  ──> running  [既存挙動のまま]
disconnected + taskRunId + SESSION_STARTED ──> idle     [既存挙動のまま — resetConductor は呼ばない。taskRunId は残り、次の tick の monitor か後続の CONDUCTOR_DONE で cleanup される]
disconnected + taskRunId + CONDUCTOR_DONE  ──> idle     [C-1: late cleanup で resetConductor(本タスクで変更)]
disconnected + taskRunId + DISCONNECT_TIMEOUT ──> idle  [C-2: forceCloseDisconnectedConductor(本タスクで追加)]

disconnected (taskRunId なし) + SESSION_IDLE ──> idle   [既存挙動のまま]
```

**重要**: `SESSION_IDLE` の経路には `resetConductor` を呼ぶエッジを **作らない**。SESSION_IDLE は Claude Code の Stop hook (`main.ts:727-735`) から **ターン境界ごとに** 発火するため、タスク実行中でも生存シグナルとして emit される。実際の cleanup は C-1（CONDUCTOR_DONE）か C-2（disconnect_timeout）が担う。詳細は §6.3 参照。

### 5.4 forceCloseDisconnectedConductor の新規実装

タスクに残された Conductor の "forced close + journal" を行う。直接 `task-state.json` を更新し、`resetConductor` で worktree 等を冪等に削除する。CLAUDE.md ガイドラインに従い **reopen しない**。

**重要**（Design Review Major 3 反映）: `loadTaskState / saveTaskState` は **既に `daemon.ts:18` で top-level import されている**（`import { loadTasks, loadTaskState, saveTaskState, filterExecutableTasks, ... } from "./task";`）。動的 `import("./task")` は使わない。以前のドラフトにあった動的 import は削除する。

```ts
// daemon.ts の handleConductorDone の近くに追加
async function forceCloseDisconnectedConductor(
  state: DaemonState,
  conductor: ConductorState
): Promise<void> {
  const taskId = conductor.taskId;
  const taskRunId = conductor.taskRunId;

  // 1. task-state.json にジャーナル付きで aborted を記録
  //    実際に Conductor の生死を確認できない以上「成功 close」ではなく aborted が正確。
  //    assignTask 失敗時も aborted 扱い (daemon.ts:662-675) なので整合性あり。
  if (taskId) {
    try {
      const ts = await loadTaskState(state.projectRoot);  // ← top-level import を使用
      const current = ts[taskId];
      // 既に closed/aborted/deleted 済みならスキップ(冪等)
      if (
        current?.status !== "closed" &&
        current?.status !== "aborted" &&
        current?.status !== "deleted"
      ) {
        const journal = `disconnect_timeout: surface=${conductor.surface} taskRunId=${taskRunId ?? "-"} disconnectedAt=${conductor.disconnectedAt}`;
        ts[taskId] = {
          ...current,
          status: "aborted",
          abortedAt: new Date().toISOString(),
          journal,
        };
        await saveTaskState(state.projectRoot, ts);  // ← top-level import を使用
        await log(
          "task_aborted",
          `task_id=${taskId} reason=disconnect_timeout journal_summary=${journal}`
        );
      }
    } catch (e: any) {
      await log(
        "error",
        `forceCloseDisconnectedConductor task-state update failed: task_id=${taskId} ${e.message}`
      );
    }
  }

  // 2. pidWatcherInterval をクリア(Minor 4 対応)
  //    spawnPidWatcher で起動された setInterval は disconnected 遷移後も生き残る可能性があるため、
  //    forced close のタイミングで明示的にクリアしておく。
  //    SESSION_ENDED 経路 (daemon.ts:481-523) は pid/sessionId を undefined にするが、
  //    pidWatcherInterval 自体は SESSION_ENDED では clear していない(pid_watcher 発火時に自己クリア)。
  //    forced close はそのクリア経路を踏まないので、ここで明示 clear する。
  if (conductor.pidWatcherInterval) {
    clearInterval(conductor.pidWatcherInterval);
    conductor.pidWatcherInterval = undefined;
  }

  // 3. resetConductor で worktree/branch/タブ名をクリーンアップ
  //    resetConductor 内で status = "idle" にセットされる
  await resetConductor(conductor, state.projectRoot);
}
```

**設計判断**:
- **CLI (`cmux-team close-task`) を daemon から呼ばない**: daemon はサブプロセス起動を避け、既存の `task-state.json` 直接更新 + `resetConductor` で十分。`scanTasks` (`daemon.ts:644` 以降) でも同様に task-state を直接書き換えている (`daemon.ts:662-675` の `assign_failed` 経路)。
- **abort 扱い**: 実際に Conductor の生死を確認できない以上「成功 close」ではなく `aborted` が正確。assignTask 失敗時も aborted 扱い (`daemon.ts:669`) なので整合性あり。
- **reopen しない**: CLAUDE.md のフィードバック「異常検知時のリカバリーは人間に委ねる」に従う。
- **`resetConductor` により `status = "idle"` になる** → 次の tick から新規タスクを受け付けられる状態に戻る。
- **`pidWatcherInterval` のクリア**: Minor 4 対応。existing `SESSION_ENDED` 経路は `pidWatcherInterval` を明示 clear せず、interval 自身の内部チェック (`process.kill(pid, 0)` → catch) に任せているが、forced close はそのタイミングを経ない可能性があるため明示 clear する。

### 5.4.1 resetConductor に disconnectedAt クリアを追加(Minor 3)

`conductor.ts` の `resetConductor` は現在 `status / taskRunId / taskId / taskTitle / worktreePath / outputDir / agents` のみクリアするが、`disconnectedAt` はクリアされないまま残る(`conductor.ts:448-456`)。forced close 後も同様に残ると、Dashboard の `isDisconnected` 分岐や将来 `disconnectedAt` を参照するコードの罠になる。

`conductor.ts:448-456` の 4. ConductorState リセットブロックに 1 行追加する:

```ts
// conductor.ts:455 付近
conductor.agents = [];
conductor.disconnectedAt = undefined;  // ← 追加(Minor 3)
```

これにより `forceCloseDisconnectedConductor`, `handleConductorDone`, 既存の reset 呼び出し全てで `disconnectedAt` が自動クリアされる。

### 5.5 import 追加(不要)

`daemon.ts` 先頭の import には既に以下が含まれている:
- `resetConductor` (`daemon.ts:13`, from `./conductor`)
- `loadTaskState`, `saveTaskState` (`daemon.ts:18`, from `./task`)

→ **追加 import は不要**。動的 `import("./task")` のような記述は一切使わない。

---

## 6. 修正 C-3: SESSION_IDLE 経路の復帰処理（Critical 1 反映で再設計）

### 6.1 変更ファイル: `skills/cmux-team/manager/daemon.ts`

### 6.2 ハンドラ書き換え (L549-573)

**設計変更**（Design Review Critical 1 反映）:
旧ドラフト（タスク指示 §C-3 の擬似コード）では `disconnected + taskRunId` 復帰時に `resetConductor` を呼ぶ案だったが、Design Review の重大指摘を受けて **`resetConductor` を呼ばず、`status = "running"` に戻すだけ** に変更する。実際の cleanup は C-1（CONDUCTOR_DONE late cleanup）または C-2（disconnect_timeout → forceCloseDisconnectedConductor）が担う。

根拠は §6.3 を参照。

```ts
case "SESSION_IDLE": {
  // Master surface チェック
  if (message.surface === state.masterSurface) {
    state.masterStatus = "idle";
    state.masterDisconnectedAt = undefined;
    if (message.pid) state.masterPid = message.pid;
    await log("master_session_idle", `surface=${message.surface}`);
    break;
  }
  const conductor = findConductor(state, message.surface);
  if (conductor) {
    conductor.disconnectedAt = undefined;  // alive の証拠(Stop hook からのシグナル)
    if (message.pid) conductor.pid = message.pid;
    if (conductor.status === "disconnected") {
      if (conductor.taskRunId) {
        // タスク実行中だった Conductor が復活 → running に戻すだけ。
        // cleanup は C-1 (CONDUCTOR_DONE) か C-2 (disconnect_timeout) が担う。
        // ここで resetConductor を呼ぶと、生存中の Conductor の worktree を誤削除してしまう
        // (Stop hook はターン境界ごとに発火するため、タスク実行中でも SESSION_IDLE は来る)。
        conductor.status = "running";
        await log(
          "conductor_recovered",
          `surface=${message.surface} via=SESSION_IDLE new_status=running taskRunId=${conductor.taskRunId}`
        );
      } else {
        // taskRunId なし(= タスク未割り当て状態で disconnected になった)→ idle に戻す
        conductor.status = "idle";
        await log("conductor_recovered", `surface=${message.surface} via=SESSION_IDLE`);
      }
    } else if (conductor.status === "starting") {
      conductor.status = "idle";
      await log("conductor_ready", `surface=${message.surface} via=SESSION_IDLE`);
    }
    await log("session_idle", `surface=${message.surface}`);
  }
  break;
}
```

### 6.3 設計根拠（Design Review Critical 1 反映）

**Stop hook はターン境界ごとに発火するため、SESSION_IDLE 単独では「タスク完了」を意味しない**。

- `cmux-team send SESSION_IDLE` を発行する経路は `skills/cmux-team/manager/main.ts:727-735` の Claude Code Stop hook である。Stop hook は「タスク完了時」ではなく「アシスタントが応答を終えて入力待ちに戻るたび」、つまり **1 ターン応答ごと** に発火する。
- 現行 daemon の `SESSION_IDLE` ハンドラも `conductor.disconnectedAt = undefined;  // alive の証拠` (`daemon.ts:560`) とコメントしており、SESSION_IDLE を「生存シグナル」として扱う設計になっている。
- したがって、タスク実行中の Conductor も **毎ターン SESSION_IDLE を emit** する。もし SESSION_IDLE 経路で `resetConductor` を呼ぶと、以下のシナリオで生存中の worktree を破壊する:
  1. `monitorConductors` が cmux の一時的不調で `validateSurface` 連続失敗 → `disconnected` へ誤遷移（A 修正後も、数分以上の tree() 不応答があれば発生しうる）
  2. cmux が数秒で回復 → Conductor は実際にはタスクを継続中
  3. Conductor が次のターン境界（例: サブエージェント spawn 後の入力待ち）で `SESSION_IDLE` を emit
  4. 旧 C-3 設計の分岐が `resetConductor` を呼び、**実行中の worktree とブランチを削除**
  5. その後の `git add / commit / worktree remove` が軒並み失敗し、タスクが壊れる

→ このため `SESSION_IDLE` 経路で `resetConductor` を呼ぶことは **禁止**。`disconnected + taskRunId` 復帰時は `running` に戻すだけにし、実際の cleanup は以下に委ねる:

| ケース | 動作経路 |
|--------|---------|
| Conductor が実際に完走した（タスク成功/失敗を含む） | C-1: Stop hook から `cmux-team send CONDUCTOR_DONE` で late cleanup |
| Conductor が本当に死んでいて SESSION_IDLE も emit しない | C-2: `DISCONNECT_TIMEOUT_SEC` (5 分) 経過後に `forceCloseDisconnectedConductor` |
| 生存中の Conductor が SESSION_IDLE emit（誤 disconnect 判定からの復帰） | C-3: `running` に戻すだけ（worktree 保全、継続して作業可能） |

**タスク指示 §C-3 との差異**: タスク指示（conductor-prompt.md）の §C-3 の擬似コードは「SESSION_IDLE で late cleanup」だったが、Design Review の重大指摘により設計を改めた。タスク指示の擬似コードはドラフトであり、設計レビュー結果を優先する（Design Review Recommendations 参照）。

### 6.4 SESSION_ACTIVE / SESSION_CLEAR / SESSION_STARTED は対象外

`SESSION_ACTIVE` (running 復帰) は既に `disconnected → running` 遷移を行うため、本タスクの変更と整合する。変更しない。

`SESSION_CLEAR` (`/clear` 実行後) と `SESSION_STARTED` (新セッション起動) もタスクのスコープ外のため変更しない。

→ タスク指示 §C-3 でも SESSION_IDLE のみが対象。

---

## 7. テスト計画

### 7.1 テストフレームワーク

- **`bun:test`**（既存）
- 実行: `bun test`（`skills/cmux-team/manager/` ディレクトリ内で）

### 7.2 新規 / 追加テスト

#### 7.2.1 `cmux.test.ts`（新規作成）

```ts
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, writeFile, chmod, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let testDir: string;
let origPath: string | undefined;

// cmux コマンドを fake スクリプトで置き換える: 呼び出し回数を外部 state file で管理
beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cmux-validate-test-"));
  const binDir = join(testDir, "bin");
  await mkdir(binDir, { recursive: true });
  // 呼び出しカウンタファイル
  await writeFile(join(testDir, "count"), "0");
  origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath}`;
});

afterEach(async () => {
  process.env.PATH = origPath ?? "";
  await rm(testDir, { recursive: true, force: true });
});

async function writeFakeCmux(script: string): Promise<void> {
  const path = join(testDir, "bin/cmux");
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
}

describe("validateSurface リトライ", () => {
  test("1 回目で成功すれば即 true を返す", async () => {
    await writeFakeCmux(`echo "pane:1\n  surface:42"`);
    const { validateSurface } = await import("./cmux");
    expect(await validateSurface("surface:42")).toBe(true);
  });

  test("1, 2 回目失敗 → 3 回目で成功すれば true", async () => {
    // カウンタを使って N 回目以降だけ成功させる
    await writeFakeCmux(`
      N=$(cat "${testDir}/count")
      N=$((N+1))
      echo $N > "${testDir}/count"
      if [ "$N" -lt 3 ]; then
        echo "error" >&2
        exit 1
      fi
      echo "pane:1\n  surface:42"
    `);
    const { validateSurface } = await import("./cmux");
    expect(await validateSurface("surface:42")).toBe(true);
  });

  test("3 回全て失敗すれば false", async () => {
    await writeFakeCmux(`echo "error" >&2; exit 1`);
    const { validateSurface } = await import("./cmux");
    expect(await validateSurface("surface:42")).toBe(false);
  });

  test("tree 成功時にはリトライしない(surface 未載なら即 false)", async () => {
    // Major 2 反映: tree 成功時は surface 未載でも即 false を返し、リトライしない。
    // カウンタで呼び出し回数を検証する。
    await writeFakeCmux(`
      N=$(cat "${testDir}/count")
      N=$((N+1))
      echo $N > "${testDir}/count"
      echo "pane:1\n  surface:99"
    `);
    const { validateSurface } = await import("./cmux");
    // tree 成功だが surface:42 は含まれない → 即 false
    expect(await validateSurface("surface:42")).toBe(false);
    // カウンタが 1(1 回しか tree() を呼んでいない)であることを検証
    const { readFile } = await import("fs/promises");
    const count = (await readFile(join(testDir, "count"), "utf-8")).trim();
    expect(count).toBe("1");
  });
});
```

**モック戦略**: `bun:test` のモジュールモックではなく、`PATH` 先頭に `bin/cmux` シェルスクリプトを置いて実プロセスとして `execFile` 経由で呼び出させる。既存テストが避けているモジュールモック依存を引きずらない。

> **注**: `import("./cmux")` は Node module cache により 1 テストファイル内で 1 回しか評価されないため、fake スクリプトの挙動は外部 state file (`count`) で毎テストリセットする。`import` 自体は `cmux` モジュール定義を読むだけ。

#### 7.2.2 `daemon.test.ts`（追記）

既存の `describe` ブロックに以下 4 シナリオを追加する。

```ts
// --- conductor_crashed → disconnected 遷移とリカバリ ---

import {
  handleMessage,
  monitorConductors,  // export 要追加
  // ...
} from "./daemon";

describe("crashed → disconnected 遷移 (T119)", () => {
  test("1. running で tree が常に失敗 → disconnected + taskRunId 保持", async () => {
    // Minor 6 反映: PATH 差し替えヘルパーを §7.2.1 と共通化して流用する。
    // beforeEach で `bin/cmux` の fake スクリプトを用意し、`PATH` の先頭に追加する。
    // ここでは fake cmux を「常に tree 失敗」させる形にセットする。
    await writeFakeCmux(`echo "tree error" >&2; exit 1`);

    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:71",
      startedAt: new Date().toISOString(),
      taskRunId: "task-010-1712345678",
      taskId: "010",
      taskTitle: "journal-generator",
      worktreePath: join(testDir, ".worktrees/task-010-1712345678"),
      outputDir: ".team/output/task-010-1712345678",
      agents: [],
      status: "running",
    };
    state.conductors.set(conductor.surface, conductor);

    // PATH 差し替えで cmux tree を失敗させる(リトライ後も失敗)
    // → surfaceAlive が false を返す
    // → monitorConductors の crashed 分岐で disconnected 遷移
    await monitorConductors(state);

    expect(conductor.status).toBe("disconnected");
    expect(conductor.disconnectedAt).toBeDefined();
    // taskRunId 等は保持される(意図的に残す設計)
    expect(conductor.taskRunId).toBe("task-010-1712345678");
    expect(conductor.taskId).toBe("010");
    expect(conductor.worktreePath).toBe(join(testDir, ".worktrees/task-010-1712345678"));

    // ログ検証: conductor_disconnected が kind=crashed で記録されていること(Minor 1)
    const { readFile } = await import("fs/promises");
    const logPath = join(testDir, ".team/logs/manager.log");
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("conductor_disconnected");
    expect(logContent).toContain("kind=crashed");
  });

  test("2. disconnected + CONDUCTOR_DONE で late cleanup が走る", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:71",
      startedAt: new Date().toISOString(),
      disconnectedAt: new Date().toISOString(),
      taskRunId: "task-010-1712345678",
      taskId: "010",
      taskTitle: "journal-generator",
      // Minor 7 反映: worktreePath は存在しないパスを指定する。
      //   resetConductor は existsSync ガード (conductor.ts:425) で worktree remove を
      //   スキップするため、実ファイルシステムに worktree が無くてもテストは成功する。
      //   これにより「late cleanup 経路の冪等性」も同時に検証される。
      worktreePath: join(testDir, ".worktrees/task-010-nothing"),
      outputDir: ".team/output/task-010",
      agents: [],
      status: "disconnected",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "CONDUCTOR_DONE",
      surface: "surface:71",
      success: true,
      timestamp: new Date().toISOString(),
    });

    // late cleanup 経路に入り、resetConductor で status=idle にリセット
    expect(conductor.status).toBe("idle");
    expect(conductor.taskRunId).toBeUndefined();
    expect(conductor.taskId).toBeUndefined();
    expect(conductor.worktreePath).toBeUndefined();
    // Minor 3: resetConductor で disconnectedAt もクリアされる
    expect(conductor.disconnectedAt).toBeUndefined();
  });

  test("2b. disconnected + taskRunId なし + CONDUCTOR_DONE は no_task で ignore", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:71",
      startedAt: new Date().toISOString(),
      disconnectedAt: new Date().toISOString(),
      agents: [],
      status: "disconnected",
      // taskRunId なし
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "CONDUCTOR_DONE",
      surface: "surface:71",
      success: true,
      timestamp: new Date().toISOString(),
    });

    // no_task ignore → 状態変更なし
    expect(conductor.status).toBe("disconnected");
  });

  test("3. disconnect timeout で forced close + journal + aborted", async () => {
    // git init で worktree 操作を有効化
    const { execFile: ef } = await import("child_process");
    const { promisify } = await import("util");
    await promisify(ef)("git", ["init", "-q"], { cwd: testDir });

    // テストタスクを作成
    await createTask("10", "journal-generator");
    // task-state に assigned を明示
    const { loadTaskState, saveTaskState } = await import("./task");
    const ts = await loadTaskState(testDir);
    ts["10"] = { status: "assigned", assignedAt: new Date().toISOString() };
    await saveTaskState(testDir, ts);

    const state = await createDaemon(testDir);
    const oldDisconnectedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();  // 10 分前
    const conductor: ConductorState = {
      surface: "surface:71",
      startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      disconnectedAt: oldDisconnectedAt,
      taskRunId: "task-010-1712345678",
      taskId: "10",
      taskTitle: "journal-generator",
      agents: [],
      status: "disconnected",
    };
    state.conductors.set(conductor.surface, conductor);

    await monitorConductors(state);

    // timeout 判定 → forced close
    expect(conductor.status).toBe("idle");
    expect(conductor.taskRunId).toBeUndefined();
    expect(conductor.disconnectedAt).toBeUndefined();  // Minor 3

    // task-state が aborted になっている
    const tsAfter = await loadTaskState(testDir);
    expect(tsAfter["10"]?.status).toBe("aborted");
    expect(tsAfter["10"]?.journal).toContain("disconnect_timeout");
    expect(tsAfter["10"]?.abortedAt).toBeDefined();

    // Minor 9 反映: conductor_disconnect_timeout ログが出力されていることを検証
    const { readFile } = await import("fs/promises");
    const logPath = join(testDir, ".team/logs/manager.log");
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("conductor_disconnect_timeout");
    expect(logContent).toContain("task_aborted");
  });

  test("3b. disconnect timeout 未到達ならスキップ", async () => {
    const state = await createDaemon(testDir);
    const recentDisconnectedAt = new Date(Date.now() - 10_000).toISOString();  // 10 秒前
    const conductor: ConductorState = {
      surface: "surface:71",
      startedAt: new Date().toISOString(),
      disconnectedAt: recentDisconnectedAt,
      taskRunId: "task-010-x",
      taskId: "10",
      agents: [],
      status: "disconnected",
    };
    state.conductors.set(conductor.surface, conductor);

    await monitorConductors(state);

    // まだ disconnected のまま
    expect(conductor.status).toBe("disconnected");
    expect(conductor.taskRunId).toBe("task-010-x");
  });

  test("4. SESSION_IDLE 経路で disconnected + taskRunId 残存時は cleanup せず running に復帰", async () => {
    // Critical 1 反映: SESSION_IDLE はターン境界ごとに発火するため、
    //   disconnected + taskRunId 復帰時に resetConductor を呼ぶと生存中の Conductor の
    //   worktree を誤削除するリスクがある。
    //   新設計では「running に戻すだけ、cleanup はせず、taskRunId を保持する」ことを検証する。
    //   実際の cleanup は C-1 (CONDUCTOR_DONE) か C-2 (disconnect_timeout) が担う。
    const state = await createDaemon(testDir);
    const worktreePath = join(testDir, ".worktrees/task-010-y");
    const conductor: ConductorState = {
      surface: "surface:71",
      startedAt: new Date().toISOString(),
      disconnectedAt: new Date().toISOString(),
      taskRunId: "task-010-y",
      taskId: "10",
      taskTitle: "t",
      worktreePath,
      outputDir: ".team/output/task-010-y",
      agents: [],
      status: "disconnected",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_IDLE",
      surface: "surface:71",
      timestamp: new Date().toISOString(),
    });

    // status は running に戻る(cleanup されない)
    expect(conductor.status).toBe("running");
    // taskRunId / taskId / worktreePath は保持される
    expect(conductor.taskRunId).toBe("task-010-y");
    expect(conductor.taskId).toBe("10");
    expect(conductor.worktreePath).toBe(worktreePath);
    // alive の証拠として disconnectedAt はクリアされる
    expect(conductor.disconnectedAt).toBeUndefined();

    // ログ検証: conductor_recovered に new_status=running が記録される
    const { readFile } = await import("fs/promises");
    const logPath = join(testDir, ".team/logs/manager.log");
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("conductor_recovered");
    expect(logContent).toContain("via=SESSION_IDLE");
    expect(logContent).toContain("new_status=running");
  });

  test("4b. SESSION_IDLE で disconnected + taskRunId なしは通常 recovery", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:71",
      startedAt: new Date().toISOString(),
      disconnectedAt: new Date().toISOString(),
      agents: [],
      status: "disconnected",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_IDLE",
      surface: "surface:71",
      timestamp: new Date().toISOString(),
    });

    expect(conductor.status).toBe("idle");
  });
});
```

### 7.3 export の追加

- `daemon.ts` の `monitorConductors` と `handleMessage` を export する必要あり。
- 現状 `handleMessage` は `export` されている (`L381`)。
- `monitorConductors` は `async function monitorConductors` でプレフィックス `export` がない (`L774`) → **export 追加が必要**。

```ts
// daemon.ts:774
export async function monitorConductors(state: DaemonState): Promise<void> {
  // ...
}
```

### 7.4 `cmux` PATH 差し替えのヘルパー関数

`daemon.test.ts` の 1. シナリオは `checkConductorStatus` 経由で `cmux tree` を呼ぶため、テストごとに fake `cmux` を差し替える必要がある。`cmux.test.ts` と同じパターン（`PATH` 差し替え + fake shell script）を `daemon.test.ts` に流用する。

または、1. シナリオは daemon レイヤのテストとしては粒度が荒すぎるので、**`cmux.test.ts` のリトライテストでカバーし、`daemon.test.ts` は crashed 時の遷移ロジックを直接呼ぶモックで検証する**ほうが簡潔:

```ts
// daemon.ts の monitorConductors を分割して、"crashed case" だけ純粋関数化:
export function transitionConductorCrashed(conductor: ConductorState): void {
  conductor.status = "disconnected";
  conductor.disconnectedAt = new Date().toISOString();
}
```

→ これをテストから直接呼ぶ、あるいは `monitorConductors` 内の状態遷移を関数抽出せずに「`cmux.validateSurface` を fake PATH で失敗させる」E2E 方式で検証する、のどちらか。

**推奨**: シナリオ 1 は PATH 差し替えで E2E 検証する（`cmux.test.ts` と同じパターンなので重複コードは発生するが、振る舞い保証としては確実）。シナリオ 2, 3, 4 はファイルシステム + state 操作のみで完結するため fake PATH 不要。

### 7.5 既存テストの互換性

- `daemon.test.ts` の既存 `scanTasks: assignTask エラー分離` テストは `status === "idle"` のままを確認 → 変更なし
- `conductor.test.ts` は `assignTask` のエラー分類のみ → 変更なし
- `SESSION_IDLE メッセージ処理` の既存テスト (`daemon.test.ts:279-305`) はスキーマ検証のみ → 変更なし

---

## 8. 影響範囲と既存テスト再チェック

| 影響箇所 | 既存テスト | 影響有無 |
|---------|-----------|---------|
| `cmux.ts::tree` timeout 追加 | なし | 新テスト追加 |
| `cmux.ts::validateSurface` リトライ | なし | 新テスト追加 |
| `daemon.ts::monitorConductors` crashed → disconnected | なし | 新テスト追加 |
| `daemon.ts::handleMessage` CONDUCTOR_DONE late cleanup | `daemon.test.ts::SESSION_IDLE メッセージ処理` | 影響なし（別ハンドラ） |
| `daemon.ts::handleMessage` SESSION_IDLE cleanup 分岐 | 同上（スキーマ検証のみ） | 影響なし |
| `daemon.ts::forceCloseDisconnectedConductor`（新規） | なし | 新テスト追加 |
| `daemon.ts::monitorConductors` に disconnect timeout 分岐 | なし | 新テスト追加 |
| `resetConductor` 呼び出し箇所増加 | 既存 `resetConductor` テストなし | なし |

**既存テスト全実行**で既存動作に回帰がないことを確認する:

```bash
cd skills/cmux-team/manager && bun test
```

- `daemon.test.ts::scanTasks: assignTask エラー分離` が `status === "idle"` を期待する点は変更なし
- `conductor.test.ts` は `assignTask` のみの確認なので無影響
- `queue.test.ts`, `task.test.ts`, `proxy.test.ts`, `preflight.test.ts` は当タスクの対象外

---

## 9. 実装順序

依存関係を考慮したステップ順:

### Step 1: schema.ts 確認（変更なし）
- `disconnectedAt` と `disconnected` status が既に存在することを確認。何もしない。

### Step 2: 修正 A — cmux.ts のリトライ実装
- ファイル: `skills/cmux-team/manager/cmux.ts`
- `TREE_TIMEOUT_MS`, `VALIDATE_SURFACE_RETRY_COUNT`, `VALIDATE_SURFACE_BACKOFF_MS` 定数追加
- `tree()` に `{ timeout: TREE_TIMEOUT_MS }` 追加
- `validateSurface()` をループ化（§2.3 のコード）
- `sleep` ヘルパー追加（`conductor.ts:17` と同じパターン、または既存インポート）

### Step 3: 修正 A のテスト — cmux.test.ts 新規作成
- `skills/cmux-team/manager/cmux.test.ts` を新規作成（§7.2.1）
- PATH 差し替え fake cmux によるリトライ動作検証
- `bun test cmux.test.ts` で単独実行確認

### Step 4: 修正 B — monitorConductors crashed ハンドラ(暫定形)
- ファイル: `skills/cmux-team/manager/daemon.ts` L796-804
- `crashed` case を `disconnected` 遷移に書き換え(§3.2)
- `conductor_crashed` → `conductor_disconnected reason=validate_surface_failed kind=crashed` に変更(Minor 1)
- taskRunId 等のフィールド保持
- **暫定形**: この時点では既存の `if (conductor.status === "idle" || conductor.status === "disconnected") continue;` は据え置く(Step 6 で separate 分岐にする)。

### Step 5: 修正 C-1 — CONDUCTOR_DONE late cleanup
- ファイル: `skills/cmux-team/manager/daemon.ts` L399-415
- `!conductor` ガードと `!conductor.taskRunId` ガードに分岐(§4.2)
- `conductor_done_late_cleanup` ログ追加
- `conductor_done_ignored reason=not_found` / `reason=no_task` に整理

### Step 6: 修正 C-2 — disconnect timeout + forceCloseDisconnectedConductor(+ 最終形 monitorConductors)
- ファイル: `skills/cmux-team/manager/daemon.ts`
- `DISCONNECT_TIMEOUT_SEC = 300` 定数追加(`STARTING_TIMEOUT_SEC` の直下)
- `forceCloseDisconnectedConductor` 関数新規追加(§5.4、`handleConductorDone` の近くに配置、**top-level import の loadTaskState/saveTaskState を使う**、`pidWatcherInterval` クリアを含める)
- `monitorConductors` を §5.3 の最終形に書き換え:
  - 冒頭で `tree(workspace)` を 1 回だけ呼びキャッシュ(`surfaceAlive` ヘルパー)。Major 1 対応
  - `disconnected` 分岐を独立化して timeout check → `forceCloseDisconnectedConductor` → continue(Major 4)
  - `idle` のみ即 continue(`if (disconnected) { timeout; continue; } if (idle) continue;`)
  - running surface 消失時は kind=crashed で disconnected 遷移(Step 4 をこの形に昇格させる)
  - Agent surface の生存チェックも `surfaceAlive` で行う(tree キャッシュ流用)

### Step 7: 修正 C-3 — SESSION_IDLE 経路(Critical 1 反映で再設計)
- ファイル: `skills/cmux-team/manager/daemon.ts` L549-573
- `disconnected + taskRunId` 復帰時は `status = "running"` に戻すだけにする(§6.2)
- **`resetConductor` は呼ばない** — Stop hook はターン境界ごとに発火するため、cleanup は C-1/C-2 に委ねる
- `taskRunId` なしの場合は従来どおり `idle` に戻す
- `starting` からの復帰は従来どおり `idle`

### Step 7.5: `conductor.ts::resetConductor` に `disconnectedAt` クリア追加(Minor 3)
- `conductor.ts:448-456` の 4. ConductorState リセットブロックに `conductor.disconnectedAt = undefined;` を 1 行追加

### Step 8: daemon.ts から monitorConductors を export
- `async function monitorConductors` → `export async function monitorConductors`

### Step 9: daemon.test.ts にシナリオ追加
- §7.2.2 の 6 テストを既存ファイル末尾に追加
- 1. シナリオ用の PATH 差し替えヘルパー（`cmux.test.ts` と共通化してもよいが、テストファイル間の共有は避けてインラインで書くほうが bun:test では簡潔）

### Step 10: 全テスト実行
```bash
cd skills/cmux-team/manager && bun test
```
- 既存テスト全 pass
- 新規テスト全 pass

### Step 11: 型チェック
```bash
cd skills/cmux-team/manager && bunx tsc --noEmit
```
- 型エラーなし

### Step 12: 手動 smoke test (任意)
- `cmux-team start` を別 worktree で試し、起動時エラーがないこと
- `cmux-team status` で Conductor リストが正常表示されること

---

## 10. 想定される落とし穴と対策

| 落とし穴 | 対策 |
|---------|------|
| `validateSurface` 遅延増加で起動が遅くなる | **Major 2 対応** で tree 成功時は即 return。遅延は tree() 例外時のみ最大 1.4s。`initializeLayout` も tree 成功時は追加遅延ゼロなのでスタートアップ体感は変わらない |
| `monitorConductors` の Agent 生存チェックループで tick 超過 | **Major 1 対応** で tree() 結果を tick 単位でキャッシュ。3 Conductor × 3 Agent でも tree 呼び出し 1 回 + includes 9 回 = ~100ms。10s tick に対して十分な余裕 |
| `disconnect_timeout` が startup 直後に発火する | `disconnectedAt` が未設定なら発火しない (§5.3 の `if (conductor.disconnectedAt)` ガード) |
| `SESSION_IDLE` 経路で生存中の Conductor の worktree を誤削除する | **Critical 1 対応** で SESSION_IDLE + taskRunId は `running` に戻すだけにした。Stop hook はターン境界ごとに emit されるため、cleanup は C-1 (CONDUCTOR_DONE) か C-2 (disconnect_timeout) に委ねる |
| `conductor_disconnect_timeout` が長時間 busy な Conductor(生きているが応答が重い)を誤 abort | `DISCONNECT_TIMEOUT_SEC = 300` (5 分) は保守的な値。`monitorConductors` が tree キャッシュで早期復帰判定できるため、実際には 5 分経過する前に SESSION_IDLE などで running 復帰するケースが大半。必要なら §12 Open Items の環境変数上書きで調整可能 |
| `handleConductorDone` の `conductor.taskId === "undefined"` ガードに引っかかる | 既存の error ログで観測可能。late cleanup 経路でも `taskRunId` があれば `resetConductor` 内の worktree 削除は正常動作する |
| PATH 差し替えテストが既存 `cmux` を呼び出してしまう | `PATH=$binDir:$origPath` と先頭に追加することで fake が優先される |
| Bun の `import("./cmux")` キャッシュで 2 テスト目以降に fake が効かない | `await import("./cmux")` のたびに Node module cache が 1 度だけ評価されるが、`cmux` モジュール自身は `execFile("cmux", ...)` を呼ぶだけ → ランタイムごとに fake が効く。state はテスト毎に counter file をリセット |
| `forceCloseDisconnectedConductor` 後も `pidWatcherInterval` が残る | **Minor 4 対応** で forceClose 内で明示 clearInterval する |
| `resetConductor` 後も `disconnectedAt` が古い値で残る | **Minor 3 対応** で resetConductor 末尾に `conductor.disconnectedAt = undefined;` 追加 |

---

## 11. 非スコープ（今回やらないこと）

- **`SESSION_ACTIVE`, `SESSION_CLEAR`, `SESSION_STARTED` の late cleanup** — タスク指示で C-3 は `SESSION_IDLE` のみ対象
- **自動 reopen** — CLAUDE.md フィードバック「異常検知時のリカバリーは人間に委ねる」に従う
- **`cmux read-screen` フォールバック** — 今回は `validateSurface` のリトライのみで対応
- **`getPaneForSurface`, `getPaneIdForSurface` の同様のリトライ化** — 必要なら別タスクで（今回の KDG-lab 事例では発火していない）
- **既存テストでカバーされていない他の crash 経路** — `pidWatcherInterval` 経由や `SESSION_ENDED` 経由は既に `disconnected` 遷移しているため変更不要

---

## 12. 完了条件 / Open Items

### 12.1 完了条件

- [ ] `cmux.ts`: `tree` に timeout 追加、`validateSurface` にリトライ実装(**tree 成功時は即 return**、tree 例外時のみリトライ — Major 2)
- [ ] `cmux.test.ts` 新規作成、4 テスト pass(最後のテストは「tree 成功時にリトライしない」ことを検証する形に書き換え済み)
- [ ] `daemon.ts`: `monitorConductors` 最終形(tree キャッシュ `surfaceAlive` + disconnected 独立分岐 + kind=crashed ログ — Major 1/4/Minor 1)
- [ ] `daemon.ts`: CONDUCTOR_DONE late cleanup 対応
- [ ] `daemon.ts`: `DISCONNECT_TIMEOUT_SEC` 定数と `forceCloseDisconnectedConductor` 関数追加(**top-level import の `loadTaskState/saveTaskState` を使用** — Major 3、`pidWatcherInterval` クリア — Minor 4)
- [ ] `daemon.ts`: `monitorConductors` に disconnected timeout 分岐追加(§5.3 最終形)
- [ ] `daemon.ts`: SESSION_IDLE 経路で `disconnected + taskRunId` は `status = "running"` に戻すだけ(**`resetConductor` を呼ばない** — Critical 1)
- [ ] `daemon.ts`: `monitorConductors` を export
- [ ] `conductor.ts::resetConductor`: 末尾に `conductor.disconnectedAt = undefined;` 1 行追加(Minor 3)
- [ ] `daemon.test.ts`: 6 新規テスト追加、全 pass(Test 1 に PATH fake setup コメント — Minor 6、Test 2 に worktreePath 冪等コメント — Minor 7、Test 3 に `conductor_disconnect_timeout` ログ検証 — Minor 9、Test 4 は running 復帰検証に書き換え — Critical 1)
- [ ] `bun test` 既存テスト全 pass
- [ ] `bunx tsc --noEmit` 型エラーなし

### 12.2 Open Items(採否は実装者判断)

Design Review で提案された Minor 項目のうち、本計画では optional 扱いとしたもの。実装フェーズで採否を決める。

- **Minor 2: `conductor_done_ignored` の `reason=not_running` 廃止の互換性** — 旧 `reason=not_running` ログを grep している外部ツールが破れる可能性があるため、CHANGELOG / リリースノートで変更点として明記する。PR 記述に含める(実コードは既に `reason=not_found` / `reason=no_task` に整理済み)。
- **Minor 5: `DISCONNECT_TIMEOUT_SEC` の環境変数上書き** — `CMUX_TEAM_DISCONNECT_TIMEOUT_SEC` 環境変数で上書き可能にする案。`CMUX_TEAM_POLL_INTERVAL` と同じパターンで 1〜2 行追加するだけのため、実装者の判断で追加可能。本計画では必須項目には含めない。
  ```ts
  const DISCONNECT_TIMEOUT_SEC =
    Number(process.env.CMUX_TEAM_DISCONNECT_TIMEOUT_SEC) || 300;
  ```

### 12.3 Design Review 10 項目との対応表

| # | Severity | 項目 | 対応場所 |
|---|----------|------|---------|
| 1 | Critical | C-3 SESSION_IDLE 再設計(`running` 復帰のみ、`resetConductor` 呼ばない) | §6.2, §6.3, §5.3.1, §7.2.2 Test 4 |
| 2 | Critical 付帯 | 状態遷移図から `SESSION_IDLE → resetConductor` エッジを削除 | §5.3.1 |
| 3 | Major 1 | monitorConductors の tree() キャッシュ | §5.3 `surfaceAlive`, §2.4 遅延見積もり |
| 4 | Major 2 | validateSurface のリトライは tree() 例外時のみ | §2.3, §7.2.1 Test 4(反転) |
| 5 | Major 3 | forceCloseDisconnectedConductor の top-level import | §5.4, §5.5 |
| 6 | Major 4 | §3.3 と §5.3/§9 Step 6 の continue 条件 | §3.3(暫定形注記), §5.3(最終形集約), §9 Step 4/6 |
| 7 | Minor 1 | `conductor_disconnected` ログに `kind=crashed` | §3.2, §5.3, §7.2.2 Test 1 |
| 8 | Minor 3 | `resetConductor` で `disconnectedAt` クリア | §5.4.1, §9 Step 7.5, §7.2.2 Test 2/3 |
| 9 | Minor 4 | `forceCloseDisconnectedConductor` で `pidWatcherInterval` クリア | §5.4 |
| 10 | Minor 5 | `CMUX_TEAM_DISCONNECT_TIMEOUT_SEC` 環境変数 | §12.2 Open Items(optional) |
| 11 | Minor 6 | Test 1 の PATH fake setup コメント | §7.2.2 Test 1 |
| 12 | Minor 7 | Test 2 の `worktreePath` 不在理由コメント | §7.2.2 Test 2 |
| 13 | Minor 8 | `initializeLayout` の遅延見積もり | §2.4 |
| 14 | Minor 9 | `conductor_disconnect_timeout` ログ検証テスト | §7.2.2 Test 3 |

Minor 2(`reason=not_running` 廃止の互換性)は §12.2 Open Items に記載し、CHANGELOG で扱う。

---

## 13. Design Review からの主な変更点(改訂版サマリ)

本 plan は Design Review "Changes Requested" に応じた改訂版。主な変更:

1. **§6 SESSION_IDLE ハンドラを再設計**(Critical 1): `disconnected + taskRunId` 復帰時に `resetConductor` を呼ぶ設計をやめ、`status = "running"` に戻すだけにした。Stop hook がターン境界ごとに発火する事実を受け、生存中の Conductor の worktree 誤削除を防ぐ。実際の cleanup は C-1 (CONDUCTOR_DONE) または C-2 (disconnect_timeout) が担う。
2. **§2.3 validateSurface のリトライを tree() 例外時のみに限定**(Major 2): tree 成功時は即 return し、missing ケース(Agent 終了直後等の正常系)に不要な 1.4s+ 遅延を載せないようにした。
3. **§5.3 monitorConductors に tree() キャッシュを導入**(Major 1): tick 冒頭で `tree(workspace)` を 1 回だけ呼び、`surfaceAlive(surface)` ヘルパーで Conductor/Agent を判定する。tree 呼び出し回数は tick あたり 1 回に抑えられ、tick interval 超過リスクが解消される。
4. **§5.3 monitorConductors の continue 条件を最終形に集約**(Major 4): `disconnected` を独立分岐(timeout check → continue)、`idle` のみ即 continue、という形に整理。§3.3 は暫定形として明示し、§5.3 が最終形であることを明記。
5. **§5.4 `forceCloseDisconnectedConductor` を top-level import 版に書き換え**(Major 3): 動的 `import("./task")` を削除し、`daemon.ts:18` に既に存在する `loadTaskState, saveTaskState` を直接使う形に統一。§5.5 の矛盾を解消。
6. **§3.2/§5.3 の `conductor_disconnected` ログに `kind=crashed` を付与**(Minor 1): 既存 `daemon.ts:682` の assign_failed 経路(`kind=conductor`)と同じ形式に揃えた。
7. **§5.4/§5.4.1 に `resetConductor` の `disconnectedAt` クリアと `pidWatcherInterval` クリアを追加**(Minor 3, Minor 4)。
8. **§7.2.1 Test 4 を「tree 成功時にはリトライしない」形に反転**(Major 2 のテスト)。
9. **§7.2.2 Test 1〜4 を Critical 1/Minor 6/7/9 に合わせて書き換え**: Test 1 に PATH fake setup コメント追加、Test 2 に worktreePath 不在理由コメント追加、Test 3 に `conductor_disconnect_timeout` ログ検証追加、Test 4 を「cleanup せず `running` 復帰」検証に全面書き換え。
10. **§9 Step 4 を「暫定形」、Step 6 で最終形に昇格**と明示。Step 7.5 で `resetConductor` への 1 行追加を別ステップとして切り出し。
11. **§10 pitfalls を Critical 1/Major 1/2 の対応を反映**した形に更新。
12. **§12.2 Open Items** セクションを追加して、optional/CHANGELOG 対応の Minor 項目を明示。
