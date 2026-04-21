# T250 実装計画書: Conductor に broken 状態を導入し、エラーステートを idle に戻さない

## 0. 要旨

A015 の 「決定 2 項: エラーステートの保持」 を実装する。
`forceCloseDisconnectedConductor` による **disconnect timeout → resetConductor → idle**
の自動フォールバックを廃止し、代わりに **broken** という新 status を
導入して、確定した異常状態をユーザーが明示的にクリアするまで痕跡ごと保持する。

スコープは A015 が「次のアクション 1」として列挙した範囲に限定する
（assign_failed / resume_fallback / initializeLayout PID 死亡等は別タスク）。

> **改訂版（rev2）のポイント**:
> - `clear-conductor` CLI の daemon 通知経路を **新 message 型 `CONDUCTOR_CLEAR`** に一本化
>   （Rev1 で採用した CONDUCTOR_DONE 流用は daemon.ts:986-992 の `no_task` guard で
>   早期 break するため機能しない。Design Review R1 対応）
> - `resetConductor` のシグネチャ拡張（opts 追加）に一本化し、cleanup 直書き展開案を削除
>   （R2 対応）
> - `conductor_broken` ログを resetConductor 側に集約（R3 対応）

## 1. 課題分析

### 1.1 現状の disconnected → idle 化の流れ

| # | 契機 | コード | 何をする |
|---|---|---|---|
| A | Conductor PID 死亡 | `daemon.ts:1949-1968` `__testSpawnPidWatcherTick` | `status = "disconnected"`, `disconnectedAt = now`, `pid = undefined` |
| B | SESSION_ENDED | `daemon.ts:1364-1371` | `status = "disconnected"`, `pid = undefined` |
| C | starting timeout (>3min) | `daemon.ts:2140-2152` | `status = "disconnected"` |
| D | assigning timeout | `daemon.ts:2155-2167` | `status = "disconnected"` |
| E | disconnect timeout (>N 分) | `daemon.ts:2169-2182` | `forceCloseDisconnectedConductor()` 呼び出し |
| F | forceCloseDisconnectedConductor 本体 | `daemon.ts:2192-2251` | task-state を aborted + cascade → `resetConductor()` |
| G | resetConductor | `conductor.ts:487-551` | siblings close + worktree/branch remove + **`status = "idle"`** + `disconnectedAt = undefined` |

F → G で **エラー痕跡（`disconnectedAt`、disconnected 到達事実、発火した timeout 事実）が全て
消える**。G の直後には `state.conductors` に **同じ surface が idle として残り**、次 tick
の `scanTasks` で `idleConductor = [...].find(c => c.status === "idle")` が当該 Conductor を
拾い、次のタスクが割り当てられる (`daemon.ts:1851`)。

### 1.2 根本原因

- `forceCloseDisconnectedConductor` が **state 遷移（ユーザーへの通知）と cleanup（worktree / branch 削除）を同時に** 行っている
- cleanup は冪等かつ必須（worktree が残ると次の割当で `git worktree add` が失敗する）
- 一方で `status = "idle"` は「この Conductor は次のタスクを受けられる」という宣言
- この 2 つが 1 関数に同居しているため、cleanup したら強制的に idle に戻るという構造になっている

### 1.3 影響範囲 (A015 (c) の直近事例)

- surface 112/113 の PID 死亡 (`spawnPidWatcher` → B パスで実施) → `conductor_disconnect_timeout`
  → E → F → G で idle 化 → 次の `scanTasks` で当該 surface に新タスクが割り当てられた
- Claude 本体は死んでいるため、新タスクのプロンプトは届かず `assigning` で再 timeout →
  ループ状態（状態が悪化し続けるが観測できない）
- `cmux-team status` / dashboard は「idle → running → disconnected → idle」の点滅だけが見えて、
  「この surface は確定的に壊れている」という情報は失われている

## 2. 技術アプローチ

### 2.1 broken status の定義

```
disconnected  : 一時的な通信断（SESSION_ENDED / PID 死亡 / timeout 未到達）
broken        : 確定した異常状態（disconnect timeout 到達 / cleanup 済み）
```

- broken Conductor は `state.conductors` に **残したまま** にする
  （surface map から削除しない。可視化のため）
- broken は **次の自動割当対象から除外**
- broken → idle への遷移は **ユーザーの明示操作のみ**
  - `cmux-team clear-conductor --surface <id>`（新設）
  - `cmux-team abort-task --task-id <id>` / `restart-task`（既存 CLI が内部で broken を解除）

### 2.2 A015 vs 本タスクの境界

A015「次のアクション」の 5 項目のうち、本タスクは **1 番のみ** を扱う:

- ✅ broken 状態の導入と forceCloseDisconnectedConductor の idle 化削除
- ❌ resetConductor への surface 実在確認追加（別タスク）
- ❌ initializeLayout の PID 死亡 → 残骸掃除先行（別タスク）
- ❌ `mainBranch` fallback の削除（別タスク）
- ❌ Task unique 制約の不変条件化（別タスク）

### 2.3 broken → idle 復帰方針（判断が必要なポイント）

**決定: 明示操作のみ** で復帰させる（自動検出併用はしない）。

理由:
- memory `feedback_error_recovery`「異常検知時のリカバリーは人間に委ねる」と整合
- A015 「決定」2 項「ユーザーが明示的にクリアするまで残す」と整合
- 自動検出（新 SESSION_STARTED 受信 → idle 復帰等）は、ユーザーが pane を手動で立て直した
  という意図の読み取りを Manager に任せることになり、誤った解釈で状態が消える
- broken になる契機（disconnect timeout）は既にユーザー通知に十分な時間が経過している状態。
  そこからさらに「自動的に直ったことにする」は A015 の方針から外れる

例外（broken を明示操作で解除する既存 CLI 経路）:
- `cmdAbortTask` / `cmdRestartTask` は `team.json.conductors.find(c => c.taskId === taskId)` で
  Conductor を探す。broken 到達時点で taskId はクリア済みのため、これらの CLI では
  **見つからない（find ＝ undefined）**。したがって broken Conductor 解除用の
  **専用 CLI `clear-conductor` を新設する**（surface 中心の指定）。
- `clear-conductor` は daemon に新 message 型 `CONDUCTOR_CLEAR` を送り、daemon 側で
  `resetConductor(targetStatus: "idle", reason: "cleared")` を呼ぶ経路。
- 既存 `abort-task` / `restart-task` は broken Conductor の解除には使えないため、
  運用ドキュメント（help + README）では `clear-conductor` を唯一の解除手段として案内する。

### 2.4 PID 監視の継続

broken 状態でも **PID watcher は clearInterval で停止済み**（`forceCloseDisconnectedConductor`
Step 2 で既に実施）。pid は既に undefined なので、新たに生存確認する対象がない。
可視化は「broken に到達したこと」と `disconnectedAt` を残すことで実現するため、追加の監視は
不要（A015 の「監視は broken 状態でも継続する（可視化のため）」はログ・TUI に状態が残って
いることを指すと解釈）。

## 3. 変更対象

| # | ファイル | 変更内容 |
|---|---------|----------|
| 1 | `schema.ts` | (a) `ConductorState.status` 型リテラルに `"broken"` を追加。 (b) 新 message 型 `ConductorClearMessage` を追加し `QueueMessage` discriminated union に加える |
| 2 | `daemon.ts` | (a) `forceCloseDisconnectedConductor` を `resetConductor(opts={targetStatus:"broken", reason:"disconnect_timeout"})` を呼ぶ形に縮退（cleanup 展開は行わない）。 (b) `handleMessage` に `case "CONDUCTOR_CLEAR"` を追加し、broken 判定 → `resetConductor(opts={targetStatus:"idle", reason:"cleared"})`。broken 以外は `conductor_clear_ignored` で break。 (c) `scanTasks` の idle 検索を `status==="idle"` のまま維持（broken は候補外）。 (d) 起動時 `initializeLayout` の team.json 復元で broken を保存 (`daemon.ts:840`)。 (e) `monitorConductors` の broken 分岐を追加（continue で skip）。 (f) SESSION_STARTED / SESSION_ACTIVE / SESSION_IDLE / SESSION_CLEAR の 4 ハンドラに broken early-return ガード |
| 3 | `conductor.ts` | `resetConductor` に 4 引数目 `opts?: { targetStatus?: "idle" \| "broken"; reason?: string }` を追加。`conductor.status = opts?.targetStatus ?? "idle"` とし、broken の場合のみ `disconnectedAt` を保持。ログは `status === "broken" ? "conductor_broken" : "conductor_reset"` で 1 箇所集約 |
| 4 | `main.ts` | (a) `cmdClearConductor` を新設（CONDUCTOR_CLEAR を postMessage）。 (b) `case "clear-conductor":` を dispatch に追加。 (c) `cmdStatus` の Conductor 列挙で broken を可視化 |
| 5 | `dashboard.tsx` | broken 表示を追加（RED + ⨯ アイコン + `disconnectedAt` 経過時間 + "use clear-conductor" ヒント）。Conductor セクションヘッダーに `${brokenCount} broken` を追加 |
| 6 | `i18n.ts` | `help_clear_conductor` を ja/en 両 dictionary に追加（`help_abort_task` / `help_restart_task` と同形式） |
| 7 | `daemon.test.ts` | (a) test "3. disconnect timeout で forced close" の期待値を `status="idle"` → `"broken"` に変更。 (b) broken Conductor が scanTasks で拾われないテスト。 (c) broken + SESSION_STARTED (4 バリアント) / SESSION_ACTIVE / SESSION_IDLE / SESSION_CLEAR で status 不変テスト。 (d) CONDUCTOR_CLEAR で broken → idle テスト。 (e) updateTeamJson → readFile → restoreConductors round-trip テスト |
| 8 | `conductor.test.ts` | resetConductor の targetStatus オプションが idle/broken 双方で期待通り動作するユニットテストを追加（既存テストは opts 未指定でデフォルト idle のまま pass） |

## 4. サブタスク分割（実装順序）

並列実装禁止。旧フォールバック（disconnect timeout → idle 自動化）は broken 導入と
**同じコミット内で削除**。

### ST-1. schema.ts: broken status を追加

- **対象**: `skills/cmux-team/manager/schema.ts:205`
- **内容**: `status: "starting" | "assigning" | "idle" | "running" | "asking" | "disconnected" | "broken"`
- **メソッド制約**: zod schema ではなくランタイム文字列 union なのでリテラル追加のみ
- **完了条件**: `bunx tsc --noEmit` が ST-3/ST-4/ST-6 で触れるべき分岐の網羅漏れを警告する
- **検証コマンド**: `rg '"starting" \| "assigning"' skills/cmux-team/manager/schema.ts`

### ST-1.5. schema.ts: CONDUCTOR_CLEAR message 型を新設 **(R1 対応・新規)**

- **対象**: `skills/cmux-team/manager/schema.ts`（L29 付近 `ConductorDoneMessage` の直下、L118 の
  `QueueMessage` discriminated union に加える）
- **内容**:
  ```ts
  export const ConductorClearMessage = z.object({
    type: z.literal("CONDUCTOR_CLEAR"),
    surface: z.string(),
    reason: z.string().optional(),  // "user_clear" 等（CLI 側で固定値を渡す）
    timestamp: z.string().datetime(),
  });
  // ...
  export const QueueMessage = z.discriminatedUnion("type", [
    // ... 既存 ...
    ConductorClearMessage,
  ]);
  export type ConductorClearMessage = z.infer<typeof ConductorClearMessage>;
  ```
- **理由（R1）**: `CONDUCTOR_DONE` 流用は `daemon.ts:986-992` の `conductor.status !== "running"
  && !conductor.taskRunId` guard で必ず早期 break するため、broken → idle 経路として機能しない。
  新 message 型で専用 handler を持たせ、handleConductorDone を触らない。
- **完了条件**: `QueueMessage` に `CONDUCTOR_CLEAR` が含まれ、`handleMessage` の switch で
  漏れなく扱える（tsc の exhaustiveness チェックに依存）
- **検証コマンド**: `rg '"CONDUCTOR_CLEAR"' skills/cmux-team/manager/schema.ts`

### ST-2. daemon.ts: forceCloseDisconnectedConductor を縮退

- **対象**: `skills/cmux-team/manager/daemon.ts:2192-2251` `forceCloseDisconnectedConductor`
- **内容**:
  1. 関数全体の責務を **「タスクを aborted + cascade させた後、`resetConductor` を `broken`
     targetStatus で呼ぶ」** に縮退する（cleanup 本体は resetConductor の中身を再利用。
     直書きしない）
  2. `await resetConductor(conductor, projectRoot, state.workspace, { targetStatus: "broken", reason: "disconnect_timeout" })` の 1 行に置き換える
  3. **削除すること**:
     - forceClose 内の `log("conductor_broken", ...)` 直書き（**R3 対応**: ログは resetConductor
       側に集約する）
     - forceClose 内で `conductor.status = "broken"` / `conductor.brokenAt = ...` を個別に
       セットする実装
     - cleanup を直書き展開する案（**R2 対応**: 案 A 一本化のため削除）
  4. **残すこと**:
     - resetConductor 呼び出し **前** の task-state.json aborted 書き込み + cascade 処理
       （T241 の child draft 戻し等）
     - `notifyStateChanged` は resetConductor 内で呼ばれるため、forceClose 側で二重に呼ばない
  5. **sessionId / その他フィールド**: 既存 resetConductor の挙動通り触らない
     （`conductor.ts:544` に `// sessionId は SessionStart hook で最新値に追従するため reset では
     触らない` のコメントあり）。**R7 対応**: Rev1 にあった「sessionId は残す（trace 追跡の
     ため）」は「既存 resetConductor 挙動の確認のみ。本 ST で追加作業なし」と書き換え済み
- **メソッド制約**: `resetConductor` のシグネチャ変更は ST-7 で行う（4 引数目に optional
  object を追加。既存呼び出し側は opts 未指定でデフォルト idle）
- **完了条件**:
  - `forceCloseDisconnectedConductor` 呼び出し後 `conductor.status === "broken"` が保持される
  - worktree / branch / siblings が掃除されている（resetConductor 内で実施）
  - `state.conductors.get(surface)` が broken Conductor を返す（削除されない）
  - forceClose 内に `log("conductor_broken", ...)` 直書きが残っていない
- **検証コマンド**: 
  - `rg 'log\("conductor_broken"' skills/cmux-team/manager/daemon.ts`（0 件になること）
  - `rg 'resetConductor\([^)]*targetStatus: "broken"' skills/cmux-team/manager/daemon.ts`（1 件）

### ST-3. daemon.ts: broken の idle 化経路を塞ぐ

- **対象**:
  - `daemon.ts:1082-1096` SESSION_STARTED handler
  - `daemon.ts:1426-1440` SESSION_ACTIVE handler
  - `daemon.ts:1514-1541` SESSION_IDLE handler
  - `daemon.ts:1661-1668` SESSION_CLEAR handler
- **内容**: **broken からの自動遷移は行わない**。各ハンドラで `conductor.status === "broken"` の場合は ignore ログのみ出して break:
  ```ts
  if (conductor.status === "broken") {
    await log(
      "session_event_ignored_broken",
      `${formatSurface(conductor.surface, "C")} event=SESSION_STARTED reason=broken_requires_manual_clear`
    );
    break;
  }
  ```
  - 上記 4 ハンドラの **既存の `disconnected/starting/assigning/asking` 分岐の前** に
    broken ガードを追加する
  - event ラベルは各 handler で正しく（`SESSION_STARTED` / `SESSION_ACTIVE` / `SESSION_IDLE`
    / `SESSION_CLEAR`）書き分けること（ST-13 (R4) で全バリアントを回帰テスト）
- **完了条件**: broken Conductor が SESSION_* イベント（4 種 + SESSION_STARTED の 4 source
  バリアント）を受け取っても status が変化しない
- **検証コマンド**: `rg 'session_event_ignored_broken' skills/cmux-team/manager/daemon.ts | wc -l`（4 件）

### ST-4. daemon.ts: monitorConductors の broken 分岐

- **対象**: `daemon.ts:2133-2185` `monitorConductors`
- **内容**: disconnected の timeout 判定ブロックの前（loop 先頭）に broken 分岐を追加。broken は skip:
  ```ts
  if (conductor.status === "broken") {
    // broken はユーザー明示操作 (clear-conductor / abort-task / restart-task) でのみ解除される。
    // 継続チェック・timeout は行わない。
    continue;
  }
  ```
- **完了条件**: broken Conductor が無限に「2 回目の timeout」で触られない
- **検証コマンド**: `rg 'conductor.status === "broken"' skills/cmux-team/manager/daemon.ts`

### ST-5. daemon.ts: scanTasks が broken を候補から外すことを確認（コード変更は不要の想定）

- **対象**: `daemon.ts:1849-1855`
  ```ts
  const idleConductor = [...state.conductors.values()].find(c => c.status === "idle");
  ```
- **内容**: 既に `status === "idle"` のみを拾う実装のため、broken は自動的に除外される。**追加
  コードは不要**だがテストで不変条件を固定する（ST-13 の 2 番目）
- **完了条件**: broken Conductor が混じった state で `scanTasks` を呼んでもその Conductor に assign されない
- **検証コマンド**: `rg 'c\.status === "idle"' skills/cmux-team/manager/daemon.ts`

### ST-6. daemon.ts: initializeLayout の team.json 復元で broken を保存

- **対象**: `daemon.ts:840`
  ```ts
  status: c.status === "running" ? "running" : c.status === "disconnected" ? "disconnected" : "idle",
  ```
- **内容**: broken を落とさない
  ```ts
  status: c.status === "running" ? "running"
    : c.status === "disconnected" ? "disconnected"
    : c.status === "broken" ? "broken"
    : "idle",
  ```
- **完了条件**: daemon 再起動後も broken Conductor が broken のまま復元される
- **検証コマンド**: `rg 'c.status === "broken"' skills/cmux-team/manager/daemon.ts`

### ST-7. conductor.ts: resetConductor に targetStatus オプションを追加

- **対象**: `skills/cmux-team/manager/conductor.ts:487-551`
- **内容**:
  ```ts
  export async function resetConductor(
    conductor: ConductorState,
    projectRoot: string,
    workspace?: string,
    opts?: { targetStatus?: "idle" | "broken"; reason?: string },
  ): Promise<void> {
    // ... 既存の cleanup（siblings close / worktree remove / branch delete）...
    // ... 既存のフィールドクリア（taskId/taskRunId/taskTitle/worktreePath/outputDir/agents など）...
    // sessionId は既存挙動通り触らない（SessionStart hook で追従）

    conductor.status = opts?.targetStatus ?? "idle";
    conductor.taskRunId = undefined;
    // ... 既存のリセット ...

    if (conductor.status === "idle") {
      conductor.disconnectedAt = undefined;
    }
    // broken の場合のみ disconnectedAt を UI 用に残す（R7 対応コメント）。
    // 将来 broken → idle に戻した後に再度 disconnected 扱いになっても、
    // clear-conductor 経路では上の if で undefined に落ちるため古い値は混入しない。

    notifyStateChanged(`conductor.ts:resetConductor:status-${conductor.status}`);
    await log(
      conductor.status === "broken" ? "conductor_broken" : "conductor_reset",
      `${formatSurface(conductor.surface, "C")}${opts?.reason ? ` reason=${opts.reason}` : ""}`,
    );
  }
  ```
  - `forceCloseDisconnectedConductor` は `{ targetStatus: "broken", reason: "disconnect_timeout" }` で呼び出す（ST-2）
  - `handleConductorClear` は `{ targetStatus: "idle", reason: "cleared" }` で呼び出す（ST-8A）
  - 既存の呼び出し箇所（`daemon.ts:1721` `daemon.ts:2250`（旧）`daemon.ts:2274` / 
    `cmdAbortTask` / `cmdRestartTask` 等）は引数を足さないためデフォルトで `"idle"` にフォール
    バック（後方互換）
  - **ログ集約（R3 対応）**: `log("conductor_broken", ...)` は本関数内の三項演算でのみ発行
    する。forceClose 等の呼び出し側で個別に `log("conductor_broken", ...)` を発行しないこと。
    reason は opts.reason 経由で渡し `${formatSurface(...)} reason=${opts.reason}` の形式で
    ログに含める。
- **完了条件**: 
  - 既存の resetConductor 呼び出し（opts 未指定）が全て idle で終わること
  - `forceCloseDisconnectedConductor` 経由の呼び出しが broken で終わること
  - `handleConductorClear` 経由の呼び出しが idle で終わること
  - `log("conductor_broken", ...)` が `conductor.ts:resetConductor` の 1 箇所のみから呼ばれること
- **検証コマンド**: 
  - `rg 'resetConductor\(' skills/cmux-team/manager`
  - `rg 'log\("conductor_broken"' skills/cmux-team/manager | rg -v conductor.test.ts | rg -v daemon.test.ts`（conductor.ts の 1 件のみ）

### ST-8A. daemon.ts: handleConductorClear を新設 **(R1 対応・新規)**

- **対象**: `skills/cmux-team/manager/daemon.ts` `handleMessage` の switch
- **内容**:
  ```ts
  case "CONDUCTOR_CLEAR": {
    const conductor = state.conductors.get(message.surface);
    if (!conductor) {
      await log(
        "conductor_clear_ignored",
        `surface=${message.surface} reason=not_found`
      );
      break;
    }
    if (conductor.status !== "broken") {
      await log(
        "conductor_clear_ignored",
        `${formatSurface(conductor.surface, "C")} status=${conductor.status} reason=not_broken`
      );
      break;
    }
    await resetConductor(conductor, state.projectRoot, state.workspace, {
      targetStatus: "idle",
      reason: "cleared",
    });
    // ログは resetConductor 内で "conductor_reset reason=cleared" として発行されるため、
    // ここで明示ログは不要（ただし操作記録として別キーを残すこともできる。
    // 現状 Decision D12 で resetConductor 集約一本に決定）
    break;
  }
  ```
- **理由（R1 対応）**: broken → idle 解除経路を handleConductorDone に相乗りさせると
  `daemon.ts:986-992` の `no_task` guard（`conductor.status !== "running" && !conductor.taskRunId`）
  で必ず break されるため、専用 handler が必要。
- **配置**: `CONDUCTOR_DONE` の直後、`CONDUCTOR_REGISTERED` の手前。
  ST-1.5 で discriminated union に追加した型と対応する。
- **完了条件**: broken Conductor が `CONDUCTOR_CLEAR` 受信後に `status === "idle"` になる
- **検証コマンド**: `rg 'case "CONDUCTOR_CLEAR"' skills/cmux-team/manager/daemon.ts`

### ST-8B. main.ts: cmdClearConductor を新設 **(R1 対応・書き換え)**

- **対象**: `skills/cmux-team/manager/main.ts`
- **内容**:
  ```ts
  async function cmdClearConductor(): Promise<void> {
    if (hasHelpFlag()) { showHelp(t("help_clear_conductor")); return; }
    const surface = requireArg("surface");
    const normalizedSurface = surface.startsWith("surface:") ? surface : `surface:${surface}`;

    const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
    if (!existsSync(teamJsonPath)) {
      console.error("Error: team.json not found"); process.exit(1);
    }
    const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
    const conductor = (teamJson.conductors ?? []).find((c: any) => c.surface === normalizedSurface);
    if (!conductor) {
      console.error(`Error: conductor ${normalizedSurface} not found in team.json`);
      process.exit(1);
    }
    if (conductor.status !== "broken") {
      console.error(
        `Error: conductor ${normalizedSurface} is not broken (current: ${conductor.status ?? "unknown"}). ` +
        `Use abort-task / restart-task for other states.`,
      );
      process.exit(1);
    }
    // R1 対応: CONDUCTOR_DONE 流用ではなく新 message 型 CONDUCTOR_CLEAR を送る。
    // daemon.ts:986-992 の no_task guard を回避し、専用 handler (ST-8A) に流す。
    await postMessage({
      type: "CONDUCTOR_CLEAR",
      surface: normalizedSurface,
      reason: "user_clear",
      timestamp: new Date().toISOString(),
    });
    console.log(`OK cleared ${normalizedSurface} (broken → idle)`);
  }
  ```
  - Rev1 にあった「handleConductorDone で `reason === "cleared"` を識別して `task_aborted` 
    重複処理を行わない分岐を入れる」は **不要**（そもそも handleConductorDone を通さない）
- **完了条件**: `cmux-team clear-conductor --surface 112` で broken Conductor が idle に戻り、
  次 tick で次のタスクを拾える
- **検証コマンド**: `rg 'clear-conductor' skills/cmux-team/manager/main.ts`

### ST-9. main.ts: dispatch に clear-conductor を追加

- **対象**: `skills/cmux-team/manager/main.ts` の switch
- **内容**:
  ```ts
  case "clear-conductor":
    await cmdClearConductor();
    break;
  ```
- **完了条件**: `cmux-team clear-conductor --help` がヘルプを表示する
- **検証コマンド**: `rg '"clear-conductor"' skills/cmux-team/manager/main.ts`

### ST-10. main.ts: cmdStatus で broken を表示

- **対象**: `main.ts:1017-1027` `cmdStatus` の Conductors 表示ブロック
- **内容**:
  ```ts
  for (const c of conductors) {
    const icon = c.status === "broken" ? "⨯" : "●";
    const statusLabel = c.status === "broken" ? " BROKEN" : "";
    const title = c.taskTitle ? `  ${c.taskTitle}` : "";
    const tid = c.taskId && c.taskId !== "undefined" ? `T${c.taskId}` : "---";
    console.log(`  ${icon} [${c.surface.replace("surface:", "")}]${statusLabel}  ${tid}${title}`);
  }
  ```
- **完了条件**: `cmux-team status` で broken Conductor が `⨯ BROKEN` と表示される
- **検証コマンド**: 手動 (E2E)

### ST-11. dashboard.tsx: broken 行を描画

- **対象**: `skills/cmux-team/manager/dashboard.tsx:459-564`
- **内容**:
  ```ts
  const isBroken = c.status === "broken";
  // ...
  } else if (isBroken) {
    const brokenElapsed = c.disconnectedAt ? formatElapsed(c.disconnectedAt) : "";
    children.push(
      ui.row({ gap: 1 }, [
        ui.text("⨯", { style: { fg: RED } }),
        ui.text(`[${surface}]`),
        ui.text(`broken ${brokenElapsed}`, { style: { fg: RED } }),
        ui.text("use clear-conductor", { dim: true }),
      ])
    );
  }
  ```
  - 配置: `isDisconnected` 分岐の直後（UI ロジック的に近い）
  - ヘッダーカウント `Conductors ${startingCount}` にも `${brokenCount} broken` を追加
    （`dashboard.tsx:1053-1056` + `1154`）
- **完了条件**: TUI に赤文字で broken が表示される
- **検証コマンド**: 手動 (E2E)

### ST-12. i18n.ts: help_clear_conductor を追加 **(R6 対応・追記)**

- **対象**: `skills/cmux-team/manager/i18n.ts`（ja / en 両 dictionary）
- **内容**: 
  - **`help_clear_conductor` key を i18n.ts の ja / en 両 dict に追加** し、書式は既存
    `help_abort_task` / `help_restart_task` と**完全に同形式**で書く（関数定義や object
    シェイプに合わせる。L120-165 近傍を参照）
  - 必要に応じて `type HelpKey = "help_abort_task" | "help_restart_task" | ... | "help_clear_conductor"`
    にも追加（現行コードで `t()` の key 型が union の場合）
  - 本文（ja）:
    ```
    cmux-team clear-conductor -- broken Conductor を明示的にリセットする

    Usage:
      cmux-team clear-conductor --surface <id>

    Options:
      --surface <id>   surface ID（例: 112 または surface:112）

    Notes:
      - broken 状態の Conductor のみクリアできます
      - 他の状態は abort-task / restart-task を使ってください
      - worktree / branch 残骸は broken 遷移時点で既に掃除済みのため、ここでは行いません
    ```
  - 本文（en）: 同等の英訳を既存 help_* と同じトーン（簡潔・命令形）で追加
- **完了条件**: `cmux-team clear-conductor --help` が日本語/英語で表示される
- **検証コマンド**: `rg 'help_clear_conductor' skills/cmux-team/manager/i18n.ts`（ja / en 両方でヒットする）

### ST-13. daemon.test.ts: broken の状態遷移テスト **(R4 対応・拡充)**

- **対象**: `skills/cmux-team/manager/daemon.test.ts`
- **内容**:
  1. 既存 test "3. disconnect timeout で forced close + journal + aborted" (L765-808) の修正:
     - `expect(conductor.status).toBe("idle")` → `expect(conductor.status).toBe("broken")`
     - `expect(conductor.disconnectedAt).toBeUndefined()` → **削除**（broken は disconnectedAt を保持）
     - `expect(conductor.taskRunId).toBeUndefined()` → 保持（cleanup は走る）
     - `expect(state.conductors.has(conductor.surface)).toBe(true)` を追加
  2. 新テスト `"broken Conductor は scanTasks の割当候補から除外される"`:
     - broken Conductor 1 つ + ready task 1 つ → `scanTasks` 実行 → task は `ready` のまま / broken は `broken` のまま / `throttled` ログが出る
  3. 新テスト `"broken Conductor は SESSION_* イベントで idle に戻らない"`（**R4 で拡充**）:
     - **SESSION_STARTED** の 4 バリアント: `source = "startup" | "resume" | "clear" | "compact"`
       各々で broken → broken のまま（`session_event_ignored_broken` ログ）
     - **SESSION_ACTIVE**: broken → broken のまま
     - **SESSION_IDLE**: broken → broken のまま
     - **SESSION_CLEAR**: broken → broken のまま
     - SESSION_STARTED の source バリアント網羅は、新しい source が schema に追加された際の
       回帰検知を目的とする（schema `z.enum(["startup", "resume", "clear", "compact"])` に
       enum が追加されたら本テストを増やす運用）
  4. 新テスト `"CONDUCTOR_CLEAR で broken Conductor が idle に戻る（正常経路）"` (**R1 対応**):
     - broken 状態で `handleMessage({ type: "CONDUCTOR_CLEAR", surface, reason: "user_clear", ... })` を呼ぶ
     - → `status === "idle"`, `disconnectedAt === undefined`, `taskRunId === undefined`, `agents === []`
     - `conductor_reset reason=cleared` ログが出る
  5. 新テスト `"CONDUCTOR_CLEAR が broken 以外の Conductor に来たら無視される"` (**R1 対応**):
     - idle / running / disconnected 状態で CONDUCTOR_CLEAR 受信 → status 不変 + `conductor_clear_ignored` ログ
  6. 新テスト `"CONDUCTOR_CLEAR が未登録 surface に来たら conductor_clear_ignored reason=not_found"`:
     - state.conductors に存在しない surface → 無視 + `not_found` ログ
- **メソッド制約**: 既存テストが使う `createDaemon` / `monitorConductors` / `handleMessage` と
  同じ API で書く。`cmux.closeSurface` / `execFile git worktree remove` 等は既存テスト同様の
  モック経路に任せる（テスト環境で git init 済み / worktreePath は existsSync false で skip）
- **完了条件**: `bun test skills/cmux-team/manager/daemon.test.ts` が全 pass
- **検証コマンド**: `bun test skills/cmux-team/manager/daemon.test.ts`

### ST-14. スナップショット回帰: team.json 往復 **(R5 対応・強化)**

- **対象**: `daemon.ts` の `updateTeamJson`（`daemon.ts:2296-2314`）と `restoreConductors`
  (`daemon.ts:824-849` 付近)
- **内容**:
  - broken status も `status: c.status` でそのまま書き出されるため updateTeamJson の変更は
    不要。restoreConductors の status 判定は ST-6 で broken を含むように修正済み
  - **(R5) unit test を daemon.test.ts に追加**: 「broken Conductor を `updateTeamJson` →
    `readFile(".team/team.json")` → `restoreConductors`（あるいは初期化時の state 復元ロジック）
    で戻した後も `status === "broken"` のまま、`disconnectedAt` / `sessionId` も保持される」
    ことを round-trip で検証する。手動 E2E のみに依存しない形に昇格する。
  - テスト疑似コード:
    ```ts
    // 1. state に broken Conductor をセット
    conductor.status = "broken";
    conductor.disconnectedAt = "2026-04-18T10:00:00.000Z";
    // 2. updateTeamJson を同期呼び出し（テスト用 helper が既存なら流用）
    await updateTeamJson(state, projectRoot);
    // 3. ファイルから読み戻す
    const json = JSON.parse(await readFile(join(projectRoot, ".team/team.json"), "utf-8"));
    // 4. restoreConductors 相当の初期化で state を再構築
    const restored = restoreConductors(json.conductors ?? []);
    // 5. 検証
    expect(restored.get("surface:112")?.status).toBe("broken");
    expect(restored.get("surface:112")?.disconnectedAt).toBe("2026-04-18T10:00:00.000Z");
    ```
    （`restoreConductors` の実 API 名は実装調査時に確定し、テスト内で `initializeLayout` か
    直接呼び出しか選ぶ。初期化テストヘルパーを流用するのが無難）
- **完了条件**: daemon 再起動（≒ team.json 復元）後も broken が broken のまま。
  unit test で pass する
- **検証コマンド**: `bun test skills/cmux-team/manager/daemon.test.ts -t "team.json round-trip"`

### ST-15. conductor.test.ts: resetConductor opts の動作確認

- **対象**: `skills/cmux-team/manager/conductor.test.ts`
- **内容**: 
  - 既存テストは opts 未指定（デフォルト）のため `status === "idle"` / `disconnectedAt === undefined` / `conductor_reset` ログになることを確認
  - 新テスト: `opts.targetStatus === "broken"` で呼んだ場合 `status === "broken"` / `disconnectedAt` が保持（事前値と同一） / `conductor_broken` ログが 1 回だけ出ることを確認
- **完了条件**: `bun test skills/cmux-team/manager/conductor.test.ts` が全 pass
- **検証コマンド**: `bun test skills/cmux-team/manager/conductor.test.ts`

## 5. リスク

### 5.1 broken が溜まって利用可能 Conductor がゼロになるケース

- **挙動**: `scanTasks` で `idleConductor === undefined` → `throttled task_id=X no_idle_conductor`
  ログ（既存の動作 `daemon.ts:1853`）。タスクは ready のまま待機する
- **対応**: 追加対応は不要。A015 の fail-stop 原則通り、Master/ユーザーがログを見て
  `clear-conductor` を叩く運用
- **可視化**: TUI の Conductor セクションに brokenCount を追加（ST-11）することで状況が一目で
  分かる

### 5.2 restart-task / abort-task と clear-conductor の責務分離

| CLI | 対象 | 動作 |
|-----|------|------|
| `abort-task --task-id` | assigned タスク | Conductor を kill + worktree 削除 → Conductor 再起動（idle 化） |
| `restart-task --task-id` | assigned / aborted タスク | abort と同様 + タスクを ready に戻して再割当 |
| `clear-conductor --surface` | broken Conductor | task-state は触らず（既に aborted）、Conductor を idle に戻す（CONDUCTOR_CLEAR 経由） |

- 境界: abort/restart は **タスク中心**、clear-conductor は **surface 中心**
- broken Conductor は taskId がクリア済み（forceClose → resetConductor で全フィールドを
  クリア）ため、abort-task / restart-task の `find(c => c.taskId === taskId)` では見つからない。
  `clear-conductor` のみが有効
- したがって 3 CLI の責務は重ならない

### 5.3 Conductor surface が手動で閉じられた場合

- `forceCloseDisconnectedConductor` → `resetConductor(opts={targetStatus:"broken"})` 内で
  `cmux.listSiblingSurfaces` を呼ぶが、surface が閉じられていれば空配列が返る。冪等動作のまま
- state.conductors には surface が残る → TUI に broken として表示
- `clear-conductor` 実行時に `resetConductor(opts={targetStatus:"idle"})` が再度
  `cmux.closeSurface` を試みるが失敗しても冪等に無視される（既存実装）
- 追加対応は **不要**

### 5.4 依存タスク cascade (T241) との相互作用 **(R7 対応・新規)**

- **懸念**: `forceCloseDisconnectedConductor` が親タスクを aborted に遷移させた際、T241 の
  cascade により `depends_on: 親タスク` を持つ子タスクが影響を受ける
- **実際の挙動**: T241 の cascade は **ready 子タスクを draft に戻す**。assigned 子は
  変更なし、closed/aborted/deleted 子は変更なし（CLAUDE.md「依存タスクの cascade (T241)」参照）
- **帰結**: cascade 後に生成される子タスクは全て **draft** 状態になるため、
  `scanTasks` の assignTask 対象にはならない。つまり **broken Conductor への誤 assign 経路は
  構造的に存在しない**（broken は idle ではないため拾われないが、そもそも ready 子が残らない）
- 追加対応は **不要**。Decision Log D12 で明示

### 5.5 テスト戦略

- **unit test（既存）**: `daemon.test.ts` / `conductor.test.ts` の既存テストは全て維持
  （ST-7 の `targetStatus` デフォルト `"idle"` により破壊なし）
- **unit test（新規）**: ST-13 で 6 テスト、ST-14 で 1 テスト、ST-15 で 1 テスト追加
- **型テスト**: `bunx tsc --noEmit` で broken 追加による網羅漏れを全て検出
- **E2E**: 手動 / wait（cmux 環境でのみ可能）
  - disconnect timeout を人為的に起こす: Conductor の PID を `kill -9`
  - `cmux-team status` で broken が見える（`⨯ BROKEN`）
  - dashboard に brokenCount が表示される
  - `cmux-team clear-conductor --surface <id>` で idle に戻る
  - 次のタスクが idle に割り当てられる
  - daemon を再起動しても broken が broken のまま（ST-14 で unit にカバー済みだが E2E でも）

## 6. 既存型エラーの先読み

`bunx tsc --noEmit` を実行 → 現状エラー 0 件（確認済み）。

broken 追加および `ConductorClearMessage` 追加後に発生が予想されるエラー:
- **`schema.ts`**: 新 message 型 `ConductorClearMessage` を `QueueMessage` discriminated union
  に追加するため、`QueueMessage` の型推論が更新される。`z.infer` で型が自動生成されるため
  個別の export は不要だが、`export type ConductorClearMessage = z.infer<typeof ConductorClearMessage>`
  を他の message 型（`ConductorDoneMessage` 等）と同形式で追加する
- **`daemon.ts` `handleMessage`**: switch の網羅性チェックを `exhaustive: never` パターンで
  行っている場合、`CONDUCTOR_CLEAR` case を追加しないと型エラーになる。ST-8A で
  追加済みであることを確認する
- **`daemon.ts`** SESSION_* ハンドラ: `conductor.status` に対する flow analysis がない
  （if/else if 連鎖）ため、broken 追加による型エラーは出ない可能性が高い。ST-3 のガード
  追加で明示的に broken を弾く
- **`dashboard.tsx`**: `isBroken` 分岐を追加しない場合、`else` に落ちて running 扱いで表示される
  だけ。型エラーなし（ST-11 で分岐追加）
- **`updateTeamJson` (`daemon.ts:2296`)**: `status: c.status` はそのままなので型エラーなし
- **zod parse 経路**: `ConductorState` は zod schema と手動 type の混成（L188 の
  `ConductorState = z.object` は status を含まない）。status は `& { status: ... }` で後付け
  されるため、broken 追加は zod parse に影響しない

**結論**: 本タスクで解消する（cleanup に分けない）。ST-1 / ST-1.5 追加後に tsc が指摘する
箇所は ST-3 / ST-4 / ST-6 / ST-8A / ST-11 で処理する。

## 7. Decision Log

| # | 決定 | 理由 |
|---|------|------|
| D1 | broken → idle 復帰は **明示操作のみ**（自動検出併用なし） | memory `feedback_error_recovery` + A015 決定 2 項と整合。自動検出は意図読み取りが曖昧で逸脱しやすい |
| D2 | `resetConductor` を 2 種類に分けず、第 4 引数に `targetStatus` オプションを追加（**案 A 一本**） | 既存呼び出し 3 箇所に破壊が入らず、cleanup ロジックの重複を避けられる。**Rev2 (R2)**: 旧案「forceClose で cleanup 直書き展開」は削除。ST-2 は resetConductor の opts 呼び出しのみに縮退 |
| D3 | `clear-conductor` は **新 message 型 `CONDUCTOR_CLEAR` を新設** | **Rev2 (R1)**: 旧案「CONDUCTOR_DONE 流用」は daemon.ts:986-992 の `no_task` guard（`conductor.status !== "running" && !conductor.taskRunId`）で必ず早期 break するため機能しない。broken Conductor は taskRunId がクリア済みで常に guard に引っかかる。専用 handler を持つことで意味も明確になる |
| D4 | broken の契機は **disconnect timeout のみ**（conductor kind AssignTaskError 等は従来通り disconnected） | A015 の本タスク範囲（次のアクション 1）に限定。assign_failed は別タスクで検討 |
| D5 | broken に到達した Conductor は **state.conductors から削除しない** | TUI 可視化のため。削除すると「壊れた Conductor がいたこと」が消える |
| D6 | broken 状態でも `disconnectedAt` を残す | UI の「経過時間」表示に使用。idle に戻すときだけ undefined に |
| D7 | PID watcher は broken 中に**再起動しない** | pid は forceClose で undefined 済み、再起動対象の Claude プロセスがない。「監視継続」は A015 的には「状態の可視化継続」と解釈 |
| D8 | scanTasks の idle 検索 `c.status === "idle"` は**変更しない** | 元々 idle のみ拾う実装なので broken は自動で除外される。不変条件としてテストで固定 |
| D9 | SESSION_* ハンドラには broken の早期 return を追加 | 自動復帰の可能性を完全に塞ぐ。観測用に `session_event_ignored_broken` ログを残す |
| D10 | `brokenAt` フィールドは**追加しない** | `disconnectedAt` で代替可能（broken は常に disconnected を経由する）。フィールド増加を避ける |
| D11 | 本タスクは A015 の**次のアクション 1 のみ**を実装 | 2〜5 は別タスクで個別対応。スコープを限定して変更を小さく保つ |
| D12 | `conductor_broken` ログは **`resetConductor` 内の 1 箇所に集約**（forceClose 側からは削除） | **Rev2 (R3)**: 重複ログを避ける。reason は opts.reason（"disconnect_timeout" / "cleared" 等）で呼び出し側から渡す。DRY |
| D13 | T241 cascade との相互作用: broken Conductor への誤 assign は **構造的に起こらない** | **Rev2 (R7)**: 親タスク aborted 時、ready 子は draft に戻る（CLAUDE.md 「依存タスクの cascade (T241)」）。scanTasks は draft を拾わないため、broken が idle 候補から外れていることと相まって、誤 assign 経路は存在しない |

## 8. 改訂履歴

| # | Finding / Recommendation | 反映箇所 |
|---|--------------------------|---------|
| R1 (Critical) | CONDUCTOR_DONE 流用 → CONDUCTOR_CLEAR 新設 | ST-1.5 新設 / ST-2 の handleConductorDone 分岐削除 / ST-8A 新設（daemon handler） / ST-8B（CLI 側 postMessage 型変更） / ST-13 テスト 4〜6 新設 / D3 理由追記 |
| R2 (Major) | ST-2 の 2 案併記削除 → 案 A 一本化 | ST-2 を「forceClose が resetConductor を opts 付きで呼ぶだけ」に縮退。cleanup 直書き案の記述を削除 / D2 に「Rev2」注記 |
| R3 (Major) | `conductor_broken` ログを resetConductor 1 箇所に集約 | ST-2 (3) に「log 直書き削除」明記 / ST-7 のコード例で三項演算 + opts.reason 記述 / D12 新設 / 検証コマンドで 1 箇所のみを grep |
| R4 (Major) | broken + SESSION_* 全バリアントの回帰テスト | ST-13 テスト 3 を SESSION_STARTED (source × 4) + SESSION_ACTIVE + SESSION_IDLE + SESSION_CLEAR に拡充 |
| R5 (Minor) | team.json round-trip unit test | ST-14 を手動 E2E 記述から unit test に昇格（疑似コード付き） |
| R6 (Minor) | i18n key 形式の明記 | ST-12 に「既存 `help_abort_task` / `help_restart_task` と同形式」「ja/en 両 dict」明記 |
| R7 (Minor) | disconnectedAt コメント / sessionId 記述 / cascade 言及 | ST-7 コード例に `// broken の場合のみ disconnectedAt を UI 用に残す` コメント / ST-2 の sessionId 記述を「既存挙動の確認のみ」に書き換え / リスク 5.4 + D13 新設 |

---

以上、Design Review (review-1.md) の 7 件 Recommendation (R1 Critical + R2-R3 Major + R4 Major + R5-R7 Minor) を全て反映した。特に R1 の CONDUCTOR_CLEAR 新設により、clear-conductor CLI が daemon.ts:986-992 の no_task guard を回避し、broken → idle の明示クリアが構造的に動作するようになった。
