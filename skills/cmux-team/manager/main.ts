#!/usr/bin/env bun
/**
 * cmux-team — マルチエージェント開発オーケストレーション
 *
 * Usage:
 *   ./main.ts start                            # daemon 起動 + Master spawn + ダッシュボード
 *   ./main.ts send TASK_CREATED --task-id 035 --task-file ...
 *   ./main.ts send SHUTDOWN
 *   ./main.ts status                           # ダッシュボード表示
 *   ./main.ts status --log 20                  # ログ末尾20行
 *   ./main.ts spawn-conductor
 *   ./main.ts spawn-agent --conductor-surface <surface> --role <role> --prompt <prompt>
 *   ./main.ts agents                           # 稼働中エージェント一覧
 *   ./main.ts kill-agent --surface <s>
 *   ./main.ts close-agent --surface <s>
 *   ./main.ts create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--depends-on <ids>] [--run-after-all]
 *   ./main.ts update-task --task-id <id> [--status <status>] [--body <text>] [--title <title>] [--depends-on <ids>]
 *   ./main.ts close-task --task-id <id> --deliverable-kind <files|merged|pr|none> [kind-specific flags] [--journal <text>] [--force]
 *   ./main.ts await-task --task-id <id> [--timeout <sec>]  # タスク完了待ち
 *   ./main.ts abort-task --task-id <id>
 *   ./main.ts restart-task --task-id <id> [--journal <text>]
 *   ./main.ts delete-task --task-id <id> [--journal <text>]
 *   ./main.ts trace-hooks [--type <T>] [--surface <s>] [--task-run <id>] [--role <r>] [--task-id <id>] [--limit <N>] [--json]
 */

import { join, dirname, basename } from "path";
import { existsSync, writeFileSync, mkdirSync, watch } from "fs";
import { homedir } from "os";
import { readFile, readdir, writeFile, mkdir, stat, unlink } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { t } from "./i18n";
import { createDaemon, initInfra, startMaster, initializeLayout, tick, updateTeamJson, updateSidebarStatus, initSourceWatcher, initFileWatcher, sleepUntilWakeup, checkUpdateAndNotify, handleMessage, normalizeSurfaceForPath, loadVersion, stopDaemon } from "./daemon";
import { resolveMarkdownViewer, startDashboard, unmountDashboard } from "./dashboard";
import { log, formatSurface } from "./logger";
import { formatExecError } from "./exec-error";
import * as cmux from "./cmux";
import { start as startProxy } from "./proxy";
import { launchConductor, resetConductor } from "./conductor";
import { createHash } from "crypto";
import { initDB, insertTaskSession, getSessionsForTask, getTaskSessions, getHookSignals, type HookSignalRecord } from "./trace-store";
import { loadTaskState, loadTasks, saveTaskState, createTaskProgrammatic, cascadeAbortToChildren, detectStartupUniqueViolations, classifyResumeAction, buildResumeAbortJournal, markTaskAborted, parseAbortJournal, normalizeTaskIdList, formatDeliverable, type TaskState, type TaskMeta } from "./task";
import { loadArtifacts, searchArtifacts, validateArtifact, addArtifact } from "./artifact";
import { runPreflight, printPreflightIssues } from "./preflight";
import { acquireOrExit, releasePidFile } from "./pidfile";
import { ensureEnvrcHookPrompt } from "./envrc-prompt";
import { checkDirenvAllowed, formatDirenvNotAllowedMessage } from "./direnv-check";
import type { QueueMessage, LayoutMode, AutoUpdateMode, SessionStartedMessage, SessionEndedMessage, NotificationMessage, Deliverable } from "./schema";
import { THROTTLE_5H_THRESHOLD, LAYOUT_MAX_CONDUCTORS, QueueMessage as QueueMessageSchema, SessionStartedMessage as SessionStartedMessageSchema, SessionEndedMessage as SessionEndedMessageSchema, NotificationMessage as NotificationMessageSchema, Deliverable as DeliverableSchema } from "./schema";
import type { TeamConfig } from "./config";
import {
  loadConfig,
  resolveLayout,
  resolveAutoUpdateMode,
  resolveFetchBeforeWorktree,
} from "./config";
import { persistRateLimit, loadRateLimit, isStale5h, isStale7d } from "./rate-limit-persistence";
import { AGENT_ROLES, normalizeAgentRole, type AgentRole } from "./schema";
import {
  readProjectInstructions,
  writeProjectInstructions,
  deleteProjectInstructions,
  listProjectInstructions,
  AGENT_INSTRUCTIONS_MAX_BYTES,
} from "./agent-instructions";
import { expandProjectInstructions } from "./template";
import { resolveOriginRepo } from "./gh-cache-repo";
import { resolveGithubToken, tokenHash } from "./gh-cache-auth";
import {
  openGhCacheDB,
  getSyncMeta,
  getCacheStats,
} from "./gh-cache-store";
import {
  syncFull,
  syncIncremental,
  RateLimitExhaustedError,
  SyncHttpError,
} from "./gh-cache-sync";
import {
  cmdIssueList,
  cmdIssueShow,
  cmdIssueSearch,
  cmdPrList,
  type CliDeps as CliDepsImport,
} from "./gh-cache-cli";

// --- プロジェクトルート検出 ---
function findProjectRoot(): string {
  // 環境変数
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;

  // .team/ を含むディレクトリを探す
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".team"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  return process.cwd();
}

/** 最新の main.ts を検索（npm グローバル → ローカル → 自分自身） */
function findLatestMainTs(): string {
  const { execFileSync } = require("child_process");

  // npm グローバルインストール先
  try {
    const npmGlobalPrefix = execFileSync("npm", ["prefix", "-g"]).toString().trim();
    const npmMainTs = join(npmGlobalPrefix, "lib/node_modules/cmux-team/skills/cmux-team/manager/main.ts");
    if (existsSync(npmMainTs)) return npmMainTs;
  } catch {}

  // ローカル
  const local = join(process.cwd(), "skills/cmux-team/manager/main.ts");
  if (existsSync(local)) return local;

  // 自分自身
  return process.argv[1] || import.meta.path;
}

// T292: `main.ts` を CLI として起動された時のみ chdir する。
// テストコードから library として import された場合は副作用を発生させない
// （import 時に `PROJECT_ROOT` env が別テストの tmp dir を指している瞬間に
//   chdir してしまい、その tmp dir が削除されると以降の cwd が無効になる事故を防ぐ）。
const PROJECT_ROOT = findProjectRoot();
process.env.PROJECT_ROOT = PROJECT_ROOT;
if (import.meta.main) {
  process.chdir(PROJECT_ROOT);
}

const execFileAsync = promisify(execFile);

// --- config ---
const DEFAULT_MODEL = "opus";

function getModelForRole(config: TeamConfig, role: "master" | "conductor" | "agent", cliOverride?: string): string {
  return cliOverride ?? config.models?.[role] ?? DEFAULT_MODEL;
}

// --- サブコマンド ---
const args = process.argv.slice(2);
const command = args[0];

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function requireArg(name: string): string {
  const val = getArg(name);
  if (!val) {
    console.error(`Error: --${name} is required`);
    process.exit(1);
  }
  return val;
}

/** --<name> （値なし）フラグの有無を判定 */
function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

/**
 * T295: `--<name> <value>` の全出現を配列として取得する。
 *
 * `close-task --deliverable-kind files --deliverable a.md --deliverable b.md` の
 * `--deliverable` のような「同一フラグを複数回指定」を受け取るために使う。
 * `--name=value` 形式は非対応（getArg と一致した非対応ポリシー）。
 */
function getMultiArg(argv: string[], name: string): string[] {
  const key = `--${name}`;
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === key && i + 1 < argv.length) {
      out.push(argv[i + 1]!);
      i++;
    }
  }
  return out;
}

/** --help / -h フラグの有無を判定 */
function hasHelpFlag(): boolean {
  return args.includes("--help") || args.includes("-h");
}

const SURFACE_REF_RE = /^surface:\d+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `--surface` 引数を `surface:NNN` ref に正規化する（T206）。
 *
 * - `surface:NNN` 形式 → そのまま返す（cmux は呼ばない）
 * - UUID 形式 → `cmux --id-format both --json tree` を呼んで逆引きする
 * - 不正形式 → throw
 *
 * UUID は cmux 出力では大文字、ユーザー入力は小文字になりがちなので、
 * 比較は `toLowerCase()` 同士で揃える。
 *
 * @throws 形式不一致 / cmux 接続失敗 / JSON parse 失敗 / 該当 surface が tree に存在しない
 */
export async function normalizeSurfaceArg(input: string): Promise<string> {
  if (SURFACE_REF_RE.test(input)) return input;
  if (!UUID_RE.test(input)) {
    throw new Error(`Invalid --surface value: ${JSON.stringify(input)} (expected "surface:NNN" or UUID)`);
  }
  const target = input.toLowerCase();
  let json: string;
  try {
    json = await cmux.tree(undefined, { json: true, idFormat: "both" });
  } catch (e: any) {
    throw new Error(`Failed to query cmux tree for UUID lookup: ${e?.message ?? e}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch (e: any) {
    throw new Error(`Failed to parse cmux tree JSON: ${e?.message ?? e}`);
  }
  for (const w of parsed?.windows ?? []) {
    for (const ws of w?.workspaces ?? []) {
      for (const p of ws?.panes ?? []) {
        for (const s of p?.surfaces ?? []) {
          const sid = typeof s?.id === "string" ? s.id.toLowerCase() : undefined;
          if (sid && sid === target) {
            const ref = s?.ref;
            if (typeof ref === "string" && SURFACE_REF_RE.test(ref)) {
              return ref;
            }
          }
        }
      }
    }
  }
  throw new Error(`UUID ${input} not found in cmux tree (workspace mismatch or surface not registered?)`);
}

/** stdin を全部読み切って文字列で返す */
async function readStdin(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

/** ヘルプテキストを表示して正常終了 */
function showHelp(text: string): never {
  console.log(text.trim());
  process.exit(0);
}

/** tasks/ からタスクファイルを検索（ID プレフィックス or frontmatter id） */
async function findTaskFile(taskId: string): Promise<string | undefined> {
  const tasksDir = join(PROJECT_ROOT, ".team/tasks");
  try {
    const files = await readdir(tasksDir);
    for (const f of files) {
      if (!f.startsWith(taskId)) continue;
      const fullPath = join(tasksDir, f);
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        const taskMdPath = join(fullPath, "task.md");
        if (existsSync(taskMdPath)) return taskMdPath;
      } else if (f.endsWith(".md")) {
        return fullPath;
      }
    }
  } catch {}
  // ファイル名が数値IDで始まらない場合、frontmatter の id でも検索
  try {
    const files = await readdir(tasksDir);
    for (const f of files) {
      const fullPath = join(tasksDir, f);
      const s = await stat(fullPath);
      let content: string | undefined;
      if (s.isDirectory()) {
        const taskMdPath = join(fullPath, "task.md");
        if (existsSync(taskMdPath)) {
          content = await readFile(taskMdPath, "utf-8");
        }
      } else if (f.endsWith(".md")) {
        content = await readFile(fullPath, "utf-8");
      }
      if (content) {
        const idMatch = content.match(/^id:\s*(.+)$/m);
        if (idMatch && idMatch[1]?.trim() === taskId) {
          if (s.isDirectory()) return join(fullPath, "task.md");
          return fullPath;
        }
      }
    }
  } catch {}
  return undefined;
}

/**
 * T291: ユーザー入力の task-id（数値 id / slug 先頭マッチ / ディレクトリ名全体）を
 * frontmatter `id:` 値（canonical id）に正規化する。
 *
 * - `findTaskFile(inputId)` で該当タスクファイルを特定
 * - frontmatter 先頭の `id: <value>` 行を読み出して canonical id を返す
 * - ファイル不在 / id 行欠落 / 読み出し失敗時は undefined
 *
 * 呼び出し側はこの返り値で `taskState[id]` / `conductor.taskId === id` /
 * `postMessage({ taskId: id })` を統一し、task-state.json に slug 入りの
 * 孤児エントリが作られる事故を防ぐ（T291）。
 */
export async function resolveCanonicalTaskId(
  inputId: string,
): Promise<string | undefined> {
  const taskFile = await findTaskFile(inputId);
  if (!taskFile) return undefined;
  try {
    const content = await readFile(taskFile, "utf-8");
    const idMatch = content.match(/^id:\s*(.+)$/m);
    const canonical = idMatch?.[1]?.trim();
    return canonical || undefined;
  } catch {
    return undefined;
  }
}

// ---- T290: aborted task の表示用 helper -----------------------------------

/**
 * T290: aborted タスクの journal を表示用に整形する。
 *
 * parseAbortJournal を使って新 format（`reason=<reason>; <detail>`）と旧 format
 * の両方を best-effort でパースし、`Task ${id} aborted [${reason}]: ${detail}`
 * 形式で返す。reason が parse できない場合は `[unknown]` を使う。
 *
 * 呼び出し側: await-task stderr (cmdAwaitTask 内 2 箇所)、printSummaries (aborted 分岐)。
 */
export function formatAbortedTaskLine(id: string, journal: string | undefined): string {
  const parsed = parseAbortJournal(journal);
  const reason = parsed.reason ?? "unknown";
  const detail = parsed.detail ?? (journal ?? "(no reason)");
  return `Task ${id} aborted [${reason}]: ${detail}`;
}

// ---- T264: cmdStart 起動時 resume 判定 wrapper -----------------------------

export interface ApplyResumeTransitionsDeps {
  findTaskFile: (taskId: string) => Promise<string | undefined>;
  exists?: (p: string) => boolean;
  now?: () => string;
}

export interface ApplyResumeTransitionsResult {
  resumePlan: Array<{
    taskId: string;
    taskRunId: string;
    worktreePath: string;
    sessionId: string;
  }>;
  /**
   * T290: abort 対象の詳細。呼び出し側（cmdStart）が loop で
   * `markTaskAborted(projectRoot, taskId, "resume_no_*", detail)` を呼ぶ。
   * applyResumeTransitions 自体は taskState を mutate しない pure-ish function。
   */
  abortTargets: Array<{
    taskId: string;
    /** markTaskAborted に渡す reason（reason=resume_* prefix 付きで journal に記録される） */
    reason: "resume_no_worktree" | "resume_no_session_id" | "resume_no_task_run_id";
    /** classifyResumeAction が返す生の reason（log resume_marked_aborted 用） */
    classifyReason: "no_worktree" | "no_session_id" | "no_task_run_id";
    /** buildResumeAbortJournal の戻り値（markTaskAborted の detail 引数として渡す） */
    detail: string;
  }>;
}

/**
 * T264 (T290 改): cmdStart 内 resume 判定ループを切り出した pure-ish wrapper。
 *
 * - taskState は **mutate しない**（T290 破壊的変更）。呼び出し側が
 *   `result.abortTargets` を loop で markTaskAborted に渡して aborted 遷移を行う
 * - cascade は markTaskAborted 内で行われるため applyResumeTransitions は
 *   cascadeAbortToChildren を呼ばない（T290 破壊的変更）
 * - emit（resume_marked_aborted / task_aborted / child_reverted_to_draft）は
 *   呼び出し側の責務。resume_marked_aborted のみ cmdStart が自前で emit し、
 *   それ以外は markTaskAborted が emit する
 * - deps.findTaskFile は detail 生成（buildResumeAbortJournal）でのみ使う
 */
export async function applyResumeTransitions(
  taskState: Record<string, TaskState>,
  _allTasks: TaskMeta[],
  deps: ApplyResumeTransitionsDeps,
): Promise<ApplyResumeTransitionsResult> {
  const exists = deps.exists ?? existsSync;

  const resumePlan: ApplyResumeTransitionsResult["resumePlan"] = [];
  const abortTargets: ApplyResumeTransitionsResult["abortTargets"] = [];

  for (const [taskId, ts] of Object.entries(taskState)) {
    if (ts.status !== "assigned") continue;
    const action = classifyResumeAction(ts, exists);

    if (action.kind === "resume") {
      resumePlan.push({
        taskId,
        taskRunId: ts.taskRunId!,
        worktreePath: ts.worktreePath!,
        sessionId: ts.sessionId!,
      });
      continue;
    }

    const taskFile = await deps.findTaskFile(taskId);
    const detail = buildResumeAbortJournal(taskFile, ts, action.reason);
    abortTargets.push({
      taskId,
      reason: `resume_${action.reason}` as ApplyResumeTransitionsResult["abortTargets"][number]["reason"],
      classifyReason: action.reason,
      detail,
    });
  }

  return { resumePlan, abortTargets };
}

async function cmdStart(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_start"));
  // cmux 環境チェック
  if (!process.env.CMUX_SOCKET_PATH) {
    console.error(t("not_in_cmux"));
    process.exit(1);
  }

  // --- preflight チェック ---
  // daemon 起動前に前提を検証し、失敗時は即 exit
  // （daemon / Master / Conductor を spawn した後で失敗すると
  //  中途半端なプロセスが残るため、spawn する前に止める）
  const preflight = await runPreflight(PROJECT_ROOT);
  if (!preflight.ok) {
    printPreflightIssues(preflight);
    process.exit(1);
  }

  // --- T259: pidfile による多重起動防止 ---
  // preflight 成功後・副作用発生前（direnv / resolveMainBranch / createDaemon）に排他を取る。
  // 既に生きている cmux-team daemon があれば console.error + exit(1) する。
  // stale pidfile（死亡プロセス or PID 再利用）は自動的に上書きされる。
  const pidFilePath = join(PROJECT_ROOT, ".team/daemon.pid");
  await acquireOrExit(pidFilePath, PROJECT_ROOT);
  await log("pidfile_acquired", `path=${pidFilePath} pid=${process.pid}`);

  // --- direnv allow fail-fast チェック ---
  // .envrc が未 allow のまま daemon を起動すると CLAUDE_CODE_OAUTH_TOKEN 等が
  // ロードされず Conductor / Agent が意図しない認証経路で立ち上がるため、
  // preflight 直後・loadConfig より前で止める。
  const direnvStatus = await checkDirenvAllowed(PROJECT_ROOT);
  if (direnvStatus === "not_allowed") {
    console.error(formatDirenvNotAllowedMessage(PROJECT_ROOT));
    await log("direnv_not_allowed", "command=start");
    process.exit(1);
  }
  if (direnvStatus === "no_direnv") {
    await log("direnv_not_found", "command=start");
    console.warn("[cmux-team] direnv が見つかりません — .envrc の環境変数は反映されません");
  }

  // layout 解決（CLI --layout > config.json > "wide"）
  const startConfig = await loadConfig(PROJECT_ROOT);
  let layout: LayoutMode;
  try {
    layout = resolveLayout(startConfig, getArg("layout"));
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  // スリープ抑止設定（CLI --no-sleep-prevention > config.json sleepPrevention > true）
  const sleepPrevention = args.includes("--no-sleep-prevention")
    ? false
    : (startConfig.sleepPrevention ?? true);

  // auto-update 設定（env CMUX_TEAM_AUTO_UPDATE > config.autoUpdate > "off"）
  let autoUpdate: { mode: AutoUpdateMode; source: "env" | "config" | "default" };
  try {
    autoUpdate = resolveAutoUpdateMode(startConfig);
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  // T213: main ブランチ解決（config > git 自動検出）。T253 で暗黙 "main" フォールバックを削除し、
  //   全て失敗時は fail-stop（process.exit(1)）する。
  //   createDaemon → initializeConductorSlots より前に解決・永続化することで
  //   Conductor 子プロセスが loadConfig する時点で config.mainBranch が必ず揃っている。
  const { resolveMainBranch, persistMainBranch, MainBranchResolutionError } =
    await import("./main-branch");
  let mainBranchResolution;
  try {
    mainBranchResolution = await resolveMainBranch(PROJECT_ROOT, {
      configMainBranch: startConfig.mainBranch,
    });
  } catch (e: any) {
    if (e instanceof MainBranchResolutionError) {
      const originEsc = (e.originHeadStderr ?? "").replace(/\n/g, "\\n").trim() || "(empty)";
      const headEsc = (e.headStderr ?? "").replace(/\n/g, "\\n").trim() || "(empty)";
      console.error(
        [
          "Error: Failed to detect the project's main branch.",
          "",
          "cmux-team は以下の順で main ブランチを解決します:",
          "  1. .team/config.json の \"mainBranch\" フィールド",
          "  2. git symbolic-ref refs/remotes/origin/HEAD",
          "  3. git symbolic-ref --short HEAD",
          "",
          "全て失敗しました。以下のいずれかで明示してください:",
          "",
          "  (A) .team/config.json に追記:",
          "      {",
          "        \"mainBranch\": \"<your-main-branch>\"",
          "      }",
          "",
          "  (B) または環境変数で一時指定:",
          "      CMUX_TEAM_MAIN_BRANCH=<your-branch> cmux-team start",
          "",
          "考えられる原因:",
          "  - 新規リポジトリで push 前 (origin/HEAD 未設定)",
          "  - shallow clone で origin/HEAD が欠落",
          "  - detached HEAD 状態",
          "  - リモートが存在しない (git remote add origin ... 未実行)",
          "",
          "診断情報:",
          `  origin/HEAD stderr: ${originEsc}`,
          `  HEAD stderr:        ${headEsc}`,
        ].join("\n"),
      );
      await log(
        "main_branch_resolve_exit",
        `reason=detect_failed origin_stderr=${originEsc} head_stderr=${headEsc}`,
      );
      process.exit(1);
    }
    throw e;
  }
  if (mainBranchResolution.source !== "config") {
    await persistMainBranch(PROJECT_ROOT, mainBranchResolution.branch);
  }
  await log(
    "main_branch_resolved",
    `branch=${mainBranchResolution.branch} source=${mainBranchResolution.source}`,
  );

  const state = await createDaemon(PROJECT_ROOT, layout);
  state.updateMode = autoUpdate.mode;
  // Step 4 で DaemonState.mainBranch を追加しているため直接代入で確定させる。
  state.mainBranch = mainBranchResolution.branch;

  // ソースファイル mtime 監視を初期化
  state.sourceMtimes = await initSourceWatcher();

  // ファイルシステム監視（tasks/, queue/ の変更で即時 tick）
  initFileWatcher(state);

  // インフラ準備
  await initInfra(state);
  await log("infra_ready");

  // T227: `.team/rate-limit.json` から前回セッションの RateLimitInfo を復元する。
  // daemon_started ログ前に復元しておくことで、dashboard 初回描画から値が出る。
  const restoredRateLimit = await loadRateLimit(PROJECT_ROOT);
  if (restoredRateLimit) {
    state.rateLimit = restoredRateLimit;
    await log(
      "rate_limit_restored",
      `unified5h=${restoredRateLimit.unified5hUtilization} unified7d=${restoredRateLimit.unified7dUtilization} stale5h=${isStale5h(restoredRateLimit)} stale7d=${isStale7d(restoredRateLimit)}`
    );
  } else {
    await log("rate_limit_restored", "empty");
  }

  // .envrc に CMUX_CLAUDE_HOOKS_DISABLED を追記するか対話確認
  // proxy 起動・TUI 起動より前で同期実行する（Ink TUI が stdin/stdout を奪うため）
  await ensureEnvrcHookPrompt(PROJECT_ROOT);

  // T192: ルート package.json からバージョンを読み込み state と daemon_started ログに記録
  state.version = await loadVersion();
  await log(
    "daemon_started",
    `${state.version} pid=${process.pid} poll=${state.pollInterval}ms max_conductors=${state.maxConductors} layout=${state.layout} sleep_prevention=${sleepPrevention}`
  );
  await log(
    "auto_update_config",
    `mode=${autoUpdate.mode} source=${autoUpdate.source}`
  );
  // T283: worktree 作成前の git fetch をデフォルト ON に反転した。起動時に
  //   現在の policy を 1 行ログとして残し、offline 環境の運用者が気付けるようにする。
  const fetchPolicy = resolveFetchBeforeWorktree();
  await log(
    "fetch_before_worktree",
    `enabled=${fetchPolicy.enabled ? "on" : "off"} source=${fetchPolicy.source}`,
  );

  // 前回のポートを記録（proxy 起動前にファイルから読む — alive チェック不要）
  let previousProxyPort: string | undefined;
  try {
    previousProxyPort = (await readFile(join(PROJECT_ROOT, ".team/proxy-port"), "utf-8")).trim();
  } catch {}

  // ロギングプロキシ起動（既存 proxy が生きていればスキップ）
  let proxyHandle: { port: number; stop: () => void } | null = null;
  const existingProxyPort = await resolveProxyPort();
  if (existingProxyPort) {
    state.proxyPort = parseInt(existingProxyPort, 10);
    await log("proxy_reused", `port=${existingProxyPort}`);
  } else {
    try {
      proxyHandle = await startProxy(PROJECT_ROOT, {
        getState: () => state,
        onMessage: async (msg) => {
          await handleMessage(state, msg);
          // T205: handleMessage 後に team.json を同期 flush する。
          // これにより「`cmux-team send X` が 200 OK を返した時点で team.json は最新」
          // の不変条件が成立し、spawn-agent → await-agent のレースが解消する。
          await updateTeamJson(state);
        },
      });
      await writeFile(join(PROJECT_ROOT, ".team/proxy-port"), String(proxyHandle.port));
      state.proxyPort = proxyHandle.port;
      await log("proxy_started", `port=${proxyHandle.port}`);
    } catch (e: any) {
      await log("proxy_start_failed", e.message);
    }
  }

  // proxy ポート変化の検出
  if (previousProxyPort && state.proxyPort && String(state.proxyPort) !== previousProxyPort) {
    state.proxyPortChanged = true;
    await log("proxy_port_changed", `prev=${previousProxyPort} new=${state.proxyPort}`);
  }

  // バージョン取得（plugin.json から — startDashboard に渡すため先に実行）
  let version: string | undefined;
  try {
    const pluginJsonPath = join(dirname(import.meta.path), "../../..", ".claude-plugin/plugin.json");
    if (existsSync(pluginJsonPath)) {
      version = JSON.parse(await readFile(pluginJsonPath, "utf-8")).version;
    }
  } catch (e: any) {
    await log("error", `version read failed: ${e.message}`);
  }

  // macOS スリープ抑止（caffeinate 管理）
  // Master/Conductor/Agent のいずれかが稼働中ならスリープを抑止し、全 idle 時は解放する。
  // 複数の cmux-team インスタンスが同時起動している場合も、各インスタンスが独立して
  // caffeinate assertion を管理するため、どれか1つがアクティブなら Mac はスリープしない。
  let caffeinateProc: { kill(): void } | null = null;
  const updateCaffeinate = (active: boolean) => {
    if (!sleepPrevention || process.platform !== "darwin") return;
    if (active && !caffeinateProc) {
      caffeinateProc = Bun.spawn(["caffeinate", "-dis"], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
    } else if (!active && caffeinateProc) {
      caffeinateProc.kill();
      caffeinateProc = null;
    }
  };

  // シグナルハンドリング（TUI 起動前に設定）
  // quit 時は proxy を停止しない（既存 Master/Conductor の接続を維持するため）
  const shutdown = async () => {
    // T234: state.running = false + 全 pidWatcher 停止をまとめて実行
    stopDaemon(state);
    state.fileWatcherAbort?.abort();
    state.fileWatcherAbort = null;
    updateCaffeinate(false);
    if (state.workspace) {
      await cmux.clearStatus("claude_code", state.workspace);
    }
    // T227: proxy 側 fire-and-forget が in-flight の可能性があるため、
    // shutdown 時に最新の rateLimit を必ず flush する（shutdown はブロック許容）
    if (state.rateLimit) {
      try {
        await persistRateLimit(PROJECT_ROOT, state.rateLimit);
      } catch (e: any) {
        await log("rate_limit_persist_failed", `shutdown: ${e.message}`);
      }
    }
    await log("daemon_stopped");
    await updateTeamJson(state);
    // T259: pidfile を最後に release（team.json 更新後、process.exit の直前）
    await releasePidFile(pidFilePath);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // --- TUI ダッシュボード早期表示 ---
  const { scheduleRefresh } = await startDashboard(() => state, {
    version,
    onReload: async () => {
      unmountDashboard();
      const latestMainTs = findLatestMainTs();
      await log("daemon_reload");
      await log("daemon_reload_target", latestMainTs);
      // T234: 再起動 exec 前に watcher を止め尽くす
      stopDaemon(state);
      state.fileWatcherAbort?.abort();
      state.fileWatcherAbort = null;
      // T259: 子 daemon が acquire できるよう親は execFileSync より前に pidfile を release する。
      // 親自身は execFileSync でブロッキングするためシグナルを受け取れず、pidfile を握り
      // 続けると子が自分自身を "alive cmux-team" と誤検知して fail-stop する。
      await releasePidFile(pidFilePath);
      const { execFileSync } = require("child_process");
      // exit 42（auto_restart）が来た場合も再起動ループを継続する（cmux-team.js と同じ挙動）
      // これがないと proxy_reused した子 daemon が auto_restart で終了した瞬間に
      // 親（onReload 呼び出し元）が process.exit(0) して proxy も道連れになる
      const MAX_RESTARTS = 10;
      let restarts = 0;
      while (restarts < MAX_RESTARTS) {
        let exitStatus = 0;
        try {
          execFileSync("bun", ["run", latestMainTs, "start"], {
            stdio: "inherit",
            env: process.env,
            cwd: process.cwd(),
          });
          break; // 正常終了
        } catch (e: any) {
          exitStatus = e.status ?? 1;
        }
        if (exitStatus === 42) {
          restarts++;
          await log("daemon_reload_restart", `restarts=${restarts}/${MAX_RESTARTS}`);
          try { execFileSync("sleep", ["1"]); } catch {}
          continue;
        }
        await log("error", `daemon reload exec failed status=${exitStatus}`);
        break;
      }
      if (restarts >= MAX_RESTARTS) {
        await log("error", "daemon reload restart limit reached");
      }
      process.exit(0);
    },
    onQuit: () => { shutdown(); },
    onFullQuit: async () => {
      await log("full_quit_requested");

      // 1. 全 Agent を close
      for (const [, conductor] of state.conductors) {
        for (const agent of conductor.agents) {
          await cmux.closeSurface(agent.surface).catch(() => {});
        }
      }

      // 2. 全 Conductor surface を close（Agent タブも含む）
      //    T207: Conductor の所属 pane を on-demand 解決し、同 pane の全 surface を一括 close
      for (const [, conductor] of state.conductors) {
        const siblings = await cmux.listSiblingSurfaces(conductor.surface, state.workspace ?? undefined);
        for (const s of siblings) {
          await cmux.closeSurface(s).catch(() => {});
        }
        await cmux.closeSurface(conductor.surface).catch(() => {});
      }

      // 3. Master surface を close（T229: 複数 Master 対応）
      for (const surface of [...state.masters.keys()]) {
        await cmux.closeSurface(surface).catch(() => {});
      }

      // 4. 閉じた surface を state から除去してから team.json を永続化する。
      //    これをやらないと次回起動の initializeLayout が存在しない surface を
      //    team.json から読んで全件 discard し、R7 方針で pane を新規作成しない
      //    ため Conductor ゼロ台で着地する（Full Quit のセマンティクスは
      //    「全部終了して次回はゼロから」なので、truth である team.json にも
      //    その事実を反映する）。
      state.conductors.clear();
      state.masters.clear();

      await log("full_quit_completed");
      // T234: 全 pidWatcher を停止してからプロセス終了
      stopDaemon(state);
      state.fileWatcherAbort?.abort();
      state.fileWatcherAbort = null;
      await updateTeamJson(state);
      // T259: pidfile を release（onFullQuit は shutdown() を通らない経路）
      await releasePidFile(pidFilePath);
      process.exit(0);
    },
  });

  // --- Conductor + Master 起動（TUI 上で進捗表示） ---

  // daemon surface / workspace 取得（CMUX_SURFACE 環境変数 → cmux identify フォールバック）
  let daemonSurface: string | undefined = process.env.CMUX_SURFACE;
  if (daemonSurface) {
    await log("daemon_surface", `${formatSurface(daemonSurface, "M")} (env)`);
    // surface が env 経由の場合も identify でworkspaceを取得
    const ws = await cmux.getCallerWorkspace();
    if (ws) {
      state.workspace = ws;
      await log("daemon_workspace", `workspace=${ws}`);
    }
  } else {
    try {
      daemonSurface = await cmux.getCallerSurface();
      await log("daemon_surface", `${formatSurface(daemonSurface, "M")} (identify)`);
    } catch (e: any) {
      await log("daemon_surface_fallback", e.message);
    }
    const ws = await cmux.getCallerWorkspace();
    if (ws) {
      state.workspace = ws;
      await log("daemon_workspace", `workspace=${ws}`);
    }
  }

  // daemon タブタイトル設定
  if (daemonSurface) {
    const num = daemonSurface.replace("surface:", "");
    await cmux.renameTab(daemonSurface, `[${num}] Manager`);
  }

  // ワークスペース名を起動フォルダ名に設定
  const folderName = basename(PROJECT_ROOT);
  await cmux.renameWorkspace(folderName, state.workspace ?? undefined);

  // --- assigned タスクの resumePlan を boot 前に構築 ---
  //   launchConductor に `{ resumeTaskId }` を渡して起動時点で
  //   `cmux-team resume <id>` をシェルに投入する（旧実装は Claude 起動後に
  //   チャット入力として消費されるバグがあった）。
  const taskState = await loadTaskState(PROJECT_ROOT);
  let taskStateModified = false;
  const rawResumePlan: Array<{
    taskId: string;
    taskRunId: string;
    worktreePath: string;
    sessionId: string;
    taskTitle?: string;
  }> = [];

  // --- T254: 起動時 unique 整合性チェック ---
  //   team.json.conductors × task-state.json の cross-check。
  //   違反 taskId は ready に戻して journal 付与、違反 surface は後段
  //   (initializeLayout 後) で resetConductor により broken に倒す。
  //   整合性チェック自体の失敗は本体起動を止めず error ログのみで続行する
  //   (A015 の「パラメータ解決失敗は fail-stop」には該当しない — 不変条件の
  //    二重防御であり、失敗時は防御が効かないだけ)。
  const violationSurfaces = new Set<string>();
  try {
    const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
    let conductorsFromTeamJson: Array<{ surface: string; taskId?: string }> = [];
    if (existsSync(teamJsonPath)) {
      const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
      conductorsFromTeamJson = (teamJson.conductors ?? []).map((c: any) => ({
        surface: c.surface,
        taskId: c.taskId,
      }));
    }
    const violations = detectStartupUniqueViolations(taskState, conductorsFromTeamJson);
    for (const v of violations) {
      for (const s of v.surfaces) {
        violationSurfaces.add(s);
      }
      // 違反 taskId を ready に戻し journal 付与
      const prev = taskState[v.taskId];
      if (prev) {
        const journal = prev.journal
          ? `${prev.journal}; unique_violation: surfaces=[${v.surfaces.join(",")}]`
          : `unique_violation: surfaces=[${v.surfaces.join(",")}]`;
        taskState[v.taskId] = { ...prev, status: "ready", journal };
        taskStateModified = true;
      }
      await log(
        "task_unique_violation_startup",
        `task_id=${v.taskId} surfaces=[${v.surfaces.join(",")}]`,
      );
    }
  } catch (e: any) {
    await log("error", `startup unique violation check failed: ${e.message}`);
  }

  // T241/T264: cascade 用に全タスクメタをロード（resume 不可 → aborted 遷移で使う）
  //   別途 line 1259 で loadTasks する箇所があるが、そちらは status 表示用で
  //   ここでは resume ループ用に先取りする（どちらも読み取り専用）
  const { tasks: allTasksForResume } = await loadTasks(PROJECT_ROOT);

  // T264 (T290 改): resume 不可（no_worktree / no_session_id / no_task_run_id）→
  //   applyResumeTransitions は判定のみ。taskState 書き換え + cascade + task_aborted log +
  //   child_reverted_to_draft log は markTaskAborted に集約。
  const resumeResult = await applyResumeTransitions(taskState, allTasksForResume, {
    findTaskFile,
  });
  rawResumePlan.push(...resumeResult.resumePlan);

  for (const target of resumeResult.abortTargets) {
    const ts = taskState[target.taskId]!;
    await log(
      "resume_marked_aborted",
      `task_id=${target.taskId} reason=${target.classifyReason} worktreePath=${ts.worktreePath ?? "null"} sessionId=${ts.sessionId ? "present" : "absent"} taskRunId=${ts.taskRunId ?? "null"}`,
    );
    // T290: markTaskAborted が taskState を on-disk で更新し、task_aborted /
    //       child_reverted_to_draft ログも内部で emit する。
    await markTaskAborted(PROJECT_ROOT, target.taskId, target.reason, target.detail);
  }

  // markTaskAborted は on-disk を直接書き換えるため、in-memory taskState を再 load して同期する
  if (resumeResult.abortTargets.length > 0) {
    const refreshed = await loadTaskState(PROJECT_ROOT);
    for (const k of Object.keys(refreshed)) taskState[k] = refreshed[k]!;
    for (const k of Object.keys(taskState)) {
      if (!(k in refreshed)) delete taskState[k];
    }
  }

  // 順序の安定化: taskId を数値として昇順 sort。これによりどの pane に
  // どの task が割り当てられるかが task-state.json の記録順に依存しなくなる。
  rawResumePlan.sort((a, b) => {
    const na = parseInt(a.taskId, 10);
    const nb = parseInt(b.taskId, 10);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    return a.taskId.localeCompare(b.taskId);
  });

  // slot 数を超える場合は末尾から ready に差し戻す
  while (rawResumePlan.length > state.maxConductors) {
    const overflow = rawResumePlan.pop()!;
    taskState[overflow.taskId] = { ...taskState[overflow.taskId], status: "ready" };
    taskStateModified = true;
    await log("resume_overflow_to_ready", `task_id=${overflow.taskId}`);
  }

  // タスクタイトルを取得（ダッシュボード/team.json 用）
  for (const item of rawResumePlan) {
    const taskFile = await findTaskFile(item.taskId);
    if (taskFile) {
      try {
        const content = await readFile(taskFile, "utf-8");
        item.taskTitle = content.match(/^title:\s*(.+)/m)?.[1]?.trim();
      } catch {}
    }
  }

  if (rawResumePlan.length > 0) {
    await log(
      "resume_plan_built",
      `count=${rawResumePlan.length} taskIds=[${rawResumePlan.map(r => r.taskId).join(",")}]`
    );
  }

  // Conductor スロット作成（resumePlan を透過）
  state.bootPhase = "conductors";
  scheduleRefresh();
  const resumeAssignments = await initializeLayout(state, daemonSurface, rawResumePlan);
  scheduleRefresh();

  // --- T254: 起動時 unique violation の後追い broken 化 ---
  //   applyRestorePlan の `conductor_taskid_reconciled` は taskState が assigned でない
  //   surface を idle に倒す（saveTaskState は initializeLayout の後なので、
  //   applyRestorePlan 時点では旧 disk 値を見ている）。
  //   そのため違反 surface は team.json 由来で running として復元され得る。
  //   ここで明示的に resetConductor(targetStatus: "broken") で上書きし、
  //   ユーザーの `cmux-team clear-conductor` による明示的な復帰を待つ。
  if (violationSurfaces.size > 0) {
    for (const surface of violationSurfaces) {
      const c = state.conductors.get(surface);
      if (!c) continue;  // A経路で除外された / D経路で新規作成されなかった
      await resetConductor(c, state.projectRoot, state.workspace ?? undefined, {
        targetStatus: "broken",
        reason: "unique_violation",
      });
    }
  }

  // resume 割当結果を ConductorState に反映（タブ名 + state 詳細）
  for (const r of resumeAssignments) {
    const c = state.conductors.get(r.surface);
    if (!c) {
      await log("resume_assignment_missing_conductor", `${formatSurface(r.surface, "C")} task_id=${r.taskId}`);
      continue;
    }
    c.taskId = r.taskId;
    c.taskRunId = r.taskRunId;
    c.worktreePath = r.worktreePath;
    c.taskTitle = r.taskTitle;
    c.status = "running";
    c.startedAt = new Date().toISOString();
    c.agents = [];

    await log(
      "task_resumed",
      `task_id=${r.taskId} session_id=${r.sessionId} ${formatSurface(r.surface, "C")} (via boot)`
    );
  }

  if (taskStateModified) {
    await saveTaskState(PROJECT_ROOT, taskState);
  }

  // Master spawn
  state.bootPhase = "master";
  scheduleRefresh();
  await startMaster(state, daemonSurface);
  scheduleRefresh();

  // 起動完了
  state.bootPhase = "ready";
  await updateTeamJson(state);
  await log("boot_completed");
  scheduleRefresh();

  // 起動時に 1 回 update チェック（off 以外のモードのみ）
  if (autoUpdate.mode !== "off") {
    state.lastUpdateCheckAt = Date.now();
    await checkUpdateAndNotify(state, autoUpdate.mode);
    scheduleRefresh();
  }

  // メインループ
  const UPDATE_CHECK_INTERVAL = 12 * 60 * 60 * 1000; // 12時間
  while (state.running) {
    try {
      await tick(state);
      await updateTeamJson(state);
      await updateSidebarStatus(state);
      scheduleRefresh(); // state 変更を TUI に反映（debounce 付き）
    } catch (e: any) {
      await log("error", `tick: ${e.message}`);
    }
    // caffeinate 制御: Master/Conductor/Agent のいずれかが稼働中ならスリープ抑止
    const systemActive =
      [...state.masters.values()].some(m => m.status === "running") ||
      [...state.conductors.values()].some(c => c.status === "running" || c.agents.length > 0);
    updateCaffeinate(systemActive);

    // update チェック（12h 間隔、off 以外のモードで実行）
    if (autoUpdate.mode !== "off" && Date.now() - state.lastUpdateCheckAt >= UPDATE_CHECK_INTERVAL) {
      state.lastUpdateCheckAt = Date.now();
      await checkUpdateAndNotify(state, autoUpdate.mode);
    }
    const sleepStart = Date.now();
    await sleepUntilWakeup(state);
    const sleepElapsed = Date.now() - sleepStart;
    // タイマーが期待値の3倍超を経過していた場合、Mac スリープからの復帰と判断
    if (sleepElapsed > state.pollInterval * 3) {
      await log("wake_detected", `gap=${Math.round(sleepElapsed / 1000)}s`);
    }
  }

  // ソース変更による再起動要求（proxy は停止しない — 再起動後に再利用される）
  if (state.restartRequested) {
    unmountDashboard();
    await log("daemon_auto_restart");
    await updateTeamJson(state);
    // T259: state 永続化の後・process.exit(42) の直前に release（順序厳守）。
    // 親が execFileSync でブロックする onReload 経路でも、restart 直前に所有権を
    // 手放すことで子が新 PID で acquire できるようにする。
    await releasePidFile(pidFilePath);
    process.exit(42);
  }

  await shutdown();
}

async function cmdSend(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_send"));
  const now = new Date().toISOString();

  let message: QueueMessage;

  // T181: JSON payload 全体を stdin で受け取るモード。
  // shell エスケープ問題（改行・クォート）を避けるため hook 側から使う。
  // T203: type 引数を伴う場合は Claude Code hook 入力 JSON として解釈し、
  //        --surface / --pid と合成して QueueMessage を組み立てる。
  // T206: hook は `${CMUX_SURFACE}` を ref 形式で渡す契約なので、ここでは UUID 正規化しない。
  if (hasFlag("from-stdin")) {
    const raw = await readStdin();
    // C2: args[1] が "--xxx" 系フラグなら type 未指定とみなして旧パスへ
    // （T189 SESSION_STOP forwarder は `send --from-stdin` 形式で呼ぶため）
    const typeArg = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
    if (typeArg) {
      // 新パス: hook JSON → 引数と合成して QueueMessage を作る
      try {
        message = buildMessageFromHookInput(typeArg, raw, {
          surface: requireArg("surface"),
          pid: Number(requireArg("pid")),
          now,
          // T266: NOTIFICATION 用の optional flag（他 type では ignore される）。
          surfaceUuid: getArg("surface-uuid"),
          workspaceUuid: getArg("workspace-uuid"),
          role: getArg("role"),
        });
      } catch (e: any) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      }
      await postMessageAndExit(message);
      return;
    }
    // 旧パス: stdin を QueueMessage として直接 parse（T189 互換）
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch (e: any) {
      console.error(`Error: invalid JSON on stdin: ${e.message}`);
      process.exit(1);
    }
    // SESSION_STOP の surface 空は早期 reject する（daemon 側でも二重防御あり）。
    if (obj && typeof obj === "object") {
      const o = obj as Record<string, unknown>;
      if (o.type === "SESSION_STOP" && (typeof o.surface !== "string" || o.surface === "")) {
        console.error("Error: SESSION_STOP requires non-empty surface");
        process.exit(1);
      }
    }
    try {
      message = QueueMessageSchema.parse(obj);
    } catch (e: any) {
      console.error(`Error: queue message validation failed: ${e.message}`);
      process.exit(1);
    }
    await postMessageAndExit(message);
    return;
  }

  const type = args[1];

  // T206: CLI 直接呼び出しの --surface / --conductor-surface は UUID 形式も受け付ける。
  // switch に入る前に必要な surface だけ正規化しておき、I/O は最小化する（surface あたり 1 回）。
  // 正規化失敗時は明確なエラーで exit 1 する（Critical C1 / Major M6）。
  const SURFACE_REQUIRED_TYPES = new Set([
    "CONDUCTOR_DONE",
    "CONDUCTOR_REGISTERED",
    "AGENT_SPAWNED",
    "SESSION_STARTED",
    "SESSION_ENDED",
    "SESSION_ACTIVE",
    "SESSION_IDLE",
    "SESSION_ASK",
    "SESSION_CLEAR",
  ]);
  let normalizedSurface: string | undefined;
  let normalizedConductorSurface: string | undefined;
  if (type && SURFACE_REQUIRED_TYPES.has(type)) {
    try {
      normalizedSurface = await normalizeSurfaceArg(requireArg("surface"));
    } catch (e: any) {
      console.error(`Error: ${e?.message ?? e}`);
      process.exit(1);
    }
  }
  if (type === "AGENT_SPAWNED") {
    try {
      normalizedConductorSurface = await normalizeSurfaceArg(requireArg("conductor-surface"));
    } catch (e: any) {
      console.error(`Error: ${e?.message ?? e}`);
      process.exit(1);
    }
  }

  switch (type) {
    case "TASK_CREATED":
      message = {
        type: "TASK_CREATED",
        taskId: requireArg("task-id"),
        taskFile: requireArg("task-file"),
        timestamp: now,
      };
      break;

    case "TASK_UPDATED":
      message = {
        type: "TASK_UPDATED",
        taskId: requireArg("task-id"),
        taskFile: requireArg("task-file"),
        timestamp: now,
      };
      break;

    case "CONDUCTOR_DONE":
      message = {
        type: "CONDUCTOR_DONE",
        surface: normalizedSurface!,
        taskRunId: getArg("task-run-id"),
        success: getArg("success") !== "false",  // デフォルト true（後方互換）
        reason: getArg("reason"),
        exitCode: getArg("exit-code") ? Number(getArg("exit-code")) : undefined,
        sessionId: getArg("session-id"),
        transcriptPath: getArg("transcript-path"),
        timestamp: now,
      };
      break;

    case "CONDUCTOR_REGISTERED":
      message = {
        type: "CONDUCTOR_REGISTERED",
        surface: normalizedSurface!,
        timestamp: now,
      };
      break;

    case "AGENT_SPAWNED":
      message = {
        type: "AGENT_SPAWNED",
        conductorSurface: normalizedConductorSurface!,
        surface: normalizedSurface!,
        role: getArg("role"),
        taskTitle: getArg("task-title"),
        timestamp: now,
      };
      break;

    case "SESSION_STARTED":
      message = {
        type: "SESSION_STARTED",
        surface: normalizedSurface!,
        pid: Number(requireArg("pid")),
        sessionId: getArg("session-id"),
        timestamp: now,
      };
      break;

    case "SESSION_ENDED":
      message = {
        type: "SESSION_ENDED",
        surface: normalizedSurface!,
        pid: getArg("pid") ? Number(getArg("pid")) : undefined,
        reason: getArg("reason"),
        timestamp: now,
      };
      break;

    case "SESSION_ACTIVE":
      message = {
        type: "SESSION_ACTIVE",
        surface: normalizedSurface!,
        pid: getArg("pid") ? Number(getArg("pid")) : undefined,
        timestamp: now,
      };
      break;

    case "SESSION_IDLE":
      message = {
        type: "SESSION_IDLE",
        surface: normalizedSurface!,
        pid: getArg("pid") ? Number(getArg("pid")) : undefined,
        timestamp: now,
      };
      break;

    case "SESSION_ASK":
      message = {
        type: "SESSION_ASK",
        surface: normalizedSurface!,
        question: requireArg("question"),
        pid: getArg("pid") ? Number(getArg("pid")) : undefined,
        timestamp: now,
      };
      break;

    case "SESSION_CLEAR":
      message = {
        type: "SESSION_CLEAR",
        surface: normalizedSurface!,
        taskRunId: getArg("task-run-id"),
        pid: getArg("pid") ? Number(getArg("pid")) : undefined,
        timestamp: now,
      };
      break;

    case "SHUTDOWN":
      message = { type: "SHUTDOWN", timestamp: now };
      break;

    default:
      console.error("Usage: send <TASK_CREATED|TASK_UPDATED|CONDUCTOR_DONE|CONDUCTOR_REGISTERED|AGENT_SPAWNED|SESSION_STARTED|SESSION_ENDED|SESSION_ACTIVE|SESSION_IDLE|SESSION_ASK|SESSION_STOP|SESSION_CLEAR|SHUTDOWN> [--from-stdin]");
      process.exit(1);
  }

  await postMessageAndExit(message);
}

/** daemon HTTP API に QueueMessage を POST して結果に応じて exit する */
async function postMessageAndExit(message: QueueMessage): Promise<void> {
  const portFile = join(PROJECT_ROOT, ".team/proxy-port");
  if (!existsSync(portFile)) {
    console.error(t("daemon_not_running"));
    process.exit(1);
  }
  const port = (await readFile(portFile, "utf-8")).trim();
  const url = `http://localhost:${port}/api/messages`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`Error: HTTP ${res.status} ${body}`);
      process.exit(1);
    }
    console.log("OK");
  } catch (e: any) {
    console.error(`Error: daemon に接続できません (${url}): ${e.message}`);
    process.exit(1);
  }
}

async function cmdStatus(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_status"));
  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  if (!existsSync(teamJsonPath)) {
    console.log(t("team_not_started_start"));
    return;
  }

  const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
  const pid = teamJson.manager?.pid;
  const alive = pid && isProcessAlive(pid);
  // T229: team.json.masters (配列) を読む。旧 team.json.master (オブジェクト) との後方互換も保つ。
  type MasterRow = { surface: string; status?: string; pid?: number };
  const masters: MasterRow[] = Array.isArray(teamJson.masters)
    ? teamJson.masters as MasterRow[]
    : teamJson.master?.surface
      ? [{ surface: teamJson.master.surface as string, status: teamJson.master.status, pid: teamJson.master.pid }]
      : [];
  const conductors: Array<{ taskId: string; taskTitle?: string; surface: string; status?: string }> = teamJson.conductors || [];
  const logLines = getArg("log") || "10";

  // --- ヘッダー ---
  const status = alive ? "RUNNING" : "STOPPED";
  const layout = typeof teamJson.layout === "string" ? teamJson.layout : "wide";
  console.log(`cmux-team  ${status}  PID ${pid || "-"}  conductors ${conductors.length}  layout=${layout}`);

  // --- Master ---
  const mastersHeader = masters.length <= 1 ? "Master" : `Masters ${masters.length}`;
  console.log(`─ ${mastersHeader} ${"─".repeat(Math.max(0, 58 - mastersHeader.length))}`);
  if (masters.length === 0) {
    console.log(`  ○ not spawned`);
  } else {
    for (const m of masters) {
      const st = m.status === "disconnected" ? "⚠" : m.status === "running" ? "◐" : "●";
      const statusLabel = m.status ? ` ${m.status}` : "";
      console.log(`  ${st} [${m.surface.replace("surface:", "")}]${statusLabel}`);
    }
  }

  // --- Conductors ---
  console.log(`─ Conductors ${conductors.length} ${"─".repeat(44)}`);
  if (conductors.length === 0) {
    console.log(`  idle`);
  } else {
    for (const c of conductors) {
      const icon = c.status === "broken" ? "⨯" : "●";
      const statusLabel = c.status === "broken" ? " BROKEN" : "";
      const title = c.taskTitle ? `  ${c.taskTitle}` : "";
      const tid = c.taskId && c.taskId !== "undefined" ? `T${c.taskId}` : "---";
      console.log(`  ${icon} [${c.surface.replace("surface:", "")}]${statusLabel}  ${tid}${title}`);
    }
  }

  // --- Tasks ---
  const { tasks } = await loadTasks(PROJECT_ROOT);
  const closedCount = tasks.filter(t => t.status === "closed").length;
  const openCount = tasks.length - closedCount;
  console.log(`─ Tasks ${"─".repeat(51)}`);
  console.log(`  open: ${openCount}  closed: ${closedCount}`);

  // --- Log tail ---
  const n = Math.max(1, parseInt(logLines, 10) || 10);
  console.log(`─ Log (last ${n}) ${"─".repeat(Math.max(0, 42 - String(n).length))}`);
  try {
    const log = await readFile(join(PROJECT_ROOT, ".team/logs/manager.log"), "utf-8");
    const lines = log.trim().split("\n").filter(Boolean).slice(-n);
    for (const line of lines) {
      const m = line.match(/^\[([^\]]+)\]\s+(.*)/);
      if (m) {
        const utcTs = m[1] ?? "";
        const time = new Date(utcTs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
        console.log(`  ${time} ${m[2]}`);
      } else {
        console.log(`  ${line}`);
      }
    }
  } catch {
    console.log(`  (no log)`);
  }
}

/** proxy ポートを読み取り、生存確認して返す */
async function resolveProxyPort(): Promise<string | undefined> {
  const proxyPortFile = join(PROJECT_ROOT, ".team/proxy-port");
  try {
    const port = (await readFile(proxyPortFile, "utf-8")).trim();
    const alive = await new Promise<boolean>((resolve) => {
      const net = require("net");
      const sock = net.connect({ port: Number(port), host: "127.0.0.1", timeout: 1000 }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      sock.on("timeout", () => { sock.destroy(); resolve(false); });
    });
    return alive ? port : undefined;
  } catch {
    return undefined;
  }
}

/** daemon の HTTP API にメッセージを送信する。daemon 未起動時はスキップ。 */
async function postMessage(msg: Record<string, unknown>): Promise<void> {
  const portFile = join(PROJECT_ROOT, ".team/proxy-port");
  if (!existsSync(portFile)) return;
  const port = (await readFile(portFile, "utf-8")).trim();
  try {
    await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
  } catch {
    // daemon 未起動・接続失敗時は無視
  }
}

/**
 * 自身を daemon に登録する共通処理（T234）。
 *
 * `role` によって `MASTER_REGISTERED` / `CONDUCTOR_REGISTERED` の POST と
 * `master_self_register` / `conductor_self_register` のログを出し分ける。
 *
 * proxy-port が読み取れない / proxy が死んでいる / POST が失敗するいずれの
 * 場合も fail-fast（exit 1）する。daemon 不在で claude だけ起動しても
 * `state.masters` / `state.conductors` に登録されず TUI・PID watcher・
 * `team.json` に反映されない壊れたセッションが取り残されるため。
 *
 * `postMessage` は daemon 未起動時に silent skip するため fail-fast と矛盾する。
 * よってここでは `fetch` で直接 POST する。
 */
async function registerSelf(
  role: "master" | "conductor",
  surface: string,
): Promise<void> {
  const messageType = role === "master" ? "MASTER_REGISTERED" : "CONDUCTOR_REGISTERED";
  const logEvent = role === "master" ? "master_self_register" : "conductor_self_register";
  const surfaceRole = role === "master" ? "U" : "C";

  const port = await resolveProxyPort();
  if (!port) {
    console.error(
      "daemon が起動していません (.team/proxy-port 不在 / proxy 死亡 / 壊れた proxy-port ファイル)。",
    );
    console.error("cmux-team start を先に実行してください。");
    console.error(
      "壊れた proxy-port ファイルの場合は `.team/proxy-port` を削除して `cmux-team start` をやり直してください。",
    );
    process.exit(1);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: messageType,
        surface,
        timestamp: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      console.error(
        `${messageType} POST failed: status=${res.status} surface=${surface}`,
      );
      process.exit(1);
    }
  } catch (e: any) {
    console.error(
      `${messageType} POST failed: ${e?.message ?? e} surface=${surface}`,
    );
    process.exit(1);
  }
  await log(logEvent, formatSurface(surface, surfaceRole));
}

/**
 * conductor-settings.json を生成する共通ヘルパー。
 * cmdConductor と cmdResume の両方から使用される。
 * @returns 生成したファイルの絶対パス
 */
/**
 * PreToolUse hook 用の bash スクリプト。
 * Bash tool の command が `cmux send` / `cmux send-key` を叩こうとしていたら exit 2 で拒否する。
 * 代替手段として `cmux-team send-agent` を stderr で案内する（2 行構成、Design Review R3）。
 *
 * 正規表現の設計:
 *   - `(^|[^-[:alnum:]_])cmux[[:space:]]+(send|send-key)([[:space:]]|$)`
 *   - `cmux-team` は `-` が前置でマッチしないため通る
 *   - `sender` 等は `(send|send-key)` 直後の space/行末条件で除外
 */
const PRE_TOOL_USE_HOOK_SCRIPT = [
  'input="$(cat)"',
  'cmd="$(printf "%s" "$input" | grep -oE "\\"command\\"[[:space:]]*:[[:space:]]*\\"[^\\"]*\\"" | head -1 | sed -E "s/^\\"command\\"[[:space:]]*:[[:space:]]*\\"//; s/\\"$//")"',
  'if printf "%s" "$cmd" | grep -qE "(^|[^-[:alnum:]_])cmux[[:space:]]+(send|send-key)([[:space:]]|$)"; then',
  '  echo "cmux send / cmux send-key は Conductor から使用禁止です。" >&2',
  '  echo "代替: cmux-team send-agent --surface <agent-surface> <message>  (自分が spawn した Agent のみ送信可)" >&2',
  '  exit 2',
  'fi',
  'exit 0',
].join("\n");

/**
 * Stop hook forwarder スクリプト (T189)。
 * stdin: Stop hook JSON payload（Claude Code 仕様）
 *
 * 役割は「forwarder」のみ:
 *   - payload から transcript_path を抽出し、surface/pid/type を足して
 *     SESSION_STOP メッセージに整形、cmux-team send --from-stdin に流す
 *   - 分類（ASK/IDLE）は Manager (daemon) 側の classifyStopPayload が担う
 *
 * jq は preflight (checkJq) で必須扱いのため fallback 分岐は持たない。
 */
const DETECT_ASK_SCRIPT = [
  '#!/usr/bin/env bash',
  '# cmux-team Stop hook forwarder (T189)',
  '# stdin: Stop hook JSON payload → SESSION_STOP に整形して daemon に転送するだけ',
  'set -u',
  '',
  'PAYLOAD="$(cat)"',
  'SURFACE="${CMUX_SURFACE:-${SURFACE_OVERRIDE:-}}"',
  'TS="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"',
  '',
  '# jq は preflight (checkJq) で必須扱い。不在時は hook もサイレント失敗する。',
  'TRANSCRIPT_PATH="$(printf %s "$PAYLOAD" | jq -r \'.transcript_path // empty\' 2>/dev/null || true)"',
  '',
  'printf \'{"type":"SESSION_STOP","surface":%s,"pid":%d,"timestamp":%s,"payload":{"transcript_path":%s}}\\n\' \\',
  '  "$(printf %s "$SURFACE" | jq -Rs .)" \\',
  '  "$PPID" \\',
  '  "$(printf %s "$TS" | jq -Rs .)" \\',
  '  "$(printf %s "$TRANSCRIPT_PATH" | jq -Rs .)" \\',
  '  | cmux-team send --from-stdin 2>/dev/null || true',
  '',
  'exit 0',
  '',
].join("\n");

/**
 * Claude Code hook の stdin JSON を type 別の QueueMessage に組み立てる純関数。
 * T203: SessionStart hook 経由で sessionId を daemon に届けるためのパス。
 *
 * @param type 組み立てる QueueMessage の type（現状 SESSION_STARTED のみ対応）
 * @param rawJson Claude Code が hook の stdin に渡す JSON 文字列
 * @param opts CLI 引数から取得したコンテキスト（surface, pid, now）
 */
export function buildMessageFromHookInput(
  type: string,
  rawJson: string,
  opts: {
    surface: string;
    pid: number;
    now: string;
    // T266: NOTIFICATION 用に hook 側から追加で渡される flag。
    //       undefined / empty string は schema.optional に変換する。
    surfaceUuid?: string;
    workspaceUuid?: string;
    role?: string;
  }
): QueueMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e: any) {
    throw new Error(`invalid hook JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("hook JSON must be an object");
  }
  const obj = parsed as Record<string, unknown>;

  if (type === "SESSION_STARTED") {
    const sessionId = typeof obj.session_id === "string" ? obj.session_id : undefined;
    const source = typeof obj.source === "string" ? obj.source : undefined;
    const message: SessionStartedMessage = {
      type: "SESSION_STARTED",
      surface: opts.surface,
      pid: opts.pid,
      sessionId,
      source: source as SessionStartedMessage["source"],
      timestamp: opts.now,
    };
    return SessionStartedMessageSchema.parse(message);
  }

  if (type === "SESSION_ENDED") {
    // T216: hook 全送信ポリシー — Claude Code の実 reason（logout/prompt_input_exit/other）を
    //       hook stdin から抽出し、そのまま daemon に転送する。hook 側では分岐させない。
    const reason = typeof obj.reason === "string" ? obj.reason : undefined;
    const message: SessionEndedMessage = {
      type: "SESSION_ENDED",
      surface: opts.surface,
      pid: opts.pid,
      reason,
      timestamp: opts.now,
    };
    return SessionEndedMessageSchema.parse(message);
  }

  if (type === "NOTIFICATION") {
    // T266: Claude Code Notification hook payload をそのまま payload: に畳む。
    //       hook 側は `--surface-uuid`, `--workspace-uuid`, `--role` を flag 経由で渡す契約
    //       （empty 文字列は undefined に正規化して zod optional へ — D9 Case B）。
    const emptyToUndef = (s: string | undefined): string | undefined =>
      s === undefined || s === "" ? undefined : s;
    const surfaceUuid = emptyToUndef(opts.surfaceUuid);
    const workspaceUuid = emptyToUndef(opts.workspaceUuid);
    const role = emptyToUndef(opts.role);

    const message: NotificationMessage = {
      type: "NOTIFICATION",
      surface: opts.surface,
      surfaceUuid,
      workspaceUuid,
      pid: opts.pid,
      role: role as NotificationMessage["role"],
      payload: obj as Record<string, any>,
      timestamp: opts.now,
    };
    return NotificationMessageSchema.parse(message);
  }

  throw new Error(`unsupported hook message type: ${type}`);
}

/**
 * detect-ask.sh を .team/prompts/ に冪等に書き出し、そのパスを返す。
 * Conductor/Agent の Stop hook が共通で呼び出す。
 * T189 以降は forwarder（SESSION_STOP を Manager に転送するだけ）。
 */
export function ensureAskDetectorScript(projectRoot: string): string {
  const scriptPath = join(projectRoot, ".team/prompts/detect-ask.sh");
  try { mkdirSync(join(projectRoot, ".team/prompts"), { recursive: true }); } catch {}
  writeFileSync(scriptPath, DETECT_ASK_SCRIPT, { mode: 0o755 });
  return scriptPath;
}

// --- T211: Master hook Python scripts ---

/**
 * Master UserPromptSubmit hook (T211)。
 * ユーザーがプロンプトを送信した瞬間に proxy `/master-state` に
 * `{status: "busy", prompt: "..."}` を POST し、Manager に Master の活動を通知する。
 *
 * 旧 `.claude/settings.json` ベース時は `CONDUCTOR_ID` guard で Agent/Conductor を除外していたが、
 * T211 以降は `master-settings.json` 経由で Master セッションにのみ適用されるため guard 不要。
 */
const MASTER_HOOK_BUSY_SCRIPT = [
  '#!/usr/bin/env python3',
  '# cmux-team Master UserPromptSubmit hook (T211)',
  '# stdin: Claude Code UserPromptSubmit hook の JSON payload',
  '# 役割: proxy /master-state に {status: "busy", prompt} を POST する',
  'import json',
  'import os',
  'import subprocess',
  'import sys',
  'import urllib.request',
  '',
  'try:',
  '    payload = json.load(sys.stdin)',
  'except Exception:',
  '    sys.exit(0)',
  '',
  'prompt = (payload.get("prompt") or "")[:80]',
  '',
  'root = subprocess.run(',
  '    ["git", "rev-parse", "--show-toplevel"],',
  '    capture_output=True, text=True,',
  ').stdout.strip()',
  'if not root:',
  '    sys.exit(0)',
  '',
  'port_file = os.path.join(root, ".team", "proxy-port")',
  'try:',
  '    port = open(port_file).read().strip()',
  'except Exception:',
  '    sys.exit(0)',
  'if not port:',
  '    sys.exit(0)',
  '',
  'data = json.dumps({"status": "busy", "prompt": prompt}).encode()',
  'try:',
  '    req = urllib.request.Request(',
  '        f"http://127.0.0.1:{port}/master-state",',
  '        data=data,',
  '        headers={"Content-Type": "application/json"},',
  '        method="POST",',
  '    )',
  '    urllib.request.urlopen(req, timeout=2)',
  'except Exception:',
  '    pass',
  '',
  'sys.exit(0)',
  '',
].join("\n");

/**
 * Master Stop hook (T211)。
 * Master セッションのレスポンス完了時に proxy `/master-state` に
 * `{status: "idle"}` を POST する。
 */
const MASTER_HOOK_STOP_SCRIPT = [
  '#!/usr/bin/env python3',
  '# cmux-team Master Stop hook (T211)',
  '# 役割: proxy /master-state に {status: "idle"} を POST する',
  'import json',
  'import os',
  'import subprocess',
  'import sys',
  'import urllib.request',
  '',
  'root = subprocess.run(',
  '    ["git", "rev-parse", "--show-toplevel"],',
  '    capture_output=True, text=True,',
  ').stdout.strip()',
  'if not root:',
  '    sys.exit(0)',
  '',
  'port_file = os.path.join(root, ".team", "proxy-port")',
  'try:',
  '    port = open(port_file).read().strip()',
  'except Exception:',
  '    sys.exit(0)',
  'if not port:',
  '    sys.exit(0)',
  '',
  'data = json.dumps({"status": "idle"}).encode()',
  'try:',
  '    req = urllib.request.Request(',
  '        f"http://127.0.0.1:{port}/master-state",',
  '        data=data,',
  '        headers={"Content-Type": "application/json"},',
  '        method="POST",',
  '    )',
  '    urllib.request.urlopen(req, timeout=2)',
  'except Exception:',
  '    pass',
  '',
  'sys.exit(0)',
  '',
].join("\n");

/**
 * Master 用 Python hook スクリプトを `.team/prompts/` に冪等に書き出す (T211)。
 * 戻り値は `{ busy, stop }` の絶対パス。
 */
export function ensureMasterHookScripts(projectRoot: string): { busy: string; stop: string } {
  const dir = join(projectRoot, ".team/prompts");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const busy = join(dir, "master-hook-busy.py");
  const stop = join(dir, "master-hook-stop.py");
  writeFileSync(busy, MASTER_HOOK_BUSY_SCRIPT, { mode: 0o755 });
  writeFileSync(stop, MASTER_HOOK_STOP_SCRIPT, { mode: 0o755 });
  return { busy, stop };
}

/**
 * Master 用 settings.json を生成する (T211)。
 * - UserPromptSubmit hook: master-hook-busy.py を呼んで `/master-state` に busy を POST
 * - Stop hook: master-hook-stop.py を呼んで `/master-state` に idle を POST
 * - statusLine: statusline.sh (存在する場合のみ)
 *
 * これらの hook は旧 `.claude/settings.json` に置かれていたが、
 * Agent/Conductor セッションにも適用されてしまう問題があったため、
 * Master 専用の settings.json に移設して起動経路で明示的に差し込む。
 */
export function generateMasterSettings(projectRoot: string): string {
  const settingsPath = join(projectRoot, ".team/prompts/master-settings.json");
  const { busy, stop } = ensureMasterHookScripts(projectRoot);
  const settings: Record<string, any> = {
    hooks: {
      // T175: SessionStart hook で daemon に masterPid を渡し spawnMasterPidWatcher を起動する。
      // Conductor の SessionStart hook と完全に同じ command パターン (main.ts:1478-1489)。
      SessionStart: [
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: "bash -c 'cmux-team send SESSION_STARTED --from-stdin --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'",
            timeout: 5000,
          }],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: `python3 ${busy}`,
            timeout: 5000,
          }],
        },
      ],
      // T266: Notification hook を daemon に集約・DB 記録する。
      // Claude Code native の通知（permission / idle 等）を全て Manager に転送し、
      // hook_signals テーブルに enrichment 付きで INSERT する。
      Notification: [
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: "bash -c 'cmux-team send NOTIFICATION --from-stdin --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" --surface-uuid \"${CMUX_SURFACE_UUID:-}\" --workspace-uuid \"${CMUX_WORKSPACE_UUID:-}\" --role master 2>/dev/null || true'",
            timeout: 5000,
          }],
        },
      ],
      Stop: [
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: `python3 ${stop}`,
            timeout: 5000,
          }],
        },
      ],
      // T175: SessionEnd hook で Master kill / ターミナル終了を検知。
      // Master は /clear でもセッション継続するため matcher に clear を含めない (D2)。
      SessionEnd: [
        {
          matcher: "logout|prompt_input_exit|other",
          hooks: [{
            type: "command",
            command: "bash -c 'cmux-team send SESSION_ENDED --from-stdin --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'",
            timeout: 5000,
          }],
        },
      ],
    },
  };

  const statuslineScript = join(homedir(), ".claude", "statusline.sh");
  if (existsSync(statuslineScript)) {
    settings.statusLine = { type: "command", command: statuslineScript };
  }

  try { mkdirSync(join(projectRoot, ".team/prompts"), { recursive: true }); } catch {}
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return settingsPath;
}

/**
 * Agent 用 settings.json を生成する。
 * - SessionStart hook: SESSION_STARTED 送信（T195: PID 追跡に使う）
 * - Stop hook: detect-ask.sh（AskUserQuestion 検出 / SESSION_IDLE 送信）
 * - SessionEnd hook: SESSION_ENDED 送信（logout/prompt_input_exit/other）
 * - statusLine: 存在する場合のみ付与
 */
export function generateAgentSettings(projectRoot: string, surface: string): string {
  const settingsPath = join(projectRoot, `.team/prompts/${surface}-agent-settings.json`);
  const askDetectorPath = ensureAskDetectorScript(projectRoot);
  const settings: Record<string, any> = {
    hooks: {
      SessionStart: [
        {
          // T203: matcher: "" は全 source 許容（Claude Code は "" / 4 値のみ受け付ける）。
          // /clear / /compact / resume / startup どれでも発火させて daemon に最新 sessionId を届ける。
          matcher: "",
          hooks: [{
            type: "command",
            // T203: hook stdin の JSON（session_id, source, ...）をそのまま cmux-team に渡す。
            command: `bash -c 'cmux-team send SESSION_STARTED --from-stdin --surface "${surface}" --pid "$PPID" 2>/dev/null || true'`,
            timeout: 5000,
          }],
        },
      ],
      // T266: Notification hook を daemon に集約・DB 記録する。
      Notification: [
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: `bash -c 'cmux-team send NOTIFICATION --from-stdin --surface "${surface}" --pid "$PPID" --surface-uuid "\${CMUX_SURFACE_UUID:-}" --workspace-uuid "\${CMUX_WORKSPACE_UUID:-}" --role agent 2>/dev/null || true'`,
            timeout: 5000,
          }],
        },
      ],
      Stop: [
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: `bash ${askDetectorPath}`,
            timeout: 5000,
          }],
        },
      ],
      SessionEnd: [
        {
          // T216: hook 全送信ポリシー — 実 reason は --from-stdin の JSON から Manager が抽出する。
          matcher: "logout|prompt_input_exit|other",
          hooks: [{
            type: "command",
            command: `bash -c 'cmux-team send SESSION_ENDED --from-stdin --surface "${surface}" --pid "$PPID" 2>/dev/null || true'`,
            timeout: 5000,
          }],
        },
      ],
    },
  };

  const statuslineScript = join(homedir(), ".claude", "statusline.sh");
  if (existsSync(statuslineScript)) {
    settings.statusLine = { type: "command", command: statuslineScript };
  }

  try { mkdirSync(join(projectRoot, ".team/prompts"), { recursive: true }); } catch {}
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return settingsPath;
}

export function generateConductorSettings(projectRoot: string): string {
  const conductorSettingsPath = join(projectRoot, ".team/prompts/conductor-settings.json");
  const askDetectorPath = ensureAskDetectorScript(projectRoot);
  const conductorSettings: Record<string, any> = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{
            type: "command",
            command: `bash -c '${PRE_TOOL_USE_HOOK_SCRIPT}'`,
            timeout: 3000,
          }],
        },
      ],
      SessionStart: [
        {
          // T203: 全 source 許容（"" / startup / resume / clear / compact のうち "" のみ全捕捉可能）。
          matcher: "",
          hooks: [{
            type: "command",
            // T203: hook stdin の JSON（session_id, source, ...）をそのまま cmux-team に渡す。
            command: "bash -c 'cmux-team send SESSION_STARTED --from-stdin --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'",
            timeout: 5000,
          }],
        },
      ],
      // T266: Notification hook を daemon に集約・DB 記録する。
      Notification: [
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: "bash -c 'cmux-team send NOTIFICATION --from-stdin --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" --surface-uuid \"${CMUX_SURFACE_UUID:-}\" --workspace-uuid \"${CMUX_WORKSPACE_UUID:-}\" --role conductor 2>/dev/null || true'",
            timeout: 5000,
          }],
        },
      ],
      Stop: [
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: `bash ${askDetectorPath}`,
            timeout: 5000,
          }],
        },
      ],
      SessionEnd: [
        {
          matcher: "clear",
          hooks: [{
            type: "command",
            command: "bash -c 'cmux-team send SESSION_CLEAR --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'",
            timeout: 5000,
          }],
        },
        {
          // T216: hook 全送信ポリシー — 全 reason (logout/prompt_input_exit/other) を Manager に転送する。
          // 実 reason は --from-stdin の JSON から buildMessageFromHookInput が抽出する。
          matcher: "logout|prompt_input_exit|other",
          hooks: [{
            type: "command",
            command: "bash -c 'cmux-team send SESSION_ENDED --from-stdin --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'",
            timeout: 5000,
          }],
        },
      ],
    },
  };

  // statusline.sh が存在する場合のみ statusLine 設定を追加
  const statuslineScript = join(homedir(), ".claude", "statusline.sh");
  if (existsSync(statuslineScript)) {
    conductorSettings.statusLine = {
      type: "command",
      command: statuslineScript,
    };
  }

  try { mkdirSync(join(projectRoot, ".team/prompts"), { recursive: true }); } catch {}
  writeFileSync(conductorSettingsPath, JSON.stringify(conductorSettings, null, 2));
  return conductorSettingsPath;
}

/**
 * CMUX_SURFACE env → cmux identify の caller surface_ref の順で解決（T206）。
 * どちらも失敗したら exit 1。
 */
async function resolveCallerSurfaceOrExit(): Promise<string> {
  const env = process.env.CMUX_SURFACE;
  if (env) return env;
  try {
    return await cmux.getCallerSurface();
  } catch (e: any) {
    console.error(
      "Error: surface を解決できません。CMUX_SURFACE env を設定するか、" +
      "cmux ペイン内から呼び出してください。" +
      ` (cmux identify failed: ${e?.message ?? e})`
    );
    process.exit(1);
  }
}

/**
 * cmux-team conductor
 * Conductor 用 Claude Code ラッパー。proxy ポートを動的に解決して claude を exec する。
 * CMUX_SURFACE 環境変数が未設定なら cmux identify から自動解決する。
 */
async function cmdConductor(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_conductor", { model: DEFAULT_MODEL }));
  const surface = await resolveCallerSurfaceOrExit();

  // self-register: cmdConductor が自身を daemon に登録（T228）。
  // proxy-port 不在 / POST 失敗時は fail-fast。
  await registerSelf("conductor", surface);

  // T213: main ブランチを env → config の順で解決。T253 で暗黙 "main" フォールバックを削除し
  //   両方空なら fail-stop する。
  //   `launchConductor` が `CMUX_TEAM_MAIN_BRANCH` をシェルに焼き付けるのが第一ソース。
  //   env が欠落しても config.mainBranch（cmdStart が永続化）で救済できる。
  const conductorConfig = await loadConfig(PROJECT_ROOT);
  const envMainBranch = process.env.CMUX_TEAM_MAIN_BRANCH?.trim();
  const mainBranch = envMainBranch || conductorConfig.mainBranch?.trim() || "";
  if (!mainBranch) {
    console.error(
      "Error: config.mainBranch is not set and CMUX_TEAM_MAIN_BRANCH is empty. " +
        "Run `cmux-team start` first to detect and persist the main branch, " +
        "or set CMUX_TEAM_MAIN_BRANCH=<your-branch> explicitly.",
    );
    await log("conductor_main_branch_missing", "reason=env_and_config_missing");
    process.exit(1);
  }

  // ロールプロンプトファイル生成
  const { generateConductorRolePrompt } = await import("./template");
  const rolePromptFile = await generateConductorRolePrompt(PROJECT_ROOT, mainBranch);

  // 環境変数を設定
  process.env.PROJECT_ROOT = PROJECT_ROOT;
  // T210: 通常経路では cmux ペインから env として継承されるため no-op だが、
  // cmux identify fallback 経路でも statusline.sh / hook が CMUX_SURFACE を
  // 取得できるよう defensive に明示設定する。
  process.env.CMUX_SURFACE = surface;
  process.env.CMUX_NO_RENAME_TAB = "1";
  process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1";
  const proxyPort = await resolveProxyPort();
  if (proxyPort) {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
  }

  // モデル解決
  const config = await loadConfig(PROJECT_ROOT);
  const model = getModelForRole(config, "conductor", getArg("model"));

  // T203: sessionId は Claude 自身に発行させる。
  // SessionStart hook が新しい session_id を daemon に push するため CLI 側で固定しない。

  const taskPromptFile = getArg("task-prompt");

  // conductor-settings.json を生成（Conductor 固有の hook + cmux hooks を注入）
  const conductorSettingsPath = generateConductorSettings(PROJECT_ROOT);

  // claude コマンド引数を組み立て
  const claudeArgs = [
    "--dangerously-skip-permissions",
    "--settings", conductorSettingsPath,
    "--model", model,
    "--append-system-prompt-file", rolePromptFile,
  ];

  // 初期プロンプトを決定
  //   taskPromptFile 指定時のみチャット入力として push する。
  //   未指定（通常の待機起動）は何も push せず、Claude は純粋に ❯ で待機する。
  if (taskPromptFile) {
    claudeArgs.push(`${taskPromptFile} を読んで指示に従って作業してください。`);
  }

  // claude を exec（プロセスを置換）
  const { execFileSync } = require("child_process");
  try {
    execFileSync("claude", claudeArgs, {
      stdio: "inherit",
      env: process.env,
      cwd: PROJECT_ROOT,
    });
  } catch (e: any) {
    // claude の終了コードをそのまま返す
    process.exit(e.status ?? 1);
  }
}

/**
 * cmux-team resume <task-id>
 * assigned タスクの Conductor セッションを claude --resume で再開する。
 */
async function cmdResume(): Promise<void> {
  if (hasHelpFlag()) showHelp("Usage: cmux-team resume <task-id>");
  const surface = await resolveCallerSurfaceOrExit();

  // self-register: cmdResume が自身を daemon に登録（T228）。
  // daemon 側ハンドラは既存 state があれば skip するため、resume 時に
  // initializeConductorSlots が pre-set した taskId/taskRunId/worktreePath は破壊されない。
  await registerSelf("conductor", surface);

  const taskId = args[1];
  if (!taskId) {
    console.error("Usage: cmux-team resume <task-id>");
    process.exit(1);
  }

  // task-state.json から resume 情報を取得
  const taskState = await loadTaskState(PROJECT_ROOT);
  const ts = taskState[taskId];
  if (!ts) {
    console.error(`Task ${taskId} not found in task-state.json`);
    process.exit(1);
  }
  if (ts.status !== "assigned") {
    console.error(`Task ${taskId} is not assigned (status: ${ts.status})`);
    process.exit(1);
  }
  if (!ts.sessionId) {
    console.error(`Task ${taskId} has no sessionId — cannot resume`);
    process.exit(1);
  }
  if (!ts.worktreePath || !existsSync(ts.worktreePath)) {
    console.error(`Task ${taskId} worktree not found: ${ts.worktreePath}`);
    process.exit(1);
  }

  // 環境変数を設定（cmdConductor と同等）
  process.env.PROJECT_ROOT = PROJECT_ROOT;
  // T210: 同上（cmdConductor 参照）— fallback 経路のための defensive export。
  process.env.CMUX_SURFACE = surface;
  process.env.CMUX_NO_RENAME_TAB = "1";
  process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1";
  const proxyPort = await resolveProxyPort();
  if (proxyPort) {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
  }

  // モデル解決
  const config = await loadConfig(PROJECT_ROOT);
  const model = getModelForRole(config, "conductor", getArg("model"));

  // conductor-settings.json 生成（cmdConductor と同一の hook 構成）
  const conductorSettingsPath = generateConductorSettings(PROJECT_ROOT);

  // claude --resume で再開
  const { execFileSync } = require("child_process");
  try {
    execFileSync("claude", [
      "--resume", ts.sessionId,
      "--dangerously-skip-permissions",
      "--settings", conductorSettingsPath,
      "--model", model,
    ], {
      stdio: "inherit",
      env: process.env,
      cwd: PROJECT_ROOT,
    });
  } catch (e: any) {
    process.exit(e.status ?? 1);
  }
}

/**
 * cmux-team spawn-master
 * Master 用 Claude Code ラッパー。proxy ポートを動的に解決して claude を exec する。
 */
async function cmdLaunchMaster(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_spawn_master", { model: DEFAULT_MODEL }));
  // T175: Master の SessionStart/SessionEnd hook が `${CMUX_SURFACE}` を展開するため
  // cmux pane env 継承が壊れた経路 (cmux identify fallback) でも surface が解決されるよう
  // Conductor (cmdConductor) と同じく defensive に明示設定する。
  const surface = await resolveCallerSurfaceOrExit();

  // T230: daemon へ自己登録する。proxy-port 不在・POST 失敗は fail-fast（exit 1）。
  // generateMasterPrompt や claude exec より前に実行する（壊れた Master を残さないため）。
  await registerSelf("master", surface);

  // プロンプト生成
  const { generateMasterPrompt } = await import("./template");
  await generateMasterPrompt(PROJECT_ROOT);

  // 環境変数を設定
  process.env.PROJECT_ROOT = PROJECT_ROOT;
  process.env.CMUX_SURFACE = surface;
  process.env.CMUX_NO_RENAME_TAB = "1";
  process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1";
  const proxyPort = await resolveProxyPort();
  if (proxyPort) {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
  }
  await log("master_spawn_surface", formatSurface(surface, "U"));
  await log("master_spawn_proxy", `port=${proxyPort ?? "none"}`);

  // Master 用 settings.json 生成 (T211: UserPromptSubmit/Stop hook を同梱)
  const masterSettingsPath = generateMasterSettings(PROJECT_ROOT);

  // モデル解決
  const config = await loadConfig(PROJECT_ROOT);
  const model = getModelForRole(config, "master", getArg("model"));

  // claude を exec
  const { execFileSync } = require("child_process");
  try {
    execFileSync("claude", [
      "--dangerously-skip-permissions",
      "--settings", masterSettingsPath,
      "--model", model,
      "--append-system-prompt-file", join(PROJECT_ROOT, ".team/prompts/master.md"),
    ], {
      stdio: "inherit",
      env: process.env,
      cwd: PROJECT_ROOT,
    });
  } catch (e: any) {
    process.exit(e.status ?? 1);
  }
}

async function cmdSpawnConductor(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_spawn_conductor"));
  const surface = process.env.CMUX_SURFACE ?? await cmux.getCallerSurface();

  // T253: launchConductor は mainBranch required。env → config の順で解決し、
  //   空なら fail-stop（cmdConductor と同じロジック）
  const spawnConfig = await loadConfig(PROJECT_ROOT);
  const envMainBranch = process.env.CMUX_TEAM_MAIN_BRANCH?.trim();
  const mainBranch = envMainBranch || spawnConfig.mainBranch?.trim() || "";
  if (!mainBranch) {
    console.error(
      "Error: config.mainBranch is not set and CMUX_TEAM_MAIN_BRANCH is empty. " +
        "Run `cmux-team start` first to detect and persist the main branch, " +
        "or set CMUX_TEAM_MAIN_BRANCH=<your-branch> explicitly.",
    );
    await log(
      "spawn_conductor_main_branch_missing",
      "reason=env_and_config_missing",
    );
    process.exit(1);
  }

  await launchConductor(PROJECT_ROOT, surface, { mainBranch });
  console.log(`SURFACE=${surface}`);
}

async function cmdSpawnAgent(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_spawn_agent", { model: DEFAULT_MODEL }));
  let conductorSurface: string;
  try {
    conductorSurface = await normalizeSurfaceArg(requireArg("conductor-surface"));
  } catch (e: any) {
    console.error(`Error: ${e?.message ?? e}`);
    process.exit(1);
  }
  const role = requireArg("role");
  const prompt = getArg("prompt");
  const promptFile = getArg("prompt-file");
  let taskTitle = getArg("task-title");
  if (!prompt && !promptFile) {
    console.error("Error: --prompt or --prompt-file is required");
    process.exit(1);
  }

  // --- direnv allow fail-fast チェック ---
  // cmdStart と同じく、.envrc が未 allow なら Agent を spawn せず即 exit する。
  // 引数検証を全てパスした後・throttle ガードより前で実行する。
  const direnvStatus = await checkDirenvAllowed(PROJECT_ROOT);
  if (direnvStatus === "not_allowed") {
    console.error(formatDirenvNotAllowedMessage(PROJECT_ROOT));
    await log("direnv_not_allowed", `command=spawn-agent role=${role}`);
    process.exit(1);
  }
  // no_direnv / no_envrc / ok は続行（spawn-agent 側では警告表示は行わない）

  // --- 1. プロキシポート読み取り + 生存確認 ---
  const proxyPort = await resolveProxyPort();

  // team.json から conductor 情報を前倒しで解決（throttle ログでも taskId を参照するため）
  let worktreePath: string | undefined;
  let taskId: string | undefined;
  try {
    const teamJson = JSON.parse(await readFile(join(PROJECT_ROOT, ".team/team.json"), "utf-8"));
    const conductors: any[] = teamJson.conductors ?? [];
    const conductor = conductors.find((c: any) => c.surface === conductorSurface);
    worktreePath = conductor?.worktreePath;
    taskId = conductor?.taskId;
    if (!taskTitle) taskTitle = conductor?.taskTitle;
  } catch {}

  // --- 1.5 throttle ガード ---
  // exit 75 = BSD sysexits EX_TEMPFAIL（一時的失敗、retry 可能）
  if (proxyPort) {
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/rate-limit`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const rl = await resp.json() as {
          throttled: boolean;
          unified5hReset: number | null;
          unified5hUtilization: number | null;
          resetRemaining: string | null;
        };
        if (rl.throttled) {
          const util = rl.unified5hUtilization ?? 0;
          console.log(`THROTTLED=true`);
          console.log(`RESET_EPOCH=${rl.unified5hReset ?? 0}`);
          console.log(`RESET_REMAINING=${rl.resetRemaining ?? ""}`);
          console.log(`UTILIZATION=${(util * 100).toFixed(1)}%`);
          console.log(`THRESHOLD=${(THROTTLE_5H_THRESHOLD * 100).toFixed(0)}%`);
          console.log(`MESSAGE=Rate limit exceeded. Wait until RESET_EPOCH before retrying spawn-agent.`);
          await log("spawn_agent_throttled",
            `conductor=${conductorSurface} role=${role} task_id=${taskId ?? "-"} util=${(util * 100).toFixed(1)}% unified5hReset=${rl.unified5hReset ?? "null"}`);
          process.exit(75);
        }
      } else {
        await log("spawn_agent_ratelimit_warn", `status=${resp.status}`);
      }
    } catch (e: any) {
      await log("spawn_agent_ratelimit_warn", `fetch_failed=${e?.message ?? e}`);
      // best-effort: 続行
    }
  }

  // --- 2. タブ作成（new-surface → new-split right フォールバック） ---
  //   T207: 対象 pane はキャッシュせず、cmux tree から on-demand 解決する。
  //   解決失敗時は undefined のまま newSurface に渡し、cmux 側のデフォルト pane に
  //   作成 → 失敗時は new-split right のフォールバック経路に乗せる。
  const callerWorkspace = await cmux.getCallerWorkspace();
  const targetPane = await cmux.getPaneForSurface(conductorSurface, callerWorkspace);

  let surface: string;
  try {
    surface = await cmux.newSurface(targetPane);
  } catch {
    surface = await cmux.newSplit("right");
  }

  // T195: newSurface / newSplit 成功時点で surface は cmux 側に存在する。
  // 念押しの validation は deadlock リスクを招くため廃止。

  // --- 2a. AGENT_SPAWNED を Claude 起動より前に daemon へ送信（T244） ---
  //   Claude 起動 (L2068 send(claudeCmd)) で SessionStart hook が発火し SESSION_STARTED
  //   を daemon に POST する。AGENT_SPAWNED がそれより後に届くと、daemon 側の
  //   SESSION_STARTED fallback 経路が「未登録 surface = master」と誤判定して
  //   state.masters に仮登録してしまう（現象: master_session_started_fallback）。
  //   それを防ぐため、surface 作成直後・Claude 起動前に AGENT_SPAWNED を先行送信する。
  await postMessage({
    type: "AGENT_SPAWNED",
    conductorSurface,
    surface,
    role,
    taskTitle,
    timestamp: new Date().toISOString(),
    // T260: spawn-agent を実行した主体（通常は Conductor surface / pid）を記録し、
    //       daemon 側で `caller=...` として agent_spawned ログに載せる。
    callerPid: process.pid,
    callerSurface: process.env.CMUX_SURFACE,
  });

  // --- 3. Claude Code 起動 ---
  // モデル解決
  const config = await loadConfig(PROJECT_ROOT);
  const model = getModelForRole(config, "agent", getArg("model"));

  // Agent 用 settings.json 生成（T181: Stop / SessionEnd hook + statusLine）
  const agentSettingsPath = generateAgentSettings(PROJECT_ROOT, surface);
  const agentSettingsFlag = `--settings '${agentSettingsPath}'`;

  // 環境変数をシェルに焼き付け
  // T283: Agent は worktree 配下で作業し、main project の sync 責務を負わない。
  // `cmdSpawnAgent` は独立 cmux surface を作るため、Conductor shell に env を
  // 足しても伝わらない。そのため Agent 経路では無条件に
  // `CMUX_TEAM_SKIP_SYNC_CHECK=1` を exportVars に追記する（ST8b）。
  const exportVars = [
    `ROLE=${role}`,
    `PROJECT_ROOT=${PROJECT_ROOT}`,
    `CMUX_SURFACE=${surface}`,
    `CMUX_NO_RENAME_TAB=1`,
    `CMUX_CLAUDE_HOOKS_DISABLED=1`,
    `CMUX_TEAM_SKIP_SYNC_CHECK=1`,
  ];
  if (taskId) {
    exportVars.push(`CMUX_TASK_ID=${taskId}`);
  }
  if (proxyPort) {
    exportVars.push(`ANTHROPIC_BASE_URL=http://127.0.0.1:${proxyPort}`);
  }
  await cmux.send(surface, `export ${exportVars.join(" ")}\n`);
  await sleep(500);

  // worktree ディレクトリに移動
  if (worktreePath) {
    await cmux.send(surface, `cd ${worktreePath}\n`);
    await sleep(500);
    await cmux.send(surface, `direnv allow 2>/dev/null\n`);
    await sleep(500);
  }

  // Claude Code 起動
  const claudeFlags = ["--dangerously-skip-permissions"];
  if (agentSettingsFlag) {
    claudeFlags.push(agentSettingsFlag);
  }
  claudeFlags.push(`--model ${model}`);

  // T247: prompt-file 内の {{PROJECT_INSTRUCTIONS}} を overlay で展開する。
  // 展開後は `.team/prompts/<basename>.expanded.md` に書き出し、その path を Claude に渡す。
  // 失敗時は元の promptFile にフォールバック。
  let effectivePromptFile = promptFile;
  if (promptFile) {
    try {
      const original = await readFile(promptFile, "utf-8");
      const { expanded, mode } = await expandProjectInstructions(PROJECT_ROOT, role, original);
      if (mode !== "noop" && expanded !== original) {
        const base = basename(promptFile, ".md");
        const expandedPath = join(PROJECT_ROOT, ".team/prompts", `${base}.expanded.md`);
        await mkdir(dirname(expandedPath), { recursive: true });
        await writeFile(expandedPath, expanded, "utf-8");
        effectivePromptFile = expandedPath;
      }
      await log(
        "spawn_agent_expand",
        `role=${role} mode=${mode} prompt_file=${promptFile}${effectivePromptFile !== promptFile ? ` expanded=${effectivePromptFile}` : ""}`,
      );
    } catch (e: any) {
      await log("spawn_agent_expand_failed", `role=${role} prompt_file=${promptFile} error=${e?.message ?? e}`);
      // 元の promptFile でフォールバック
      effectivePromptFile = promptFile;
    }
  }

  let claudeCmd: string;
  if (effectivePromptFile) {
    claudeCmd = `claude ${claudeFlags.join(" ")} '${effectivePromptFile} を読んで指示に従ってください。'`;
  } else {
    claudeCmd = `claude ${claudeFlags.join(" ")} '${prompt}'`;
  }
  await cmux.send(surface, claudeCmd + "\n");

  // --- 4. タブ名設定 ---
  const num = surface.replace("surface:", "");
  await cmux.renameTab(surface, `[${num}] Agent`);

  // タスク-セッション索引に記録
  try {
    const teamJson2 = JSON.parse(await readFile(join(PROJECT_ROOT, ".team/team.json"), "utf-8"));
    const cond = teamJson2?.conductors?.find((c: any) => c.surface === conductorSurface);
    if (cond?.taskId) {
      const db = initDB(PROJECT_ROOT);
      insertTaskSession(db, {
        timestamp: new Date().toISOString(),
        task_id: cond.taskId,
        task_run_id: cond.taskRunId,
        session_id: "",
        role,
        surface,
        worktree_path: worktreePath,
        event: "agent_spawned",
      });
      db.close();
    }
  } catch (e: any) {
    log("error", `trace DB agent_spawned insert failed: ${e?.message ?? e}`).catch(() => {});
  }

  // --- 7. stdout に surface を出力 ---
  console.log(`SURFACE=${surface}`);
}

async function cmdAgents(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_agents"));
  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  if (!existsSync(teamJsonPath)) {
    console.log(t("team_not_started"));
    return;
  }

  const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
  const conductors: Array<{
    taskId: string;
    taskTitle?: string;
    surface: string;
    agents?: Array<{ surface: string; role?: string; sessionId?: string }>;
  }> = teamJson.conductors || [];

  let agentCount = 0;
  for (const c of conductors) {
    const agents = c.agents || [];
    for (const a of agents) {
      agentCount++;
      const rolePart = a.role ? `role=${a.role}` : "role=unknown";
      const sessionPart = a.sessionId ? `  session=${a.sessionId}` : "";
      console.log(`${a.surface}  ${rolePart}  conductor=${c.surface}  task=${c.taskId}${sessionPart}`);
    }
  }

  if (agentCount === 0) {
    console.log(t("no_running_agents"));
  }
}

async function cmdKillAgent(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_kill_agent"));
  let surface: string;
  try {
    surface = await normalizeSurfaceArg(requireArg("surface"));
  } catch (e: any) {
    console.error(`Error: ${e?.message ?? e}`);
    process.exit(1);
  }

  // surface を閉じる（closeSurface は SESSION_ENDED を送信しないため、明示的に通知する）
  await cmux.closeSurface(surface);

  // daemon に SESSION_ENDED を通知して agents リストから削除させる
  await postMessage({
    type: "SESSION_ENDED",
    surface,
    reason: "kill-agent",
    timestamp: new Date().toISOString(),
  });

  console.log(`OK killed ${surface}`);
}

async function cmdCloseAgent(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_close_agent"));
  let surface: string;
  try {
    surface = await normalizeSurfaceArg(requireArg("surface"));
  } catch (e: any) {
    console.error(`Error: ${e?.message ?? e}`);
    process.exit(1);
  }

  // surface を閉じる（closeSurface は SESSION_ENDED を送信しないため、明示的に通知する）
  await cmux.closeSurface(surface);

  // daemon に SESSION_ENDED を通知して agents リストから削除させる。
  // reason="close-agent" により daemon 側で status="completed" として done マーカーが書かれる。
  await postMessage({
    type: "SESSION_ENDED",
    surface,
    reason: "close-agent",
    timestamp: new Date().toISOString(),
  });

  console.log(`OK closed ${surface}`);
}

/**
 * `cmdSendAgent` で使用する検証結果の型。
 * reason は理由別ログ/エラーメッセージの分岐に使う。
 */
export type SendAgentValidationReason =
  | "not_a_conductor"
  | "agent_not_found"
  | "self_send";

export type SendAgentValidationResult =
  | { ok: true }
  | { ok: false; reason: SendAgentValidationReason };

/**
 * team.json と caller/target surface から send-agent の可否を判定する。
 * ファイル I/O を行わないため単体テストが容易。
 */
export function validateSendAgentTarget(
  teamJson: any,
  callerSurface: string,
  targetSurface: string,
): SendAgentValidationResult {
  if (callerSurface === targetSurface) {
    return { ok: false, reason: "self_send" };
  }
  const conductors: any[] = teamJson?.conductors ?? [];
  const conductor = conductors.find((c: any) => c.surface === callerSurface);
  if (!conductor) {
    return { ok: false, reason: "not_a_conductor" };
  }
  const agent = (conductor.agents ?? []).find((a: any) => a.surface === targetSurface);
  if (!agent) {
    return { ok: false, reason: "agent_not_found" };
  }
  return { ok: true };
}

/**
 * team.json の反映ラグを吸収するため、agent_not_found の場合のみリトライする。
 * 200ms × 最大 5 回（合計 1 秒）。他の reject 理由は恒久的なのでリトライしない。
 */
export async function waitForAgentRegistered(
  teamJsonPath: string,
  callerSurface: string,
  targetSurface: string,
  opts: { maxRetries?: number; intervalMs?: number } = {},
): Promise<SendAgentValidationResult> {
  const maxRetries = opts.maxRetries ?? 5;
  const intervalMs = opts.intervalMs ?? 200;
  let lastResult: SendAgentValidationResult = { ok: false, reason: "agent_not_found" };
  for (let i = 0; i < maxRetries; i++) {
    if (!existsSync(teamJsonPath)) {
      // team.json が未生成: agent_not_found 扱いで retry ループに乗せる
      lastResult = { ok: false, reason: "agent_not_found" };
    } else {
      try {
        const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
        lastResult = validateSendAgentTarget(teamJson, callerSurface, targetSurface);
      } catch {
        lastResult = { ok: false, reason: "agent_not_found" };
      }
      if (lastResult.ok) return lastResult;
      if (lastResult.reason !== "agent_not_found") return lastResult;
    }
    if (i < maxRetries - 1) await sleep(intervalMs);
  }
  return lastResult;
}

async function cmdSendAgent(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_send_agent"));
  let targetSurface: string;
  try {
    targetSurface = await normalizeSurfaceArg(requireArg("surface"));
  } catch (e: any) {
    console.error(`Error: ${e?.message ?? e}`);
    process.exit(1);
  }

  // メッセージは positional 引数（複数個の場合は space で join）
  const flags = new Set(["--surface", "--no-return"]);
  const messageParts: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "--surface") { i++; continue; }
    if (flags.has(a)) continue;
    if (a.startsWith("--")) continue;
    messageParts.push(a);
  }
  const message = messageParts.join(" ");
  if (!message) {
    console.error("Error: <message> is required");
    process.exit(1);
  }
  const noReturn = args.includes("--no-return");

  // caller surface の解決
  let callerSurface = process.env.CMUX_SURFACE;
  if (!callerSurface) {
    try {
      callerSurface = await cmux.getCallerSurface();
    } catch {
      console.error("Error: CMUX_SURFACE が未設定で、cmux identify でも取得できません。Conductor 環境から実行してください。");
      process.exit(1);
    }
  }

  await log("send_agent_started", `caller=${callerSurface} target=${targetSurface}`);

  // team.json の存在確認
  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  if (!existsSync(teamJsonPath)) {
    console.error("Error: .team/team.json not found. cmux-team start を実行してください。");
    await log(
      "send_agent_rejected",
      `caller=${callerSurface} target=${targetSurface} reason=team_json_missing`,
    );
    process.exit(1);
  }

  // 自己送信は即時 reject（retry しても通らないため）
  if (callerSurface === targetSurface) {
    console.error(
      `Error: 自分自身 (${callerSurface}) には送信できません。cmux-team send-agent は自分が spawn した Agent 宛のみ使用可能です。`,
    );
    await log(
      "send_agent_rejected",
      `caller=${callerSurface} target=${targetSurface} reason=self_send`,
    );
    process.exit(1);
  }

  // team.json 反映ラグに対する retry（agent_not_found のみ）
  const result = await waitForAgentRegistered(teamJsonPath, callerSurface, targetSurface);
  if (!result.ok) {
    if (result.reason === "not_a_conductor") {
      console.error(
        `Error: caller surface ${callerSurface} は Conductor として登録されていません。`,
      );
    } else {
      console.error(
        `Error: surface ${targetSurface} はこの Conductor (${callerSurface}) が spawn した Agent ではありません。`,
      );
    }
    await log(
      "send_agent_rejected",
      `caller=${callerSurface} target=${targetSurface} reason=${result.reason}`,
    );
    process.exit(1);
  }

  // T195: Agent の PID を team.json から引いて生存確認する（PID ベース）。
  // pid 未反映ウィンドウに備えて 200ms × 3 リトライする。
  let targetAgentPid: number | undefined;
  for (let i = 0; i < 3; i++) {
    try {
      const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
      const conductors: any[] = teamJson?.conductors ?? [];
      for (const c of conductors) {
        const ag = (c.agents ?? []).find((a: any) => a.surface === targetSurface);
        if (ag?.pid) {
          targetAgentPid = ag.pid;
          break;
        }
      }
    } catch {}
    if (typeof targetAgentPid === "number") break;
    await sleep(200);
  }

  const workspace = await cmux.getCallerWorkspace();
  if (typeof targetAgentPid !== "number" || !cmux.isAlive(targetAgentPid)) {
    const reason = typeof targetAgentPid !== "number" ? "no_pid_in_team_json" : "pid_dead";
    console.error(`Error: surface ${targetSurface} is not alive (${reason})`);
    await log(
      "send_agent_rejected",
      `caller=${callerSurface} target=${targetSurface} reason=${reason}`,
    );
    process.exit(1);
  }

  // 送信
  try {
    await cmux.send(targetSurface, message, { workspace });
    if (!noReturn) {
      await sleep(500);
      await cmux.sendKey(targetSurface, "return", { workspace });
    }
  } catch (e: any) {
    await log(
      "error",
      `send-agent failed: caller=${callerSurface} target=${targetSurface} ${e?.message ?? e} stderr=${e?.stderr ?? ""}`,
    );
    throw e;
  }

  await log(
    "send_agent_completed",
    `caller=${callerSurface} target=${targetSurface} bytes=${message.length}`,
  );
  console.log(`OK sent to ${targetSurface}`);
}

/**
 * T283: ready 昇格時に local `<mainBranch>` と `origin/<mainBranch>` の整合性を
 * 検証する共通ヘルパ。cmdCreateTask / cmdUpdateTask の両方から呼び出す。
 *
 * - status が "ready" でない / `--force` / `CMUX_TEAM_SKIP_SYNC_CHECK=1` の
 *   いずれかで skip する
 * - loadConfig().mainBranch が未設定ならログのみ出して skip（cmdStart 前に
 *   タスクを切る UX を殺さないため。Decision Log D11）
 * - reject なら console.error + exit 1、warn なら console.warn + 続行
 */
async function runSyncCheckOrExit(opts: {
  status: string | undefined;
  forceFlag: boolean;
  skipFetch: boolean;
  phase: "create" | "update";
  taskId?: string;
}): Promise<void> {
  if (opts.status !== "ready") return;
  if (opts.forceFlag) {
    await log(
      "ready_force_bypass",
      `phase=${opts.phase}${opts.taskId ? ` task_id=${opts.taskId}` : ""}`,
    );
    return;
  }
  if (process.env.CMUX_TEAM_SKIP_SYNC_CHECK === "1") {
    await log(
      "ready_sync_skipped",
      `phase=${opts.phase} reason=env${opts.taskId ? ` task_id=${opts.taskId}` : ""}`,
    );
    return;
  }

  const config = await loadConfig(PROJECT_ROOT);
  const mainBranch = config.mainBranch?.trim();
  if (!mainBranch) {
    await log(
      "ready_sync_skipped",
      `phase=${opts.phase} reason=no_main_branch${opts.taskId ? ` task_id=${opts.taskId}` : ""}`,
    );
    return;
  }

  const { checkSyncState } = await import("./git-sync");
  const result = await checkSyncState(PROJECT_ROOT, {
    mainBranch,
    doFetch: !opts.skipFetch,
  });
  const taskIdField = opts.taskId ? ` task_id=${opts.taskId}` : "";
  if (result.verdict.kind === "reject") {
    await log(
      "ready_rejected",
      `phase=${opts.phase} state=${result.state}${taskIdField}`,
    );
    console.error(result.verdict.message);
    process.exit(1);
  }
  if (result.verdict.kind === "warn") {
    await log(
      "ready_warning",
      `phase=${opts.phase} state=${result.state}${taskIdField}`,
    );
    console.warn(result.verdict.message);
  }
}

async function cmdCreateTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_create_task"));
  const title = requireArg("title");
  const priority = (getArg("priority") || "medium") as "high" | "medium" | "low";
  const status = getArg("status") || "draft";
  const body = getArg("body") || "";
  const baseBranch = getArg("base-branch") || "";
  const dependsOnRaw = getArg("depends-on") || "";
  const runAfterAllArg = process.argv.includes("--run-after-all");
  const exclusiveArg = process.argv.includes("--exclusive");
  // --exclusive は --run-after-all を暗黙に含む
  const runAfterAll = runAfterAllArg || exclusiveArg;
  const exclusive = exclusiveArg;
  const kind = getArg("kind") || "";

  if (runAfterAllArg && exclusiveArg) {
    await log(
      "create_task_redundant_flags",
      `title=${title} note=--exclusive implies --run-after-all`,
    );
  }

  // T283: ready で作成するなら sync state をチェック。reject なら exit 1
  await runSyncCheckOrExit({
    status,
    forceFlag: hasFlag("force"),
    skipFetch: hasFlag("skip-fetch"),
    phase: "create",
  });

  let dependsOn: string[];
  try {
    dependsOn = normalizeTaskIdList(dependsOnRaw);
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  let result: { id: string; filePath: string; relPath: string };
  try {
    result = await createTaskProgrammatic(PROJECT_ROOT, {
      title,
      priority,
      status,
      body,
      baseBranch: baseBranch || undefined,
      dependsOn,
      runAfterAll,
      exclusive,
      kind: kind || undefined,
      sectionHeader: t("task_section_header"),
      // T229: 作成元 surface を CMUX_SURFACE から拾い createdBy として記録する
      createdBy: process.env.CMUX_SURFACE,
    });
  } catch (e: any) {
    if (e?.code === "RUN_AFTER_ALL_CONFLICT") {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  // status が ready の場合のみ TASK_CREATED を送信
  if (status === "ready") {
    await postMessage({
      type: "TASK_CREATED",
      taskId: result.id,
      taskFile: result.filePath,
      timestamp: new Date().toISOString(),
    });
  }

  console.log(`TASK_ID=${result.id} FILE=${result.relPath}`);
}

async function cmdUpdateTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_update_task"));
  // T291: --task-id に slug / ディレクトリ名を渡された場合でも frontmatter id: を
  //       canonical key として扱う。以降の taskState[taskId] / postMessage({ taskId })
  //       は canonical id で統一される。エラー表示は元の入力値を使う。
  const taskIdInput = requireArg("task-id");
  const canonical = await resolveCanonicalTaskId(taskIdInput);
  if (!canonical) {
    console.error(`Error: task ${taskIdInput} not found in .team/tasks/`);
    process.exit(1);
  }
  const taskId = canonical;
  const newStatus = getArg("status");
  const body = getArg("body");
  const title = getArg("title");
  const dependsOn = getArg("depends-on");

  if (newStatus === undefined && body === undefined && title === undefined && dependsOn === undefined) {
    console.error("Error: at least one of --status, --body, --title, or --depends-on is required");
    process.exit(1);
  }

  const taskFile = await findTaskFile(taskId);
  if (!taskFile) {
    console.error(`Error: task ${taskId} not found in .team/tasks/`);
    process.exit(1);
  }

  // ステータス遷移ガード
  const taskState = await loadTaskState(PROJECT_ROOT);
  const currentStatus = taskState[taskId]?.status;

  if (currentStatus === "assigned") {
    console.error(`Error: task ${taskId} is assigned (running). Cannot update a running task. Create a new task instead.`);
    process.exit(1);
  }
  if (currentStatus === "closed") {
    console.error(`Error: task ${taskId} is closed. Cannot reopen a closed task. Use create-task to create a new one.`);
    process.exit(1);
  }

  // --title: frontmatter 内の title 行を更新
  if (title !== undefined) {
    const content = await readFile(taskFile, "utf-8");
    const updated = content.replace(/^title:\s*.+$/m, `title: ${title}`);
    await writeFile(taskFile, updated);
  }

  // --depends-on: frontmatter 内の depends_on 行を更新（なければ追加）
  if (dependsOn !== undefined) {
    let depsArray: string[];
    try {
      depsArray = normalizeTaskIdList(dependsOn);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    const depsValue = depsArray.length > 0 ? `[${depsArray.join(", ")}]` : "[]";
    let content = await readFile(taskFile, "utf-8");
    if (content.match(/^depends_on:\s*.+$/m)) {
      // 既存の depends_on 行を更新
      content = content.replace(/^depends_on:\s*.+$/m, `depends_on: ${depsValue}`);
    } else {
      // depends_on 行がなければ、frontmatter の最後の --- 前に追加
      const fmEnd = content.indexOf("---", content.indexOf("---") + 3);
      content = content.slice(0, fmEnd) + `depends_on: ${depsValue}\n` + content.slice(fmEnd);
    }
    await writeFile(taskFile, content);
  }

  // --body: frontmatter 以降の本文を差し替え
  if (body !== undefined) {
    const content = await readFile(taskFile, "utf-8");
    const fmEnd = content.indexOf("---", content.indexOf("---") + 3);
    const frontmatter = content.slice(0, fmEnd + 3);
    await writeFile(taskFile, frontmatter + "\n\n" + body + "\n");
  }

  // --status: task-state.json を更新
  let notifiedTaskCreated = false;
  if (newStatus !== undefined) {
    // T283: ready への遷移なら sync state をチェック。reject なら exit 1
    await runSyncCheckOrExit({
      status: newStatus,
      forceFlag: hasFlag("force"),
      skipFetch: hasFlag("skip-fetch"),
      phase: "update",
      taskId,
    });

    taskState[taskId] = { ...taskState[taskId], status: newStatus };
    await saveTaskState(PROJECT_ROOT, taskState);

    // ready に変更された場合は TASK_CREATED を送信
    if (newStatus === "ready") {
      await postMessage({
        type: "TASK_CREATED",
        taskId,
        taskFile,
        timestamp: new Date().toISOString(),
      });
      notifiedTaskCreated = true;
    }
  }

  // TASK_CREATED を送らなかった変更でも TUI 即時反映のため TASK_UPDATED を送る。
  // title/body/depends-on の更新、および ready 以外への status 変更を対象にする。
  if (!notifiedTaskCreated) {
    await postMessage({
      type: "TASK_UPDATED",
      taskId,
      taskFile,
      timestamp: new Date().toISOString(),
    });
  }

  const parts: string[] = [];
  if (newStatus !== undefined) parts.push(`status=${newStatus}`);
  if (title !== undefined) parts.push("title updated");
  if (body !== undefined) parts.push("body updated");
  if (dependsOn !== undefined) parts.push("depends_on updated");
  console.log(`OK updated ${taskId} ${parts.join(", ")}`);
}

/**
 * T295: `close-task` の CLI 引数を pure に解析する。
 *
 * 判定ポリシー:
 * - `--deliverable-kind` 必須。未指定は error
 * - `files` は `--deliverable <path>` を 1 件以上必須、かつ他 kind 用フラグ禁止
 * - `merged` は `--merged-into <branch>` + `--merge-sha <sha>` 必須、他 kind 用フラグ禁止
 * - `pr` は `--pr-url <url>` 必須、他 kind 用フラグ禁止
 * - `none` は全 kind 用フラグ禁止（journal は全 kind optional）
 * - zod による discriminated union の最終 validation も通す（型レベルの safety net）
 *
 * F1 reflection: assigned ガードは「kind が valid に解決されれば通す」方針にしたため、
 * この pure parser は assigned 関連判定を持たない（呼び出し側で taskState を見る）。
 */
export function parseCloseTaskArgs(
  argv: string[],
): { deliverable: Deliverable; journal?: string; force: boolean } | { error: string } {
  const getOne = (name: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const kind = getOne("deliverable-kind");
  const journal = getOne("journal");
  const force = argv.includes("--force");
  const files = getMultiArg(argv, "deliverable");
  const mergedInto = getOne("merged-into");
  const mergeSha = getOne("merge-sha");
  const prUrl = getOne("pr-url");

  if (!kind) {
    return {
      error:
        "--deliverable-kind is required (one of: files, merged, pr, none). " +
        "See `cmux-team close-task --help` for examples.",
    };
  }

  // exclusive check: 他 kind 用フラグが紛れ込んでいたら reject
  const foreignFlags: string[] = [];
  if (kind !== "files" && files.length > 0) foreignFlags.push("--deliverable");
  if (kind !== "merged" && mergedInto !== undefined) foreignFlags.push("--merged-into");
  if (kind !== "merged" && mergeSha !== undefined) foreignFlags.push("--merge-sha");
  if (kind !== "pr" && prUrl !== undefined) foreignFlags.push("--pr-url");
  if (foreignFlags.length > 0) {
    return {
      error: `--deliverable-kind ${kind} does not accept: ${foreignFlags.join(", ")}`,
    };
  }

  let deliverable: Deliverable;
  switch (kind) {
    case "files": {
      if (files.length === 0) {
        return {
          error:
            "--deliverable-kind files requires at least one --deliverable <path>",
        };
      }
      deliverable = { kind: "files", files };
      break;
    }
    case "merged": {
      if (!mergedInto || !mergeSha) {
        return {
          error:
            "--deliverable-kind merged requires both --merged-into <branch> and --merge-sha <sha>",
        };
      }
      deliverable = { kind: "merged", branch: mergedInto, sha: mergeSha };
      break;
    }
    case "pr": {
      if (!prUrl) {
        return {
          error: "--deliverable-kind pr requires --pr-url <url>",
        };
      }
      deliverable = { kind: "pr", prUrl };
      break;
    }
    case "none": {
      deliverable = { kind: "none" };
      break;
    }
    default:
      return {
        error: `--deliverable-kind must be one of: files, merged, pr, none (got: ${kind})`,
      };
  }

  // zod safety net
  const parsed = DeliverableSchema.safeParse(deliverable);
  if (!parsed.success) {
    return { error: `deliverable schema validation failed: ${parsed.error.message}` };
  }

  return { deliverable: parsed.data, journal: journal || undefined, force };
}

async function cmdCloseTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_close_task"));
  // T291: --task-id に slug / ディレクトリ名を渡された場合でも frontmatter id: を
  //       canonical key として扱う。以降の team.json.conductors[].taskId マッチも
  //       canonical id で比較されるため CONDUCTOR_DONE が確実に発射される。
  const taskIdInput = requireArg("task-id");
  const canonical = await resolveCanonicalTaskId(taskIdInput);
  if (!canonical) {
    console.error(`Error: task ${taskIdInput} not found in .team/tasks/`);
    process.exit(1);
  }
  const taskId = canonical;

  // T295: deliverable 引数の解析（kind 必須化）
  const parsed = parseCloseTaskArgs(args);
  if ("error" in parsed) {
    console.error(`Error: ${parsed.error}`);
    process.exit(1);
  }
  const { deliverable, journal, force } = parsed;

  const taskFile = await findTaskFile(taskId);
  if (!taskFile) {
    console.error(`Error: task ${taskId} not found in .team/tasks/`);
    process.exit(1);
  }

  // assigned ガード: --force で明示許可（T295 F1: kind が valid に解決されていれば
  // それが意図の表明なので、journal の有無ではなく --force を唯一の escape にする）
  const taskState = await loadTaskState(PROJECT_ROOT);
  const currentStatus = taskState[taskId]?.status;
  if (currentStatus === "assigned" && !force) {
    console.error(`Error: task ${taskId} is assigned (running). Use --force to close a running task.`);
    process.exit(1);
  }

  // task-state.json で closed + closedAt + journal + deliverable を設定（ファイルは移動しない）
  taskState[taskId] = {
    status: "closed",
    closedAt: new Date().toISOString(),
    ...(journal ? { journal } : {}),
    deliverable,
  };
  await saveTaskState(PROJECT_ROOT, taskState);

  // CONDUCTOR_DONE メッセージ送信（daemon に完了を通知）
  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  let teamJson: any;
  try {
    teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
  } catch {
    // team.json 読めなくても close 自体は成功させる
  }
  const conductor = teamJson?.conductors?.find((c: any) => c.taskId === taskId);
  if (conductor?.surface) {
    await postMessage({
      type: "CONDUCTOR_DONE",
      surface: conductor.surface,
      taskRunId: conductor.taskRunId,
      success: true,
      timestamp: new Date().toISOString(),
    });
  } else {
    // conductor が見つからない場合は CONDUCTOR_DONE による wakeup が発火しない
    // TUI 即時反映のため TASK_UPDATED を送る
    await postMessage({
      type: "TASK_UPDATED",
      taskId,
      taskFile,
      timestamp: new Date().toISOString(),
    });
  }

  // タスク-セッション索引に記録
  try {
    const db = initDB(PROJECT_ROOT);
    insertTaskSession(db, {
      timestamp: new Date().toISOString(),
      task_id: taskId,
      task_run_id: conductor?.taskRunId,
      session_id: conductor?.sessionId ?? "",
      role: "conductor",
      surface: conductor?.surface,
      event: "closed",
    });
    db.close();
  } catch (e: any) {
    log("error", `trace DB closed insert failed: ${e?.message ?? e}`).catch(() => {});
  }

  console.log(`OK closed ${taskId}`);
}

async function cmdAwaitTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_await_task"));

  const taskIdRaw = requireArg("task-id");
  const timeoutSec = parseInt(getArg("timeout") ?? "3600", 10);

  // カンマ区切りで複数タスク ID をサポート
  const taskIds = taskIdRaw.split(",").map(s => s.trim()).filter(Boolean);

  if (taskIds.length === 0) {
    console.error("Error: --task-id requires at least one task ID");
    process.exit(1);
  }

  // 即座に現在の状態を確認（既に closed/aborted かもしれない）
  const initialState = await loadTaskState(PROJECT_ROOT);
  const remaining = new Set(taskIds);

  for (const id of taskIds) {
    const st = initialState[id];
    if (!st) {
      console.error(`Error: task ${id} not found in task-state.json`);
      process.exit(1);
    }
    if (st.status === "closed") {
      remaining.delete(id);
    }
    if (st.status === "aborted") {
      console.error(formatAbortedTaskLine(id, st.journal));
      process.exit(1);
    }
  }

  // 既に全部 closed ならすぐ結果を出力して終了
  if (remaining.size === 0) {
    await printSummaries(taskIds);
    process.exit(0);
  }

  // fs.watch で task-state.json を監視
  const taskStateFile = join(PROJECT_ROOT, ".team/task-state.json");
  const ac = new AbortController();

  // タイムアウトタイマー
  const timer = setTimeout(() => {
    ac.abort();
    console.error(`Timeout: ${timeoutSec}s elapsed, tasks still pending: ${[...remaining].join(",")}`);
    process.exit(2);
  }, timeoutSec * 1000);

  try {
    const watcher = watch(taskStateFile, { signal: ac.signal }, async () => {
      try {
        const state = await loadTaskState(PROJECT_ROOT);
        for (const id of [...remaining]) {
          const st = state[id];
          if (st?.status === "closed") {
            remaining.delete(id);
          }
          if (st?.status === "aborted") {
            clearTimeout(timer);
            watcher.close();
            console.error(formatAbortedTaskLine(id, st.journal));
            process.exit(1);
          }
        }
        if (remaining.size === 0) {
          clearTimeout(timer);
          watcher.close();
          await printSummaries(taskIds);
          process.exit(0);
        }
      } catch {
        // JSON パースエラーなどは無視（一時ファイル書き込み中の可能性）
      }
    });
  } catch (e: any) {
    if (e?.name === "AbortError") return;
    throw e;
  }
}

/**
 * cmux-team await-agent — Agent の完了/ask/crash を done マーカー経由で待つ (T181)。
 *
 * 設計:
 *   - daemon が `.team/conductors/<c>/agent-done/<a>.done` を書く → fs.watch で即検出
 *   - `cmdAwaitTask` と同じく watcher 先起動 + existsSync の 3 段構えで TOCTOU race を解消
 *   - 起動時刻 (startedAt) より古い `timestamp_ms` の done は残骸として skip + unlink
 *   - STATUS=completed / ask → exit 0, crashed → exit 10, timeout → exit 2
 *
 * 注意: `await-agent` は Agent プロセスの wait ではなく done ファイルの fs.watch であり、
 * rate limit (429) を直接は受けない。Agent 側の Claude CLI が 429 で止まった場合は:
 *   - 内部リトライ → timeout で再 await
 *   - SessionEnd → STATUS=crashed で Conductor が判断して spawn-agent/send-agent で再開
 * のいずれかに倒れる（plan §8.3 / §10.2）。
 */
async function cmdAwaitAgent(): Promise<void> {
  if (hasHelpFlag()) {
    showHelp([
      "Usage: cmux-team await-agent --surface <agent-surface> [--timeout <sec>]",
      "",
      "Wait for an agent's done marker (completed / ask / crashed / timeout).",
      "",
      "Options:",
      "  --surface <s>   Target agent surface (required)",
      "  --timeout <n>   Timeout seconds (default: 600)",
      "",
      "Exit codes:",
      "  0  completed or ask",
      "  2  timeout",
      "  10 crashed",
      "  1  internal error",
    ].join("\n"));
  }

  let surface: string;
  try {
    surface = await normalizeSurfaceArg(requireArg("surface"));
  } catch (e: any) {
    console.error(`Error: ${e?.message ?? e}`);
    process.exit(1);
  }
  const timeoutSec = parseInt(getArg("timeout") ?? "600", 10);

  // team.json から agent の所属 Conductor を逆引き
  const conductorSurface = await findConductorSurfaceForAgent(surface);
  if (!conductorSurface) {
    console.error(`Error: agent surface ${surface} not registered in team.json`);
    process.exit(1);
  }

  const doneDir = join(
    PROJECT_ROOT,
    ".team/conductors",
    normalizeSurfaceForPath(conductorSurface),
    "agent-done",
  );
  const doneFileName = `${normalizeSurfaceForPath(surface)}.done`;
  const doneFile = join(doneDir, doneFileName);
  await mkdir(doneDir, { recursive: true });

  // startedAt より古い done は「前回の残骸」として skip する (plan §8.4)
  const startedAt = Date.now();

  const ac = new AbortController();
  let watcherClosed = false;
  const timer = setTimeout(() => {
    watcherClosed = true;
    ac.abort();
    console.log("STATUS=timeout");
    process.exit(2);
  }, timeoutSec * 1000);

  const handleDoneIfFresh = async (): Promise<boolean> => {
    if (!existsSync(doneFile)) return false;
    let content: string;
    try {
      content = await readFile(doneFile, "utf-8");
    } catch {
      return false;
    }
    const tsMatch = /^timestamp_ms=(\d+)/m.exec(content);
    const ts = tsMatch ? Number(tsMatch[1]) : 0;
    // 古い done は残骸として除去
    if (ts && ts < startedAt) {
      await unlink(doneFile).catch(() => {});
      return false;
    }
    clearTimeout(timer);
    watcherClosed = true;
    ac.abort();
    await printAgentDoneAndExit(doneFile, content);
    return true;
  };

  // watcher を先に起動してから存在チェック → 書き込みのタイミングがどちらに転んでも拾える
  try {
    const { watch: watchAsync } = await import("fs/promises");
    (async () => {
      try {
        for await (const ev of watchAsync(doneDir, { signal: ac.signal })) {
          if (watcherClosed) break;
          if (ev.filename !== doneFileName) continue;
          await handleDoneIfFresh();
        }
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        console.error(`Error: watcher failed: ${e.message}`);
        process.exit(1);
      }
    })();
  } catch (e: any) {
    console.error(`Error: failed to start watcher: ${e.message}`);
    process.exit(1);
  }

  // watcher セットアップ後に「既に書かれていないか」再チェック
  await handleDoneIfFresh();
}

/** done ファイルの key=value を STDOUT に大文字化して出し、STATUS に応じて exit する。 */
async function printAgentDoneAndExit(doneFile: string, content: string): Promise<never> {
  const out = content
    .split("\n")
    .map(line => {
      const idx = line.indexOf("=");
      if (idx <= 0) return line;
      return line.slice(0, idx).toUpperCase() + line.slice(idx);
    })
    .join("\n");
  process.stdout.write(out.endsWith("\n") ? out : out + "\n");

  const status = /^STATUS=(\w+)/m.exec(out)?.[1];
  const code =
    status === "completed" || status === "ask" ? 0 :
    status === "crashed" ? 10 :
    1;

  // 次回 await-agent が古い done を誤検出しないよう削除する（同期点）
  await unlink(doneFile).catch(() => {});
  process.exit(code);
}

/** team.json から Agent surface の所属 Conductor surface を逆引きする */
async function findConductorSurfaceForAgent(agentSurface: string): Promise<string | null> {
  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  if (!existsSync(teamJsonPath)) return null;
  try {
    const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8")) as {
      conductors?: Array<{ surface: string; agents?: Array<{ surface: string }> }>;
    };
    for (const c of teamJson.conductors ?? []) {
      if (c.agents?.some(a => a.surface === agentSurface)) return c.surface;
    }
  } catch {}
  return null;
}

/** タスクの summary.md を探して stdout にダンプする */
async function printSummaries(taskIds: string[]): Promise<void> {
  for (const id of taskIds) {
    const taskFile = await findTaskFile(id);
    if (!taskFile) continue;

    // タスクディレクトリ形式の場合: .team/tasks/NNN-slug/runs/task-NNN-*/summary.md
    const taskDir = taskFile.endsWith("/task.md")
      ? dirname(taskFile)
      : null;

    if (taskDir) {
      const runsDir = join(taskDir, "runs");
      if (existsSync(runsDir)) {
        const runs = await readdir(runsDir);
        const sorted = runs.filter(r => r.startsWith(`task-${id}-`)).sort();
        const latestRun = sorted[sorted.length - 1];
        if (latestRun) {
          const summaryPath = join(runsDir, latestRun, "summary.md");
          if (existsSync(summaryPath)) {
            const content = await readFile(summaryPath, "utf-8");
            if (taskIds.length > 1) {
              console.log(`\n--- Task ${id} ---`);
            }
            console.log(content);
            continue;
          }
        }
      }
    }

    // summary が見つからない場合は journal を出力
    // T290: aborted は reason prefix を parseAbortJournal で復元して表示
    const state = await loadTaskState(PROJECT_ROOT);
    const st = state[id];
    if (st?.status === "aborted") {
      if (taskIds.length > 1) {
        console.log(`\n--- Task ${id} ---`);
      }
      console.log(formatAbortedTaskLine(id, st.journal));
    } else if (st?.journal) {
      if (taskIds.length > 1) {
        console.log(`\n--- Task ${id} ---`);
      }
      console.log(st.journal);
    } else {
      console.log(`Task ${id}: closed (no summary available)`);
    }
  }
}

/**
 * assigned タスクのクリーンアップ（sub-agent close, PID kill, worktree/ブランチ削除）
 *
 * T260: 戻り値に「どの手段で停止シグナルを送ったか」を記録し、呼び出し側で
 *       `abort_signal_sent method=... pid=...` ログを出せるようにする。
 * - method="sigterm"   : Conductor PID 生存 → SIGTERM を送った
 * - method="surface_close": PID 不明 or 既に死亡。Agent surface のみ閉じた
 * - method="none"      : agent も pid も無く、何もシグナルを出していない
 */
type CleanupResult = { method: "sigterm" | "surface_close" | "none"; pid?: number };

async function cleanupAssignedTask(conductor: any): Promise<CleanupResult> {
  let method: CleanupResult["method"] = "none";
  let pid: number | undefined;

  // Sub-agent の surface を閉じる
  if (conductor.agents?.length > 0) {
    for (const agent of conductor.agents) {
      try {
        await cmux.closeSurface(agent.surface);
      } catch {}
    }
    method = "surface_close";
  }

  // Conductor の PID を kill
  if (conductor.pid && isProcessAlive(conductor.pid)) {
    try {
      process.kill(conductor.pid, "SIGTERM");
      method = "sigterm";
      pid = conductor.pid;
    } catch {}
  }

  // worktree 削除
  if (conductor.worktreePath && existsSync(conductor.worktreePath)) {
    try {
      const { execFile: execFileCb } = require("child_process");
      const { promisify } = require("util");
      const execFileAsync = promisify(execFileCb);
      await execFileAsync("git", ["worktree", "remove", conductor.worktreePath, "--force"], {
        cwd: PROJECT_ROOT,
      });
    } catch (e: any) {
      await log("cleanup_failed", `abort-task worktree remove: path=${conductor.worktreePath} ${formatExecError(e)}`);
    }
    // ブランチ削除
    if (conductor.taskRunId) {
      const branch = `${conductor.taskRunId}/task`;
      try {
        const { execFile: execFileCb } = require("child_process");
        const { promisify } = require("util");
        const execFileAsync = promisify(execFileCb);
        await execFileAsync("git", ["branch", "-D", branch], { cwd: PROJECT_ROOT });
      } catch (e: any) {
        await log("cleanup_failed", `abort-task branch delete: branch=${branch} ${formatExecError(e)}`);
      }
    }
  }

  return { method, pid };
}

/**
 * T250: broken 状態の Conductor を明示的に idle に戻す。
 *
 * - abort-task / restart-task は taskId 起点で Conductor を探すが、broken に到達した
 *   Conductor は taskId がクリア済みのため見つからない。
 * - 代わりに surface 起点で CONDUCTOR_CLEAR を送り、daemon 側の handler で
 *   resetConductor(opts={targetStatus:"idle", reason:"cleared"}) を呼ばせる。
 * - broken 以外の状態の Conductor は error 終了させる（abort-task / restart-task の誘導）。
 */
async function cmdClearConductor(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_clear_conductor"));
  const surface = requireArg("surface");
  const normalizedSurface = surface.startsWith("surface:") ? surface : `surface:${surface}`;

  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  if (!existsSync(teamJsonPath)) {
    console.error("Error: team.json not found");
    process.exit(1);
  }
  let teamJson: any;
  try {
    teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
  } catch {
    console.error("Error: team.json unreadable");
    process.exit(1);
  }
  const conductor = (teamJson.conductors ?? []).find(
    (c: any) => c.surface === normalizedSurface,
  );
  if (!conductor) {
    console.error(`Error: conductor ${normalizedSurface} not found in team.json`);
    process.exit(1);
  }
  if (conductor.status !== "broken") {
    console.error(
      `Error: conductor ${normalizedSurface} is not broken (current: ${conductor.status ?? "unknown"}). ` +
        `Use abort-task / restart-task for other states.`,
    );
    process.exit(1);
  }
  // R1 対応: CONDUCTOR_DONE 流用ではなく新 message 型 CONDUCTOR_CLEAR を送る。
  // daemon.ts の no_task guard を回避し、専用 handler (ST-8A) に流す。
  await postMessage({
    type: "CONDUCTOR_CLEAR",
    surface: normalizedSurface,
    reason: "user_clear",
    timestamp: new Date().toISOString(),
  });
  console.log(`OK cleared ${normalizedSurface} (broken → idle)`);
}

async function cmdAbortTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_abort_task"));
  // T291: canonical 不明で exit 1（孤児 taskState を生まないための安全側）
  const taskIdInput = requireArg("task-id");
  const canonical = await resolveCanonicalTaskId(taskIdInput);
  if (!canonical) {
    console.error(`Error: task ${taskIdInput} not found in .team/tasks/`);
    process.exit(1);
  }
  const taskId = canonical;
  const journalArg = getArg("journal");

  // タスクタイトル取得（journal デフォルト生成用）
  const taskFile = await findTaskFile(taskId);
  let title = "";
  if (taskFile) {
    const taskContent = await readFile(taskFile, "utf-8");
    title = taskContent.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? "";
  }
  const journal = journalArg ?? t("abort_journal_default", { id: taskId, title }).replace(/\s+$/, "");

  // 1. タスク状態を確認
  const taskStateForCheck = await loadTaskState(PROJECT_ROOT);
  const currentStatus = taskStateForCheck[taskId]?.status;
  if (currentStatus !== "assigned") {
    console.error(`Error: task ${taskId} is not assigned (current status: ${currentStatus ?? "unknown"}). Only assigned tasks can be aborted.`);
    process.exit(1);
  }

  // 2. team.json から該当 Conductor を特定
  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  let teamJson: any;
  try {
    teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
  } catch {
    console.error("Error: team.json not found or unreadable");
    process.exit(1);
  }
  const conductor = teamJson.conductors?.find((c: any) => c.taskId === taskId);
  if (!conductor) {
    console.error(`Error: no conductor found for task ${taskId}`);
    // T290: taskState 書き換え・cascade・task_aborted log・child_reverted_to_draft log を
    //       markTaskAborted に集約。journal は detail として渡す（reason=abort_task; prefix が付く）
    await markTaskAborted(PROJECT_ROOT, taskId, "abort_task", journal, { taskTitle: title });
    // conductor 不在のため CONDUCTOR_DONE は送れない。TUI 即時反映のため TASK_UPDATED を送る
    const taskFilePath = await findTaskFile(taskId);
    await postMessage({
      type: "TASK_UPDATED",
      taskId,
      taskFile: taskFilePath ?? "",
      timestamp: new Date().toISOString(),
    });
    console.log(`OK aborted ${taskId} (no conductor found, state updated only)`);
    return;
  }

  // 3〜5. クリーンアップ（sub-agent close, PID kill, worktree 削除）
  const cleanup = await cleanupAssignedTask(conductor);
  // T260: 実際にどの手段で停止シグナルを送ったか記録する。
  //       method=none はログしない（シグナルを送っていないため）。
  if (cleanup.method !== "none") {
    await log(
      "abort_signal_sent",
      `task_id=${taskId} surface=${formatSurface(conductor.surface, "C")} reason=abort_task method=${cleanup.method}${cleanup.pid !== undefined ? ` pid=${cleanup.pid}` : ""}`
    );
  }

  // 6. T290: taskState 書き換え・cascade・task_aborted log・child_reverted_to_draft log を
  //          markTaskAborted に集約。journal は detail として渡す。
  await markTaskAborted(PROJECT_ROOT, taskId, "abort_task", journal, { taskTitle: title });

  // タスク-セッション索引に記録
  try {
    const db = initDB(PROJECT_ROOT);
    insertTaskSession(db, {
      timestamp: new Date().toISOString(),
      task_id: taskId,
      task_run_id: conductor?.taskRunId,
      session_id: conductor?.sessionId ?? "",
      role: "conductor",
      surface: conductor?.surface,
      event: "aborted",
    });
    db.close();
  } catch (e: any) {
    log("error", `trace DB aborted insert failed: ${e?.message ?? e}`).catch(() => {});
  }

  // 7. CONDUCTOR_DONE メッセージ送信（daemon に通知）
  await postMessage({
    type: "CONDUCTOR_DONE",
    surface: conductor.surface,
    taskRunId: conductor.taskRunId,
    success: false,
    reason: "aborted",
    timestamp: new Date().toISOString(),
  });

  // 8. Conductor を再起動（session-id は cmdConductor が自己生成して daemon に通知する）
  await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface} CMUX_CLAUDE_HOOKS_DISABLED=1\n`);
  await sleep(500);
  await cmux.send(conductor.surface, `cmux-team conductor\n`);

  console.log(`OK aborted ${taskId} (conductor ${conductor.surface} restarting)`);
}

/**
 * aborted 状態のタスクを ready に戻す。残骸 worktree / branch を冪等削除し、
 * task-state.json から resume 用フィールドを剥がす。Conductor は紐付いていないため
 * team.json は引かず CONDUCTOR_DONE も送らない。
 */
async function restartFromAborted(
  taskId: string,
  stale: TaskState,
  title: string,
  journal: string,
  taskFile: string | undefined,
): Promise<void> {
  if (stale.worktreePath && existsSync(stale.worktreePath)) {
    try {
      await execFileAsync(
        "git",
        ["worktree", "remove", stale.worktreePath, "--force"],
        { cwd: PROJECT_ROOT },
      );
    } catch (e) {
      await log(
        "cleanup_failed",
        `restart-task aborted worktree remove: path=${stale.worktreePath} ${formatExecError(e)}`,
      );
    }
  }
  if (stale.taskRunId) {
    const branch = `${stale.taskRunId}/task`;
    try {
      await execFileAsync("git", ["branch", "-D", branch], { cwd: PROJECT_ROOT });
    } catch (e) {
      await log(
        "cleanup_failed",
        `restart-task aborted branch delete: branch=${branch} ${formatExecError(e)}`,
      );
    }
  }

  const ts = await loadTaskState(PROJECT_ROOT);
  ts[taskId] = {
    ...ts[taskId],
    status: "ready",
    journal: `[restart] ${journal}`,
  };
  delete ts[taskId].assignedAt;
  delete ts[taskId].abortedAt;
  delete ts[taskId].worktreePath;
  delete ts[taskId].taskRunId;
  delete ts[taskId].conductorSlot;
  delete ts[taskId].sessionId;
  await saveTaskState(PROJECT_ROOT, ts);

  await log(
    "task_restarted",
    `task_id=${taskId}${title ? ` title=${title}` : ""} from=aborted journal_summary=${journal}`,
  );

  await postMessage({
    type: "TASK_CREATED",
    taskId,
    taskFile: taskFile ?? "",
    timestamp: new Date().toISOString(),
  });

  console.log(`OK restarted ${taskId} (was aborted, re-queued as ready)`);
}

async function cmdRestartTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_restart_task"));
  // T291: canonical 不明で exit 1（孤児 taskState を生まないための安全側）
  const taskIdInput = requireArg("task-id");
  const canonical = await resolveCanonicalTaskId(taskIdInput);
  if (!canonical) {
    console.error(`Error: task ${taskIdInput} not found in .team/tasks/`);
    process.exit(1);
  }
  const taskId = canonical;
  const journalArg = getArg("journal");

  // タスクタイトル取得（journal デフォルト生成用）
  const taskFile = await findTaskFile(taskId);
  let title = "";
  if (taskFile) {
    const taskContent = await readFile(taskFile, "utf-8");
    title = taskContent.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? "";
  }
  const journal = journalArg ?? t("restart_journal_default", { id: taskId, title }).replace(/\s+$/, "");

  // 1. タスク状態を確認
  const taskState = await loadTaskState(PROJECT_ROOT);
  const currentStatus = taskState[taskId]?.status;
  if (currentStatus !== "assigned" && currentStatus !== "aborted") {
    console.error(`Error: task ${taskId} is not assigned or aborted (current status: ${currentStatus ?? "unknown"}). Only assigned or aborted tasks can be restarted.`);
    process.exit(1);
  }

  if (currentStatus === "aborted") {
    await restartFromAborted(taskId, taskState[taskId]!, title, journal, taskFile);
    return;
  }

  // 2. team.json から該当 Conductor を特定
  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  let teamJson: any;
  try {
    teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
  } catch {
    console.error("Error: team.json not found or unreadable");
    process.exit(1);
  }
  const conductor = teamJson.conductors?.find((c: any) => c.taskId === taskId);
  if (!conductor) {
    // Conductor が見つからない場合: status を ready に戻して TASK_CREATED 通知
    taskState[taskId] = {
      ...taskState[taskId],
      status: "ready",
      journal: `[restart] ${journal}`,
    };
    delete taskState[taskId].assignedAt;
    delete taskState[taskId].worktreePath;
    delete taskState[taskId].taskRunId;
    delete taskState[taskId].conductorSlot;
    delete taskState[taskId].sessionId;
    await saveTaskState(PROJECT_ROOT, taskState);
    await log("task_restarted", `task_id=${taskId}${title ? ` title=${title}` : ""} journal_summary=${journal} no_conductor=true`);
    await postMessage({
      type: "TASK_CREATED",
      taskId,
      taskFile: taskFile ?? "",
      timestamp: new Date().toISOString(),
    });
    console.log(`OK restarted ${taskId} (no conductor found, re-queued as ready)`);
    return;
  }

  // 3. クリーンアップ（sub-agent close, PID kill, worktree 削除）
  // T260: cleanupAssignedTask は method/pid を返すが、restart-task 経路では
  //       ログ文脈が「中断」ではなく「やり直し」なので abort_signal_sent は出さず
  //       戻り値は捨てる（T260 plan Reviewer rec #3）。
  await cleanupAssignedTask(conductor);

  // 4. タスク状態を ready に変更
  taskState[taskId] = {
    ...taskState[taskId],
    status: "ready",
    journal: `[restart] ${journal}`,
  };
  delete taskState[taskId].assignedAt;
  delete taskState[taskId].worktreePath;
  delete taskState[taskId].taskRunId;
  delete taskState[taskId].conductorSlot;
  delete taskState[taskId].sessionId;
  await saveTaskState(PROJECT_ROOT, taskState);

  await log("task_restarted", `task_id=${taskId}${title ? ` title=${title}` : ""} journal_summary=${journal}`);

  // 5. CONDUCTOR_DONE メッセージ送信（daemon に通知）
  await postMessage({
    type: "CONDUCTOR_DONE",
    surface: conductor.surface,
    taskRunId: conductor.taskRunId,
    success: false,
    reason: "restarted",
    timestamp: new Date().toISOString(),
  });

  // 6. Conductor を再起動（session-id は cmdConductor が自己生成して daemon に通知する）
  await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface} CMUX_CLAUDE_HOOKS_DISABLED=1\n`);
  await sleep(500);
  await cmux.send(conductor.surface, `cmux-team conductor\n`);

  // 7. TASK_CREATED 通知送信（自動再割り当て用）
  await postMessage({
    type: "TASK_CREATED",
    taskId,
    taskFile: taskFile ?? "",
    timestamp: new Date().toISOString(),
  });

  console.log(`OK restarted ${taskId} (conductor ${conductor.surface} restarting)`);
}

async function cmdDeleteTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_delete_task"));
  // T291: --task-id に slug を渡されても canonical id で taskState を更新する。
  //       cascadeAbortToChildren も canonical id で走る。
  const taskIdInput = requireArg("task-id");
  const canonical = await resolveCanonicalTaskId(taskIdInput);
  if (!canonical) {
    console.error(`Error: task ${taskIdInput} not found in .team/tasks/`);
    process.exit(1);
  }
  const taskId = canonical;
  const journalArg = getArg("journal");

  const taskFile = await findTaskFile(taskId);
  if (!taskFile) {
    console.error(`Error: task ${taskId} not found in .team/tasks/`);
    process.exit(1);
  }

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

  const taskContent = await readFile(taskFile, "utf-8");
  const titleMatch = taskContent.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const title = titleMatch?.[1] ?? "";

  const journal = journalArg ?? t("delete_journal_default", { id: taskId, title }).replace(/\s+$/, "");

  taskState[taskId] = {
    status: "deleted",
    deletedAt: new Date().toISOString(),
    journal,
  };
  // T241: depends_on 親 delete → ready 子を draft に戻す（ログキーは parent_aborted で統一）
  const { tasks: allTasks } = await loadTasks(PROJECT_ROOT);
  const { revertedChildren } = cascadeAbortToChildren(taskState, allTasks, taskId);
  await saveTaskState(PROJECT_ROOT, taskState);

  await log("task_deleted", `task_id=${taskId}${title ? ` title=${title}` : ""} journal_summary=${journal}`);
  for (const childId of revertedChildren) {
    await log(
      "child_reverted_to_draft",
      `parent=${taskId} child=${childId} reason=parent_aborted`
    );
  }

  // TUI 即時反映のため TASK_UPDATED を送る
  await postMessage({
    type: "TASK_UPDATED",
    taskId,
    taskFile,
    timestamp: new Date().toISOString(),
  });

  console.log(`OK deleted ${taskId}`);
}

async function cmdTraceTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_trace_task"));

  // task-id は第1引数（args[1]）から取得
  const taskId = args[1];
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
    const rel = worktreePath.startsWith(PROJECT_ROOT)
      ? worktreePath.slice(PROJECT_ROOT.length + 1)
      : worktreePath;
    console.log(`Worktree: ${rel}`);
  }

  // DB からセッション取得
  const db = initDB(PROJECT_ROOT);
  const sessions = getSessionsForTask(db, taskId);
  db.close();

  // T243: assigned 行から base 情報を表示（worktree 作成時の base branch / 親 commit / 解決ソース）
  const assignedRow = sessions.find(
    (s) => s.event === "assigned" && s.role === "conductor",
  );
  if (assignedRow && (assignedRow.base_branch || assignedRow.base_sha || assignedRow.base_source)) {
    const baseLabel = assignedRow.base_branch ?? "-";
    const shortSha = assignedRow.base_sha ? assignedRow.base_sha.slice(0, 7) : "-";
    const source = assignedRow.base_source ?? "-";
    console.log(`Base: ${baseLabel} @${shortSha} (source=${source})`);
  } else {
    console.log("Base: -");
  }

  // T295: Deliverable 行（Base 行 if/else の外で 1 回だけ出力）
  const traceTaskState = await loadTaskState(PROJECT_ROOT);
  const deliverable = traceTaskState[taskId]?.deliverable;
  if (deliverable) {
    const longLines = formatDeliverable(deliverable, "long").split("\n");
    console.log(`Deliverable: ${longLines[0]}`);
    for (let i = 1; i < longLines.length; i++) {
      console.log(longLines[i]);
    }
  } else {
    console.log("Deliverable: -");
  }
  console.log();

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

function normalizeSurfaceArgForHooks(raw: string): string {
  if (raw.startsWith("surface:")) return raw;
  const m = raw.match(/^[CAMUS]?\[(\d+)\]$/) ?? raw.match(/^(\d+)$/);
  if (m) return `surface:${m[1]}`;
  return raw;
}

function formatSurfaceForHooks(surface: string | null): string {
  if (!surface) return "-";
  const id = surface.startsWith("surface:") ? surface.slice(8) : surface;
  return `S[${id}]`;
}

function buildHookDetail(r: HookSignalRecord): string {
  const parts: string[] = [];
  // T266: NOTIFICATION は enrichment 列 (role/task_id/agent_role/notification_type/message) を優先表示
  if (r.type === "NOTIFICATION") {
    if (r.role) parts.push(`role=${r.role}`);
    if (r.task_id) parts.push(`task_id=${r.task_id}`);
    if (r.agent_role) parts.push(`agent_role=${r.agent_role}`);
    if (r.notification_type) parts.push(`ntype=${r.notification_type}`);
    if (r.message) {
      const m = r.message.length > 60 ? r.message.slice(0, 57) + "..." : r.message;
      parts.push(`message=${JSON.stringify(m)}`);
    }
    return parts.join(" ") || "-";
  }
  if (r.source) parts.push(`source=${r.source}`);
  if (r.reason) parts.push(`reason=${r.reason}`);
  if (r.task_run_id) parts.push(`task_run=${r.task_run_id}`);
  if (r.question) {
    const q = r.question.length > 60 ? r.question.slice(0, 57) + "..." : r.question;
    parts.push(`question="${q}"`);
  }
  return parts.join(" ") || "-";
}

async function cmdTraceHooks(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_trace_hooks"));

  const typeFilter = getArg("type");
  const taskRunFilter = getArg("task-run");
  const surfaceRaw = getArg("surface");
  const limitRaw = getArg("limit");
  const asJson = hasFlag("json");
  // T266: NOTIFICATION enrichment 列でのフィルタ
  const roleFilter = getArg("role");
  const taskIdFilter = getArg("task-id");

  let limit = 50;
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`Error: --limit must be a positive number (got: ${limitRaw})`);
      process.exit(1);
    }
    limit = Math.floor(n);
  }

  let surfaceFilter: string | undefined;
  if (surfaceRaw !== undefined) {
    surfaceFilter = normalizeSurfaceArgForHooks(surfaceRaw);
  }

  const db = initDB(PROJECT_ROOT);
  const rows = getHookSignals(db, {
    type: typeFilter,
    surface: surfaceFilter,
    taskRunId: taskRunFilter,
    role: roleFilter,
    taskId: taskIdFilter,
    limit,
  });
  db.close();

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("No hook signals found.");
    return;
  }

  console.log("TIMESTAMP                      TYPE              SURFACE          PID       DETAIL");
  for (const r of rows) {
    const ts = (r.timestamp ?? "").padEnd(30).slice(0, 30);
    const type = (r.type ?? "").padEnd(17).slice(0, 17);
    const surface = formatSurfaceForHooks(r.surface).padEnd(16).slice(0, 16);
    const pid = (r.pid !== null ? String(r.pid) : "-").padEnd(9).slice(0, 9);
    const detail = buildHookDetail(r);
    console.log(`${ts} ${type} ${surface} ${pid} ${detail}`);
  }
}

function deriveJsonlDir(worktreePath: string): string {
  const hash = createHash("sha256").update(worktreePath).digest("hex").slice(0, 16);
  return join(process.env.HOME ?? "~", ".claude/projects", hash);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- agent-instructions サブコマンド (T247) ---

/** --role 引数を `AgentRole` に正規化。未知 → stderr + exit 1 */
function requireAgentRole(): AgentRole {
  const raw = requireArg("role");
  const role = normalizeAgentRole(raw);
  if (!role) {
    console.error(
      `Error: unknown role: ${JSON.stringify(raw)} (expected one of ${AGENT_ROLES.join(", ")}; aliases: impl, reviewer)`,
    );
    process.exit(1);
  }
  return role;
}

async function cmdGetAgentInstructions(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_get_agent_instructions"));
  const role = requireAgentRole();
  const body = await readProjectInstructions(PROJECT_ROOT, role);
  if (body === null) {
    // ファイル無し — 無出力で exit 0（仕様 §5.2）
    process.exit(0);
  }
  process.stdout.write(body);
  process.exit(0);
}

async function cmdSetAgentInstructions(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_set_agent_instructions"));
  const role = requireAgentRole();

  const bodyArg = getArg("body");
  const fromFile = getArg("from-file");
  const fromStdin = hasFlag("from-stdin");
  const sources = [bodyArg !== undefined, fromFile !== undefined, fromStdin].filter(Boolean).length;
  if (sources === 0) {
    console.error("Error: one of --body, --from-file, --from-stdin is required");
    process.exit(1);
  }
  if (sources > 1) {
    console.error("Error: --body, --from-file, --from-stdin are mutually exclusive");
    process.exit(1);
  }

  let body: string;
  if (bodyArg !== undefined) {
    body = bodyArg;
  } else if (fromFile !== undefined) {
    try {
      body = await readFile(fromFile, "utf-8");
    } catch (e: any) {
      console.error(`Error: failed to read ${fromFile}: ${e.message}`);
      process.exit(1);
    }
  } else {
    body = await readStdin();
  }

  try {
    await writeProjectInstructions(PROJECT_ROOT, role, body);
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
  const bytes = Buffer.byteLength(body, "utf-8");
  console.log(`OK role=${role} bytes=${bytes} (limit=${AGENT_INSTRUCTIONS_MAX_BYTES})`);
  process.exit(0);
}

async function cmdDeleteAgentInstructions(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_delete_agent_instructions"));
  const role = requireAgentRole();
  const deleted = await deleteProjectInstructions(PROJECT_ROOT, role);
  console.log(`DELETED=${deleted}`);
  process.exit(0);
}

async function cmdListAgentInstructions(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_list_agent_instructions"));
  const items = await listProjectInstructions(PROJECT_ROOT);
  for (const it of items) {
    if (it.exists) {
      console.log(`${it.role} ✓ ${it.size} bytes`);
    } else {
      console.log(`${it.role} ✗`);
    }
  }
  process.exit(0);
}

// --- gh サブコマンド (T272) ---
/**
 * cmux-team gh — GitHub issue/PR キャッシュ管理
 *   gh sync [--full]
 *   gh status
 *
 * Exit codes:
 *   0 success
 *   1 generic
 *   2 non-git / non-GitHub origin
 *   3 auth missing
 *   4 rate limit exhausted
 */
async function cmdGh(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("gh_help"));
  const sub = args[1];
  switch (sub) {
    case "sync":
      await cmdGhSync();
      break;
    case "status":
      await cmdGhStatus();
      break;
    default:
      console.error(t("gh_unknown_subcommand", { sub: sub ?? "" }));
      process.exit(1);
  }
}

/**
 * `openGhCacheDB` に渡す前段: repo / token を解決して正規化した env を返す。
 * 失敗時は各 exit code で process.exit する。
 */
async function resolveGhContext(): Promise<{
  db: ReturnType<typeof openGhCacheDB>;
  repoInfo: NonNullable<Awaited<ReturnType<typeof resolveOriginRepo>>>;
  auth: Awaited<ReturnType<typeof resolveGithubToken>> & { token: string };
}> {
  const repoInfo = await resolveOriginRepo(PROJECT_ROOT);
  if (!repoInfo) {
    console.error(t("gh_not_a_github_repo"));
    process.exit(2);
  }
  const auth = await resolveGithubToken(repoInfo.host);
  if (auth.kind === "none" || !auth.token) {
    console.error(
      t("gh_auth_missing", {
        host: repoInfo.host,
        checked: auth.checked.join(", "),
      }),
    );
    process.exit(3);
  }
  const db = openGhCacheDB(PROJECT_ROOT, repoInfo, tokenHash(auth.token));
  return { db, repoInfo, auth: auth as typeof auth & { token: string } };
}

async function cmdGhSync(): Promise<void> {
  const full = hasFlag("full");
  const { db, repoInfo, auth } = await resolveGhContext();

  try {
    const result = full
      ? await syncFull({ db, repoInfo, auth })
      : await syncIncremental({ db, repoInfo, auth });

    if (result.notModified) {
      const meta = getSyncMeta(db);
      console.log(
        t("gh_sync_not_modified", {
          last_sync: meta?.last_incremental_sync ?? meta?.last_full_sync ?? "-",
        }),
      );
    } else {
      console.log(
        t("gh_sync_success", {
          mode: result.mode,
          issues: String(result.fetchedIssues),
          comments: String(result.fetchedComments),
          reviews: String(result.fetchedReviews),
          duration_ms: String(result.durationMs),
        }),
      );
    }
    process.exit(0);
  } catch (e) {
    if (e instanceof RateLimitExhaustedError) {
      console.error(
        t("gh_rate_limit_exhausted", {
          remaining: String(e.rateLimit.remaining ?? "?"),
          reset_at: e.rateLimit.resetAt ?? "?",
        }),
      );
      process.exit(4);
    }
    if (e instanceof SyncHttpError) {
      console.error(`Error: GitHub API ${e.status}: ${e.message}`);
      process.exit(1);
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

async function cmdGhStatus(): Promise<void> {
  const repoInfo = await resolveOriginRepo(PROJECT_ROOT);
  if (!repoInfo) {
    console.error(t("gh_not_a_github_repo"));
    process.exit(2);
  }
  const auth = await resolveGithubToken(repoInfo.host);
  if (auth.kind === "none" || !auth.token) {
    console.error(
      t("gh_auth_missing", {
        host: repoInfo.host,
        checked: auth.checked.join(", "),
      }),
    );
    process.exit(3);
  }
  const db = openGhCacheDB(PROJECT_ROOT, repoInfo, tokenHash(auth.token));
  const meta = getSyncMeta(db);
  const stats = getCacheStats(db);

  console.log(t("gh_status_header"));
  console.log(
    t("gh_status_last_full", { when: meta?.last_full_sync ?? t("gh_status_never_synced") }),
  );
  console.log(
    t("gh_status_last_incremental", {
      when: meta?.last_incremental_sync ?? t("gh_status_never_synced"),
    }),
  );
  console.log(t("gh_status_host", { host: repoInfo.host }));
  console.log(
    t("gh_status_repo", { owner: repoInfo.owner, repo: repoInfo.repo }),
  );
  console.log(t("gh_status_viewer", { viewer: meta?.viewer_login ?? "-" }));
  console.log(
    t("gh_status_issue_counts", {
      total: String(stats.issueCount),
      open: String(stats.issueOpenCount),
      closed: String(stats.issueClosedCount),
    }),
  );
  console.log(
    t("gh_status_pr_counts", {
      total: String(stats.prCount),
      open: String(stats.prOpenCount),
      closed: String(stats.prClosedCount),
      merged: String(stats.prMergedCount),
    }),
  );
  console.log(t("gh_status_comments", { count: String(stats.commentCount) }));
  console.log(
    t("gh_status_rate", {
      remaining: meta?.rate_limit_remaining != null ? String(meta.rate_limit_remaining) : "?",
      limit: "?",
      reset: meta?.rate_limit_reset ?? "-",
    }),
  );
  console.log(t("gh_status_token", { hash: tokenHash(auth.token) }));
  process.exit(0);
}

// --- issue / pr サブコマンド (T272 Phase 2) ---
/**
 * `cmux-team issue list|show|search [...]`
 */
async function cmdIssue(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("gh_help"));
  const sub = args[1];
  const ctx = await resolveGhContext();
  const deps: CliDepsImport = { ...ctx, args };
  switch (sub) {
    case "list":
      await cmdIssueList(deps);
      process.exit(0);
      break;
    case "show":
      await cmdIssueShow(deps, "issue");
      process.exit(0);
      break;
    case "search":
      await cmdIssueSearch(deps);
      process.exit(0);
      break;
    default:
      console.error(t("gh_unknown_subcommand", { sub: sub ?? "" }));
      process.exit(1);
  }
}

/**
 * `cmux-team pr list|show [...]`
 */
async function cmdPr(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("gh_help"));
  const sub = args[1];
  const ctx = await resolveGhContext();
  const deps: CliDepsImport = { ...ctx, args };
  switch (sub) {
    case "list":
      await cmdPrList(deps);
      process.exit(0);
      break;
    case "show":
      await cmdIssueShow(deps, "pr");
      process.exit(0);
      break;
    default:
      console.error(t("gh_unknown_subcommand", { sub: sub ?? "" }));
      process.exit(1);
  }
}

// --- artifacts サブコマンド ---
async function cmdArtifacts(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_artifacts"));
  const subCmd = args[1];

  // cmux-team artifacts --validate
  if (getArg("validate") !== undefined || args.includes("--validate")) {
    const artifacts = await loadArtifacts(PROJECT_ROOT);
    if (artifacts.length === 0) {
      console.log(t("no_artifacts"));
      return;
    }
    let hasError = false;
    for (const a of artifacts) {
      const errors = validateArtifact(a);
      if (errors.length > 0) {
        hasError = true;
        console.log(`⚠️  ${a.id || a.fileName}: ${errors.join(", ")}`);
      }
    }
    if (!hasError) {
      console.log(`All ${artifacts.length} artifacts valid`);
    }
    return;
  }

  // cmux-team artifacts add <file>
  if (subCmd === "add") {
    const filePath = args[2];
    if (!filePath) {
      console.error(t("artifact_add_file_required"));
      process.exit(1);
    }
    const absPath = filePath.startsWith("/") ? filePath : join(process.cwd(), filePath);
    if (!existsSync(absPath)) {
      console.error(t("artifact_add_file_not_found", { path: filePath }));
      process.exit(1);
    }
    const tagsRaw = getArg("tags");
    const projectRootOverride = getArg("project-root");
    const result = await addArtifact({
      projectRoot: projectRootOverride ?? PROJECT_ROOT,
      srcPath: absPath,
      type: getArg("type"),
      title: getArg("title"),
      task: getArg("task"),
      tags: tagsRaw ? tagsRaw.split(",").map(s => s.trim()) : undefined,
    });
    console.log(t("artifact_added", { id: result.id, path: result.destPath }));
    if (result.unlinkWarning) {
      console.error(`warning: source file not removed (${result.unlinkWarning}). Please remove ${absPath} manually.`);
      await log("artifact_add_unlink_failed", `src=${absPath} dest=${result.destPath} reason=${result.unlinkWarning}`);
    }
    return;
  }

  // cmux-team artifacts show <id>
  if (subCmd === "show") {
    const rawId = args[2];
    if (!rawId) {
      console.error(t("artifact_id_required"));
      process.exit(1);
    }
    // "A001" でも "001" でも受け付ける
    const normalizedId = rawId.startsWith("A") ? rawId : `A${rawId.padStart(3, "0")}`;
    const artifacts = await loadArtifacts(PROJECT_ROOT);
    const found = artifacts.find((a) => a.id === normalizedId || a.id === rawId);
    if (!found) {
      console.error(t("artifact_not_found", { id: rawId }));
      process.exit(1);
    }
    const content = await readFile(found.filePath, "utf-8");
    console.log(content);
    return;
  }

  // cmux-team artifacts open <id>
  if (subCmd === "open") {
    const rawId = args[2];
    if (!rawId) {
      console.error(t("artifact_id_required_open"));
      process.exit(1);
    }
    const normalizedId = rawId.startsWith("A") ? rawId : `A${rawId.padStart(3, "0")}`;
    const artifacts = await loadArtifacts(PROJECT_ROOT);
    const found = artifacts.find((a) => a.id === normalizedId || a.id === rawId);
    if (!found) {
      console.error(t("artifact_not_found", { id: rawId }));
      process.exit(1);
    }

    const viewer = await resolveMarkdownViewer();

    const proc = Bun.spawn([viewer, found.filePath], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
    return;
  }

  // cmux-team artifacts search <query>
  if (subCmd === "search") {
    const query = args[2];
    if (!query) {
      console.error(t("search_query_required"));
      process.exit(1);
    }
    const results = await searchArtifacts(PROJECT_ROOT, query);
    if (results.length === 0) {
      console.log(t("no_artifacts_matching", { query }));
      return;
    }
    for (const { artifact, matches } of results) {
      console.log(`\n--- ${artifact.id}  ${artifact.type}  ${artifact.title} ---`);
      for (const m of matches) {
        // 前後1行のコンテキスト表示
        const content = await readFile(artifact.filePath, "utf-8");
        const lines = content.split("\n");
        const start = Math.max(0, m.lineNum - 2);
        const end = Math.min(lines.length - 1, m.lineNum);
        for (let i = start; i <= end; i++) {
          const prefix = i === m.lineNum - 1 ? ">" : " ";
          console.log(`${prefix} ${i + 1}: ${lines[i]}`);
        }
        console.log("");
      }
    }
    return;
  }

  // cmux-team artifacts (list — デフォルト)
  const artifacts = await loadArtifacts(PROJECT_ROOT);
  if (artifacts.length === 0) {
    console.log(t("no_artifacts"));
    return;
  }

  // フィルタリング
  const typeFilter = getArg("type");
  const taskFilter = getArg("task");
  let filtered = artifacts;
  if (typeFilter) {
    filtered = filtered.filter((a) => a.type === typeFilter);
  }
  if (taskFilter) {
    filtered = filtered.filter((a) => a.task === taskFilter);
  }

  // ソート
  const sortBy = getArg("sort") || "created";
  filtered.sort((a, b) => {
    const aVal = sortBy === "updated" ? (a.updated || a.created) : a.created;
    const bVal = sortBy === "updated" ? (b.updated || b.created) : b.created;
    return aVal.localeCompare(bVal);
  });

  // 一覧表示
  for (const a of filtered) {
    const date = (a.updated || a.created).slice(0, 10);
    const taskLabel = a.task ? `  ${a.task}` : "";
    console.log(`${a.id.padEnd(6)} ${a.type.padEnd(10)} ${a.title}  ${date}${taskLabel}`);
  }
}

// --- ルーティング ---
// 単体テストから import した場合にトップレベル副作用を走らせないためのガード
if (import.meta.main) {
// --version / -v はサブコマンド dispatch より先に処理
if (args[0] === "--version" || args[0] === "-v") {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(await readFile(pkgUrl, "utf8")) as { version?: string };
    if (!pkg.version) throw new Error("no version field");
    console.log(`cmux-team ${pkg.version}`);
  } catch {
    console.log("cmux-team (version unknown)");
  }
  process.exit(0);
}
switch (command) {
  case "start":
    await cmdStart();
    break;
  case "send":
    await cmdSend();
    break;
  case "status":
    await cmdStatus();
    break;
  case "spawn-conductor":
    await cmdSpawnConductor();
    break;
  case "spawn-agent":
    await cmdSpawnAgent();
    break;
  case "agents":
    await cmdAgents();
    break;
  case "kill-agent":
    await cmdKillAgent();
    break;
  case "close-agent":
    await cmdCloseAgent();
    break;
  case "send-agent":
    await cmdSendAgent();
    break;
  case "create-task":
    await cmdCreateTask();
    break;
  case "update-task":
    await cmdUpdateTask();
    break;
  case "close-task":
    await cmdCloseTask();
    break;
  case "await-task":
    await cmdAwaitTask();
    break;
  case "await-agent":
    await cmdAwaitAgent();
    break;
  case "abort-task":
    await cmdAbortTask();
    break;
  case "restart-task":
    await cmdRestartTask();
    break;
  case "clear-conductor":
    await cmdClearConductor();
    break;
  case "delete-task":
    await cmdDeleteTask();
    break;
  case "trace-task":
    await cmdTraceTask();
    break;
  case "trace-hooks":
    await cmdTraceHooks();
    break;
  case "conductor":
    await cmdConductor();
    break;
  case "resume":
    await cmdResume();
    break;
  case "spawn-master":
    await cmdLaunchMaster();
    break;
  case "artifacts":
    await cmdArtifacts();
    break;
  case "get-agent-instructions":
    await cmdGetAgentInstructions();
    break;
  case "set-agent-instructions":
    await cmdSetAgentInstructions();
    break;
  case "delete-agent-instructions":
    await cmdDeleteAgentInstructions();
    break;
  case "list-agent-instructions":
    await cmdListAgentInstructions();
    break;
  case "gh":
    await cmdGh();
    break;
  case "issue":
    await cmdIssue();
    break;
  case "pr":
    await cmdPr();
    break;
  default:
    if (!command || hasHelpFlag()) {
    console.log(t("help_main"));
      process.exit(0);
    }
    console.error(`Unknown command: ${command}`);
    console.error(`Run 'cmux-team --help' for usage.`);
    process.exit(1);
}
}
