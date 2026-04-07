# 実装計画: タスクフォルダ集約

## 目的

Conductor が生成するプロンプト・出力を「タスクフォルダ」に集約する。
現在 `.team/prompts/{taskRunId}.md` と `.team/output/{taskRunId}/` に分散しているファイルを、タスクディレクトリの `runs/` 配下にまとめる。

## 新構造

```
.team/tasks/{NNN}-{slug}/
├── task.md
└── runs/
    └── {taskRunId}/
        ├── conductor-prompt.md
        └── summary.md
```

## 後方互換

- 既存 `.md` フラットタスクはそのまま読める（`loadTasks` がハイブリッド対応）
- 旧 `.team/prompts/` `.team/output/` のファイルは削除しない
- `task-state.json` は変更なし

## 実装ステップ

### Step 1: schema.ts — TaskMeta に taskDir 追加

**ファイル**: `skills/cmux-team/manager/schema.ts`（変更なし — TaskMeta は schema.ts ではなく task.ts に定義）

**ファイル**: `skills/cmux-team/manager/task.ts` L9-20 の `TaskMeta` interface

**変更内容**:
- `taskDir?: string` フィールドを追加（ディレクトリ構造タスクの場合にディレクトリパスが入る）

```typescript
export interface TaskMeta {
  id: string;
  title: string;
  status: string;
  priority: string;
  dependsOn: string[];
  runAfterAll: boolean;
  filePath: string;
  fileName: string;
  createdAt: string;
  baseBranch?: string;
  taskDir?: string;  // 追加: フォルダ構造の場合のディレクトリパス
}
```

---

### Step 2: task.ts — loadTasks() のハイブリッド化

**ファイル**: `skills/cmux-team/manager/task.ts` L109-135 の `loadTasks()`

**変更内容**:
- `readdir` の結果をループする際、`.md` ファイルだけでなくディレクトリも処理する
- `stat` でファイル/ディレクトリを判別
- ディレクトリの場合は `{dir}/task.md` を読んで `parseTaskMeta` に渡す
- `parseTaskMeta` の戻り値に `taskDir` をセット

```typescript
export async function loadTasks(projectRoot: string): Promise<{
  tasks: TaskMeta[];
  taskState: TaskStateMap;
}> {
  const tasksDir = join(projectRoot, ".team/tasks");
  const taskState = await loadTaskState(projectRoot);
  const tasks: TaskMeta[] = [];

  if (existsSync(tasksDir)) {
    const files = await readdir(tasksDir);
    for (const f of files) {
      const fullPath = join(tasksDir, f);
      const s = await stat(fullPath);

      let meta: TaskMeta | null = null;

      if (s.isDirectory()) {
        // 新形式: ディレクトリ → {dir}/task.md を読む
        const taskMdPath = join(fullPath, "task.md");
        if (existsSync(taskMdPath)) {
          const content = await readFile(taskMdPath, "utf-8");
          meta = parseTaskMeta(content, f, taskMdPath);
          if (meta) {
            meta.taskDir = fullPath;
          }
        }
      } else if (f.endsWith(".md")) {
        // 旧形式: フラットファイル
        const content = await readFile(fullPath, "utf-8");
        meta = parseTaskMeta(content, f, fullPath);
      }

      if (meta) {
        if (taskState[meta.id]) {
          meta.status = taskState[meta.id]!.status;
        }
        tasks.push(meta);
      }
    }
  }

  return { tasks, taskState };
}
```

**import 追加**: `stat` を `fs/promises` から追加（`import { readdir, readFile, writeFile, rename, stat } from "fs/promises";`）

---

### Step 3: main.ts — cmdCreateTask() のフォルダ作成

**ファイル**: `skills/cmux-team/manager/main.ts` L1165-1276 の `cmdCreateTask()`

**変更内容**:
1. **maxId 算出**（L1228-1235）: ディレクトリ名からも数値抽出（現状 `parseInt(f, 10)` がファイル/ディレクトリ両方で動作するため変更不要。`013-some-task.md` と `013-some-task/` 両方とも `parseInt("013...")` → `13`）
2. **ファイル作成部分**（L1238-1257）: フラットファイル → ディレクトリ + task.md に変更
3. **TASK_CREATED メッセージの taskFile**（L1269）: 新パスに更新
4. **コンソール出力**（L1274）: 新パスに更新

```typescript
// 変更前:
const fileName = `${newId}-${slug}.md`;
const filePath = join(tasksDir, fileName);
// ...
await writeFile(filePath, content);

// 変更後:
const dirName = `${newId}-${slug}`;
const taskDir = join(tasksDir, dirName);
await mkdir(taskDir, { recursive: true });
const filePath = join(taskDir, "task.md");
// ...
await writeFile(filePath, content);
```

TASK_CREATED メッセージと console.log のパス更新:
```typescript
// 変更前:
const relPath = `.team/tasks/${fileName}`;

// 変更後:
const relPath = `.team/tasks/${dirName}/task.md`;
```

---

### Step 4: template.ts — プロンプト出力先の変更

**ファイル**: `skills/cmux-team/manager/template.ts` L64-98 の `generateConductorTaskPrompt()`

**変更内容**:
- 新しいオプション引数 `taskDir?: string` を追加
- `taskDir` がある場合: `{taskDir}/runs/{taskRunId}/conductor-prompt.md` に出力
- `taskDir` がない場合（旧タスク）: 従来通り `.team/prompts/{taskRunId}.md` に出力

```typescript
export async function generateConductorTaskPrompt(
  projectRoot: string,
  taskRunId: string,
  taskId: string,
  taskContent: string,
  worktreePath: string,
  outputDir: string,
  baseBranch?: string,
  taskDir?: string          // 追加
): Promise<string> {
  const templateDir = findTemplateDir();
  if (!templateDir || !existsSync(join(templateDir, "conductor-task.md"))) {
    throw new Error(
      "Conductor task template not found. npm install -g cmux-team を実行してください"
    );
  }

  let promptFile: string;
  if (taskDir) {
    // 新形式: タスクフォルダ内の runs/ に出力
    const runDir = join(taskDir, "runs", taskRunId);
    await mkdir(runDir, { recursive: true });
    promptFile = join(runDir, "conductor-prompt.md");
  } else {
    // 旧形式: .team/prompts/ に出力
    const promptsDir = join(projectRoot, ".team/prompts");
    await mkdir(promptsDir, { recursive: true });
    promptFile = join(promptsDir, `${taskRunId}.md`);
  }

  let content = await readFile(join(templateDir, "conductor-task.md"), "utf-8");

  content = content
    .replace(/\{\{TASK_CONTENT\}\}/g, taskContent)
    .replace(/\{\{WORKTREE_PATH\}\}/g, worktreePath)
    .replace(/\{\{OUTPUT_DIR\}\}/g, join(projectRoot, outputDir))
    .replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot)
    .replace(/\{\{CONDUCTOR_ID\}\}/g, taskRunId)
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch || "main（デフォルト）");

  await writeFile(promptFile, content);
  await log("conductor_task_prompt_generated", `taskRunId=${taskRunId} path=${promptFile}`);
  return promptFile;
}
```

---

### Step 5: conductor.ts — outputDir の変更 + タスクファイル検索拡張

**ファイル**: `skills/cmux-team/manager/conductor.ts` L204-298 の `assignTask()`

**変更内容**:
1. **タスクファイル検索**（L214-225）: ディレクトリも対象にする
2. **outputDir**（L245-246）: `taskDir` があれば `{taskDir}/runs/{taskRunId}/` に変更
3. **generateConductorTaskPrompt 呼び出し**（L248-256）: `taskDir` 引数を追加

```typescript
export async function assignTask(
  conductor: ConductorState,
  taskId: string,
  projectRoot: string
): Promise<ConductorState | null> {
  try {
    const taskRunId = `task-${taskId.padStart(3, '0')}-${Math.floor(Date.now() / 1000)}`;

    // --- 1. タスクファイル検索（ハイブリッド対応） ---
    const tasksDir = join(projectRoot, ".team/tasks");
    const entries = await readdir(tasksDir);
    let taskContent: string | null = null;
    let taskDir: string | undefined;

    for (const entry of entries) {
      const id = entry.match(/^0*(\d+)/)?.[1];
      if (id !== taskId && id !== taskId.replace(/^0+/, "")) continue;

      const fullPath = join(tasksDir, entry);
      const s = await stat(fullPath);

      if (s.isDirectory()) {
        const taskMdPath = join(fullPath, "task.md");
        if (existsSync(taskMdPath)) {
          taskContent = await readFile(taskMdPath, "utf-8");
          taskDir = fullPath;
        }
      } else if (entry.endsWith(".md")) {
        taskContent = await readFile(fullPath, "utf-8");
      }
      break;
    }

    if (!taskContent) {
      await log("error", `Task file not found for ID=${taskId}`);
      return null;
    }

    const taskTitle = taskContent.match(/^title:\s*(.+)/m)?.[1]?.trim() || "unknown";
    const baseBranch = taskContent.match(/^base_branch:\s*(.+)$/m)?.[1]?.trim();

    // --- 2. git worktree 作成 --- (変更なし)

    // --- 3. Conductor プロンプト生成 ---
    let outputDir: string;
    if (taskDir) {
      // 新形式: タスクフォルダ内
      const relRunDir = join(taskDir, "runs", taskRunId).replace(projectRoot + "/", "");
      outputDir = relRunDir;
    } else {
      // 旧形式: .team/output/
      outputDir = `.team/output/${taskRunId}`;
    }
    await mkdir(join(projectRoot, outputDir), { recursive: true });

    const promptFile = await generateConductorTaskPrompt(
      projectRoot,
      taskRunId,
      taskId,
      taskContent,
      worktreePath,
      outputDir,
      baseBranch,
      taskDir       // 追加
    );

    // --- 4〜6 --- (変更なし)
  }
}
```

**import 追加**: `stat` を `fs/promises` から追加

---

## 影響範囲の確認

| 項目 | 影響 |
|------|------|
| task-state.json | 変更なし（ID ベースの管理は維持） |
| done マーカー | `outputDir` パスに含まれるため自動的に新パスに配置される |
| `resetConductor()` | `conductor.outputDir` を参照するため変更不要 |
| TASK_CREATED メッセージ | `taskFile` フィールドのパスが変わる（`schema.ts` のバリデーションは `z.string()` のため問題なし） |
| テンプレート変数 `{{OUTPUT_DIR}}` | 新パスが渡されるためテンプレート自体の変更不要 |
| `cmux-team close-task` | task-state.json ベースのため変更不要 |
| `cmux-team status` | loadTasks() 経由で読むため自動対応 |

## 実装順序（依存関係）

```
Step 1 (TaskMeta 拡張)
  └→ Step 2 (loadTasks ハイブリッド化) ← Step 1 の taskDir フィールドを使用
       └→ Step 3 (cmdCreateTask ディレクトリ作成) ← Step 2 と独立だが先に構造を作る側
       └→ Step 4 (template.ts) ← taskDir 引数追加
            └→ Step 5 (conductor.ts) ← Step 4 の新シグネチャを使用
```
