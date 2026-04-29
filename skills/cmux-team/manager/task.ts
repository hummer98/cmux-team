/**
 * タスクファイルのパース・依存解決
 */
import { readdir, readFile, writeFile, rename, stat, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, basename } from "path";
import { log } from "./logger";
import { Deliverable } from "./schema";
import type { Deliverable as DeliverableT } from "./schema";

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
  /** タスク種別（frontmatter kind フィールド）。旧アーカイブ互換のため読み取りのみ維持。 */
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
  /**
   * T295: 納品方式（closed 時のみ set）。discriminated union で kind ごとに
   * 必須フィールドが異なる。旧 closed 行は undefined のまま読める（後方互換）。
   * schema.ts の `Deliverable` を参照。
   */
  deliverable?: DeliverableT;
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
 * T254: 同一 taskId が複数 Conductor に assign されている不変条件違反を表す。
 * `surfaces` は違反に関与した全 Conductor の surface（例: `["surface:5", "surface:7"]`）。
 */
export interface UniqueViolation {
  taskId: string;
  surfaces: string[];
}

/**
 * T254: runtime 用 unique 検査。
 * 対象 taskId が既に他 Conductor に assigned でないかを判定する。
 *
 * - `taskState[taskId]?.status === "assigned"` かつ `conductorSlot` が
 *   `conductorSurface` と異なる場合のみ `{ conflict: true, existingSurface }` を返す。
 * - `conductorSlot` が未設定（legacy データ・初期状態）は conflict=false を返す。
 *   false positive を避けるため。
 */
export function findAssignmentConflict(
  taskState: TaskStateMap,
  taskId: string,
  conductorSurface: string,
): { conflict: boolean; existingSurface?: string } {
  const entry = taskState[taskId];
  if (!entry) return { conflict: false };
  if (entry.status !== "assigned") return { conflict: false };
  const existing = entry.conductorSlot;
  if (!existing) return { conflict: false };
  if (existing === conductorSurface) return { conflict: false };
  return { conflict: true, existingSurface: existing };
}

/**
 * T254: 起動時の unique 整合性チェック。
 * team.json.conductors × task-state.json の cross-check で、
 * 同一 taskId を複数 surface が主張する状況を検出する。
 *
 * 検査ロジック:
 * 1. team.json.conductors を走査して同一 taskId を持つ surface をグルーピング。
 *    グループサイズ >= 2 は violation。
 * 2. task-state.json の assigned エントリで `conductorSlot=S_A` が設定されており、
 *    かつ team.json.conductors に `{surface: S_B, taskId: X}` (S_A !== S_B) が存在する場合、
 *    同一 taskId に対して異なる surface を主張する cross-source 不一致 → violation。
 *    (R3: conductorSlot が team.json に一切現れない「stale slot」は既存の
 *    resume_marked_aborted / conductor_taskid_reconciled 経路に委ねるため検出しない)
 */
export function detectStartupUniqueViolations(
  taskState: TaskStateMap,
  conductorsFromTeamJson: Array<{ surface: string; taskId?: string }>,
): UniqueViolation[] {
  const violationMap = new Map<string, Set<string>>();

  // 1. team.json.conductors で同一 taskId をグルーピング
  const taskToSurfaces = new Map<string, string[]>();
  for (const c of conductorsFromTeamJson) {
    if (!c.taskId) continue;
    const arr = taskToSurfaces.get(c.taskId) ?? [];
    arr.push(c.surface);
    taskToSurfaces.set(c.taskId, arr);
  }
  for (const [taskId, surfaces] of taskToSurfaces.entries()) {
    if (surfaces.length >= 2) {
      const set = violationMap.get(taskId) ?? new Set<string>();
      for (const s of surfaces) set.add(s);
      violationMap.set(taskId, set);
    }
  }

  // 2. task-state.json × team.json cross-check
  //    conductorSlot=S_A が設定されており、team.json.conductors に
  //    {surface: S_B, taskId: X} が存在し S_A !== S_B なら violation
  for (const [taskId, entry] of Object.entries(taskState)) {
    if (entry.status !== "assigned") continue;
    const slot = entry.conductorSlot;
    if (!slot) continue;
    const surfacesInTeam = taskToSurfaces.get(taskId) ?? [];
    for (const s of surfacesInTeam) {
      if (s !== slot) {
        const set = violationMap.get(taskId) ?? new Set<string>();
        set.add(slot);
        set.add(s);
        violationMap.set(taskId, set);
      }
    }
  }

  const result: UniqueViolation[] = [];
  for (const [taskId, surfaces] of violationMap.entries()) {
    result.push({ taskId, surfaces: [...surfaces].sort() });
  }
  return result;
}

// ---- T264: resume 不可検出 + journal 生成 ---------------------------------

/**
 * T264: cmdStart 起動時の resume 可否分類。
 * - `resume`: sessionId / taskRunId / worktreePath 全て揃い、worktree が実在する
 * - `abort`: いずれかが欠落している（reason で原因を区別）
 *
 * 検証順序は `no_session_id` → `no_task_run_id` → `no_worktree` の固定優先順位で、
 * 最初に欠落した要素を reason として返す。
 */
export type ResumeClassification =
  | { kind: "resume" }
  | { kind: "abort"; reason: "no_worktree" | "no_session_id" | "no_task_run_id" };

/**
 * 起動時、assigned タスクが resume 可能か判定する pure function。
 * exists はテスト注入用（デフォルト `existsSync`）。
 */
export function classifyResumeAction(
  ts: TaskState,
  exists: (p: string) => boolean = existsSync,
): ResumeClassification {
  if (!ts.sessionId) return { kind: "abort", reason: "no_session_id" };
  if (!ts.taskRunId) return { kind: "abort", reason: "no_task_run_id" };
  if (!ts.worktreePath || !exists(ts.worktreePath)) {
    return { kind: "abort", reason: "no_worktree" };
  }
  return { kind: "resume" };
}

/**
 * T264: resume 不可で aborted 化するタスクの journal を生成する。
 *
 * - runs ディレクトリパスは相対（`.team/tasks/<slug>/runs/<taskRunId>/`）で埋める
 * - 単一ファイル形式（legacy flat task.md）は runs ディレクトリが構造上存在しないため
 *   `(runs dir not found — legacy flat task file)` と代替表記
 * - `taskFile` が undefined（`.team/tasks/<slug>/` ごと消失）は `<unknown>` を埋める
 */
export function buildResumeAbortJournal(
  taskFile: string | undefined,
  ts: TaskState,
  reason: "no_worktree" | "no_session_id" | "no_task_run_id",
): string {
  const taskRunId = ts.taskRunId ?? "unknown";
  let artifactsPath: string;
  if (taskFile && taskFile.endsWith("/task.md")) {
    const slug = basename(dirname(taskFile));
    artifactsPath = `.team/tasks/${slug}/runs/${taskRunId}/`;
  } else if (taskFile) {
    artifactsPath = "(runs dir not found — legacy flat task file)";
  } else {
    artifactsPath = `.team/tasks/<unknown>/runs/${taskRunId}/`;
  }
  const summary = reason === "no_worktree"
    ? "lost worktree"
    : reason === "no_session_id"
    ? "missing session id"
    : "missing task run id";
  return `[resume] ${summary} (taskRunId=${taskRunId}). artifacts preserved at ${artifactsPath}`;
}

/**
 * T267: タスク ID を 3 桁ゼロパディングへ正規化する。
 *
 * 新規 ID は `createTaskProgrammatic` が `String(n).padStart(3, "0")` で発行するため、
 * CLI 経由の `--depends-on` も同一形式へ揃えないと frontmatter の `depends_on` が
 * `closedIds.has(...)` 比較で取りこぼされる（issue #25）。
 *
 * - 10 進整数文字列のみ受け付ける（`0x10` / `1.5` / `-1` / `+1` / `1e2` は reject）
 * - `1` 以上を要求（`0` / `000` は reject — 新規 ID は 1 始まり）
 * - 4 桁以上はそのまま（`padStart` の minLength 仕様と一致）
 */
export function normalizeTaskId(raw: string): string {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(
      `--depends-on must be positive integer task IDs. Got: "${raw}"`,
    );
  }
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(
      `--depends-on must be positive integer task IDs. Got: "${raw}"`,
    );
  }
  return String(n).padStart(3, "0");
}

/**
 * T267: カンマ区切りのタスク ID 文字列を正規化済み配列へ変換する。
 *
 * - 空文字・カンマのみ・末尾カンマは `[]` を返す（update-task の「依存クリア」経路を維持）
 * - 順序・重複はそのまま保持（dedup しない）
 * - いずれか 1 要素でも invalid なら最初の invalid で throw
 */
export function normalizeTaskIdList(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeTaskId);
}

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
 *
 * T295: 各 entry の `deliverable` フィールドに対して `Deliverable.safeParse` を
 * 挟む。壊れた deliverable は warn ログ + 当該 entry の `deliverable` を
 * undefined に倒して継続（fail-fast しない）。旧 closed 行（deliverable
 * フィールドなし）は undefined のまま正常に読める。
 */
export async function loadTaskState(projectRoot: string): Promise<TaskStateMap> {
  const filePath = join(projectRoot, ".team/task-state.json");
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf-8")) as TaskStateMap;
    for (const [taskId, entry] of Object.entries(parsed)) {
      if (entry && typeof entry === "object" && "deliverable" in entry && entry.deliverable !== undefined) {
        const result = Deliverable.safeParse(entry.deliverable);
        if (!result.success) {
          await log(
            "deliverable_parse_failed",
            `task_id=${taskId} error=${result.error.message.replace(/\s+/g, " ").slice(0, 200)}`,
          );
          entry.deliverable = undefined;
        } else {
          entry.deliverable = result.data;
        }
      }
    }
    return parsed;
  } catch (e: any) {
    await log("error", `loadTaskState parse failed: ${e.message}`);
    return {};
  }
}

/**
 * T295: Deliverable を人間可読表記に整形する。
 *
 * - `short`: リスト一覧用（dashboard buildTaskRow の suffix）
 *   - `merged/abc1234` / `pr/<host>/<path>` / `files(3)` / `none`
 * - `long`: 詳細表示用（trace-task の Deliverable 行）
 *   - 複数行出力可。呼び出し側は行単位で console.log すること
 */
export function formatDeliverable(d: DeliverableT, mode: "short" | "long"): string {
  switch (d.kind) {
    case "files":
      if (mode === "short") return `files(${d.files.length})`;
      return `files:\n${d.files.map((f) => `  - ${f}`).join("\n")}`;
    case "merged":
      if (mode === "short") return `merged/${d.sha.slice(0, 7)}`;
      return `merged into ${d.branch} @ ${d.sha}`;
    case "pr":
      if (mode === "short") {
        const m = d.prUrl.match(/\/pull\/(\d+)/);
        if (m) return `pr/#${m[1]}`;
        return `pr`;
      }
      return `PR: ${d.prUrl}`;
    case "none":
      if (mode === "short") return `none`;
      return `none (see journal)`;
    default: {
      const _exhaustive: never = d;
      return String(_exhaustive);
    }
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

  // すべてのタスクを id で引けるマップ（チェーン遡及で再利用）
  const byId = new Map(tasks.map(t => [t.id, t]));

  // ready/assigned タスクが「進む見込みのない依存」(draft/aborted) を持つかを BFS で再帰判定。
  // 循環は visited で防ぐ。closed はそれ以上辿らない。byId に無い依存は無視する（既存挙動踏襲）。
  const isBlockedByDeadDep = (task: TaskMeta): boolean => {
    const visited = new Set<string>();
    const queue: string[] = [...task.dependsOn];
    while (queue.length > 0) {
      const depId = queue.shift()!;
      if (visited.has(depId)) continue;
      visited.add(depId);
      const dep = byId.get(depId);
      if (!dep) continue;
      if (dep.status === "draft" || dep.status === "aborted") return true;
      if (dep.status === "closed") continue;
      queue.push(...dep.dependsOn);
    }
    return false;
  };

  // 通常タスク（run_after_all でも、run_after_all に依存するタスクでもない）の ready + assigned 数。
  // チェーンを遡って draft/aborted に到達する場合は drain ブロッカーから除外する（T387）。
  const normalActive = tasks.filter(t =>
    !t.runAfterAll &&
    !dependsOnRunAfterAll.has(t.id) &&
    (t.status === "ready" || assignedIds.has(t.id)) &&
    !isBlockedByDeadDep(t)
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

// ---- T290: aborted 経路の journal/reason 表現統一 --------------------------

/**
 * T290: markTaskAborted が受け付ける reason 列挙。
 *
 * 6 経路（daemon.ts 4 経路 + main.ts 2 経路）と resume 3 reason を覆う。
 * journal 新 format `reason=<AbortReason>; <detail>` の `<AbortReason>` に入る値。
 */
export type AbortReason =
  | "user_clear"
  | "judgment_pending"
  | "assign_failed"
  | "disconnect_timeout"
  | "abort_task"
  | "resume_no_session_id"
  | "resume_no_task_run_id"
  | "resume_no_worktree";

export interface MarkTaskAbortedOptions {
  /** log detail `title=` 用。未指定なら出さない */
  taskTitle?: string;
  /** log detail に付加する追加 key=value（例: `kind=task` / `source=agent`）。
   *  空白・`=` を含む value は呼び出し側で正規化済みである前提 */
  extraLogFields?: Record<string, string>;
  /** テスト注入用。デフォルト `() => new Date().toISOString()` */
  now?: () => string;
}

export interface MarkTaskAbortedResult {
  /** ready → draft に戻った子 ID（`child_reverted_to_draft` は内部 emit 済み） */
  revertedChildren: string[];
  /** 実際に書き込んだ journal（呼び出し側の TUI reflection 等用） */
  journal: string;
  /** 既に closed/aborted/deleted で no-op だった場合 true。saveTaskState は呼ばれない */
  idempotentSkip?: true;
  /** 冪等 skip の理由（既存 status）。skip 時のみ埋まる */
  existingStatus?: string;
}

/**
 * T290: aborted 経路の集約ヘルパー。
 *
 * 従来 6 経路（daemon.ts 4 + main.ts 2）で手書き複製されていた
 *   load → 冪等ガード → journal 組立 → status 代入 → cascade → save → task_aborted emit → child_reverted emit
 * を 1 本に集約する。journal の on-disk 形式は `reason=<reason>; <detail>`（detail 空時は
 * `reason=<reason>;`）。log の `reason=` は同一 `reason` 引数から組み立てるため、
 * T269 の「log reason と journal prefix の乖離」は**構造的に再発不能**になる。
 *
 * **呼び出し側に残す責務:**
 * - `notifyStateChanged(source)` の発火（EventBus ポリシー「emit = mutation 元」を守るため）
 * - `TASK_UPDATED` の postMessage（abort-task CLI）
 * - worktree 削除 / pidWatcher 停止 / resetConductor（helper スコープ外）
 *
 * **journal_summary は全経路で emit（意図的）:** TUI dashboard が `journal_summary=`
 * を正規表現抽出しているため、全経路で同じキーを出すことで TUI 可視性を向上させる。
 *
 * **idempotent skip 方針:** current status が closed/aborted/deleted の場合、
 * 何も書き込まず `{ idempotentSkip: true, existingStatus }` を返す（log emit しない）。
 * 呼び出し側が必要に応じて `conductor_done_unresolved_skip` 等の context log を出す。
 */
export async function markTaskAborted(
  projectRoot: string,
  taskId: string,
  reason: AbortReason,
  detail: string,
  opts?: MarkTaskAbortedOptions,
): Promise<MarkTaskAbortedResult> {
  const now = opts?.now ?? (() => new Date().toISOString());

  // T290 D1: journal on-disk 形式 = `reason=<snake_case>; <detail>`（detail 空時は末尾 `;`）
  const journal = detail ? `reason=${reason}; ${detail}` : `reason=${reason};`;

  // T303: applyTaskEvent(ABORT) 経由。reducer が cascade_children + task_aborted_core を
  // emit し、子 shadow も apply-task-actions.ts 側で呼ばれる。
  // 循環依存 (task.ts ↔ task-state-store.ts) を避けるため dynamic import を使う。
  const { applyTaskEvent } = await import("./state-machine/task-state-store");

  const result = await applyTaskEvent(projectRoot, {
    taskId,
    event: { type: "ABORT", reason },
    ctx: { hasConductor: false, parentAborted: false },
    patch: (prev, next) =>
      next === "aborted"
        ? { merge: { abortedAt: now(), journal } }
        : {},
  });

  if (!result.committed) {
    // reducer noop = 既に terminal。冪等 skip。
    return {
      revertedChildren: [],
      journal,
      idempotentSkip: true,
      existingStatus: result.prev,
    };
  }

  // T303 R17: wrapper 側で extraLogFields を載せた `task_aborted` を別途 emit
  //            (reducer は `task_aborted_core` を emit 済み — 二重 emit しない)
  const parts: string[] = [`task_id=${taskId}`, `reason=${reason}`];
  if (opts?.taskTitle) parts.push(`title=${opts.taskTitle}`);
  parts.push(`journal_summary=${journal}`);
  if (opts?.extraLogFields) {
    for (const [k, v] of Object.entries(opts.extraLogFields)) {
      parts.push(`${k}=${v}`);
    }
  }
  await log("task_aborted", parts.join(" "));

  // T358 M1: events.jsonl 用に SpecAbortReason へマップして emit する。
  // 循環依存 (task.ts → events-writer.ts → task.ts) を避けるため dynamic import。
  try {
    const { emitEvent, mapAbortReason } = await import("./events-writer");
    await emitEvent({
      event: "task_aborted",
      task_id: taskId,
      reason: mapAbortReason(reason),
      journal_summary: journal,
    });
  } catch (e: any) {
    await log(
      "events_writer_error",
      `event=task_aborted task_id=${taskId} message=${e?.message ?? String(e)}`,
    );
  }

  for (const childId of result.revertedChildren) {
    await log(
      "child_reverted_to_draft",
      `parent=${taskId} child=${childId} reason=parent_aborted`,
    );
  }

  return { revertedChildren: result.revertedChildren, journal };
}

export interface ParsedAbortJournal {
  /** 新 format から抽出された reason、または旧 format から推定された reason。不明時 undefined */
  reason?: AbortReason | string;
  /** reason prefix を除いた人間可読部分。新/旧問わず「何が起きたか」を記述した string */
  detail?: string;
  /** 元 journal（そのまま） */
  raw: string;
}

/**
 * T290: aborted journal の best-effort parser。
 *
 * - 新 format `reason=<snake_case>; <detail>` を優先的にマッチ
 * - 旧 format prefix（user_clear: / assign_failed: / disconnect_timeout: /
 *   conductor_done_unresolved: / [resume] lost worktree / [resume] missing session id /
 *   [resume] missing task run id）を best-effort で推定
 * - どれにもマッチしない場合は `{ reason: undefined, detail: raw, raw }`
 *   （`reason=unknown` を書き込むと abort-task CLI のユーザー入力を誤誘導するため
 *    undefined のまま残す）
 */
export function parseAbortJournal(journal: string | undefined): ParsedAbortJournal {
  if (!journal) return { raw: "" };

  const newMatch = journal.match(/^reason=([a-z_]+);\s?(.*)$/s);
  if (newMatch) {
    const [, reason, detail] = newMatch;
    return { reason, detail, raw: journal };
  }

  // 旧 format prefix 推定（order は固定 — 見やすさのため）
  const legacyPrefixes: Array<[RegExp, AbortReason]> = [
    [/^user_clear: /, "user_clear"],
    [/^assign_failed: /, "assign_failed"],
    [/^disconnect_timeout: /, "disconnect_timeout"],
    [/^conductor_done_unresolved: /, "judgment_pending"],
    [/^\[resume\] lost worktree/, "resume_no_worktree"],
    [/^\[resume\] missing session id/, "resume_no_session_id"],
    [/^\[resume\] missing task run id/, "resume_no_task_run_id"],
  ];
  for (const [re, reason] of legacyPrefixes) {
    if (re.test(journal)) return { reason, detail: journal, raw: journal };
  }

  return { reason: undefined, detail: journal, raw: journal };
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
export function cascadeAbortToChildrenInPlace(
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
 * T303: 後方互換 alias。新規コードでは `cascadeAbortToChildrenInPlace` を使う。
 * 既存の呼び出し側 (task.ts:markTaskAborted など) はリネーム後もこの関数名を使い続けられる。
 */
export const cascadeAbortToChildren = cascadeAbortToChildrenInPlace;

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
 * T300: 「terminal（これ以上状態が変化しない）」状態の判定。
 * closed / aborted / deleted を同一視したい 3 箇所（scanTasks の
 * closed Set / openTasksList フィルタ / createTaskProgrammatic の
 * run_after_all 競合チェック）で共有する。
 *
 * 新しい terminal 状態を追加する場合はここに足すだけで 3 箇所が同期する。
 */
export function isTerminalStatus(status: string): boolean {
  return status === "closed" || status === "aborted" || status === "deleted";
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
        !isTerminalStatus(t.status) &&
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

  // task-state.json 更新 (T303: applyTaskEvent(CREATE) 経由。循環依存回避で dynamic import)
  const { applyTaskEvent } = await import("./state-machine/task-state-store");
  const initialStatus = (status === "ready" || status === "draft"
    ? status
    : "draft") as "draft" | "ready";
  await applyTaskEvent(projectRoot, {
    taskId: newId,
    event: { type: "CREATE" },
    ctx: {
      hasConductor: false,
      parentAborted: false,
      initialStatus,
    },
    patch: (_prev, _next) =>
      opts.createdBy
        ? { merge: { createdBy: opts.createdBy, status: initialStatus } }
        : { merge: { status: initialStatus } },
    // T358: events.jsonl の task_created.title に title を載せる。
    eventStream: { taskTitle: title },
  });

  const relPath = `.team/tasks/${dirName}/task.md`;
  return { id: newId, filePath, dirName, relPath };
}
