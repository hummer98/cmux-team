# T087: Journal の Tundefined 防御 + 不正ログ行削除

## 概要

manager.log に `task_id=undefined` のログ行が存在し、Dashboard の Journal に `Tundefined` と表示される問題を修正する。

## 変更ファイル一覧

| # | ファイル | 変更内容 |
|---|---------|---------|
| 1 | `skills/cmux-team/manager/dashboard.tsx` | parseJournalEntries で不正 taskId をスキップ |
| 2 | `skills/cmux-team/manager/dashboard.tsx` | buildJournalRows で防御的フィルタ追加 |
| 3 | `skills/cmux-team/manager/main.ts` | status コマンドの taskId 表示を防御 |
| 4 | `skills/cmux-team/manager/daemon.ts` | handleConductorDone で taskId undefined 時にエラーログ |
| 5 | `.team/logs/manager.log` | 不正ログ行の削除（sed） |

## 変更順序と具体的な変更内容

### Step 1: dashboard.tsx — isValidTaskId ヘルパー追加 + parseJournalEntries 修正

**追加（L199 の `parseJournalEntries` 関数の直前）:**

```typescript
function isValidTaskId(id: string): boolean {
  return id !== "" && id !== "?" && id !== "undefined";
}
```

**変更（parseJournalEntries 内 L199-231）:**

各イベント分岐で `result.push` の前に `if (!isValidTaskId(taskId)) continue;` を追加する。4箇所すべてに適用:

```typescript
    if (event === "task_received") {
      const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
      if (!isValidTaskId(taskId)) continue;  // ← 追加
      const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
      result.push({ time, icon: nerdIcon("\uf055", "[+]"), taskId, message: title, level: "info", iconColor: CYAN });
    } else if (event === "conductor_started") {
      const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
      if (!isValidTaskId(taskId)) continue;  // ← 追加
      const surface = detail.match(/surface=surface:(\S+)/)?.[1] ?? "";
      const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
      result.push({ ... });
    } else if (event === "task_completed") {
      const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
      if (!isValidTaskId(taskId)) continue;  // ← 追加
      ...
    } else if (event === "task_aborted") {
      const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
      if (!isValidTaskId(taskId)) continue;  // ← 追加
      ...
    }
```

### Step 2: dashboard.tsx — buildJournalRows に防御フィルタ (L464-477)

二重防御として、entries を filter してから map する。

**変更（L468）:**

```typescript
// before
  return entries.map((entry) => {

// after
  return entries.filter((e) => isValidTaskId(e.taskId)).map((entry) => {
```

### Step 3: main.ts — status コマンド (L614)

taskId が undefined/"undefined"/falsy の場合に "---" を表示する。

**変更（L614）:**

```typescript
// before
      console.log(`  ● [${c.surface.replace("surface:", "")}]  T${c.taskId}${title}`);

// after
      const tid = c.taskId && c.taskId !== "undefined" ? `T${c.taskId}` : "---";
      console.log(`  ● [${c.surface.replace("surface:", "")}]  ${tid}${title}`);
```

### Step 4: daemon.ts — handleConductorDone (L715-726)

conductor.taskId が undefined の場合はエラーログに切り替え、`task_id=undefined` がログに書き込まれないようにする。

**変更（L721-726）:**

```typescript
// before
  await log(
    "task_completed",
    `task_id=${conductor.taskId} surface=${conductor.surface}${
      conductor.taskTitle ? ` title=${conductor.taskTitle}` : ""
    }${journalSummary ? ` journal_summary=${journalSummary}` : ""}`
  );

// after
  if (!conductor.taskId || conductor.taskId === "undefined") {
    await log(
      "error",
      `handleConductorDone: conductor.taskId is undefined surface=${conductor.surface}`
    );
  } else {
    await log(
      "task_completed",
      `task_id=${conductor.taskId} surface=${conductor.surface}${
        conductor.taskTitle ? ` title=${conductor.taskTitle}` : ""
      }${journalSummary ? ` journal_summary=${journalSummary}` : ""}`
    );
  }
```

### Step 5: manager.log クリーンアップ

プロジェクトルート（worktree ではなく元リポジトリ）の `.team/logs/manager.log` から `task_id=undefined` を含む行を削除する。

```bash
sed -i '' '/task_id=undefined/d' /Users/yamamoto/git/cmux-team/.team/logs/manager.log
```

**注意**: この操作は worktree 内ではなく、元リポジトリの `.team/` に対して実行する。worktree 内に `.team/` は存在しない。

## テスト方法

1. **ビルド確認**: `cd skills/cmux-team/manager && bun build ./main.ts --outdir=./dist --target=bun` が成功すること
2. **動作確認**: `cmux-team start` → Dashboard の Journal に `Tundefined` が表示されないこと
3. **status 確認**: `cmux-team status` で taskId 未設定の Conductor が `---` 表示になること
4. **ログ確認**: `grep task_id=undefined .team/logs/manager.log` が 0 件であること
