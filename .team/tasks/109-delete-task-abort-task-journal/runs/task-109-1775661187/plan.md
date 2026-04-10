# 実装計画書: delete-task コマンド追加 + abort-task の Journal 記録対応

## 1. 概要

以下の3つの変更を行う:

1. **delete-task コマンド新規追加** — draft/ready 状態のタスクを論理削除する CLI コマンド
2. **abort-task に journal オプション追加** — 中止理由を task-state.json に記録し、Journal タブに表示
3. **daemon.ts / dashboard.tsx の対応** — deleted タスクのフィルタリングと aborted タスクの journal 表示

## 2. 変更箇所の詳細

### 2.1 task.ts — TaskState に deletedAt 追加

**ファイル:** `skills/cmux-team/manager/task.ts`
**箇所:** L23-28（TaskState インターフェース）

```typescript
export interface TaskState {
  status: string;     // "draft" | "ready" | "in_progress" | "closed" | "aborted" | "deleted"
  closedAt?: string;  // ISO 8601
  abortedAt?: string; // ISO 8601
  deletedAt?: string; // ISO 8601 — delete 時のタイムスタンプ
  journal?: string;   // 完了時/中止時/削除時のサマリー
}
```

変更点: `deletedAt` フィールド追加、`status` コメントに `"deleted"` 追加。

### 2.2 main.ts — delete-task コマンド新規追加

**ファイル:** `skills/cmux-team/manager/main.ts`

#### 2.2.1 cmdDeleteTask 関数の新規追加（cmdAbortTask の後、L1568 付近に挿入）

```typescript
async function cmdDeleteTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(`
cmux-team delete-task -- タスクを削除（deleted）にする

Usage:
  cmux-team delete-task --task-id <id> [options]

Options:
  --task-id <id>          タスク ID（必須）
  --journal <text>        削除ジャーナル（任意、デフォルト: "削除: T{id} {title}"）

Examples:
  cmux-team delete-task --task-id 035
  cmux-team delete-task --task-id 035 --journal "不要になったため削除"

Notes:
  - draft/ready のタスクのみ削除できます（assigned は abort-task を使用）
  - task-state.json の status が deleted に設定されます
  - Journal タブに記録が残ります
`);
  const taskId = requireArg("task-id");
  const journalArg = getArg("journal");

  // 1. タスクファイルの存在確認
  const taskFile = await findTaskFile(taskId);
  if (!taskFile) {
    console.error(`Error: task ${taskId} not found in .team/tasks/`);
    process.exit(1);
  }

  // 2. タスク状態を確認（assigned は不可）
  const taskState = await loadTaskState(PROJECT_ROOT);
  const currentStatus = taskState[taskId]?.status;
  if (currentStatus === "assigned") {
    console.error(`Error: task ${taskId} is assigned (running). Use abort-task to stop a running task.`);
    process.exit(1);
  }
  if (currentStatus === "closed" || currentStatus === "aborted" || currentStatus === "deleted") {
    console.error(`Error: task ${taskId} is already ${currentStatus}.`);
    process.exit(1);
  }

  // 3. タスクのタイトルを取得（journal デフォルト用）
  const taskContent = await readFile(taskFile, "utf-8");
  const titleMatch = taskContent.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const title = titleMatch?.[1] ?? "";

  // 4. journal のデフォルト生成
  const journal = journalArg ?? `削除: T${taskId} ${title}`.trim();

  // 5. task-state.json に deleted + deletedAt + journal を設定
  taskState[taskId] = {
    status: "deleted",
    deletedAt: new Date().toISOString(),
    journal,
  };
  await saveTaskState(PROJECT_ROOT, taskState);

  // 6. ログに記録（Journal タブ表示用）
  await log("task_deleted", `task_id=${taskId}${title ? ` title=${title}` : ""} journal_summary=${journal}`);

  console.log(`OK deleted ${taskId}`);
}
```

#### 2.2.2 コマンドディスパッチに追加（L1844 付近、abort-task の後）

```typescript
case "delete-task":
  await cmdDeleteTask();
  break;
```

#### 2.2.3 ヘルプテキストに追加（L1876 付近、abort-task の後）

```
cmux-team delete-task --task-id <id> [--journal <text>] タスクを削除
```

#### 2.2.4 ファイル冒頭のコメントに追加（L19 付近）

```
 *   ./main.ts delete-task --task-id <id> [--journal <text>]
```

### 2.3 main.ts — abort-task に journal オプション追加

**ファイル:** `skills/cmux-team/manager/main.ts`
**箇所:** L1456-1568（cmdAbortTask 関数）

#### 変更点:

1. **ヘルプテキスト更新**（L1457-1474）: `--journal` オプションの説明を追加

2. **journal 引数の取得**（L1475 付近）:
   ```typescript
   const journalArg = getArg("journal");
   ```

3. **タスクタイトル取得**（L1476 付近、taskId 取得後）:
   タスクファイルからタイトルを読む。journal デフォルト生成に使用。

4. **journal デフォルト生成**:
   ```typescript
   const journal = journalArg ?? `中断: T${taskId} ${title}`.trim();
   ```

5. **task-state.json 更新にjournal追加**（L1546-1552、L1498-1504 の2箇所）:
   ```typescript
   taskState[taskId] = {
     ...taskState[taskId],
     status: "aborted",
     abortedAt: new Date().toISOString(),
     journal,
   };
   ```

6. **ログに journal 記録**（L1554 の CONDUCTOR_DONE 送信の前に追加）:
   ```typescript
   await log("task_aborted", `task_id=${taskId}${title ? ` title=${title}` : ""} journal_summary=${journal}`);
   ```
   これにより dashboard.tsx の Journal タブで表示可能になる。

7. **Conductor なしの早期 return パス**（L1496-1506）にも同じく journal と log を追加。

### 2.4 daemon.ts — deleted フィルタ追加

**ファイル:** `skills/cmux-team/manager/daemon.ts`

#### 2.4.1 openTasksList フィルタ更新（L577）

**変更前:**
```typescript
const openTasksList = tasks.filter(t => t.status !== "closed" && t.status !== "aborted");
```

**変更後:**
```typescript
const openTasksList = tasks.filter(t => t.status !== "closed" && t.status !== "aborted" && t.status !== "deleted");
```

#### 2.4.2 closed set に deleted を追加（L571-575）

**変更前:**
```typescript
const closed = new Set(
  Object.entries(taskState)
    .filter(([_, s]) => s.status === "closed" || s.status === "aborted")
    .map(([id]) => id)
);
```

**変更後:**
```typescript
const closed = new Set(
  Object.entries(taskState)
    .filter(([_, s]) => s.status === "closed" || s.status === "aborted" || s.status === "deleted")
    .map(([id]) => id)
);
```

理由: deleted タスクに depends_on しているタスクが依存解決で待ち続けないようにする。

### 2.5 dashboard.tsx — deleted / aborted の Journal 表示対応

**ファイル:** `skills/cmux-team/manager/dashboard.tsx`

#### 2.5.1 task_deleted イベントのパース追加（L270 付近、task_aborted の後）

```typescript
} else if (event === "task_deleted") {
  const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
  if (!isValidTaskId(taskId)) continue;
  const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
  const summary = detail.match(/journal_summary=(.+)/)?.[1] ?? "";
  result.push({ time, icon: nerdIcon("\uf056", "[−]"), taskId, message: summary || title || "deleted", level: "warn", iconColor: YELLOW });
}
```

#### 2.5.2 task_aborted に journal_summary 表示追加（L265-269）

**変更前:**
```typescript
} else if (event === "task_aborted") {
  const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
  if (!isValidTaskId(taskId)) continue;
  const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
  result.push({ time, icon: nerdIcon("\uf057", "[✕]"), taskId, message: title || "aborted", level: "error", iconColor: RED });
}
```

**変更後:**
```typescript
} else if (event === "task_aborted") {
  const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
  if (!isValidTaskId(taskId)) continue;
  const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
  const summary = detail.match(/journal_summary=(.+)/)?.[1] ?? "";
  result.push({ time, icon: nerdIcon("\uf057", "[✕]"), taskId, message: summary || title || "aborted", level: "error", iconColor: RED });
}
```

変更点: `journal_summary` をパースし、存在すれば優先的に表示。

### 2.6 templates/master.md — delete-task の使い方追記

**ファイル:** `skills/cmux-team/templates/master.md`

abort-task の記述付近に以下を追加:

```markdown
cmux-team delete-task --task-id <id> [--journal "理由"]   未着手タスクを削除
```

また、タスク操作パターンの表に追加:

```
| 未着手タスクの削除 | `cmux-team delete-task --task-id NNN --journal "理由"` |
```

## 3. 実装順序

1. **task.ts** — TaskState に `deletedAt` 追加（型定義のみ、他に影響なし）
2. **daemon.ts** — openTasksList フィルタと closed set に `deleted` 追加
3. **main.ts** — `cmdDeleteTask` 関数を新規追加 + ディスパッチ・ヘルプ更新
4. **main.ts** — `cmdAbortTask` に `--journal` オプション追加 + ログ記録
5. **dashboard.tsx** — `task_deleted` パース追加 + `task_aborted` に journal_summary 追加
6. **templates/master.md** — delete-task の使い方追記

理由: 型定義 → フィルタ → コマンド実装 → 表示の順で依存方向に沿って変更する。

## 4. テスト計画

### 4.1 delete-task コマンド

```bash
# draft タスクの削除
cmux-team create-task --title "テスト削除用"
cmux-team delete-task --task-id <id>
# → task-state.json に status: "deleted", deletedAt, journal が設定されること
# → manager.log に task_deleted イベントが記録されること

# journal 指定
cmux-team create-task --title "テスト削除用2" --status ready
cmux-team delete-task --task-id <id> --journal "不要になったため"
# → journal が "不要になったため" であること

# assigned タスクの削除拒否
# → "Use abort-task" エラーが表示されること

# 既に closed/aborted/deleted のタスクの削除拒否
# → "already closed" 等のエラーが表示されること
```

### 4.2 abort-task の journal 対応

```bash
# journal 付きの abort
cmux-team abort-task --task-id <id> --journal "方針変更のため中断"
# → task-state.json に journal が記録されること
# → manager.log に task_aborted イベント + journal_summary が記録されること

# journal 未指定の abort
cmux-team abort-task --task-id <id>
# → デフォルト journal "中断: T{id} {title}" が記録されること
```

### 4.3 ダッシュボード表示

```bash
cmux-team status
# → Tasks タブに deleted タスクが表示されないこと
# → Journal タブに削除タスクの journal が表示されること（[−] アイコン）
# → Journal タブに中止タスクの journal が表示されること（[✕] アイコン + journal_summary）
```

### 4.4 依存解決

```bash
# T100（deleted）に depends_on している T101 が実行可能になること
cmux-team create-task --title "前提タスク" --status ready
cmux-team create-task --title "依存タスク" --depends-on <T100のid> --status ready
cmux-team delete-task --task-id <T100のid>
# → T101 が executable として検出されること
```

## 5. リスク・注意点

### 5.1 既存機能への影響

- **openTasksList フィルタ変更**: `deleted` を追加するだけなので既存の `closed`/`aborted` フィルタは影響なし
- **closed set への追加**: deleted タスクを「完了扱い」にすることで依存解決が壊れないようにする。deleted は「もう存在しない」なので、待ち続けるよりも解決済みとする方が合理的
- **abort-task の既存動作**: journal 追加は非破壊的。journal 未指定時はデフォルトメッセージが入るため、既存の自動実行（Conductor から呼ばれるケースは無い）に影響しない

### 5.2 handleConductorDone との関係

- abort-task は main.ts 側で直接ログを書き（`task_aborted`）、CONDUCTOR_DONE も送信する
- daemon の handleConductorDone は引き続き `task_completed` をログするが、task_aborted は abort 直後に main.ts から既にログ済みなので、Journal タブには abort のジャーナルが表示される
- 結果として Journal タブには `task_aborted`（main.ts から）と `task_completed`（daemon から）の両方が出る可能性があるが、task_aborted が先にログされるため時系列で正しく表示される。もし重複が問題になる場合は、daemon.ts の handleConductorDone で aborted タスクの task_completed ログをスキップする対応も検討できるが、今回のスコープ外とする

### 5.3 CONDUCTOR_DONE 不要（delete-task）

delete-task は draft/ready タスクのみ対象で、Conductor に割り当てられていないため CONDUCTOR_DONE は不要。ログ記録（`log("task_deleted", ...)`）のみで Journal タブ表示に十分。
