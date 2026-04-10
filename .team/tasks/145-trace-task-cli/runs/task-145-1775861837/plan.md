# 実装計画: T145 trace-task CLI + スキル

## 概要

既存の `cmux-team trace` コマンドを `cmux-team trace-task` に置き換え、タスク単位のセッション履歴を分析しやすい形式で表示する。加えて、スキル（`skills/trace-task/SKILL.md`）とコマンド（`commands/trace-task.md`）を新設し、Claude セッション内から「T141 を分析して」等の自然言語やスラッシュコマンドでタスク履歴にアクセスできるようにする。

## 変更ファイル一覧

| # | ファイル | 変更内容 |
|---|---------|---------|
| 1 | `skills/cmux-team/manager/main.ts` | `cmdTrace()` → `cmdTraceTask()` にリネーム、出力フォーマット刷新、`case "trace"` → `case "trace-task"` に変更、冒頭 usage コメント更新 |
| 2 | `skills/cmux-team/manager/i18n.ts` | `help_trace` → `help_trace_task` にリネーム、ヘルプテキスト内容を trace-task 用に更新（en + ja）、`help_main` の trace 行を trace-task に更新 |
| 3 | `skills/trace-task/SKILL.md` | 新規作成 — タスク履歴分析スキル |
| 4 | `commands/trace-task.md` | 新規作成 — `/trace-task T141` コマンド |

## 実装手順

### Step 1: i18n.ts のヘルプテキスト更新

**ファイル**: `skills/cmux-team/manager/i18n.ts`

1. `help_trace` キーを `help_trace_task` にリネーム（en: 370行目、ja: 833行目）
2. ヘルプテキスト内容を以下に変更:

```
cmux-team trace-task -- display session history for a task

Usage:
  cmux-team trace-task <task-id> [options]

Options:
  --summary              show summary mode (stub for future)

Examples:
  cmux-team trace-task 141
  cmux-team trace-task 141 --summary
```

日本語版も同様に更新。

3. `help_main`（en: 476-478行目、ja: 939-941行目）の trace 関連3行を以下1行に置換:

```
  cmux-team trace-task <task-id>              display session history for a task
```

日本語版:

```
  cmux-team trace-task <task-id>              タスクのセッション履歴を表示
```

### Step 2: main.ts の cmdTrace → cmdTraceTask リファクタ

**ファイル**: `skills/cmux-team/manager/main.ts`

1. **冒頭 usage コメント**（1-22行目）: `trace` 関連行を以下に変更:
   ```
   *   ./main.ts trace-task <task-id> [--summary]     display session history for a task
   ```

2. **switch 文**（2048行目）: `case "trace":` → `case "trace-task":` に変更

3. **関数リネーム**: `cmdTrace()` → `cmdTraceTask()` にリネーム（1763行目）

4. **`cmdTraceTask()` の実装を書き換え**（1763-1823行目）:

   ```typescript
   async function cmdTraceTask(): Promise<void> {
     if (hasHelpFlag()) showHelp(t("help_trace_task"));

     // task-id は第1引数（args[1]）またはフラグから取得
     const taskId = args[1] || getArg("task-id") || getArg("task");
     if (!taskId) {
       console.error("Error: task ID is required");
       console.error("Usage: cmux-team trace-task <task-id>");
       process.exit(1);
     }

     // タスクタイトルを取得
     const { tasks, taskState } = await loadTasks(PROJECT_ROOT);
     const taskMeta = tasks.find(t => t.id === taskId);
     const title = taskMeta?.title ?? "(unknown)";

     // task-state.json から taskRunId と worktreePath を取得
     const state = taskState[taskId];
     const taskRunId = state?.taskRunId ?? "-";
     const worktreePath = state?.worktreePath;

     console.log(`Task T${taskId}: ${title}`);
     console.log(`Run: ${taskRunId}`);
     if (worktreePath) {
       // 相対パス表示（PROJECT_ROOT からの相対）
       const rel = worktreePath.startsWith(PROJECT_ROOT)
         ? worktreePath.slice(PROJECT_ROOT.length + 1)
         : worktreePath;
       console.log(`Worktree: ${rel}`);
     }
     console.log();

     // DB からセッション取得
     const db = initDB(PROJECT_ROOT);
     const sessions = getSessionsForTask(db, taskId);
     db.close();

     if (sessions.length === 0) {
       console.log("No sessions found.");
       return;
     }

     console.log("Sessions:");
     for (const s of sessions) {
       const role = (s.role ?? "-").padEnd(12);
       const sid = s.session_id ? s.session_id.slice(0, 8) : "--------";
       const surface = s.surface ? `surface:${s.surface.replace("surface:", "")}` : "-";

       // JSONL パス導出と行数カウント
       let jsonlPath = "-";
       let lineCount = "-";
       if (s.worktree_path && s.session_id) {
         const jsonlDir = deriveJsonlDir(s.worktree_path);
         const fullPath = join(jsonlDir, `${s.session_id}.jsonl`);
         if (existsSync(fullPath)) {
           jsonlPath = fullPath.replace(process.env.HOME ?? "~", "~");
           try {
             const content = await readFile(fullPath, "utf-8");
             const lines = content.split("\n").filter(l => l.trim()).length;
             lineCount = `${lines} lines`;
           } catch {
             lineCount = "? lines";
           }
         }
       }

       console.log(`  ${role} ${sid}  ${surface.padEnd(12)}  ${lineCount.padEnd(10)}  ${jsonlPath}`);
     }

     // --summary スタブ
     if (getArg("summary") !== undefined || args.includes("--summary")) {
       console.log("\n(summary mode is not yet implemented)");
     }
   }
   ```

### Step 3: スキル作成 — `skills/trace-task/SKILL.md`

**新規ファイル**: `skills/trace-task/SKILL.md`

```markdown
---
name: trace-task
description: >
  タスクのセッション履歴を分析するスキル。
  Triggers: 「T141 を分析」「タスクの履歴を見せて」「セッション履歴」
  「trace task」「タスクのログ」「何が起きたか確認」等の発言。
---

# trace-task: タスクセッション履歴分析

タスクに関連した全セッション（Conductor + Agent）の情報を追跡・分析する。

## 手順

### 1. セッション一覧の取得

```bash
cmux-team trace-task <task-id>
```

出力例:
```
Task T141: SESSION_CLEAR で running Conductor のステータスをリセットする
Run: task-141-1775852524
Worktree: .worktrees/task-141-1775852524

Sessions:
  conductor    a87d71b5  surface:125   54 lines   ~/.claude/projects/.../a87d71b5.jsonl
  impl         1ad0d40a  surface:136   77 lines   ~/.claude/projects/.../1ad0d40a.jsonl
  inspector    xxxxxxxx  surface:137   45 lines   ~/.claude/projects/.../xxxxxxxx.jsonl
```

### 2. JSONL の分析

セッション一覧から JSONL パスを取得し、`Read` ツールで内容を確認する。

JSONL の各行は JSON オブジェクトで、主要フィールド:
- `type`: メッセージタイプ（`human`, `assistant`, `tool_use`, `tool_result` 等）
- `message.content`: メッセージ内容
- `timestamp`: タイムスタンプ

**大きな JSONL は `offset` + `limit` で範囲指定して読むこと。**

### 3. 分析観点

- **タイムライン**: 各セッションの開始・終了時刻、所要時間
- **エラー**: エラーメッセージ、リトライ、失敗パターン
- **判断**: Agent がどのような判断を下したか
- **成果物**: 生成されたファイル、コミット
```

### Step 4: コマンド作成 — `commands/trace-task.md`

**新規ファイル**: `commands/trace-task.md`

```markdown
---
allowed-tools: Bash, Read, Glob, Grep
description: "タスクのセッション履歴を取得・分析する"
---

# /trace-task

タスクに関連した全セッション（Conductor + Agent）の履歴を取得し分析する。

## 引数

`$ARGUMENTS` にタスク ID を指定する（例: `T141`, `141`）。

## 手順

1. タスク ID を `$ARGUMENTS` から抽出（T プレフィックスがあれば除去）
2. CLI でセッション一覧を取得:
   ```bash
   cmux-team trace-task <task-id>
   ```
3. 出力された JSONL パスを `Read` ツールで開き、内容を分析
4. タイムライン・エラー・判断・成果物を要約して報告

## 注意

- JSONL ファイルは大きい場合があるため、`offset` + `limit` で必要な範囲だけ読む
- 全行を一度に読もうとしないこと
```

## リスク・注意点

1. **既存の `cmux-team trace` を使っているスクリプトやドキュメント**: `trace` → `trace-task` への変更で壊れる可能性。ただし trace コマンドは主に手動実行であり、daemon や他のコード内部で `cmdTrace` を呼び出している箇所はない（switch 文の `case "trace":` のみ）。リスクは低い。

2. **JSONL 行数カウントのパフォーマンス**: `readFile` で全体を読んで行数をカウントする。JSONL が巨大な場合にメモリと時間を消費する可能性がある。ただしセッション数は通常少数（3-5個）であり、各 JSONL も数百行程度のため実用上問題なし。将来的に `wc -l` や stream で最適化可能。

3. **タスクが task-state.json にない場合**: `loadTasks` でタスクファイルが見つからない場合、タイトルが "(unknown)" になる。closed/archived タスクでもタスクファイル自体は残っているため問題は起きにくいが、削除済みタスクでは発生しうる。DB のセッション情報は表示可能。

4. **docs/spec/ の更新は本タスクのスコープ外**: 仕様書の同期は別途 dockeeper タスクで行う。

5. **plugin.json / marketplace.json の更新**: 新スキル `trace-task` を追加する場合、`.claude-plugin/plugin.json` の skills 配列への追加が必要になる可能性がある。Implementer は確認すること。
