/**
 * タスクファイルのパース・依存解決
 */
import { readdir, readFile, writeFile, rename, stat, mkdir } from "fs/promises";
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
  /**
   * 排他実行。true の場合、drain 後に単独実行され、assigned の間は他の全 assignment
   * が停止する。暗黙に runAfterAll: true のセマンティクスを含む（parseTaskMeta で強制）。
   */
  exclusive: boolean;
  filePath: string;
  fileName: string;
  createdAt: string;  // ISO 8601 datetime
  baseBranch?: string;  // マージ先ブランチ（未指定時は暗黙的に main）
  taskDir?: string;  // フォルダ構造の場合のディレクトリパス
  /** タスク種別（frontmatter kind フィールド）。例: "cmux-team-update" */
  kind?: string;
  /** T229: 作成元 surface（`surface:NNN`）。frontmatter `created_by` 由来 */
  createdBy?: string;
}

export interface TaskState {
  status: string;     // "draft" | "ready" | "in_progress" | "closed" | "aborted" | "deleted"
  assignedAt?: string;  // ISO 8601 — assign 時のタイムスタンプ
  closedAt?: string;  // ISO 8601
  abortedAt?: string; // ISO 8601 — abort 時のタイムスタンプ
  deletedAt?: string; // ISO 8601 — delete 時のタイムスタンプ
  journal?: string;   // 完了時/中止時/削除時のサマリー
  /** T229: 作成元 surface（`surface:NNN`）。複数 Master のどちらが作成したかを示す。 */
  createdBy?: string;
  // resume 用情報（assignTask 時に記録）
  worktreePath?: string;    // git worktree の絶対パス
  taskRunId?: string;       // task-NNN-TIMESTAMP 形式の実行 ID
  conductorSlot?: string;   // Conductor の surface ID（例: "surface:5"）
  sessionId?: string;       // Claude セッション ID（SESSION_STARTED 後に記録）
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
  const kind = unquote(fm.match(/^kind:\s*(.+)$/m)?.[1]?.trim() ?? "");
  const createdBy = unquote(fm.match(/^created_by:\s*(.+)$/m)?.[1]?.trim() ?? "");

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

  const runAfterAllRaw = fm.match(/^run_after_all:\s*(.+)$/m)?.[1]?.trim() === "true";
  const exclusive = fm.match(/^exclusive:\s*(.+)$/m)?.[1]?.trim() === "true";
  // exclusive=true は run_after_all=true を暗黙に含む（drain 待ちセマンティクス）
  const runAfterAll = runAfterAllRaw || exclusive;

  return {
    id: id || fileName.match(/^(\d+)/)?.[1] || "",
    title,
    status,
    priority,
    dependsOn,
    runAfterAll,
    exclusive,
    filePath,
    fileName,
    createdAt,
    baseBranch: baseBranch || undefined,
    kind: kind || undefined,
    createdBy: createdBy || undefined,
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

export interface CascadeAbortResult {
  /** ready → draft に戻した子タスク ID のリスト */
  revertedChildren: string[];
}

/**
 * **呼び出し側は親が aborted/deleted に遷移した直後のみ呼ぶこと（cascade 関数内では遷移状態を検証しない）**。
 *
 * depends_on に `parentTaskId` を含む `ready` 状態の子タスクを `draft` に戻し、
 * journal に `parent_aborted: <parentTaskId>` を追記する（既存 journal は `; ` で連結）。
 *
 * - 子が `ready` の場合のみ `draft` に戻す（draft/assigned/closed/aborted/deleted は変更なし）
 * - 複数 depends_on のうち 1 つでも親が abort/deleted なら cascade 対象
 *   （呼び出し側が「自身の遷移」起点で呼ぶので、ここではその 1 親との関係のみ判定）
 * - `state` (TaskStateMap) はミュータブルに更新するため、呼び出し側で saveTaskState を呼ぶこと
 * - ログ出力は呼び出し側で行う（文脈がある呼び側に責務）
 *
 * 返り値 `revertedChildren`: draft に戻した子 ID 群（呼び出し側がログ・notify に使う）
 */
export function cascadeAbortToChildren(
  state: TaskStateMap,
  tasks: TaskMeta[],
  parentTaskId: string
): CascadeAbortResult {
  const reverted: string[] = [];
  for (const t of tasks) {
    if (!t.dependsOn.includes(parentTaskId)) continue;
    const current = state[t.id];
    if (current?.status !== "ready") continue;

    const prev = current.journal ?? "";
    const appended = `parent_aborted: ${parentTaskId}`;
    state[t.id] = {
      ...current,
      status: "draft",
      journal: prev ? `${prev}; ${appended}` : appended,
    };
    reverted.push(t.id);
  }
  return { revertedChildren: reverted };
}

/**
 * 優先度ソート（high > medium > low）
 */
export function sortByPriority(tasks: TaskMeta[]): TaskMeta[] {
  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return [...tasks].sort((a, b) => {
    const pa = order[a.priority] ?? 1;
    const pb = order[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    // 同一 priority 内は ID 昇順で決定化（exclusive 同士の順序保証にも使う）
    return a.id.localeCompare(b.id);
  });
}

/** ダッシュボード表示用: open タスクを createdAt 降順（新しい順）にソート */
export function sortOpenTasksForDisplay(tasks: TaskMeta[]): TaskMeta[] {
  return [...tasks].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/**
 * タスクをプログラム的に作成する（cmdCreateTask と daemon の双方から呼び出す共通化 API）。
 *
 * - newId の採番（既存タスクの最大 ID + 1、3 桁 zero-pad）
 * - slug 生成
 * - {PROJECT_ROOT}/.team/tasks/{NNN-slug}/task.md を書く
 * - task-state.json を更新
 * - run_after_all 競合時は throw（呼び出し側で try/catch）
 * - TASK_CREATED の postMessage は**呼ばない**（呼び出し側に委ねる）
 */
export async function createTaskProgrammatic(
  projectRoot: string,
  opts: {
    title: string;
    priority?: "high" | "medium" | "low";
    status?: string; // "draft" | "ready" | ...
    body?: string;
    baseBranch?: string;
    dependsOn?: string[];
    runAfterAll?: boolean;
    /**
     * 排他実行。暗黙に runAfterAll=true を含む（内部で強制セットされる）。
     */
    exclusive?: boolean;
    kind?: string;
    /** tasks セクションのヘッダ（i18n 用）。デフォルト "タスク内容" */
    sectionHeader?: string;
    /** T229: 作成元 surface（`surface:NNN`）。frontmatter に `created_by:` として埋め込む */
    createdBy?: string;
  },
): Promise<{ id: string; filePath: string; dirName: string; relPath: string }> {
  const title = opts.title;
  const priority = opts.priority ?? "medium";
  const status = opts.status ?? "draft";
  const body = opts.body ?? "";
  const baseBranch = opts.baseBranch ?? "";
  const dependsOn = opts.dependsOn ?? [];
  const exclusive = opts.exclusive ?? false;
  // exclusive は run_after_all を暗黙に含む
  const runAfterAll = (opts.runAfterAll ?? false) || exclusive;
  const kind = opts.kind ?? "";
  const sectionHeader = opts.sectionHeader ?? "タスク内容";

  // run_after_all 競合チェック
  // - exclusive 同士は共存可能（ID 順で drain → 順次排他実行）
  // - 非排他 run_after_all と他の未クローズ run_after_all（exclusive 含む）は競合
  if (runAfterAll) {
    const { tasks } = await loadTasks(projectRoot);
    const conflict = tasks.find(
      (t) =>
        t.runAfterAll &&
        t.status !== "closed" &&
        !(exclusive && t.exclusive),
    );
    if (conflict) {
      const err = new Error(
        `run_after_all task already exists: ${conflict.id} (${conflict.title})`,
      );
      (err as any).code = "RUN_AFTER_ALL_CONFLICT";
      (err as any).existingTaskId = conflict.id;
      throw err;
    }
  }

  // slug 生成
  let slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) slug = "task";

  const tasksDir = join(projectRoot, ".team/tasks");
  await mkdir(tasksDir, { recursive: true });

  let maxId = 0;
  try {
    const files = await readdir(tasksDir);
    for (const f of files) {
      const n = parseInt(f, 10);
      if (!isNaN(n) && n > maxId) maxId = n;
    }
  } catch {}

  const newId = String(maxId + 1).padStart(3, "0");
  const dirName = `${newId}-${slug}`;
  const taskDir = join(tasksDir, dirName);
  await mkdir(taskDir, { recursive: true });
  const filePath = join(taskDir, "task.md");

  const frontmatterLines: string[] = [
    `id: ${newId}`,
    `title: ${title}`,
    `priority: ${priority}`,
  ];
  if (baseBranch) frontmatterLines.push(`base_branch: ${baseBranch}`);
  if (runAfterAll) frontmatterLines.push(`run_after_all: true`);
  if (exclusive) frontmatterLines.push(`exclusive: true`);
  if (dependsOn.length > 0) {
    frontmatterLines.push(`depends_on: [${dependsOn.join(", ")}]`);
  }
  if (kind) frontmatterLines.push(`kind: ${kind}`);
  if (opts.createdBy) frontmatterLines.push(`created_by: ${opts.createdBy}`);
  frontmatterLines.push(`created_at: ${new Date().toISOString()}`);

  const content = `---
${frontmatterLines.join("\n")}
---

## ${sectionHeader}
${body}
`;
  await writeFile(filePath, content);

  // task-state.json 更新
  const taskState = await loadTaskState(projectRoot);
  const entry: TaskState = { status };
  if (opts.createdBy) entry.createdBy = opts.createdBy;
  taskState[newId] = entry;
  await saveTaskState(projectRoot, taskState);

  const relPath = `.team/tasks/${dirName}/task.md`;
  return { id: newId, filePath, dirName, relPath };
}
