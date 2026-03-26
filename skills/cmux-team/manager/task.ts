/**
 * タスクファイルのパース・依存解決
 */
import { readdir, readFile } from "fs/promises";
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
}

/**
 * YAML frontmatter からメタデータを抽出
 */
export function parseTaskMeta(content: string, fileName: string, filePath: string): TaskMeta | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch?.[1]) return null;

  const fm = fmMatch[1];

  const id = fm.match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const title = fm.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const status = fm.match(/^status:\s*(.+)$/m)?.[1]?.trim() ?? "ready";
  const priority = fm.match(/^priority:\s*(.+)$/m)?.[1]?.trim() ?? "medium";

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
        .map((s) => s.trim().replace(/^0+/, ""))
        .filter(Boolean);
    } else {
      // single value: 033
      dependsOn = [raw.replace(/^0+/, "")];
    }
  }

  return {
    id: id.replace(/^0+/, "") || fileName.match(/^0*(\d+)/)?.[1] || "",
    title,
    status,
    priority,
    dependsOn,
    filePath,
    fileName,
  };
}

/**
 * open/ と closed/ のタスクを読み込み
 */
export async function loadTasks(projectRoot: string): Promise<{
  open: TaskMeta[];
  closed: Set<string>;
}> {
  const openDir = join(projectRoot, ".team/tasks/open");
  const closedDir = join(projectRoot, ".team/tasks/closed");

  const open: TaskMeta[] = [];
  const closed = new Set<string>();

  // closed タスクの ID を収集
  if (existsSync(closedDir)) {
    const files = await readdir(closedDir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const id = f.match(/^0*(\d+)/)?.[1];
      if (id) closed.add(id);
    }
  }

  // open タスクを読み込み
  if (existsSync(openDir)) {
    const files = await readdir(openDir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const content = await readFile(join(openDir, f), "utf-8");
      const meta = parseTaskMeta(content, f, join(openDir, f));
      if (meta) open.push(meta);
    }
  }

  return { open, closed };
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
