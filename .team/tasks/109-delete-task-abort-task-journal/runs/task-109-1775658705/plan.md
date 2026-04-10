# 実装計画: delete-task コマンド追加 + abort-task の Journal 記録対応

## 概要

未着手タスク（draft/ready）を削除する `delete-task` コマンドを新規追加し、`abort-task` に `--journal` オプションを追加して中断理由を記録できるようにする。ダッシュボードの Journal タブと Tasks タブの表示も対応する。

## 変更ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/task.ts` | `TaskState` に `deletedAt` フィールド追加 |
| `skills/cmux-team/manager/main.ts` | `cmdDeleteTask()` 新規追加、`cmdAbortTask()` に `--journal` 対応、ヘルプ/switch 更新 |
| `skills/cmux-team/manager/daemon.ts` | `scanTasks()` の closed set と openTasksList フィルタに `deleted` 追加 |
| `skills/cmux-team/manager/dashboard.tsx` | `parseJournalEntries()` に `task_deleted` イベント追加 |
| `skills/cmux-team/templates/master.md` | `delete-task` の使い方を追記 |

## 実装手順

### Step 1: task.ts — TaskState インターフェース拡張

**ファイル**: `skills/cmux-team/manager/task.ts` L23-28

**変更**: `TaskState` に `deletedAt` フィールドを追加する。

```typescript
export interface TaskState {
  status: string;     // "draft" | "ready" | "in_progress" | "closed" | "aborted" | "deleted"
  closedAt?: string;  // ISO 8601
  abortedAt?: string; // ISO 8601 — abort 時のタイムスタンプ
  deletedAt?: string; // ISO 8601 — delete 時のタイムスタンプ
  journal?: string;   // 完了時のサマリー
}
```

### Step 2: main.ts — delete-task コマンド追加

**ファイル**: `skills/cmux-team/manager/main.ts`

`cmdCloseTask()` (L1389) の直前に `cmdDeleteTask()` を追加する。

**関数名**: `cmdDeleteTask()`

**処理フロー**:

1. ヘルプ表示（`hasHelpFlag()` チェック）
2. `--task-id` を `requireArg("task-id")` で取得
3. `--journal` を `getArg("journal")` で取得（任意）
4. `findTaskFile(taskId)` でタスク存在確認（なければ exit(1)）
5. `loadTaskState()` で現在のステータスを取得
6. **ガード**: `assigned` 状態なら削除不可。エラーメッセージ: `"Error: task {id} is assigned (running). Use abort-task instead."` で exit(1)
7. **ガード**: すでに `closed`/`aborted`/`deleted` なら重複操作エラー
8. task-state.json に以下を記録:
   ```typescript
   taskState[taskId] = {
     status: "deleted",
     deletedAt: new Date().toISOString(),
     journal: journal ?? `削除: T${taskId} ${taskTitle}`,
   };
   ```
   - `taskTitle` は `parseTaskMeta()` でタスクファイルから取得
9. ログ出力: `log("task_deleted", \`task_id=${taskId} title=${taskTitle}\`)` — daemon のログに記録（Journal タブで表示するため）
10. `console.log(\`OK deleted ${taskId}\`)` で完了

**CONDUCTOR_DONE は不要**（未着手タスクのため Conductor に割り当てられていない）。

**ヘルプテキスト**:
```
cmux-team delete-task -- 未着手タスクを削除（deleted）にする

Usage:
  cmux-team delete-task --task-id <id> [options]

Options:
  --task-id <id>          タスク ID（必須）
  --journal <text>        削除理由（任意、デフォルト: "削除: T{id} {title}"）

Examples:
  cmux-team delete-task --task-id 035
  cmux-team delete-task --task-id 035 --journal "要件変更のため不要"

Notes:
  - draft / ready 状態のタスクのみ削除できます
  - assigned（実行中）のタスクは abort-task を使ってください
```

### Step 3: main.ts — abort-task に journal 対応

**ファイル**: `skills/cmux-team/manager/main.ts` L1456-1567 (`cmdAbortTask()`)

**変更点**:

1. **引数追加** (L1475 付近): `--journal` パラメータを取得
   ```typescript
   const journal = getArg("journal");
   ```

2. **ヘルプテキスト更新** (L1457-1474): `--journal` オプションを追記
   ```
   Options:
     --task-id <id>          タスク ID（必須）
     --journal <text>        中断理由（任意、デフォルト: "中断: T{id} {title}"）

   Examples:
     cmux-team abort-task --task-id 035
     cmux-team abort-task --task-id 035 --journal "方針変更のため中断"
   ```

3. **タスク状態記録** — 2箇所の `taskState[taskId] = {...}` を更新:

   **(a) Conductor が見つからない場合** (L1498-1501):
   ```typescript
   taskState[taskId] = {
     ...taskState[taskId],
     status: "aborted",
     abortedAt: new Date().toISOString(),
     journal: journal ?? `中断: T${taskId} ${taskTitle}`,
   };
   ```
   - `taskTitle` は `findTaskFile()` + `parseTaskMeta()` で取得する必要がある（L1475 の後で取得）

   **(b) 正常 abort フロー** (L1547-1551):
   ```typescript
   taskState[taskId] = {
     ...taskState[taskId],
     status: "aborted",
     abortedAt: new Date().toISOString(),
     journal: journal ?? `中断: T${taskId} ${taskTitle}`,
   };
   ```

4. **ログ出力追加**: abort 完了後にログ記録（Journal タブ表示用）
   ```typescript
   await logToFile(PROJECT_ROOT, "task_aborted", `task_id=${taskId}${taskTitle ? ` title=${taskTitle}` : ""}`);
   ```
   - daemon 経由ではなく直接ログファイルに書き込む（`cmdAbortTask` は CLI コマンドとして実行されるため）
   - `logToFile` は `cmdCloseTask` と同様のパターンで実装（既存の `log()` はdaemon 用なので、CLI からは manager.log に直接追記する）

   **注意**: 既存の daemon.ts `handleConductorDone` → `task_completed` ログが abort 時にも出る可能性がある。abort-task は CONDUCTOR_DONE を `success: false, reason: "aborted"` で送信するので、daemon 側では `conductor_error` としてログされる（L390）。`task_aborted` ログは CLI 側で別途書く必要がある。

   実装方針: `cmdCloseTask` や `cmdAbortTask` は CLI として実行されるので、manager.log への直接追記を行う。既存のログ関数 `log()` は `logger.ts` の関数で daemon プロセス内で使われるもの。CLI コマンドから使う場合は `logger.ts` の `log()` がそのまま使えるか確認が必要。

   → `logger.ts` の `log()` は `PROJECT_ROOT` を参照しているなら CLI からも呼び出し可能。実際に `main.ts` の他のコマンド（close-task 等）でログ出力しているかを確認する。

   **追加調査結果**: `main.ts` では `import { log } from "./logger"` しており、CLI からも `log()` を呼び出せる。ただし `close-task` は明示的にログ出力していない（daemon 側の `handleConductorDone` で `task_completed` として記録される）。`abort-task` は daemon の `handleConductorDone` を通らない場合があるため、CLI 側でログを書く方が確実。

   → `log("task_aborted", \`task_id=${taskId} title=${taskTitle}\`)` を abort 処理の最後に追加する。

### Step 4: daemon.ts — deleted フィルタ追加

**ファイル**: `skills/cmux-team/manager/daemon.ts`

**変更箇所 3つ**:

**(a) closed set** (L571-575):
```typescript
// Before:
const closed = new Set(
  Object.entries(taskState)
    .filter(([_, s]) => s.status === "closed" || s.status === "aborted")
    .map(([id]) => id)
);

// After:
const closed = new Set(
  Object.entries(taskState)
    .filter(([_, s]) => s.status === "closed" || s.status === "aborted" || s.status === "deleted")
    .map(([id]) => id)
);
```

**(b) openTasksList** (L577):
```typescript
// Before:
const openTasksList = tasks.filter(t => t.status !== "closed" && t.status !== "aborted");

// After:
const openTasksList = tasks.filter(t => t.status !== "closed" && t.status !== "aborted" && t.status !== "deleted");
```

**(c) closedMetas** (L599): deleted タスクは Tasks タブに表示しない。closedMetas に含めない。
```typescript
// Before:
const closedMetas = tasks.filter(t => t.status === "closed" || t.status === "aborted");

// After（変更なし — deleted は含めない）:
const closedMetas = tasks.filter(t => t.status === "closed" || t.status === "aborted");
```
→ closedMetas は Tasks タブの下部に表示する完了タスク一覧なので、deleted は表示しない。変更不要。

### Step 5: dashboard.tsx — task_deleted イベント対応

**ファイル**: `skills/cmux-team/manager/dashboard.tsx` L237-273 (`parseJournalEntries()`)

`task_aborted` の処理（L265-269）の後に `task_deleted` イベントを追加:

```typescript
} else if (event === "task_deleted") {
  const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
  if (!isValidTaskId(taskId)) continue;
  const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
  result.push({ time, icon: nerdIcon("\uf056", "[-]"), taskId, message: title || "deleted", level: "warn", iconColor: GRAY });
}
```

- アイコン: `\uf056` (fa-minus-circle) — 削除を表現。フォールバック: `[-]`
- レベル: `warn`（info でもよいが、操作の記録として目立たせる）
- 色: `GRAY` — 削除は非アクティブな操作なのでグレー表示

**GRAY 定数の確認**: dashboard.tsx に `GRAY` 定数が定義されているか確認し、なければ追加する。既存の色定数（`RED`, `GREEN`, `YELLOW`, `CYAN`）と同じパターンで定義。

### Step 6: main.ts — ヘルプ/usage 更新

**ファイル**: `skills/cmux-team/manager/main.ts`

**(a) switch 文** (L1835-1893): `abort-task` case の後に追加
```typescript
case "delete-task":
  await cmdDeleteTask();
  break;
```

**(b) usage 一覧** (L1860-1887): `abort-task` の行の後に追加
```
  cmux-team delete-task --task-id <id> [--journal <text>]  未着手タスクを削除
```

**(c) abort-task の usage 行** (L1876): journal オプションを追記
```
  cmux-team abort-task --task-id <id> [--journal <text>]   実行中タスクを中止
```

### Step 7: templates/master.md — delete-task 追記

**ファイル**: `skills/cmux-team/templates/master.md`

L23 付近の「abort-task は原則使わない」の記述の近くに追記:

```markdown
- **不要なタスクの削除**: draft/ready のタスクが不要になった場合は `cmux-team delete-task --task-id NNN --journal "理由"` で削除する
```

また、L84 付近のコマンド一覧テーブルに追加:

```markdown
| 不要タスクを削除 | `cmux-team delete-task --task-id NNN [--journal "理由"]` |
```

## テスト方針

### 手動テスト手順

1. **delete-task 基本動作**:
   - draft タスクを作成 → `cmux-team delete-task --task-id NNN` → task-state.json で `status: "deleted"`, `deletedAt`, `journal`（デフォルト値）を確認
   - ready タスクで同様に確認

2. **delete-task ガード**:
   - assigned タスクに対して実行 → エラーメッセージが出ることを確認
   - 存在しないタスク ID → エラーが出ることを確認

3. **abort-task + journal**:
   - assigned タスクに `cmux-team abort-task --task-id NNN --journal "テスト中断"` → task-state.json の `journal` フィールドに記録されることを確認
   - `--journal` なしで abort → デフォルトメッセージが入ることを確認

4. **ダッシュボード確認**:
   - delete 後に Tasks タブに表示されないことを確認
   - delete/abort のジャーナルが Journal タブに表示されることを確認

5. **daemon の scanTasks**:
   - deleted タスクが openTasks にカウントされないことを確認
   - deleted タスクの依存先が closed 扱いで解決されることを確認

## リスク・注意点

1. **既存データとの互換性**: task-state.json に `deleted` status が追加されるが、既存エントリには影響なし。`deletedAt` フィールドも optional なので後方互換性あり。

2. **ログフォーマット**: `task_deleted` イベントは新規追加。既存のログパーサー（dashboard.tsx の `parseJournalEntries`）に影響を与えないよう、既存イベントのパースロジックには手を加えない。

3. **abort-task のログ**: abort-task は CLI として実行されるが、`log()` 関数で manager.log に追記する。daemon がログファイルを読み取る際に競合する可能性は低い（追記のみのため）。

4. **GRAY 定数**: dashboard.tsx に GRAY 色定数がなければ追加が必要。既存の色パレットを確認してから実装する。
