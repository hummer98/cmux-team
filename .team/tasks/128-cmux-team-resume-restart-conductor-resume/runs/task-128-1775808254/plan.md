# 実装計画: cmux-team restart 時の Conductor セッション resume

## 概要

`cmux-team start`（restart）時に、task-state.json に記録された sessionId と worktreePath を使い、assigned 状態のタスクを `claude --resume` で再開する機能を追加する。これにより restart 時にタスクが宙に浮くのを防ぐ。

## 変更ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/task.ts` | TaskState に `worktreePath`, `taskRunId`, `conductorSlot`, `sessionId` を追加 |
| `skills/cmux-team/manager/conductor.ts` | `assignTask` で新フィールドを task-state.json に保存 |
| `skills/cmux-team/manager/daemon.ts` | SESSION_STARTED で sessionId を task-state.json に書き込み、`updateTeamJson` に sessionId 追加、boot 後に resume 統合ロジック追加 |
| `skills/cmux-team/manager/main.ts` | `cmux-team resume <task-id>` サブコマンド新設、`cmdStart` に boot 後 resume 統合ロジック追加 |
| `skills/cmux-team/manager/schema.ts` | 変更なし（ConductorState は既に sessionId, worktreePath, taskRunId を持っている） |

## 詳細設計

### 1. TaskState インターフェース拡張

- **ファイル**: `skills/cmux-team/manager/task.ts`
- **変更箇所**: `TaskState` インターフェース（22-30行目）
- **変更内容**: 以下のオプショナルフィールドを追加
  ```typescript
  export interface TaskState {
    status: string;
    assignedAt?: string;
    closedAt?: string;
    abortedAt?: string;
    deletedAt?: string;
    journal?: string;
    // resume 用情報（assignTask 時に記録）
    worktreePath?: string;    // git worktree の絶対パス
    taskRunId?: string;       // task-NNN-TIMESTAMP 形式の実行 ID
    conductorSlot?: string;   // Conductor の surface ID（例: "surface:5"）
    sessionId?: string;       // Claude セッション ID（SESSION_STARTED 後に記録）
  }
  ```
- **理由**: restart 時に resume に必要な情報を task-state.json に永続化するため。ConductorState はインメモリのみで daemon 再起動時に消えるが、task-state.json はファイルベースで永続する。

### 2. assignTask での resume 情報保存

- **ファイル**: `skills/cmux-team/manager/daemon.ts`
- **変更箇所**: `scanTasks` 関数内の task-state.json 書き込み部分（783-790行目）
- **変更内容**: `assigned` ステータス記録時に `worktreePath`, `taskRunId`, `conductorSlot` も保存
  ```typescript
  // task-state.json に assigned + assignedAt + resume 情報を記録
  const ts = await loadTaskState(state.projectRoot);
  ts[task.id] = {
    ...ts[task.id],
    status: 'assigned',
    assignedAt: new Date().toISOString(),
    worktreePath: updated.worktreePath,
    taskRunId: updated.taskRunId,
    conductorSlot: updated.surface,
  };
  await saveTaskState(state.projectRoot, ts);
  ```
- **理由**: `assignTask` の戻り値（ConductorState）に worktreePath, taskRunId, surface が含まれている。この時点で sessionId はまだ不明（Claude 起動前）なので、ここでは保存しない。

### 3. SESSION_STARTED ハンドラで sessionId を task-state.json に保存

- **ファイル**: `skills/cmux-team/manager/daemon.ts`
- **変更箇所**: `handleMessage` の `SESSION_STARTED` ケース（506-538行目）
- **変更内容**: conductor の sessionId 設定後、conductor.taskId が存在すれば task-state.json にも sessionId を書き込む
  ```typescript
  case "SESSION_STARTED": {
    // ... 既存の Master チェック・Conductor 処理 ...
    if (conductor) {
      // ... 既存のステータス遷移・pid 設定 ...
      conductor.pid = message.pid;
      if (message.sessionId) conductor.sessionId = message.sessionId;
      conductor.disconnectedAt = undefined;
      spawnPidWatcher(state, conductor, message.pid);
      
      // sessionId を task-state.json に記録（resume 用）
      if (message.sessionId && conductor.taskId) {
        const ts = await loadTaskState(state.projectRoot);
        if (ts[conductor.taskId] && ts[conductor.taskId].status === "assigned") {
          ts[conductor.taskId] = {
            ...ts[conductor.taskId],
            sessionId: message.sessionId,
          };
          await saveTaskState(state.projectRoot, ts);
          await log("session_id_saved", `task_id=${conductor.taskId} session_id=${message.sessionId}`);
        }
      }
      // ... 既存のログ ...
    }
    break;
  }
  ```
- **理由**: sessionId は Claude 起動後の SessionStart hook で初めて確定する。この時点で task-state.json に書き込むことで、restart 後に resume が可能になる。

### 4. `cmux-team resume <task-id>` サブコマンド新設

- **ファイル**: `skills/cmux-team/manager/main.ts`
- **変更箇所**: 新関数 `cmdResume` を `cmdConductor`（686行目付近）の近くに追加。ルーティング（1707行目以降）に `case "resume"` を追加。
- **変更内容**:
  ```typescript
  /**
   * cmux-team resume <task-id>
   * assigned タスクの Conductor セッションを claude --resume で再開する。
   */
  async function cmdResume(): Promise<void> {
    if (hasHelpFlag()) showHelp("Usage: cmux-team resume <task-id>");
    const taskId = args[1];
    if (!taskId) {
      console.error("Usage: cmux-team resume <task-id>");
      process.exit(1);
    }

    // task-state.json から resume 情報を取得
    const taskState = await loadTaskState(PROJECT_ROOT);
    const ts = taskState[taskId];
    if (!ts) {
      console.error(`Task ${taskId} not found in task-state.json`);
      process.exit(1);
    }
    if (ts.status !== "assigned") {
      console.error(`Task ${taskId} is not assigned (status: ${ts.status})`);
      process.exit(1);
    }
    if (!ts.sessionId) {
      console.error(`Task ${taskId} has no sessionId — cannot resume`);
      process.exit(1);
    }
    if (!ts.worktreePath || !existsSync(ts.worktreePath)) {
      console.error(`Task ${taskId} worktree not found: ${ts.worktreePath}`);
      process.exit(1);
    }

    // 環境変数を設定（cmdConductor と同等）
    process.env.PROJECT_ROOT = PROJECT_ROOT;
    process.env.CONDUCTOR_ID = process.env.CMUX_SURFACE ?? "";
    process.env.CMUX_NO_RENAME_TAB = "1";
    process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1";
    const proxyPort = await resolveProxyPort();
    if (proxyPort) {
      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
    }

    // モデル解決
    const config = await loadConfig();
    const model = getModelForRole(config, "conductor", getArg("model"));

    // conductor-settings.json 生成（cmdConductor と同一の hook 構成）
    const slotId = process.env.CMUX_SURFACE ?? "unknown";
    const conductorSettingsPath = join(PROJECT_ROOT, `.team/prompts/${slotId}-settings.json`);
    // ... cmdConductor と同一の conductorSettings を生成 ...
    // （共通化は別途リファクタリング課題とし、ここでは同一コードを使用）

    // claude --resume で再開
    const { execFileSync } = require("child_process");
    try {
      execFileSync("claude", [
        "--resume", ts.sessionId,
        "--dangerously-skip-permissions",
        "--settings", conductorSettingsPath,
        "--model", model,
      ], {
        stdio: "inherit",
        env: process.env,
        cwd: ts.worktreePath,  // worktree ディレクトリで実行
      });
    } catch (e: any) {
      process.exit(e.status ?? 1);
    }
  }
  ```
- **理由**: `cmdConductor` は新規セッションを起動する。resume コマンドは既存セッションを `--resume` フラグで再開する。cwd を worktreePath にすることで、以前の作業コンテキストが維持される。

### 5. `cmdStart` に boot 後 resume 統合ロジック追加

- **ファイル**: `skills/cmux-team/manager/main.ts`
- **変更箇所**: `cmdStart` 関数の boot 完了後（408-411行目付近、`state.bootPhase = "ready"` の後）
- **変更内容**: boot 完了後に task-state.json で `status=assigned` のタスクを検索し、resume 可能なら idle Conductor に送信
  ```typescript
  // 起動完了
  state.bootPhase = "ready";
  await updateTeamJson(state);
  await log("boot_completed");

  // --- assigned タスクの resume ---
  const taskState = await loadTaskState(PROJECT_ROOT);
  for (const [taskId, ts] of Object.entries(taskState)) {
    if (ts.status !== "assigned") continue;

    const canResume = ts.sessionId
      && ts.worktreePath && existsSync(ts.worktreePath)
      && ts.taskRunId;

    if (!canResume) {
      // resume 不可 → ready に戻す（次の scanTasks で再割り当て）
      taskState[taskId] = { ...ts, status: "ready" };
      await log("resume_fallback_to_ready", `task_id=${taskId} reason=${!ts.sessionId ? "no_session_id" : "no_worktree"}`);
      continue;
    }

    // idle Conductor を探す
    const idleConductor = [...state.conductors.values()].find(c => c.status === "idle");
    if (!idleConductor) {
      await log("resume_no_idle_conductor", `task_id=${taskId}`);
      continue;
    }

    // ConductorState を復元
    idleConductor.taskRunId = ts.taskRunId;
    idleConductor.taskId = taskId;
    idleConductor.worktreePath = ts.worktreePath;
    idleConductor.status = "running";
    idleConductor.startedAt = new Date().toISOString();
    idleConductor.agents = [];

    // タスクタイトルを取得（task ファイルから）
    const taskFile = await findTaskFile(taskId);
    if (taskFile) {
      try {
        const content = await readFile(taskFile, "utf-8");
        idleConductor.taskTitle = content.match(/^title:\s*(.+)/m)?.[1]?.trim();
      } catch {}
    }

    // タブ名更新
    const num = idleConductor.surface.replace("surface:", "");
    const shortTitle = (idleConductor.taskTitle ?? "").slice(0, 30);
    await cmux.renameTab(idleConductor.surface, `[${num}] ♦ T${taskId} ${shortTitle}`).catch(() => {});

    // resume コマンドを Conductor ペインに送信
    await cmux.send(idleConductor.surface, `export CMUX_SURFACE=${idleConductor.surface}\n`);
    await new Promise(r => setTimeout(r, 500));
    await cmux.send(idleConductor.surface, `cmux-team resume ${taskId}\n`);

    await log("task_resumed", `task_id=${taskId} session_id=${ts.sessionId} surface=${idleConductor.surface}`);
  }
  await saveTaskState(PROJECT_ROOT, taskState);

  scheduleRefresh();
  ```
- **理由**: boot 完了後（Conductor スロットが idle で利用可能になった直後）に resume を試行する。resume 不可のタスクは `ready` に戻し、通常の scanTasks で新規セッションとして再割り当てされるようにする。

### 6. updateTeamJson に sessionId を追加

- **ファイル**: `skills/cmux-team/manager/daemon.ts`
- **変更箇所**: `updateTeamJson` 関数（1084-1099行目）の conductors マッピング
- **変更内容**: `conductors[].sessionId` を出力に追加
  ```typescript
  teamJson.conductors = [...state.conductors.values()].map((c) => ({
    surface: c.surface,
    taskRunId: c.taskRunId,
    taskId: c.taskId,
    taskTitle: c.taskTitle,
    status: c.status,
    worktreePath: c.worktreePath,
    outputDir: c.outputDir,
    startedAt: c.startedAt,
    paneId: c.paneId,
    sessionId: c.sessionId,    // ← 追加
    agents: c.agents.map((a) => ({
      surface: a.surface,
      role: a.role,
      sessionId: a.sessionId,
    })),
  }));
  ```
- **理由**: team.json に sessionId を含めることで、restart 時の `initializeLayout` で ConductorState に sessionId が復元される。また、外部ツールからの状態確認にも使える。

### 7. initializeLayout での sessionId 復元

- **ファイル**: `skills/cmux-team/manager/daemon.ts`
- **変更箇所**: `initializeLayout` 関数（346-398行目）の conductors 復元部分
- **変更内容**: team.json から ConductorState 復元時に `sessionId` も含める
  ```typescript
  alive.push({
    surface: c.surface,
    taskRunId: c.taskRunId,
    taskId: c.taskId,
    taskTitle: c.taskTitle,
    worktreePath: c.worktreePath,
    outputDir: c.outputDir,
    startedAt: c.startedAt ?? new Date().toISOString(),
    paneId: c.paneId,
    sessionId: c.sessionId,    // ← 追加
    agents: /* ... */,
    status: /* ... */,
  });
  ```
- **理由**: restart 時に ConductorState に sessionId が復元されないと、running 状態の Conductor を正しく追跡できない。ただし resume は task-state.json ベースで行うため、これは補助的な情報。

### 8. conductor-settings.json 生成の共通化

- **ファイル**: `skills/cmux-team/manager/main.ts`
- **変更箇所**: `cmdConductor`（714-812行目）のsettings生成部分
- **変更内容**: settings 生成ロジックを `generateConductorSettings(projectRoot, slotId)` ヘルパー関数として抽出し、`cmdConductor` と `cmdResume` の両方から呼び出す
  ```typescript
  function generateConductorSettings(projectRoot: string, slotId: string): string {
    const conductorSettingsPath = join(projectRoot, `.team/prompts/${slotId}-settings.json`);
    const conductorSettings = {
      hooks: {
        // ... 既存の hook 定義（714-810行目の内容をそのまま移動）...
      },
    };
    try { mkdirSync(join(projectRoot, ".team/prompts"), { recursive: true }); } catch {}
    writeFileSync(conductorSettingsPath, JSON.stringify(conductorSettings, null, 2));
    return conductorSettingsPath;
  }
  ```
- **理由**: `cmdConductor` と `cmdResume` で同一の hook 設定が必要。重複コードを避けるために共通化する。

## 実装順序

1. **TaskState 拡張** (`task.ts`)
   - TaskState にフィールド追加（型定義のみ、既存動作への影響なし）

2. **conductor-settings.json 生成の共通化** (`main.ts`)
   - `generateConductorSettings` ヘルパー関数を抽出
   - `cmdConductor` をリファクタリング（動作変更なし）

3. **assignTask での resume 情報保存** (`daemon.ts` scanTasks)
   - task-state.json 書き込み時に worktreePath, taskRunId, conductorSlot を追加

4. **SESSION_STARTED での sessionId 保存** (`daemon.ts` handleMessage)
   - sessionId を task-state.json に書き込む処理を追加

5. **updateTeamJson に sessionId 追加** (`daemon.ts`)
   - conductors マッピングに sessionId フィールド追加

6. **initializeLayout での sessionId 復元** (`daemon.ts`)
   - team.json から ConductorState 復元時に sessionId を含める

7. **`cmux-team resume` サブコマンド** (`main.ts`)
   - `cmdResume` 関数を実装
   - ルーティングに `case "resume"` を追加

8. **`cmdStart` に resume 統合ロジック** (`main.ts`)
   - boot 完了後の assigned タスク検索・resume 送信ロジックを追加

## リスク・注意点

- **sessionId の有効性**: `claude --resume` に渡す sessionId が期限切れ等で無効な場合、claude がエラーで終了する。この場合 SESSION_ENDED hook が発火し、daemon が検出して Conductor を disconnected にする。タスクは assigned のまま残るため、手動で `abort-task` → 新タスク作成が必要。
  - 対策: resume 失敗時に `CONDUCTOR_DONE success=false` を送信するよう、`cmdResume` の catch ブロックで処理を追加することを検討。

- **worktree の状態不整合**: restart 前の worktree にコミットされていない変更がある場合、resume 後の Claude が不整合な状態から再開する可能性がある。ただし、Conductor は worktree 内で作業するため、main ブランチへの影響はない。

- **conductorSlot の変動**: restart 時に Conductor の surface ID が変わる可能性がある（cmux のペイン再作成）。resume 統合ロジックでは task-state.json の `conductorSlot` ではなく、boot 後に利用可能な idle Conductor を使用するため、この問題は回避される。

- **競合**: resume 統合ロジックは boot 完了後・メインループ前に同期的に実行されるため、scanTasks との競合は発生しない。

- **既存タスクの互換性**: TaskState の新フィールドはすべてオプショナルなので、既存の task-state.json との後方互換性は維持される。resume 情報がないタスクは従来通り ready に戻される。

- **resetConductor でのクリーンアップ**: タスク完了時の `resetConductor` で task-state.json から resume 情報を消す必要はない。`close-task` / `abort-task` 時に status が変わるため、resume 判定の `status === "assigned"` チェックで自然に除外される。
