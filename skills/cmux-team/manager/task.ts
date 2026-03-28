/**
 * タスクファイルのパース・依存解決
 */
import { readdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

export interface TaskMeta {
  id: string;
  title: string;
  status: string;
  priority: string;
  dependsOn: string[];
  filePath: string;
  fileName: string;
  createdAt: string;  // ISO 8601 datetime
}

export interface TaskState {
  status: string;     // "draft" | "ready" | "in_progress" | "closed"
  closedAt?: string;  // ISO 8601
  journal?: string;   // 完了時のサマリー
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

  return {
    id: id || fileName.match(/^(\d+)/)?.[1] || "",
    title,
    status,
    priority,
    dependsOn,
    filePath,
    fileName,
    createdAt,
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
  } catch {
    return {};
  }
}

/**
 * task-state.json の書き込み
 */
export async function saveTaskState(projectRoot: string, state: TaskStateMap): Promise<void> {
  const filePath = join(projectRoot, ".team/task-state.json");
  await writeFile(filePath, JSON.stringify(state, null, 2) + "\n");
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
      if (!f.endsWith(".md")) continue;
      const filePath = join(tasksDir, f);
      const content = await readFile(filePath, "utf-8");
      const meta = parseTaskMeta(content, f, filePath);
      if (meta) {
        // task-state.json の状態で上書き（後方互換: なければファイルの frontmatter 値を使用）
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
 * 優先度ソート（high > medium > low）
 */
export function sortByPriority(tasks: TaskMeta[]): TaskMeta[] {
  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return [...tasks].sort(
    (a, b) => (order[a.priority] ?? 1) - (order[b.priority] ?? 1)
  );
}
