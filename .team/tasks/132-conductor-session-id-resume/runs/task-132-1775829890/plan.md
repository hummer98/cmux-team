# 実装計画: Conductor 起動時に --session-id を指定して resume 可能にする

## 設計判断

### 案の評価

| 案 | 概要 | 実現可能性 | 採用 |
|---|---|---|---|
| **案A** | タスク割当時に Claude を再起動（`/exit` → `--session-id` 付きで再起動） | 高い。session-id が確実に設定される | **採用** |
| 案B | 初回起動時に仮 session-id を設定し、`/clear` 後もそのまま使う | 低い。`/clear` で新セッションが作成され、元の session-id では resume 不可の可能性が高い | 不採用 |
| 案C | Conductor AI に `/exit` を指示する | 低い。セマンティック動作への依存（設計原則に反する） | 不採用 |

### 案A を選択した理由

1. **調査結果**: `--session-id <uuid>` で起動 → `--resume <uuid>` で再開が確実に動作する
2. **決定論的**: Manager（コード）が UUID 生成・保存・起動を全て制御。hook のタイミング競合が発生しない
3. **設計原則に合致**: 「決定論的なものはコードで」「上位が下位を制御」

### オーバーヘッド

- Claude プロセス再起動に約3-5秒のオーバーヘッド
- タスク割当は頻繁な操作ではないため許容範囲
- `/clear` + プロンプト送信（現在の方式）でも約3秒のウェイトがあるため、差は小さい

## フロー変更

### 現在のフロー（Before）

```
1. assignTask: worktree 作成 → プロンプト生成
2. assignTask: /clear + Enter → 2秒待ち → プロンプト送信 + Enter
3. Claude: 新セッション開始 → SessionStart hook 発火
4. hook: cmux-team send SESSION_STARTED --session-id "$SESSION_ID"
   ↑ $SESSION_ID は常に空（Claude は stdin JSON で渡すため）
5. daemon: sessionId を task-state.json に保存（空のまま）
6. resume 時: sessionId がないためエラー
```

### 新しいフロー（After）

```
1. assignTask: worktree 作成 → プロンプト生成
2. assignTask: UUID 生成 → task-state.json に sessionId を即座に保存
3. assignTask: PID watcher クリア → /exit 送信 → 2秒待ち
4. assignTask: cmux-team conductor <slot> --session-id <uuid> --task-prompt <file>
5. cmdConductor: claude --session-id <uuid> --task-prompt の内容 で起動
6. Claude: 指定した session-id でセッション開始
7. resume 時: task-state.json の sessionId で --resume 可能
```

## 変更ファイル一覧

| ファイル | 変更内容 | 影響度 |
|---------|---------|--------|
| `manager/main.ts` | `cmdConductor` に `--session-id`, `--task-prompt` オプション追加 | 中 |
| `manager/main.ts` | `generateConductorSettings` から SessionStart hook の `--session-id` パラメータ削除 | 小 |
| `manager/conductor.ts` | `assignTask` を `/clear` → `/exit` + 再起動方式に変更 | 大 |
| `manager/conductor.ts` | `resetConductor` で `sessionId` をクリア | 小 |
| `manager/daemon.ts` | `SESSION_STARTED` ハンドラから sessionId 保存ロジック削除 | 小 |
| `manager/daemon.ts` | `scanTasks` で sessionId を task-state.json に記録 | 小 |

## 各ファイルの具体的な変更内容

### 1. `main.ts` — `cmdConductor` (L859-906)

`--session-id` と `--task-prompt` オプションを追加し、Claude の起動引数に反映する。

```typescript
async function cmdConductor(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_conductor", { model: DEFAULT_MODEL }));
  const slotId = args[1];
  if (!slotId) {
    console.error("Usage: cmux-team conductor <slot-id>");
    process.exit(1);
  }

  // 新規: オプション解析
  const sessionId = getArg("session-id");
  const taskPromptFile = getArg("task-prompt");

  // ロールプロンプトファイル生成（変更なし）
  const { generateConductorRolePrompt } = await import("./template");
  const rolePromptFile = await generateConductorRolePrompt(PROJECT_ROOT);

  // 環境変数を設定（変更なし）
  process.env.PROJECT_ROOT = PROJECT_ROOT;
  process.env.CONDUCTOR_ID = slotId;
  process.env.CMUX_NO_RENAME_TAB = "1";
  process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1";
  const proxyPort = await resolveProxyPort();
  if (proxyPort) {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
  }

  // モデル解決（変更なし）
  const config = await loadConfig();
  const model = getModelForRole(config, "conductor", getArg("model"));

  // conductor-settings.json を生成（変更なし）
  const conductorSettingsPath = generateConductorSettings(PROJECT_ROOT, slotId);

  // 新規: claude コマンド引数を組み立て
  const claudeArgs = [
    "--dangerously-skip-permissions",
    "--settings", conductorSettingsPath,
    "--model", model,
    "--append-system-prompt-file", rolePromptFile,
  ];
  if (sessionId) {
    claudeArgs.push("--session-id", sessionId);
  }

  // 新規: 初期プロンプトを決定
  const initialPrompt = taskPromptFile
    ? `${taskPromptFile} を読んで指示に従って作業してください。`
    : t("conductor_wait_prompt");
  claudeArgs.push(initialPrompt);

  // claude を exec
  const { execFileSync } = require("child_process");
  try {
    execFileSync("claude", claudeArgs, {
      stdio: "inherit",
      env: process.env,
      cwd: PROJECT_ROOT,
    });
  } catch (e: any) {
    process.exit(e.status ?? 1);
  }
}
```

**要点**:
- `getArg("session-id")` で UUID を取得、`getArg("task-prompt")` でプロンプトファイルパスを取得
- `--session-id` が指定されていれば `claude --session-id <uuid>` として渡す
- `--task-prompt` が指定されていれば、タスクプロンプトを初期メッセージにする（idle wait prompt の代わり）

### 2. `main.ts` — `generateConductorSettings` (L758-761)

SessionStart hook から `--session-id` パラメータを削除。

```typescript
// Before (L760):
command: "bash -c 'cmux-team send SESSION_STARTED --conductor-id \"$CONDUCTOR_ID\" --surface \"${CMUX_SURFACE:-unknown}\" --pid \"$PPID\" --session-id \"${SESSION_ID:-}\" 2>/dev/null || true'",

// After:
command: "bash -c 'cmux-team send SESSION_STARTED --conductor-id \"$CONDUCTOR_ID\" --surface \"${CMUX_SURFACE:-unknown}\" --pid \"$PPID\" 2>/dev/null || true'",
```

### 3. `conductor.ts` — `assignTask` (L345-382)

セクション4「既存セッションをリセットして新プロンプトを送信」を、`/exit` + 再起動方式に変更。

```typescript
    // --- 4. Claude プロセスを再起動（--session-id 付き） ---
    const sessionId = crypto.randomUUID();

    // PID watcher をクリア（/exit 後の PID 消失で誤って disconnected にしない）
    if (conductor.pidWatcherInterval) {
      clearInterval(conductor.pidWatcherInterval);
      conductor.pidWatcherInterval = undefined;
    }

    try {
      // 現在の Claude セッションを終了
      await cmux.send(conductor.surface, "/exit");
      await sleep(500);
      await cmux.sendKey(conductor.surface, "return");
      await sleep(2000); // Claude 終了 + cmdConductor 終了 + shell 復帰を待つ

      // 新しい Claude を --session-id 付きで起動
      await cmux.send(
        conductor.surface,
        `cmux-team conductor ${conductor.surface} --session-id ${sessionId} --task-prompt ${promptFile}\n`
      );
    } catch (e: any) {
      throw new AssignTaskError("conductor", `conductor restart failed: ${e.message}`, e);
    }

    // --- 5. タブ名更新 ---
    // （変更なし）

    // --- 6. ConductorState 更新 ---
    conductor.taskRunId = taskRunId;
    conductor.taskId = taskId;
    conductor.taskTitle = taskTitle;
    conductor.worktreePath = worktreePath;
    conductor.outputDir = outputDir;
    conductor.startedAt = new Date().toISOString();
    conductor.agents = [];
    conductor.status = "running";
    conductor.sessionId = sessionId;  // 新規: session-id を保存
```

**要点**:
- `crypto.randomUUID()` で UUID v4 を生成
- PID watcher をクリア（`/exit` 後の誤検出防止）
- `/exit` + Enter で現在の Claude を終了
- 2秒待ち（Claude プロセス終了 + shell 復帰）
- `cmux-team conductor <slot-id> --session-id <uuid> --task-prompt <file>` で新しい Claude を起動
- `conductor.sessionId = sessionId` で ConductorState に保存

**`/exit` が shell に届いた場合（Claude 未起動時）の安全性**:
- shell は `/exit` を実行しようとして `bash: /exit: No such file or directory` エラーを出すが、次のコマンドは正常に実行される
- エッジケース（Conductor crash 後の idle 復帰時）でも安全

### 4. `conductor.ts` — `resetConductor` (L462-473)

`sessionId` のクリアを追加。

```typescript
    // 4. ConductorState リセット
    conductor.status = "idle";
    conductor.taskRunId = undefined;
    conductor.taskId = undefined;
    conductor.taskTitle = undefined;
    conductor.worktreePath = undefined;
    conductor.outputDir = undefined;
    conductor.agents = [];
    conductor.disconnectedAt = undefined;
    conductor.sessionId = undefined;  // 新規追加
```

### 5. `daemon.ts` — `SESSION_STARTED` ハンドラ (L507-553)

sessionId 保存ロジックを削除。SESSION_STARTED は pid と status 遷移のみ担当する。

```typescript
    case "SESSION_STARTED": {
      // Master surface チェック（変更なし）
      if (message.surface === state.masterSurface) {
        state.masterPid = message.pid;
        state.masterStatus = "idle";
        state.masterDisconnectedAt = undefined;
        spawnMasterPidWatcher(state, message.pid);
        await log("master_session_started", `surface=${message.surface} pid=${message.pid}`);
        break;
      }
      const conductor = findConductor(state, message.surface);
      if (conductor) {
        if (conductor.status === "starting" || conductor.status === "disconnected") {
          const prevStatus = conductor.status;
          conductor.status = "idle";
          await log(
            prevStatus === "starting" ? "conductor_ready" : "conductor_recovered",
            `surface=${message.surface}`
          );
        }
        conductor.pid = message.pid;
        // 削除: if (message.sessionId) conductor.sessionId = message.sessionId;
        conductor.disconnectedAt = undefined;
        spawnPidWatcher(state, conductor, message.pid);

        // 削除: sessionId を task-state.json に記録するブロック全体 (L534-543)

        await log(
          "session_started",
          `surface=${message.surface} pid=${message.pid}`
        );
      } else {
        await log("session_started_ignored", `surface=${message.surface} reason=conductor_not_found`);
      }
      break;
    }
```

**削除するコード** (L529, L534-543):
- `if (message.sessionId) conductor.sessionId = message.sessionId;`
- `if (message.sessionId && conductor.taskId) { ... }` ブロック全体

### 6. `daemon.ts` — `scanTasks` (L798-808)

task-state.json への書き込みに `sessionId` を追加。

```typescript
    state.conductors.set(updated.surface, updated);
    const ts = await loadTaskState(state.projectRoot);
    ts[task.id] = {
      ...ts[task.id],
      status: 'assigned',
      assignedAt: new Date().toISOString(),
      worktreePath: updated.worktreePath,
      taskRunId: updated.taskRunId,
      conductorSlot: updated.surface,
      sessionId: updated.sessionId,  // 新規追加
    };
    await saveTaskState(state.projectRoot, ts);
```

## 変更不要のファイル

| ファイル | 理由 |
|---------|------|
| `main.ts` — `cmdResume` | 既存の `claude --resume <sessionId>` で正しく動作。変更不要 |
| `schema.ts` | `SessionStartedMessage.sessionId` は optional のまま残す（後方互換）。`ConductorState.sessionId` も変更不要 |
| `task.ts` | `TaskState.sessionId` の型定義は変更不要 |
| `main.ts` — resume フロー (L417-473) | task-state.json から sessionId を読む既存ロジックで動作。assignTask で sessionId が確実に保存されるため、`resume_fallback_to_ready` の発生が大幅に減る |

## テスト方法

### 1. 基本フローのテスト

```bash
# cmux-team を起動
cmux-team start

# タスクを作成して ready にする
cmux-team create-task --title "テスト: session-id" --status ready --body "echo hello"

# Conductor がタスクを受け取り、--session-id 付きで Claude が再起動されることを確認
# ログを確認:
tail -f .team/logs/manager.log | grep -E "session_id|conductor_started|task_resumed"

# task-state.json に sessionId が記録されていることを確認
cat .team/task-state.json | jq
```

### 2. Resume フローのテスト

```bash
# タスク実行中に cmux-team stop で daemon を停止
cmux-team stop

# daemon を再起動
cmux-team start

# assigned タスクが自動的に resume されることを確認
# ログで task_resumed イベントを確認
grep "task_resumed" .team/logs/manager.log
```

### 3. エッジケースのテスト

- **Conductor idle 状態からの再起動**: 起動直後（Claude が idle 状態）にタスクを割り当て → `/exit` + 再起動が正常に動作すること
- **連続タスク**: タスク完了後、idle 状態の Conductor に次のタスクを割り当て → 再起動が正常に動作すること
- **UUID 形式**: task-state.json に保存される sessionId がハイフン付き UUID v4 形式であること

## リスクと軽減策

| リスク | 軽減策 |
|-------|--------|
| `/exit` 送信後の待ち時間が不足（Claude がまだ終了していない） | 2秒の待ち時間を設定。不足する場合は `cmux read-screen` でシェルプロンプトを検出するフォールバックを追加 |
| PID watcher が `/exit` 前に誤発火 | `assignTask` 内で PID watcher を明示的にクリア |
| Conductor が crash 済み（Claude 未起動）で `/exit` が shell に送られる | shell は `/exit` を実行不可として無視し、次の `cmux-team conductor` コマンドは正常に実行される |
