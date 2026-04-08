/**
 * タスクファイルのパース・依存解決
 */
import { readdir, readFile, writeFile, rename, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { log } from "./logger";

export interface TaskMeta {
  id: string;
  title: string;
  status: string;
  priority: string;
  dependsOn: string[];
  runAfterAll: boolean;
  filePath: string;
  fileName: string;
  createdAt: string;  // ISO 8601 datetime
  baseBranch?: string;  // マージ先ブランチ（未指定時は暗黙的に main）
  taskDir?: string;  // フォルダ構造の場合のディレクトリパス
}

export interface TaskState {
  status: string;     // "draft" | "ready" | "in_progress" | "closed" | "aborted" | "deleted"
  assignedAt?: string;  // ISO 8601 — assign 時のタイムスタンプ
  closedAt?: string;  // ISO 8601
  abortedAt?: string; // ISO 8601 — abort 時のタイムスタンプ
  deletedAt?: string; // ISO 8601 — delete 時のタイムスタンプ
  journal?: string;   // 完了時/中止時/削除時のサマリー
}

export type TaskStateMap = Record<string, TaskState>;

/**
 * YAML frontmatter からメタデータを抽出
 */
export function parseTaskMeta(content: string, fileName: string, filePath: string): TaskMeta | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch?.[1]) return null;

  const fm = fmMatch[1];

  const unquote = (s: string) => s.replace(/^["']|["']$/g, "");
  const id = unquote(fm.match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? "");
  const title = unquote(fm.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? "");
  const status = unquote(fm.match(/^status:\s*(.+)$/m)?.[1]?.trim() ?? "ready");
  const priority = unquote(fm.match(/^priority:\s*(.+)$/m)?.[1]?.trim() ?? "medium");
  const createdAt = unquote(fm.match(/^created_at:\s*(.+)$/m)?.[1]?.trim() ?? "");
  const baseBranch = unquote(fm.match(/^base_branch:\s*(.+)$/m)?.[1]?.trim() ?? "");

  // depends_on: [033, 034] or depends_on: 033
  let dependsOn: string[] = [];
  const depsMatch = fm.match(/^depends_on:\s*(.+)$/m);
  if (depsMatch?.[1]) {
    const raw = depsMatch[1].trim();
    if (raw.startsWith("[")) {
      // YAML array: [033, 034]
      dependsOn = raw
        .replace(/[\[\]]/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      // single value: 033
      dependsOn = [raw.trim()];
    }
  }

  const runAfterAll = fm.match(/^run_after_all:\s*(.+)$/m)?.[1]?.trim() === "true";

  return {
    id: id || fileName.match(/^(\d+)/)?.[1] || "",
    title,
    status,
    priority,
    dependsOn,
    runAfterAll,
    filePath,
    fileName,
    createdAt,
    baseBranch: baseBranch || undefined,
  };
}

/**
 * task-state.json の読み込み
 */
export async function loadTaskState(projectRoot: string): Promise<TaskStateMap> {
  const filePath = join(projectRoot, ".team/task-state.json");
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch (e: any) {
    await log("error", `loadTaskState parse failed: ${e.message}`);
    return {};
  }
}

/**
 * task-state.json の書き込み
 */
export async function saveTaskState(projectRoot: string, state: TaskStateMap): Promise<void> {
  const filePath = join(projectRoot, ".team/task-state.json");
  const tmpPath = filePath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(state, null, 2) + "\n");
  await rename(tmpPath, filePath);
}

/**
 * フラットな tasks/ からタスクを読み込み、task-state.json で状態を上書き
 */
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

/**
 * 実行可能なタスクをフィルタリング
 * - status: ready であること
 * - depends_on の全タスクが closed に存在すること
 */
export function filterExecutableTasks(
  tasks: TaskMeta[],
  closedIds: Set<string>,
  assignedIds: Set<string>
): TaskMeta[] {
  return tasks.filter((task) => {
    // status チェック
    if (task.status !== "ready") return false;

    // run_after_all タスクは通常のフィルタリングから除外
    if (task.runAfterAll) return false;

    // 既にアサイン済み
    if (assignedIds.has(task.id)) return false;

    // 依存チェック
    if (task.dependsOn.length > 0) {
      const allDepsResolved = task.dependsOn.every((dep) => closedIds.has(dep));
      if (!allDepsResolved) return false;
    }

    return true;
  });
}

/**
 * run_after_all タスクの実行可否を判定
 * 条件: 通常タスク（run_after_all でない、かつ run_after_all タスクに depends_on しているものを除く）の ready + assigned が 0
 */
export function filterRunAfterAllTasks(
  tasks: TaskMeta[],
  closedIds: Set<string>,
  assignedIds: Set<string>
): TaskMeta[] {
  // run_after_all タスクの ID セット
  const runAfterAllIds = new Set(
    tasks.filter(t => t.runAfterAll).map(t => t.id)
  );

  // run_after_all タスクに depends_on しているタスクの ID セット
  const dependsOnRunAfterAll = new Set(
    tasks.filter(t =>
      !t.runAfterAll && t.dependsOn.some(dep => runAfterAllIds.has(dep))
    ).map(t => t.id)
  );

  // 通常タスク（run_after_all でも、run_after_all に依存するタスクでもない）の ready + assigned 数
  const normalActive = tasks.filter(t =>
    !t.runAfterAll &&
    !dependsOnRunAfterAll.has(t.id) &&
    (t.status === "ready" || assignedIds.has(t.id))
  );

  if (normalActive.length > 0) return [];

  // 通常タスクが全て完了 → run_after_all タスクのうち実行可能なものを返す
  return tasks.filter(t => {
    if (!t.runAfterAll) return false;
    if (t.status !== "ready") return false;
    if (assignedIds.has(t.id)) return false;
    // 依存チェック
    if (t.dependsOn.length > 0) {
      if (!t.dependsOn.every(dep => closedIds.has(dep))) return false;
    }
    return true;
  });
}

/**
 * 優先度ソート（high > medium > low）
 */
export function sortByPriority(tasks: TaskMeta[]): TaskMeta[] {
  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return [...tasks].sort(
    (a, b) => (order[a.priority] ?? 1) - (order[b.priority] ?? 1)
  );
}

/** ダッシュボード表示用: open タスクを createdAt 降順（新しい順）にソート */
export function sortOpenTasksForDisplay(tasks: TaskMeta[]): TaskMeta[] {
  return [...tasks].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}
