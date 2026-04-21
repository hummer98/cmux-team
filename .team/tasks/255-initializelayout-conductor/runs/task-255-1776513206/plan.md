# T255 実装計画: initializeLayout の Conductor 復帰ロジックを単純化する

## 1. 目的と完了条件

### 目的
再起動時の Conductor 復帰処理を「team.json の pid alive チェックのみ → 1 つでも生きていれば早期 return」の現行仕様から、**surface 実在 × PID 生存 × task 有無のマトリクスで駆動する宣言的な復帰アルゴリズム**に置き換える。部分復元時の補充・残骸 pane の掃除・session-id による resume を同一ルーチンで扱う。

### 完了条件（タスク本文リピート）
- 部分復元時（`pid=null` と pid alive が混在）でも不足分が `maxConductors` まで新規作成されること
- surface が workspace に実在する Conductor は PID が死んでいても session-id で resume 復帰すること
- PID 死亡 + surface 残骸ありのケースで残骸 pane が掃除されること（旧 T252 統合分）
- resume できない（worktree 消失等）場合は task を ready に戻す等の妥当なフォールバックがあること
- 既存の self-register フロー（`CONDUCTOR_REGISTERED`）と衝突しないこと
- `daemon.test.ts` の既存ケースが通ること + 新アルゴリズムに対応するテスト追加

<!-- 懸念 1 対応: 方針の微調整 -->
**本 PR での方針変更**: 上記 1 項目目「不足分が `maxConductors` まで新規作成されること」は、**`team.json.conductors` が空のときのみ満たす**方針に調整する。部分復元時（既存 pane が残っている）は `createConductorPanes` の newSplit が既存 pane とレイアウト衝突するため、補充を行わず `maxConductors` 未満で稼働する運用に倒す（R7、後続タスクで拡張対応）。

## 2. 現行コードの構造理解

### 2.1 `initializeLayout` (`daemon.ts:782-905`)

```
team.json 存在チェック
  └─ conductors[] を走査
       ├─ PID alive check 1 本だけで restored[] に積む
       └─ pid_dead は conductor_restore_skipped で捨てる
  └─ restored.length > 0 なら
       ├─ state.conductors をまるごと差し替え（restored のみ）
       ├─ pidWatcher 再起動
       ├─ resumePlan に対して conductor_resume_noop ログを出すだけ（resume 命令は送らない）
       └─ return [] ← ★ 新規スロット作成フェーズに進まない
  └─ restored.length === 0 のみ initializeConductorSlots に到達
```

**問題点:** (1) surface 実在を見ていないので、PID が alive でも surface が workspace から消えている虚ろな entry を復元してしまい得る。(2) 部分復元（pid_dead 混在）時、restored 側 1 件でも残れば early return するため `maxConductors` への補充が走らない（今回の `surfaces=C[46]` だけで boot_completed するバグ）。(3) pid_dead + surface 残骸（cmux pane のみ残存）を掃除する経路が無い（旧 T252）。

### 2.2 `initializeConductorSlots` (`conductor.ts:183-254`)

- `createConductorPanes(count, daemonSurface, layout)` で Phase 1 pane 分割
- Phase 2 で panes に対して `launchConductor` を 1:1 割当
  - `resumePlan[i]` があれば `{ resumeTaskId, mainBranch }` 付きで起動（`cmux-team resume <id>` を pane に送信）
  - 無ければ通常起動（`cmux-team conductor` を pane に送信）
- 直後に pre-population: `conductors.set(surface, { status: "running", taskId, taskRunId, worktreePath, taskTitle, agents: [] })` を resumePlan 分だけ同期的に行う（`conductor_resume_prepopulated` ログ）
- 非 resume 分の `state.conductors` 登録は `CONDUCTOR_REGISTERED` self-register に委譲（T228）
- 返り値は `ResumeAssignment[]`（呼び出し元 `main.ts:657-675` が `state.conductors.get(r.surface)` を mutate して taskRunId/taskTitle/status/startedAt を最終反映）

### 2.3 `CONDUCTOR_REGISTERED` ハンドラ (`daemon.ts:1257-1303`)

- **idempotent**: `state.conductors.has(message.surface)` が true なら `conductor_register_skipped` でスキップ（既存 taskId/agents/status を破壊しない）
- つまり復帰側で `state.conductors.set()` を先に行っておけば、後続の `cmdConductor` / `cmdResume` からの self-register POST は skip される（衝突しない）
- soft cap: `state.conductors.size >= state.maxConductors` でも warn して登録続行（hard cap にしない）

### 2.4 resume 送信方法

現行 resume は **pane 起動コマンド経路**（`launchConductor` の `cmux.send(surface, 'cmux-team resume <id>\n')`）でのみ行われ、既に起動済みの Claude プロセスに対して resume させるコードパスは存在しない。

したがって、本タスクで「surface あり + Claude 死亡 + running task」ケースを実現するには:
- 対象 surface に対して `launchConductor(projectRoot, surface, { resumeTaskId, mainBranch })` をそのまま流用すれば良い（シェル環境のリセット → `cmux-team resume <id>` 送信 → タブ名設定）
- 「surface 無し + running task」ケースは **新規 surface 作成 + `launchConductor(..., { resumeTaskId })`** = 現行 `initializeConductorSlots` の resume パスそのもの

よって resume 命令を送るための新規実装は不要。`launchConductor` の呼び出し箇所を復帰フロー側にも足すだけで済む。

### 2.5 `resume_fallback_to_ready` の既存実装 (`main.ts:596-605`)

`initializeLayout` より前（`rawResumePlan` 構築時）に、`sessionId / worktreePath 実在 / taskRunId` いずれか欠落なら `taskState[taskId].status = "ready"` に戻して `resume_fallback_to_ready` ログを出す処理が既にある。

→ worktree 消失フォールバックは **この既存ロジックを temporary 時点の判定に一本化**する。後段の `initializeLayout` 内では「resumePlan に乗ってきた item は worktree 実在前提」として扱える。

## 3. 新アルゴリズムの擬似コード

<!-- 懸念 7 対応 -->
**既存 `layout_mismatch_on_resume` ログの扱い**: 現行 `daemon.ts:796-801` の警告ログは保持。出力タイミングは **team.json 読み込み直後**（`planLayoutRestore` 呼び出し前、`initializeLayout` の冒頭）で従来通り発火させる。CHANGELOG にも「挙動維持」として記載。

### 3.1 マトリクス

| # | surface 実在 | PID 生存 | taskRunId/sessionId 有り | 通常動作 | tree 失敗時 (liveSurfaces=null) <!-- 懸念 4 対応 --> |
|---|:---:|:---:|:---:|---|---|
| A | ✓ | ✓ | — | **そのまま登録**（既存 pane + Claude 生存、running task があれば running、無ければ idle） | A 相当（保守） |
| B | ✓ | ✗ | ✓ (running) | **resume 起動**（`launchConductor({ resumeTaskId })` で session-id 再開）。state は pre-set | **A 相当にダウングレード**: pid dead でも触らず登録。次 tick の `spawnPidWatcher` で `disconnected` に落ちて人間判断に委ねる |
| C | ✓ | ✗ | ✗ (idle) | **残骸掃除**: `cmux.closeSurface(surface)` → entry 破棄 → 新規スロット補充枠に | **cleanup せず discard のみ**: surface 消失判定ができないため pane を閉じるのは危険（別 workspace の surface を誤閉じるリスク）。entry のみ discard |
| D | ✗ | — | ✓ (running) | **新規 surface + resume**: `createConductorPanes(1)` 等で surface 作成 → `launchConductor({ resumeTaskId })`。state pre-set | **unmatched として plain 新規に合流**: surface 実在判定不能のため個別処理を避け、全部 unmatched resume 扱いで一元化 |
| E | ✗ | — | ✗ (idle) | **entry 破棄**: 新規スロット補充枠に | entry 破棄（同左） |

<!-- 懸念 4 対応 -->
tree 失敗時は `tree_fetch_failed degrade=pid_only` ログを `initializeLayout` 冒頭で先頭出力し、分類は「pid alive 一本」に縮退（ほぼ現行動作と同等）。`B` は `A` へ寄せ、`C` のハード cleanup は停止。

<!-- 懸念 1 対応 -->
**pane 新規分割の方針**: 復帰時は**既存 pane を起点にした新規 pane 分割を行わない**。`kept.size + unmatched resume の消化分` が `maxConductors` 未満でも許容し、足りない枠は人間が `cmux-team stop/start` で再配置する割り切り。理由: `createConductorPanes` は `daemonSurface` 起点で `newSplit` する前提で、既存 C1〜C3 pane が workspace に残った状態でのレイアウト整合性を保証しない（wide: 右に split → 重複 / 16x9: 下に split → 下段 3 pane 化）。宣言的な復帰アルゴリズムの範囲を `state.conductors` と session-id resume に限定し、**レイアウト補充は後続タスクで扱う**（R6 として記載）。

ただし **team.json が空 or conductors 配列ゼロ** のケース（初回起動 / `cmux-team stop` 後の正常起動）は従来通り `initializeConductorSlots(maxConductors, resumePlan)` を呼んで plain 新規 slot を一斉作成する（この経路は pane 衝突が起こらない）。

### 3.2 擬似コード

```ts
async function initializeLayout(state, daemonSurface, resumePlan) {
  const { projectRoot, workspace, maxConductors, layout } = state;
  const teamJsonPath = join(projectRoot, ".team/team.json");

  // 1. team.json 読み込み（存在しない / 壊れている / conductors 空 は空配列扱い）
  //    layout_mismatch_on_resume は従来通りここで出す（懸念 7 対応）
  const { conductors: conductorsFromJson, layout: teamLayout } = loadConductorsFromTeamJson(...);
  if (teamLayout && teamLayout !== state.layout) {
    await log("layout_mismatch_on_resume", `team=${teamLayout} current=${state.layout}`);
  }

  // 2. workspace 内に実在する surface 集合を一度だけ取得
  //    tree() 失敗時は liveSurfaces=null で pid_only degrade（懸念 4 対応）
  const liveSurfaces = await fetchLiveSurfaces(workspace); // Set<string> | null
  if (liveSurfaces === null) {
    await log("tree_fetch_failed", `degrade=pid_only`);
  }

  // 3. resumePlan を taskId でインデックス（main.ts 側で filter/sort 済み）
  const resumeByTaskId = new Map(resumePlan?.map(r => [r.taskId, r]) ?? []);
  const matchedTaskIds = new Set<string>();  // 懸念 2 対応: classification で拾った taskId を記録

  // 4. 各 entry を A〜E に分類（liveSurfaces=null 時は 3.1 表の右列に縮退）
  const kept: Array<{ decision: "A"|"B"|"D"; ... }> = [];
  const discarded: Array<{ surface: string; reason: string }> = [];
  const cleanupSurfaces: string[] = [];  // C

  for (const c of conductorsFromJson) {
    if (!c.surface) continue;
    const pidAlive = typeof c.pid === "number" && cmux.isAlive(c.pid);
    const surfaceExists = liveSurfaces ? liveSurfaces.has(c.surface) : true;
    const runningTask = c.taskId && resumeByTaskId.has(c.taskId);
    const treeDegraded = liveSurfaces === null;

    if (surfaceExists && pidAlive) {
      kept.push({ ...c, decision: "A" });
      if (runningTask) matchedTaskIds.add(c.taskId);
    } else if (surfaceExists && !pidAlive && runningTask && !treeDegraded) {
      kept.push({ ...c, decision: "B", resume: resumeByTaskId.get(c.taskId) });
      matchedTaskIds.add(c.taskId);
    } else if (surfaceExists && !pidAlive && !runningTask && !treeDegraded) {
      cleanupSurfaces.push(c.surface);
      discarded.push({ surface: c.surface, reason: "pid_dead_idle_cleanup" });
    } else if (!surfaceExists && runningTask && !treeDegraded) {
      kept.push({ decision: "D", resume: resumeByTaskId.get(c.taskId) });
      matchedTaskIds.add(c.taskId);
    } else if (treeDegraded && !pidAlive) {
      // tree 失敗 + pid dead → A 相当保守（B 経路・C cleanup・D 分岐はすべて回避）
      kept.push({ ...c, decision: "A" });
      if (runningTask) matchedTaskIds.add(c.taskId);
    } else {
      discarded.push({ surface: c.surface, reason: "surface_missing_no_task" });
    }
  }

  // 4b. unmatched resume の集約（懸念 2 対応）
  //     team.json に未反映の assigned タスク（daemon クラッシュのタイミング依存）を拾う
  const unmatchedResumes = [];
  for (const [tid, item] of resumeByTaskId) {
    if (!matchedTaskIds.has(tid)) {
      unmatchedResumes.push(item);
      await log("resume_unmatched_to_ready", `task_id=${tid} reason=not_in_team_json`);
    }
  }
  //     本タスクの方針（懸念 1 対応: 復帰時 pane 新規作成しない）により、
  //     unmatched は pane 補充せず task-state を ready に戻して次 tick の scanTasks に委ねる。
  for (const r of unmatchedResumes) {
    taskState[r.taskId].status = "ready";
  }
  saveTaskState(projectRoot, taskState);

  // 5. 残骸掃除（C 経路）— 冪等扱いで失敗は best-effort
  for (const s of cleanupSurfaces) {
    await cmux.closeSurface(s);
    await log("conductor_stale_surface_closed", `${formatSurface(s, "C")}`);
    // worktree 削除はしない（feedback_error_recovery: 判断を人間に委ねる）
  }

  // 6. A 決定分の state 反映（そのまま登録）— 懸念 6 対応: task-state 整合性リコンサイル
  state.conductors.clear();  // 既存挙動踏襲
  for (const item of kept.filter(k => k.decision === "A")) {
    let taskId = item.taskId;
    let taskRunId = item.taskRunId;
    let worktreePath = item.worktreePath;
    let status = item.status ?? "running";
    if (taskId && taskState[taskId]?.status !== "assigned") {
      await log(
        "conductor_taskid_reconciled",
        `${formatSurface(item.surface, "C")} taskId=${taskId} ` +
        `teamJsonStatus=${status} taskStateStatus=${taskState[taskId]?.status ?? "missing"}`,
      );
      taskId = undefined; taskRunId = undefined; worktreePath = undefined;
      status = "idle";
    }
    const c = { ...item, taskId, taskRunId, worktreePath, status };
    state.conductors.set(c.surface, c);
    if (typeof c.pid === "number") spawnPidWatcher(state, c, c.pid);
    for (const a of c.agents ?? []) if (a.pid) spawnAgentPidWatcher(state, c, a, a.pid);
  }

  // 7. B 決定分: 既存 surface に対して launchConductor(resumeTaskId) を送って resume。
  //    pre-set → launchConductor を sequential に。失敗時はロールバック（懸念 3 対応）。
  const assignments = [];
  for (const item of kept.filter(k => k.decision === "B")) {
    state.conductors.set(item.surface, {
      surface: item.surface,
      status: "running",
      startedAt: new Date().toISOString(),
      agents: [],
      taskId: item.resume.taskId,
      taskRunId: item.resume.taskRunId,
      worktreePath: item.resume.worktreePath,
      taskTitle: item.resume.taskTitle,
    });
    try {
      await launchConductor(projectRoot, item.surface, {
        resumeTaskId: item.resume.taskId,
        mainBranch: state.mainBranch,
      });
      assignments.push({ surface: item.surface, ...item.resume });
    } catch (e) {
      // 懸念 3 対応: pre-set をロールバック + task-state を ready に戻す
      state.conductors.delete(item.surface);
      taskState[item.resume.taskId].status = "ready";
      saveTaskState(projectRoot, taskState);
      await log(
        "conductor_resume_launch_failed",
        `${formatSurface(item.surface, "C")} task_id=${item.resume.taskId} err=${e.message}`,
      );
    }
  }

  // 8. 不足分を新規作成（懸念 1 対応: 復帰時は pane 新規作成しない方針）
  //    team.json が空/ゼロのケースのみ従来通り initializeConductorSlots を呼ぶ。
  //    kept.size > 0 のときは pane 補充を見送り、人間の手動再起動に委ねる。
  if (conductorsFromJson.length === 0) {
    // 初回起動 / stop 後の正常起動: plain 新規 slot を一斉作成
    const newAssignments = await initializeConductorSlots(
      projectRoot, state.conductors, maxConductors, daemonSurface,
      [...resumePlan], layout, state.mainBranch,
    );
    assignments.push(...newAssignments);
  }
  // 部分復元時（kept.size > 0）は D 相当の resume も pane 補充も行わない。
  // D 決定分・unmatched resume は全て step 4b で ready に戻されるため、次 tick で
  // 空き Conductor があれば scanTasks 経由で再割当される。

  return assignments;
}
```

<!-- 懸念 1 対応 / 懸念 2 対応: D 経路の扱い -->
上記擬似コードでは **`kept.size > 0` の部分復元時には pane 補充も D/unmatched resume も行わない方針**を採用。D 決定分（surface 消失 + running task）と unmatched resume はまとめて `task-state` を `ready` に戻し、次 tick の `scanTasks` で空き Conductor があれば通常の assignment フローで再割当される。これにより session-id resume は失われるが、Conductor 側の `cmux-team resume` は `--resume <sessionId>` の fallback 経路で新セッションを張る（既存挙動と同じ）。

もし session-id resume を優先したい要望が出た場合は、後続タスクで「kept pane を起点に newSplit する `createConductorPanes` 拡張」を追加する形で対応する（R6）。

### 3.3 副作用のタイミング

| 順序 | 操作 | 副作用 |
|---|---|---|
| 1 | team.json 読み込み | 読み取りのみ |
| 2 | `tree(workspace)` 取得 | 読み取りのみ（失敗時は null fallback） |
| 3 | 分類ループ | 副作用なし |
| 4 | cleanup (`cmux.closeSurface`) | cmux 側で pane close |
| 5 | A の state 反映 | `state.conductors.set` + pidWatcher 起動 |
| 6 | B の pre-set + `launchConductor` | `state.conductors.set` → pane にシェル環境投入 → `cmux-team resume <id>` 送信 |
| 7 | `initializeConductorSlots` | `createConductorPanes` で新 pane 分割 → `launchConductor` 一斉起動 |
| 8 | self-register POST 受信 | `CONDUCTOR_REGISTERED` ハンドラが idempotent merge（pre-set 済みなら skip） |

ループ順序: **A → cleanup → B → D（= 新規 pane + resume）→ plain 新規 slot**。この順序により、新規 pane 分割前に残骸 pane を閉じて座席を空けるため、ペイン配置が予想外にズレない（wide/16x9 とも）。

## 4. 関数分解の提案

### 4.1 新規 helper（`daemon.ts` 内 or 新ファイル `layout-restore.ts`）

型定義（`daemon.ts` もしくは `schema.ts` に追加、テスト容易性のため小さく切る）:

```ts
type RestoreDecision = "keep-alive" | "resume-existing" | "cleanup-stale"
                     | "resume-new-surface" | "discard";

interface RestoreEntry {
  raw: any;                     // team.json の conductor 生 JSON（型は既存踏襲）
  decision: RestoreDecision;
  resume?: ResumePlanItem;      // B / D のとき
}

interface LayoutRestorePlan {
  alive: RestoreEntry[];        // A
  resumeExisting: RestoreEntry[]; // B
  cleanup: string[];            // C (surface list)
  resumeNewSurface: RestoreEntry[]; // D
  discarded: Array<{ surface: string; reason: string }>; // C,E
}
```

分類 pure function（副作用なし、テストしやすい）:

```ts
export function planLayoutRestore(
  conductorsFromJson: any[],
  liveSurfaces: Set<string> | null,  // null = tree 失敗（不明扱い）
  isAlive: (pid: number) => boolean,
  resumePlan: ResumePlanItem[],
): LayoutRestorePlan;
```

適用フェーズ（副作用あり、daemon state を mutate）:

```ts
async function applyRestorePlan(
  state: DaemonState,
  plan: LayoutRestorePlan,
  daemonSurface: string | undefined,
): Promise<ResumeAssignment[]>;
```

### 4.2 既存関数との責務分担

| 関数 | 変更 |
|---|---|
| `initializeLayout` (`daemon.ts`) | 上記 helper を呼び出すだけの薄いオーケストレータに簡素化 |
| `initializeConductorSlots` (`conductor.ts`) | **変更なし**。ただし **`team.json.conductors` が空の場合のみ呼び出す**（懸念 1 対応）。部分復元時は呼ばないため、既存 pane と重複するレイアウト衝突を回避 |
| `launchConductor` (`conductor.ts`) | **変更なし** — B 経路（既存 pane への resume 送信）でそのまま流用。D 経路は本タスク範囲外（R7 / 懸念 1 対応方針） |
| `cmux.ts` | **`tree(workspace)` 出力から surface 一覧を Set で返すユーティリティ** を新規追加（`fetchLiveSurfaces(workspace): Promise<Set<string> | null>`）。`workspace === undefined` のときは `null` を返す契約（懸念 9 M13）。既存 `getPaneForSurface` / `listSiblingSurfaces` のパース処理とロジック共有 |

### 4.3 `state.conductors.clear()` の扱い

現行 (`daemon.ts:853`) は restored 反映直前に `state.conductors.clear()` している。これは **initializeLayout 到達時点で state には何も入っていない前提**に依存している（createDaemon 直後）。この前提を踏襲し、clear() は applyRestorePlan の冒頭で 1 回だけ実行する。

## 5. resume 送信方法の特定

**結論: 既存の `launchConductor(projectRoot, surface, { resumeTaskId, mainBranch })` をそのまま使う。新規実装は不要。**

- 実体は `conductor.ts:85-117`。pane に対して:
  1. `cmux send "export CMUX_SURFACE=... CMUX_CLAUDE_HOOKS_DISABLED=1 CMUX_TEAM_MAIN_BRANCH=..."`
  2. `cmux send "cmux-team resume <taskId>\n"`
  3. `cmux renameTab "[N] Conductor"`
- 内部で `cmdResume` (`main.ts:1719-1788`) が発動して `claude --resume <sessionId>` を exec する
- B 経路（既存 surface に対して resume）と D 経路（新規 surface に対して resume）で共通コード

**注意:** B 経路では `createConductorPanes` は呼ばれない。既に surface が存在するため、`launchConductor` だけで十分。

## 6. worktree 消失時のフォールバック判断

### 判断: **既存の `main.ts:596-605` (resume_fallback_to_ready) に一本化する**

**根拠:**
1. `rawResumePlan` 構築フェーズ（`main.ts:589-613`）で `existsSync(ts.worktreePath)` が既に検査されており、消失時は `task-state[taskId].status = "ready"` に戻して `resume_fallback_to_ready` ログを出している。
2. したがって `initializeLayout` に渡ってくる `resumePlan` は **worktree 実在が保証された item のみ**。B/D 経路で改めて検査する必要はない（ただし保険として `launchConductor` 送信直前に `existsSync` を assert だけしておく → 消えていたら同様に ready 戻し + アボート ログ）。
3. `abort + journal` を選ばない理由: 
   - 原因が worktree 削除（ユーザー操作か破壊的 cleanup）だけなら、復元不能 = タスク自体の失敗ではない。
   - `ready` に戻せば次の `scanTasks` で新しい worktree から再割当される（既に `resume_fallback_to_ready` が採っている方針）
   - `feedback_error_recovery.md` 通り、自動 abort は **明確に詰んだケース** に限定すべき。worktree が単に消えただけなら `ready` 戻しの方が人間の意図に沿う

**保険経路のログ:** `launchConductor` 直前で worktree 消失を検知した場合は `resume_worktree_missing_late task_id=<id> surface=<S>` を出し、`taskState[taskId].status = "ready"` に差し戻して `saveTaskState` を呼ぶ。

## 7. 冪等性・再入安全性の考察

**前提:** `initializeLayout` は daemon 起動時の 1 回のみ呼ばれる（`main.ts:653` から呼び出し、以後呼び出されない）。本タスクでも単発呼び出しを維持する。

それでも冪等性を担保すべき理由と方針:

| 観点 | 再入時の挙動 |
|---|---|
| **`state.conductors.clear()` の破壊性** | `applyRestorePlan` の冒頭で 1 回だけ。再入すると既存 alive entry も消してしまうので、`initializeLayout` が 2 回呼ばれる設計変更を将来行う場合は `clear()` を外して idempotent merge に寄せる（今回は単発呼び出し前提なので clear で OK） |
| **`CONDUCTOR_REGISTERED` との race** | pre-set → self-register POST の順。後着 POST は `conductor_register_skipped` で idempotent に弾かれる |
| **`cmux.closeSurface` の二重呼び出し** | 既存の `closeSurface` は `runCmux(...).catch(() => {})` で冪等実装済み（`cmux.ts:99-103`）。二重呼び出し OK |
| **`launchConductor` の二重送信** | pane 起動コマンドは `cmux send` で pane のシェルに流すだけ。再送すると重複プロンプトになるため、A 経路（alive）には絶対に送らない（= `resume_existing` / `resume_new_surface` 以外では launchConductor を呼ばない） |
| **`spawnPidWatcher` の二重起動** | **既存実装済み**（`daemon.ts:2046-2048` で `if (conductor.pidWatcherInterval) clearInterval(conductor.pidWatcherInterval)` により、新 watcher 起動前に既存 watcher を確実に停止）。本 PR では touch せず現状維持 <!-- 懸念 5 対応 --> |
| **B/D 経路の `launchConductor` 失敗** <!-- 懸念 3 対応 --> | pre-set した entry を孤児化させない。`try/catch` で `state.conductors.delete(surface)` + `taskState[taskId].status = "ready"` + `saveTaskState()` を実行し、`conductor_resume_launch_failed surface=<S> task_id=<T> err=...` ログを出す。次 tick の `scanTasks` で再割当される |

## 8. テスト戦略

### 8.1 残すテスト（既存）

`daemon.test.ts` の以下は本タスクで影響を受けない — そのまま通ること:
- L590-893 `crashed → disconnected 遷移 (T121/T195)` 群
- L1842-1956 `handleMessage: CONDUCTOR_REGISTERED (T228)` 群（idempotent skip 契約）
- L1631-1756 `startMaster restore (T229)` 群（Master 復元は別ロジック）
- L3005-3037 `team.json round-trip: broken Conductor を書き出して読み戻しても broken のまま (ST-14)`
  - ただし L3029-3036 の pseudo-restore コード片は行番号コメント (`daemon.ts:840-845`) が古くなるため、コメント更新が必要

### 8.2 書き換えるテスト

該当なし（`initializeLayout` 単体テストは現状存在しない）。

### 8.3 追加するテスト

新 `describe("initializeLayout restore matrix (T255)")` を追加。モック:

- `cmux.__setTreeImpl(impl)`: `tree(workspace)` の戻り値を差し替え（surface 実在判定のため）
- `cmux.__setIsAliveImpl(impl)`: PID 生存判定を差し替え
- `cmux.closeSurface` / `launchConductor` は spy（呼ばれたかを検証）
- team.json / task-state.json は `testDir` に直書き

テストケース（マトリクスに対応）:

| ID | シナリオ | 検証 |
|---|---|---|
| M1 | **A のみ**: 2 entry 両方 surface 実在 + pid alive | `conductors_restored count=2`、`launchConductor` / `closeSurface` 未呼び出し、`conductors.size === 2` |
| M2 | **A 1件 + C 1件**: 1件 alive、1件 pid_dead + surface 残骸あり + task なし | `cleanupSurfaces` が `closeSurface` 呼び出し、`conductors.size === 1`、`layout_creating_new_slots count=1` |
| M3 | **B 1件**: surface 実在 + pid_dead + running task | `launchConductor({ resumeTaskId })` 1回、`conductors.size === 1` (pre-set 確認) |
| M4 | **D 1件**: surface 消失 + running task | `createConductorPanes` + `launchConductor({ resumeTaskId })` 呼び出し、新規 surface が state に登場 |
| M5 | **E 1件**: surface 消失 + task なし | entry 破棄 + 新規 slot 補充、`conductor_restore_skipped reason=surface_missing_no_task` ログ |
| M6 | **再現バグ**: pid_dead 2件 + pid alive 1件 + maxConductors=2 を `surfaces=C[...]` 1件で boot_completed しない | `state.conductors.size === maxConductors` まで補充される |
| M7 | **`tree` 失敗**: `__setTreeImpl` が throw | 既存エントリを信用して現行動作に degrade（`liveSurfaces=null` 経路）、`tree_fetch_failed` ログ |
| M8 | **resume + self-register race**: pre-set 後に `CONDUCTOR_REGISTERED` が来ても taskId/agents 等が破壊されない | 既存 T228 テストのシナリオ再利用 |
| M9 | **worktree 消失 late**: `main.ts` 側 filter を通ったが `launchConductor` 直前に消える | `resume_worktree_missing_late` ログ + `task-state[id].status === "ready"` |
| M10 <!-- 懸念 6 対応 --> | **task-state 不整合**: A 決定の pane の `taskId` が team.json では running だが `taskState[id].status === "closed"` | `conductor_taskid_reconciled` ログ + entry が idle にリセット（`taskId` / `taskRunId` / `worktreePath` 全てクリア） |
| M11 <!-- 懸念 9 (M10 from review) --> | **`maxConductors=0`**（env 誤設定） | conductors 0、cleanupSurfaces のみ走る、`initializeConductorSlots` は呼ばれない |
| M12 <!-- 懸念 2, 9 (M11) --> | **`planLayoutRestore` 単体: team.json 空 + resumePlan 非空** | classification は空、step 4b で全 resume が `resume_unmatched_to_ready` + ready に戻される。team.json empty 経路の `initializeConductorSlots` 側では改めて ready タスクとして拾う |
| M13 <!-- 懸念 9 (M12) --> | **workspace 不明**（`state.workspace === undefined`） | `fetchLiveSurfaces(undefined)` は `null` を返す契約にする（別 workspace の surface を誤拾いしないため）→ tree_fetch_failed 経路で pid_only degrade |
| M14 <!-- 懸念 7, 9 (M13) --> | **layout mismatch**（team.json=wide、current=16x9） | `layout_mismatch_on_resume team=wide current=16x9` ログが出続ける（本タスクで挙動維持） |
| M15 <!-- 懸念 9 (M14) --> | **pre-set → `CONDUCTOR_REGISTERED` race（新経路）**: B 経路で pre-set 後に self-register POST が到着 | taskId / taskRunId / worktreePath / agents が破壊されず、`conductor_register_skipped` ログ |
| M16 <!-- 懸念 3 --> | **B 経路の `launchConductor` throw** | `state.conductors.get(surface)` が undefined、`taskState[id].status === "ready"`、`conductor_resume_launch_failed` ログ |

### 8.4 モック差し替えのヘルパー

既に `cmux.ts` に `__setTreeImpl` / `__setIsAliveImpl` があるため新規実装不要。テスト用に `buildTreeOutput(surfaces: string[])` の簡易生成関数を `daemon.test.ts` に置く（実際の `cmux tree` 出力形式に即した fixture）。

## 9. リスクと代替案

### リスク

| # | リスク | 対策 |
|---|---|---|
| R1 | `tree(workspace)` が重い / 失敗しやすい環境で起動が遅延する | timeout 5s は既存。失敗時は `liveSurfaces=null` 経路で現行動作に degrade（A 扱いを甘くする） |
| R2 | `state.conductors.clear()` が alive entry も消す副作用に依存する既存テストがある可能性 | 上記 ST-14 のみが唯一の影響箇所。コメント更新で追随 |
| R3 | `launchConductor` 経路で `cmux send "export CMUX_SURFACE=..."` → `cmux send "cmux-team resume ..."` の **shell prompt 状態の前提**（プロンプトが応答可能な状態）が崩れている pane （例: Claude が残骸として残っている）に対して送信すると余計な文字列が bleed する | B 経路に入る前に PID は死んでいる前提だが、念のため pane が **kill-agent 相当でクリーンアップ済みか** は今後の課題として artifact に記録。本タスクでは「pid_dead = shell に戻っている」前提で進める |
| R4 | Claude Max レート制限で同時 resume 起動が弾かれる | 既存 `initializeConductorSlots` の Phase 2 は sequential（await 1 本ずつ）なので問題なし。B 経路も同じく sequential にする |
| R5 | 旧 `conductor_resume_noop` ログの消失で既存アラートが壊れる | <!-- 懸念 10 対応 --> 本体 `daemon.ts:876` と T174 関連 docs（`.team/tasks/174-*/...`）のみ。**外部アラート・ダッシュボード・CHANGELOG 以外のドキュメントからの依存は確認できず**（下記エビデンス参照）。廃止で OK。CHANGELOG に明記 |
| R6 | `launchConductor` 直前 `existsSync` 後の worktree 消失 TOCTOU <!-- 懸念 8 対応 --> | **許容する**。根拠: (1) 実運用で Conductor 稼働中に worktree を削除することは稀、(2) 失敗時は claude 起動が落ちて PID 未登録のまま次 tick で `disconnected` 扱いになり、最終的に人間判断に委ねられる（feedback_error_recovery 準拠） |
| R7 | 部分復元時に pane 補充を行わない（懸念 1 方針）ため、`maxConductors` 未満で稼働することがある <!-- 懸念 1 対応 --> | 人間が `cmux-team stop/start` で完全再起動すれば復旧する。`layout_kept_partial count=<N> expected=<maxConductors>` を出して可観測化。将来 session-id resume を優先したくなったら「kept pane 起点の `createConductorPanes` 拡張」を後続タスクで対応 |

### 代替案（却下）

- **案 A: `validateSurface(surface, workspace)` を surface ごとに発行する** → tree 呼び出しが N 回走り重い。`tree(workspace)` 1 回を parse して Set を作る方が安い（しかも既存 `listSiblingSurfaces` と同じパターン）
- **案 B: 既存 early-return を残したまま「補充のみ追加」** → 部分復元バグは直るが、surface 残骸掃除 (C) と session-id resume (B/D) が分散したまま。マトリクス実装にしないと宣言的に記述できない
- **案 C: 旧 `validateSurface` を復活させ cmux.ts 側でリトライ付きで実装** → T195 で削除した経緯と逆行。内部で `tree()` を叩く点は同じなので利益なし

## 10. コミット/PR 粒度の提案

**単一 PR、3 コミットを提案:**

1. **refactor(manager): extract `planLayoutRestore` helper with restore matrix types**
   - `daemon.ts` or `layout-restore.ts` に pure function + 型定義追加
   - 既存 `initializeLayout` は未変更のまま、helper のテストだけ追加（M1〜M5 の分類テスト）

2. **feat(manager): simplify initializeLayout using restore matrix (T255)**
   - `initializeLayout` を helper 使用形に書き換え
   - `cmux.ts` に `fetchLiveSurfaces(workspace)` ヘルパー追加
   - `conductor_stale_surface_closed` / `resume_worktree_missing_late` / `tree_fetch_failed` / `resume_unmatched_to_ready` / `conductor_taskid_reconciled` / `conductor_resume_launch_failed` / `layout_kept_partial` ログ追加
   - M6〜M16 の統合テスト追加
   - `daemon.test.ts:3029` のコメント行番号を新実装に合わせて更新

3. **docs(changelog): T255 restore matrix**
   - CHANGELOG に「部分復元時の挙動変更（pane 補充は行わない / unmatched resume は ready に戻す）」「残骸 pane 掃除」「session-id resume（B 経路のみ）」を修正として記載
   - `conductor_resume_noop` ログ廃止を明記
   - 新ログ一覧（上記コミット 2）を列挙

<!-- 懸念 11 対応 -->
**代替: コミット 2 をさらに分割する選択肢**（必須ではない。diff 肥大時の bisect 容易性向上のため）:

- **2a. feat(manager): B-path resume for existing pane (T255)** — 既存 surface + pid dead + running task に対する session-id resume のみ追加。D/unmatched 経路は未着手。M3 / M15 / M16 テスト追加。
- **2b. feat(manager): unmatched resume & stale cleanup (T255)** — C cleanup、unmatched resume の ready 戻し、task-state reconcile を追加。M2 / M10 / M12 テスト追加。
- **2c. feat(manager): tree failure degrade path (T255)** — `tree()` 失敗時の pid_only degrade 処理と 3.1 表右列の挙動を実装。M7 / M13 テスト追加。

本タスクでは 2 本化を第一選択とし、レビューで diff 行数が大きくなりすぎる場合に 2a/2b/2c 分割へ切り替える運用とする。

### PR レビューポイント（レビュアーへの案内）

- `planLayoutRestore` が **pure function** であること（副作用なし、Set/Array を返すだけ）
- A〜E の分岐が **MECE** であること（擬似コードのマトリクス表と 1:1）
- `state.conductors.clear()` のタイミングが `applyRestorePlan` 冒頭 1 回のみであること
- `launchConductor` の呼び出しが B / D 経路以外から呼ばれていないこと（A に resume を送ったらバグ）
- `CONDUCTOR_REGISTERED` の idempotent skip が pre-set 後も働くこと（既存 T228 テストが通ること）
- `cmux.tree` mock を使った M1〜M9 がすべて通ること
- ログフォーマットが `CLAUDE.md` の `formatSurface` 規約に沿っていること（`C[...]` / key=value）

## 付録 A: `conductor_resume_noop` 依存確認エビデンス <!-- 懸念 10 対応 -->

`rg -n "conductor_resume_noop"` 実行結果（worktree `.worktrees/task-255-1776513206` ルート、2026-04-18 実施）:

```
skills/cmux-team/manager/daemon.ts:876:                "conductor_resume_noop",
.team/tasks/255-initializelayout-conductor/task.md:65:- resume 済み Conductor に対して resume 命令を二重送信しないこと（現行の `conductor_resume_noop` 相当の振る舞い）
.team/tasks/174-assigned-resume-claude/runs/task-174-1775987839/design-review.md
.team/tasks/174-assigned-resume-claude/runs/task-174-1775987839/plan.md
.team/tasks/174-assigned-resume-claude/runs/task-174-1775987839/impl.md
.team/tasks/174-assigned-resume-claude/runs/task-174-1775987839/summary.md
.team/tasks/174-assigned-resume-claude/runs/task-174-1775987839/inspection.md
```

- 本体依存: `daemon.ts:876` のみ（= 本 PR で削除する該当行）
- 監視対象: `.team/tasks/174-*/...` は過去タスクの run ドキュメントで実行時依存なし
- **外部（リポジトリ外のダッシュボード / アラート / README）からの依存は確認できず**。廃止で影響なし。

### CHANGELOG 雛形（コミット 3 で追記）

```md
### Changed
- **T255**: Conductor 復帰ロジックを restore matrix ベースに刷新。
  - 部分復元時に「1 件でも pid alive があれば early return」する挙動を廃止し、
    A〜E のマトリクス分類で宣言的に処理。
  - 既存 surface + pid dead + running task に対して session-id resume を実行（B 経路）。
  - pid dead + surface 残骸 + idle の pane を cleanup（旧 T252 統合）。
  - team.json に未反映の assigned タスク（unmatched resume）は task-state を ready に戻す。
  - 部分復元時は pane 補充を行わない（maxConductors 未満で稼働することを許容）。

### Removed
- ログ `conductor_resume_noop`（team.json 復元早期 return 時のみ発火していたログ）を廃止。
  新アルゴリズムでは発火経路自体が存在しない。

### Added
- ログ: `conductor_stale_surface_closed`, `resume_worktree_missing_late`,
  `tree_fetch_failed`, `resume_unmatched_to_ready`, `conductor_taskid_reconciled`,
  `conductor_resume_launch_failed`, `layout_kept_partial`。
```

## 付録 B: 参照した既存コード

- `skills/cmux-team/manager/daemon.ts:782-905`（`initializeLayout`）
- `skills/cmux-team/manager/daemon.ts:1257-1303`（`CONDUCTOR_REGISTERED` ハンドラ）
- `skills/cmux-team/manager/conductor.ts:85-117`（`launchConductor`）
- `skills/cmux-team/manager/conductor.ts:183-254`（`initializeConductorSlots` + pre-population）
- `skills/cmux-team/manager/main.ts:579-679`（resume plan 構築と反映）
- `skills/cmux-team/manager/main.ts:1719-1788`（`cmdResume`）
- `skills/cmux-team/manager/cmux.ts:139-165`（`tree` / `getPaneForSurface`）
- `skills/cmux-team/manager/cmux.ts:176-232`（`listSiblingSurfaces` / `isAlive` / `__setIsAliveImpl`）
- `skills/cmux-team/manager/cmux.ts:99-103`（`closeSurface`）
- `skills/cmux-team/manager/daemon.test.ts:1842-1956`（T228 idempotent テスト）
- `skills/cmux-team/manager/daemon.test.ts:3005-3037`（team.json round-trip テスト — コメント更新対象）
