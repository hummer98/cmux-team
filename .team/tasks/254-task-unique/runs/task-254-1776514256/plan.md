# T254 実装計画: Task の二重起動を防ぐ unique 制約を不変条件として検査

- **Task ID**: 254
- **Author**: planner-254
- **Date**: 2026-04-18
- **Scope**: `assignTask` の unique 検査（runtime）と cmdStart の起動時整合性チェックに限定。`resume_fallback_to_ready` の再設計・atomic 書き込み実装は**スコープ外**。

---

## 1. 課題分析

### 1.1 現状の問題点

同一 taskId が複数 Conductor で同時 running になり得る構造的リスクが残っている。
A015 (a) で整理された 4 シナリオのうち、本タスクが塞ぐのは以下:

| # | シナリオ | 発生経路 | 現状の防御 |
|---|---------|---------|-----------|
| S1 | 外部プロセスによる `task-state.json` 書換 | ユーザー手動編集 / 将来的な外部 CLI | **なし** |
| S2 | daemon 再起動時の team.json ⇔ task-state.json 食い違い | daemon crash → 古い team.json + 新しい task-state.json で起動 | `conductor_taskid_reconciled` (applyRestorePlan 内) が taskId をクリアするが、unique violation 自体は検出しない |
| S3 | 並行 daemon 起動 | 複数ワークスペースで同じ PROJECT_ROOT を触る異常運用 | **なし** |
| S4 | 将来の並列化リファクタでの race 再発 | scanTasks を並列化した場合、`assignedIds.add` 以前の窓で衝突 | 現状は逐次実行で race 窓が狭い（保険が欲しい） |

### 1.2 根本原因の特定

- `assignTask` (`conductor.ts:258`) は対象 taskId に対する「他 Conductor 先取り assign」の検査を持たない
- `scanTasks` (`daemon.ts:1992`) は `state.conductors` のメモリ状態から `assignedIds` を構築するため、外部プロセス書換や daemon 再起動直後の食い違いを見ない
- `cmdStart` の `rawResumePlan` 構築 (`main.ts:575-648`) は「assigned エントリを resume できるか」だけを判定しており、「同じ taskId が 2 つ以上の Conductor に紐づいていないか」という不変条件は検査しない

### 1.3 影響範囲

| 層 | 影響 |
|----|------|
| `task-state.json` | assigned エントリの unique violation が残ると worktree の二重書込・コミット衝突 |
| `team.json` | daemon が自動更新する派生物。整合性は task-state.json 側を正とする |
| Conductor ライフサイクル | violation 検出時は broken 化（A015 fail-stop 方針） |
| Task ライフサイクル | violation 検出時は ready に戻し journal 付与（人間介入待ち） |

---

## 2. 技術アプローチ

### 2.1 採用アプローチ

**2 段の検査を不変条件として配置する**:

1. **runtime 検査** — `assignTask` 先頭で `task-state.json` を再読込し、対象 taskId が既に別 Conductor に `assigned` でないかを検査。違反は `AssignTaskError("task", ...)` として scanTasks の既存エラーハンドラに流す
2. **起動時検査** — `cmdStart` で `rawResumePlan` 構築前に `task-state.json` × `team.json.conductors` を cross-check。違反 taskId は ready + journal に戻し、違反 Conductor は `initializeLayout` 後に `resetConductor(targetStatus: "broken", reason: "unique_violation")` で broken 化

### 2.2 既存パターンとの整合

| 既存パターン | 再利用方法 |
|-------------|-----------|
| `AssignTaskError("task", reason)` (`conductor.ts:36-48`) | runtime 検査の違反通知。既存 `scanTasks` (daemon.ts:2104-2143) で自動的に task abort + Conductor idle 維持される経路に乗る |
| `loadTaskState` / `saveTaskState` (`task.ts:112-131`) | atomic 読み書きが既実装。本タスクで再実装しない |
| `broken` ステータス (T250) | 違反 Conductor の fail-stop 先。`restoreConductorState` が broken を保持する仕組みが既実装 |
| `resetConductor(targetStatus: "broken", reason: ...)` (`conductor.ts:502-588`) | cleanup + ログ(`conductor_broken`) を集約発行する（D12 集約ポリシー） |
| `conductor_taskid_reconciled` (`applyRestorePlan` 内 `daemon.ts:864-879`) | taskState が assigned でない Conductor は taskId クリア + idle 化される。本タスクの broken 化は**この後段で上書き適用**する必要がある |

### 2.3 代替案と却下理由

| 代替案 | 却下理由 |
|--------|---------|
| `task-state.json` 書き込みに OS レベルの advisory lock を追加 | saveTaskState は既に atomic（tmp + rename）。race は task レベルの論理整合で解決すべき |
| `team.json` を直接書き換えて broken 状態を仕込む | team.json は daemon が `updateTeamJson` で自動更新する派生物（CLAUDE.md の規約）。手動書き込み禁止 |
| violation 検出時に片方の Conductor のみ broken 化 | 「どちらが正しい」を自動判断できない。A015 fail-stop に従い保守的に両方停止 |
| `planLayoutRestore` に broken 分類を追加 | T255 で導入されたばかりのマトリクスを早期に拡張するのは変更範囲過大。後追い broken 化で十分 |

---

## 3. 変更対象

### 3.1 変更ファイル一覧

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/task.ts` | unique 検査ヘルパー 2 関数を追加 (`findAssignmentConflict`, `detectStartupUniqueViolations`) |
| `skills/cmux-team/manager/conductor.ts` | `assignTask` 先頭（`conductor.ts:268` の `try {` 直後、タスクファイル検索より前）に unique 検査を追加 |
| `skills/cmux-team/manager/main.ts` | `cmdStart` 内 `rawResumePlan` 構築前（`main.ts:575` 近辺）に起動時整合性チェックを追加。`initializeLayout` 呼び出し後（`main.ts:653` の直後）に violation surface を broken 化する処理を追加 |

### 3.2 新規作成ファイル

なし。

### 3.3 削除ファイル

なし。

---

## 4. サブタスク分割

実装順序を考慮した番号付き作業リスト。前のサブタスクが完了した前提で次を実装する。

### S1. `task.ts` に unique 検査ヘルパー 2 関数を追加

- **対象ファイル**: `skills/cmux-team/manager/task.ts`
- **変更内容**:
  - `findAssignmentConflict(taskState: TaskStateMap, taskId: string, conductorSurface: string): { conflict: boolean; existingSurface?: string }` を追加
    - `taskState[taskId]?.status === "assigned"` かつ `taskState[taskId].conductorSlot` が `conductorSurface` と異なる場合に `{ conflict: true, existingSurface }` を返す
    - `conductorSlot` が未設定の場合は conflict=false（legacy / 初期状態）
  - `detectStartupUniqueViolations(taskState: TaskStateMap, conductorsFromTeamJson: Array<{ surface: string; taskId?: string }>): UniqueViolation[]` を追加
    - `UniqueViolation` 型を新設: `{ taskId: string; surfaces: string[] }`
    - 検査ロジック:
      1. team.json.conductors を走査し、同一 `taskId` を持つ Conductor surface をグルーピング
      2. グループサイズが 2 以上なら violation として記録
      3. task-state.json の assigned エントリで `conductorSlot` が team.json に存在する Conductor の surface と一致しない場合も violation（cross-check）
- **完了条件**:
  - 2 関数が export されている
  - 既存の TaskState / TaskStateMap 型を破壊的変更しない
  - `bunx tsc --noEmit` が通る
- **メソッド制約**: 既存 `TaskState.conductorSlot` (`task.ts:44`) フィールドを参照する
- **検証コマンド**:
  ```bash
  grep -n "findAssignmentConflict\|detectStartupUniqueViolations\|UniqueViolation" skills/cmux-team/manager/task.ts
  ```

### S2. `assignTask` 先頭に runtime unique 検査を追加

- **対象ファイル**: `skills/cmux-team/manager/conductor.ts`
- **変更内容**:
  - `assignTask` 関数（`conductor.ts:258`）の `try {` ブロック先頭（`conductor.ts:269` の「`// --- 1. タスクファイル検索 ---`」コメント直前）に以下を挿入:
    ```typescript
    // --- 0. Unique 検査（T254: 同一 taskId の二重 assign 防止） ---
    const currentTaskState = await loadTaskState(projectRoot);
    const conflict = findAssignmentConflict(currentTaskState, taskId, conductor.surface);
    if (conflict.conflict) {
      await log(
        "task_unique_violation_runtime",
        `task_id=${taskId} existing_surface=${conflict.existingSurface} conflict_surface=${conductor.surface}`,
      );
      throw new AssignTaskError(
        "task",
        `task_already_assigned_to=${conflict.existingSurface}`,
      );
    }
    ```
  - import 追加: `findAssignmentConflict` を `./task` から import（既存 `loadTaskState` import 行に合流）
- **完了条件**:
  - violation 発生時、scanTasks (`daemon.ts:2104`) の `e.kind === "task"` 分岐を通り、task が `aborted` に遷移し `journal: "assign_failed: task_already_assigned_to=<surface>"` が記録される
  - Conductor は idle のまま維持（既存エラーハンドラの挙動）
  - `bunx tsc --noEmit` が通る
- **メソッド制約**:
  - `AssignTaskError("task", reason)` を使う（kind="conductor" にしない。Conductor 自体は壊れていない）
  - worktree 作成（`git worktree add`）より前に検査を配置（失敗時の cleanup コストを避ける）
- **検証コマンド**:
  ```bash
  grep -n "task_unique_violation_runtime\|findAssignmentConflict" skills/cmux-team/manager/conductor.ts
  ```

### S3. `cmdStart` に起動時整合性チェックを追加

- **対象ファイル**: `skills/cmux-team/manager/main.ts`
- **変更内容**:
  - `main.ts:579` の `const taskState = await loadTaskState(PROJECT_ROOT);` の直後、`rawResumePlan` 構築ループの前に以下を挿入:
    ```typescript
    // --- T254: 起動時 unique 整合性チェック ---
    //   team.json.conductors × task-state.json の cross-check
    //   違反 taskId は ready に戻し journal 付与、違反 surface は後で broken 化する
    const violationSurfaces = new Set<string>();
    try {
      const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
      let conductorsFromTeamJson: Array<{ surface: string; taskId?: string }> = [];
      if (existsSync(teamJsonPath)) {
        const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
        conductorsFromTeamJson = (teamJson.conductors ?? []).map((c: any) => ({
          surface: c.surface,
          taskId: c.taskId,
        }));
      }
      const violations = detectStartupUniqueViolations(taskState, conductorsFromTeamJson);
      for (const v of violations) {
        for (const s of v.surfaces) {
          violationSurfaces.add(s);
        }
        // 違反 taskId を ready に戻し journal 付与
        const prev = taskState[v.taskId];
        if (prev) {
          const journal = prev.journal
            ? `${prev.journal}; unique_violation: surfaces=[${v.surfaces.join(",")}]`
            : `unique_violation: surfaces=[${v.surfaces.join(",")}]`;
          taskState[v.taskId] = { ...prev, status: "ready", journal };
          taskStateModified = true;
        }
        await log(
          "task_unique_violation_startup",
          `task_id=${v.taskId} surfaces=[${v.surfaces.join(",")}]`,
        );
      }
    } catch (e: any) {
      await log("error", `startup unique violation check failed: ${e.message}`);
    }
    ```
  - import 追加: `detectStartupUniqueViolations` を `./task` から import（既存 import 行に合流）
- **完了条件**:
  - `existsSync(teamJsonPath)` が false の初回起動時は早期 return（`conductorsFromTeamJson` は空 → violations 空）
  - 違反が 0 件なら既存挙動を維持
  - 違反検出時、`taskStateModified=true` となり既存の save パスで永続化される
- **メソッド制約**:
  - `taskStateModified` は既存ローカル変数（`main.ts:580`）を再利用する。新規フラグを立てない
  - `existsSync` は既に import 済み（`main.ts` 上部）、`readFile` / `join` も同様
  - try/catch でチェック自体の失敗は error log + 続行（起動全体を止めない。A015 の「パラメータ解決失敗は fail-stop」には該当しない — これは整合性チェック失敗であり、本体処理は続行して監視者が気付ける状態を優先する）
- **検証コマンド**:
  ```bash
  grep -n "task_unique_violation_startup\|detectStartupUniqueViolations\|violationSurfaces" skills/cmux-team/manager/main.ts
  ```

### S4. `initializeLayout` 後に violation surface を broken 化

- **対象ファイル**: `skills/cmux-team/manager/main.ts`
- **変更内容**:
  - `main.ts:653` の `const resumeAssignments = await initializeLayout(state, daemonSurface, rawResumePlan);` の直後（`for (const r of resumeAssignments) { ... }` ループより**前**）に以下を挿入:
    ```typescript
    // --- T254: 起動時 unique violation の後追い broken 化 ---
    //   applyRestorePlan の `conductor_taskid_reconciled` は taskState が assigned でない
    //   surface を idle に倒すため、この後段で明示的に broken へ上書きする。
    if (violationSurfaces.size > 0) {
      for (const surface of violationSurfaces) {
        const c = state.conductors.get(surface);
        if (!c) continue;  // A経路で除外された / D経路で新規作成されなかった
        await resetConductor(c, state.projectRoot, state.workspace ?? undefined, {
          targetStatus: "broken",
          reason: "unique_violation",
        });
      }
    }
    ```
  - import 追加: `resetConductor` を `./conductor` から import（既存 conductor.ts 系 import に合流）
- **完了条件**:
  - `violationSurfaces` に含まれる全 surface が `state.conductors` 内で `status: "broken"` に遷移
  - `conductor_broken` ログが violation surface 1 つにつき 1 行発行される（resetConductor 内で集約発行、D12 ポリシー）
  - resumeAssignments ループ（`main.ts:657-671`）で同じ surface が `c.status = "running"` に上書きされないこと（= 違反 Conductor は resumePlan から排除されている必要あり）
- **メソッド制約**:
  - `resetConductor` は surface 実在確認を含む（T251）。broken 化は冪等
  - `state.workspace` は起動時に set 済み（`main.ts:560`）
- **検証コマンド**:
  ```bash
  grep -n "violationSurfaces\|resetConductor.*broken.*unique_violation" skills/cmux-team/manager/main.ts
  ```

### S5. violation 検出時に resumePlan から除外する

- **対象ファイル**: `skills/cmux-team/manager/main.ts`
- **変更内容**:
  - `main.ts:589-613` の `rawResumePlan` 構築ループで、`violationSurfaces` ではなく **`taskState[taskId].status === "ready"`（violation により ready に戻されている）** なら既存の `if (ts.status !== "assigned") continue;` で自動的にスキップされることを確認する
  - **コード変更不要の可能性が高い** — S3 で `taskState[v.taskId].status = "ready"` を既にセットしているため、その直後の `for (const [taskId, ts] of Object.entries(taskState))` は更新後の state を見る（同じ taskState 参照を使っているため）
  - **注意**: JavaScript のオブジェクト参照セマンティクス上、`taskState[v.taskId] = { ...prev, status: "ready" }` は新規オブジェクトを代入しているため、`taskState[v.taskId]` は確実に `status: "ready"` になる。`Object.entries` はその時点のスナップショットを返す
- **完了条件**:
  - violation 検出後の rawResumePlan に violation taskId が含まれない
  - 手動検証: S3 のコードパスを通した後、rawResumePlan.length が期待通り減少
- **検証**: コード追加なし。S3 で既に担保されている前提を plan に明記することで、後続サブタスクでの混乱を防ぐ

### S6. 手動 E2E テスト

- **対象**: 実装完了後、以下の 3 シナリオで動作確認
- **完了条件**: 全シナリオで期待ログが出ること（後述 §5.3 参照）

### 制約事項（再掲）

- **並列実装禁止**: 既存 `assignTask` / `cmdStart` の挙動を残したまま新パスを並走させない。検査は既存フローに統合する
- **削除タスク必須**: 本タスクでは既存コードの削除はなし（検査を追加するのみ）

---

## 5. リスク

### 5.1 既存機能への影響

| リスク | 発現条件 | 緩和策 |
|--------|---------|-------|
| `conductor_taskid_reconciled` と衝突 | applyRestorePlan が violation surface を idle に倒す | S4 で後追い broken 化することで上書き（実行順序が決定的に後） |
| 初回起動で誤検出 | `team.json` が空 or 未存在 | S3 の `existsSync(teamJsonPath)` + `??  []` で空配列扱い |
| assignTask 内の `loadTaskState` 追加読み込みによる性能劣化 | 高頻度 assign 発生時 | `loadTaskState` は既に同期読み込み + 小サイズ JSON。実測影響ほぼなし（参考: conductor.ts 既存コードで `loadTaskState` を複数箇所で呼ぶ） |
| 既存 `resume_fallback_to_ready` 経路と重複発火 | taskState が「assigned だが worktree 消失」かつ「unique violation」の両方 | unique violation を先に検出し ready に戻すので、その後の `resume_fallback_to_ready` 判定では既に `status !== "assigned"` となり fallback もスキップ（重複ログなし） |

### 5.2 エッジケース

| ケース | 扱い |
|--------|------|
| task-state.json で assigned なエントリの `conductorSlot` が `undefined`（legacy データ） | `findAssignmentConflict` / `detectStartupUniqueViolations` では conductorSlot 不明なら conflict=false（false positive を避ける） |
| team.json.conductors 全員の taskId が `undefined`（全 idle） | violation 検出なし（期待通り） |
| 同一 taskId を 3 つ以上の Conductor が持つ | 全員を violationSurfaces に追加し全員 broken 化 |
| violation surface が applyRestorePlan の C 経路（cleanup-stale）で既に close されている | `state.conductors.get(surface)` が undefined で `continue` するので安全 |
| `cmux-team start` の preflight / 認証チェックで先に exit | unique 検査まで到達しないので影響なし |

### 5.3 テスト戦略

自動テストなし（プロジェクト方針）。以下の手動 E2E を実施。

**テスト T1: assignTask ランタイム unique 検査**

1. daemon 起動済み、idle Conductor Z1 / Z2 がある状態
2. 手動で `.team/task-state.json` を編集し、taskId X を `{ status: "assigned", conductorSlot: "surface:Z1" }` に書き換える
3. 別の ready タスク Y を作成（`cmux-team create-task --title "trigger"`）し、scanTasks を発火させる
4. 意図的に X を再度 ready に戻す（`cmux-team update-task --task-id X --status ready`）
5. scanTasks が X を Z2 に assign しようとする
6. **期待ログ**: `task_unique_violation_runtime task_id=X existing_surface=surface:Z1 conflict_surface=surface:Z2`
7. **期待状態**: X は `aborted` + journal に `assign_failed: task_already_assigned_to=surface:Z1`、Z2 は idle のまま

**テスト T2: 起動時 unique 検査（同一 taskId が複数 Conductor）**

1. daemon 停止（`cmux-team stop`）
2. `.team/team.json` を手動編集し、2 つの Conductor に同じ taskId=X を持たせる
3. `.team/task-state.json` で X の status=`assigned`、conductorSlot は 1 つ目の surface
4. `cmux-team start` で daemon 起動
5. **期待ログ**:
   - `task_unique_violation_startup task_id=X surfaces=[surface:S1,surface:S2]`
   - `conductor_broken surface:S1 reason=unique_violation`
   - `conductor_broken surface:S2 reason=unique_violation`
6. **期待状態**: X は ready + journal に `unique_violation: surfaces=[surface:S1,surface:S2]`、S1/S2 は `broken` ステータス

**テスト T3: false positive が無いこと**

1. 通常運用: task X を assign、Conductor S1 が running の状態で daemon 停止
2. `cmux-team start` で再起動
3. **期待**: unique violation ログなし、X は resume 経路で S1 に再アサインされる

**テスト T4: conductorSlot 未設定（legacy データ）**

1. task-state.json で X が `{ status: "assigned" }`（conductorSlot なし）
2. `cmux-team start`
3. **期待**: violation 検出されず、既存の `resume_fallback_to_ready` 経路で ready に戻る（`canResume` が false のため）

---

## 6. 既存型エラーの先読み

### 6.1 本タスクで解消するもの

対象ファイル（`conductor.ts`, `main.ts`, `daemon.ts`, `task.ts`）の着手前の `bunx tsc --noEmit` 結果:

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-254-1776514256/skills/cmux-team/manager
bunx tsc --noEmit 2>&1 | grep -E "^(conductor\.ts|main\.ts|daemon\.ts|task\.ts)" || true
```

**結果**: 0 件（既存型エラーなし）。

### 6.2 後続 cleanup（別タスクで扱う）

該当なし。本タスクで導入する新規関数はすべて既存型（`TaskStateMap`, `ConductorState`）の範囲内で完結する。

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | 違反検出時、違反 Conductor のうち一方のみ broken 化するか、全員 broken 化するか | **全員 broken 化** | 「どれが正しい assign か」を自動判断できない。A015 fail-stop 原則に従い保守的に全員停止してユーザー介入を待つ |
| D2 | 違反 task の扱い: ready に戻すか、aborted にするか | **ready に戻す + journal に `unique_violation:` を追記** | task.md 要件に「journal 付きで ready に戻す（人間の介入待ち）」と明示。aborted にすると再実行のために手動で ready に戻す操作が必要になり UX が悪化 |
| D3 | unique 検査の「真のソース」は何にするか | **task-state.json を正、team.json.conductors は cross-check に使う** | task-state.json は saveTaskState で atomic 書き込み（既実装）。team.json は daemon の `updateTeamJson` による派生物なので観測値として扱う |
| D4 | assignTask runtime 検査の `AssignTaskError.kind` | **`"task"`（Conductor は idle 維持）** | unique violation は task 側の整合性問題であり、Conductor 自体は正常。kind=conductor にすると無関係に Conductor を disconnected に倒してしまう |
| D5 | `resume_fallback_to_ready` (`main.ts:601`) との関係 | **変更しない（スコープ外）** | task.md で明示的にスコープ外と指定されている。unique violation 検出後は taskState 側で status=ready になるので、後続の `resume_fallback_to_ready` 判定は自動的にスキップされる |
| D6 | 起動時違反 Conductor を broken に倒すタイミング | **`initializeLayout` 完了後の後追い適用** | applyRestorePlan の `conductor_taskid_reconciled` が taskState=ready を見て idle に倒すため、その後段で明示的に上書きする。planLayoutRestore のマトリクス拡張は変更範囲過大 |
| D7 | ログイベント名 | **`task_unique_violation_runtime` / `task_unique_violation_startup`** | 発生経路を 2 種に明示的に分離。task.md の例示「`task_unique_violation`」から接尾辞を付与して起動時 / ランタイムを区別する |
| D8 | task-state.json に `conductorSlot: undefined` のエントリがある場合の扱い | **conflict=false（検査対象外）** | legacy データや初期状態では conductorSlot が未設定。false positive を避けるため conductorSlot が set されているエントリのみを検査対象とする |
| D9 | 起動時整合性チェック自身の失敗（JSON parse 失敗等）の扱い | **error log を出して本体処理は続行（チェックだけスキップ）** | A015 の「パラメータ解決失敗は fail-stop」には該当しない — 整合性チェックは不変条件の二重防御であり、失敗時は単に防御が効かないだけ。本体起動を止めると chain reaction で事態が悪化する |
| D10 | runtime 検査を worktree 作成より前に配置するか、後に配置するか | **前に配置（try ブロック先頭）** | 違反検出後の cleanup（worktree remove / branch delete）のコストを回避。既存の `taskContent === null` パスと同じ位置に配置 |

---

## 8. 実装順序（チェックリスト）

- [ ] S1: `task.ts` に `findAssignmentConflict` / `detectStartupUniqueViolations` / `UniqueViolation` 型を追加
- [ ] S2: `conductor.ts:assignTask` 先頭に runtime unique 検査を追加
- [ ] S3: `main.ts:cmdStart` に起動時整合性チェックを追加（`rawResumePlan` 構築前）
- [ ] S4: `main.ts:cmdStart` の `initializeLayout` 後に違反 surface を broken 化
- [ ] S5: コード追加なし（S3 の taskState 更新で rawResumePlan から自動除外されることを確認）
- [ ] S6: 手動 E2E テスト T1〜T4 を実施、ログ内容を確認
- [ ] `bunx tsc --noEmit` がパスすること
- [ ] `rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts` が 0 件のまま
- [ ] 変更ファイル 3 個（task.ts, conductor.ts, main.ts）で閉じていること
