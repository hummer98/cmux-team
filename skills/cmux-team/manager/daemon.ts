/**
 * Daemon — メインループ + surface 管理
 */
import { readdir, readFile, writeFile, mkdir, stat, watch, rename } from "fs/promises";
import { existsSync, openSync, readSync, closeSync, fstatSync } from "fs";
import { join, dirname } from "path";
import {
  collectResults,
  initializeConductorSlots,
  assignTask,
  resetConductor,
  AssignTaskError,
  type ResumePlanItem,
  type ResumeAssignment,
} from "./conductor";
import { spawnMaster, isMasterAlive } from "./master";
import * as cmux from "./cmux";
import { loadTasks, loadTaskState, saveTaskState, filterExecutableTasks, filterRunAfterAllTasks, sortByPriority, sortOpenTasksForDisplay, createTaskProgrammatic } from "./task";
import updateNotifier from "update-notifier";
import { log, formatSurface, formatPair } from "./logger";
import { notifyStateChanged } from "./eventBus";
import { classifyStopPayload, DEFAULT_TAIL_BYTES } from "./classify-stop";
import type { AgentState, ConductorState, QueueMessage, RateLimitInfo, LayoutMode } from "./schema";
import { THROTTLE_5H_THRESHOLD, LAYOUT_MAX_CONDUCTORS } from "./schema";
import type { Database } from "bun:sqlite";
import { initDB, insertHookSignal } from "./trace-store";
import { isStale } from "./rate-limit-persistence";

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  assignedAt?: string;
  closedAt?: string;
  abortedAt?: string;
  dependsOn: string[];
  baseBranch?: string;
  filePath?: string;  // タスクファイルのパス
}

export interface DaemonState {
  running: boolean;
  bootPhase: "infra" | "conductors" | "master" | "ready";
  masterSurface: string | null;
  masterPid: number | undefined;
  masterStatus: "idle" | "running" | "disconnected";
  masterDisconnectedAt: string | undefined;
  masterPrompt: string | undefined;
  conductors: Map<string, ConductorState>;
  projectRoot: string;
  pollInterval: number;
  maxConductors: number;
  /** レイアウトモード（wide=3 Conductor / 16x9=2 Conductor） */
  layout: LayoutMode;
  lastUpdate: Date;
  pendingTasks: number;
  openTasks: number;
  taskList: TaskSummary[];
  sourceMtimes: Map<string, number>;
  restartRequested: boolean;
  /** 最後に update チェックした時刻（Date.now()） */
  lastUpdateCheckAt: number;
  /** update 検出結果（null = 更新なし、または未チェック） */
  updateAvailable: {
    current: string;
    latest: string;
    detectedAt: string;
    createdTaskId?: string | null;
  } | null;
  /** auto-update のモード（dashboard のバナー文言分岐に使用） */
  updateMode: "off" | "notify" | "task";
  /** API レート制限情報（proxy.ts が更新） */
  rateLimit: RateLimitInfo | null;
  /** ロギングプロキシのポート番号（null = 未起動または不明） */
  proxyPort: number | null;
  /** fs.watch からの即時 tick 要求を通知する resolve 関数 */
  wakeup: (() => void) | null;
  /** tick 実行中に届いた wakeup 要求を記録するフラグ */
  wakeupPending: boolean;
  /** fs.watch の async iterator を決定論的に停止するための AbortController */
  fileWatcherAbort: AbortController | null;
  /** Master PID ウォッチャーの interval */
  masterPidWatcherInterval?: ReturnType<typeof setInterval>;
  /** proxy ポートが前回起動時から変化したか（Master 再起動トリガー） */
  proxyPortChanged: boolean;
  /** daemon が稼働しているワークスペース（他 workspace の surface との混同を防ぐ） */
  workspace: string | null;
  /** サイドバーステータスの前回表示値（差分抑制用） */
  lastSidebarStatus: string | null;
  /** サイドバーステータスの前回カテゴリ（遷移判定用） */
  lastSidebarCategory: string | null;
  /** daemon プロセスが属する cmux-team パッケージのバージョン（例: "v3.45.0"）。T192 で追加 */
  version: string;
  /** プロジェクトの主開発ブランチ（config.mainBranch で解決）。T213 で追加。
   *  初期値は "main"。cmdStart が resolveMainBranch の結果で上書きする */
  mainBranch: string;
  /** T216: hook 全送信を記録する trace DB ハンドル。initInfra で遅延初期化 */
  traceDb: Database | null;
}

/**
 * surface 名をファイルパス用に正規化する (T181)。
 * `surface:12` のようなコロンを含む surface 名を `surface_12` に変換。
 * await-agent / daemon 双方で同じ関数を使って一貫した done ファイルパスを組み立てる。
 */
export function normalizeSurfaceForPath(surface: string): string {
  return surface.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Agent の done マーカーファイルを書き出す (T181)。
 * Conductor の await-agent がこのファイルを fs.watch し、STATUS/REASON/QUESTION を
 * stdout に返す。timestamp_ms は await-agent が古い done を skip するために使う。
 *
 * ファイルパス: .team/conductors/<conductor-surface>/agent-done/<agent-surface>.done
 */
export async function writeAgentDone(
  projectRoot: string,
  conductorSurface: string,
  agentSurface: string,
  payload: { status: "completed" | "crashed" | "ask"; reason?: string; question?: string },
): Promise<void> {
  const dir = join(
    projectRoot,
    ".team/conductors",
    normalizeSurfaceForPath(conductorSurface),
    "agent-done",
  );
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${normalizeSurfaceForPath(agentSurface)}.done`);
  const now = new Date();
  const lines = [
    `status=${payload.status}`,
    `timestamp_ms=${now.getTime()}`,
    `timestamp=${now.toISOString()}`,
  ];
  if (payload.reason) lines.push(`reason=${payload.reason}`);
  if (payload.question) {
    const q = payload.question.replace(/\r?\n/g, " ").slice(0, 4096);
    lines.push(`question=${q}`);
  }
  await writeFile(file, lines.join("\n") + "\n");
}

/** 長い文字列をログ用に短縮 */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

/**
 * T189: transcript JSONL ファイルの末尾 N bytes のみ読む。
 * Claude Code transcript は数十 MB に成長しうるため全読込を避ける。
 * ファイルが bytes 未満なら全体を返す。読込失敗時は null。
 */
function readTranscriptTail(path: string, bytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const { size } = fstatSync(fd);
    const readLen = Math.min(size, bytes);
    const offset = size - readLen;
    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, offset);
    return buf.toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try { closeSync(fd); } catch {}
    }
  }
}

/** surface または taskRunId で Conductor を検索 */
function findConductor(state: DaemonState, surface: string): ConductorState | undefined {
  const direct = state.conductors.get(surface);
  if (direct) return direct;
  // taskRunId で検索（フォールバック）
  for (const c of state.conductors.values()) {
    if (c.taskRunId === surface) return c;
  }
  return undefined;
}

export async function createDaemon(
  projectRoot: string,
  layout: LayoutMode = "wide",
): Promise<DaemonState> {
  // maxConductors: env が指定されていればそれを優先（既存挙動を破壊しない）。
  // 未指定なら layout 派生値（wide=3, 16x9=2）を使う。
  const envMax = process.env.CMUX_TEAM_MAX_CONDUCTORS;
  const maxConductors = envMax !== undefined && envMax !== ""
    ? Number(envMax)
    : LAYOUT_MAX_CONDUCTORS[layout];
  if (envMax !== undefined && envMax !== "" && layout === "16x9" && Number(envMax) > 2) {
    // 16x9 は 2 pane しか作らないため env で 3 以上を要求されても pane を増やせない。
    // 警告だけ出して env 値を尊重しない（pane 作成時に clamp される）。
    await log(
      "max_conductors_layout_mismatch",
      `env=${envMax} layout=${layout} — 16x9 creates only 2 panes; extra conductors will not be created`,
    );
  }
  return {
    running: true,
    bootPhase: "infra",
    masterSurface: null,
    masterPid: undefined,
    masterStatus: "disconnected",
    masterDisconnectedAt: undefined,
    masterPrompt: undefined,
    conductors: new Map(),
    projectRoot,
    pollInterval: Number(process.env.CMUX_TEAM_POLL_INTERVAL ?? 10_000),
    maxConductors,
    layout,
    lastUpdate: new Date(),
    pendingTasks: 0,
    openTasks: 0,
    taskList: [],
    sourceMtimes: new Map(),
    restartRequested: false,
    lastUpdateCheckAt: 0,
    updateAvailable: null,
    updateMode: "off",
    rateLimit: null,
    proxyPort: null,
    wakeup: null,
    wakeupPending: false,
    fileWatcherAbort: null,
    proxyPortChanged: false,
    workspace: null,
    lastSidebarStatus: null,
    lastSidebarCategory: null,
    version: "v?.?.?",
    mainBranch: "main",
    traceDb: null,
  };
}

/**
 * T192: ルート package.json からバージョンを読み取り "v3.45.0" 形式で返す。
 * 失敗時は "v?.?.?" を返し daemon 起動を阻害しない。
 */
export async function loadVersion(): Promise<string> {
  try {
    const pkgPath = join(dirname(import.meta.path), "../../../package.json");
    const raw = await readFile(pkgPath, "utf-8");
    const version = JSON.parse(raw).version as string | undefined;
    return version ? `v${version}` : "v?.?.?";
  } catch {
    return "v?.?.?";
  }
}

/** manager/ ディレクトリ内の全 .ts ファイルの mtime を記録した Map を返す */
export async function initSourceWatcher(): Promise<Map<string, number>> {
  const managerDir = dirname(import.meta.path);
  const mtimes = new Map<string, number>();
  try {
    const files = await readdir(managerDir);
    for (const f of files) {
      if (!f.endsWith(".ts") && !f.endsWith(".tsx")) continue;
      const filePath = join(managerDir, f);
      const s = await stat(filePath);
      mtimes.set(filePath, s.mtimeMs);
    }
  } catch (e: any) {
    await log("error", `initSourceWatcher failed: ${e.message}`);
  }
  return mtimes;
}

/** 現在の mtime と比較し、変更があれば変更ファイル名を返す（なければ null） */
export async function checkSourceChanged(mtimeMap: Map<string, number>): Promise<string | null> {
  const managerDir = dirname(import.meta.path);
  try {
    const files = await readdir(managerDir);
    for (const f of files) {
      if (!f.endsWith(".ts") && !f.endsWith(".tsx")) continue;
      const filePath = join(managerDir, f);
      const s = await stat(filePath);
      const prev = mtimeMap.get(filePath);
      if (prev === undefined || s.mtimeMs !== prev) {
        return f;
      }
    }
  } catch (e: any) {
    await log("error", `checkSourceChanged failed: ${e.message}`);
  }
  return null;
}

/**
 * .team/tasks/ を再帰監視し、.team 直下の task-state.json も別 watcher で監視。
 * 変更検出時は 50ms debounce で requestWakeup を呼ぶ。
 * 停止は state.fileWatcherAbort 経由（AbortController で for-await を決定論的に終わらせる）。
 */
export function initFileWatcher(state: DaemonState): void {
  const ac = new AbortController();
  state.fileWatcherAbort = ac;

  // 再帰: .team/tasks/ は NNN-slug/task.md の作成まで拾う
  // 非再帰: .team 直下で task-state.json のみフィルタして拾う（.team/output/ 等の高頻度書き込みを除外）
  const targets: { dir: string; recursive: boolean }[] = [
    { dir: join(state.projectRoot, ".team/tasks"), recursive: true },
    { dir: join(state.projectRoot, ".team"), recursive: false },
  ];

  // 50ms debounce: saveTaskState の writeFile→rename 間隔は通常 5-10ms なので
  // .tmp と task-state.json のイベントは十分同一バッチに収まる。
  // 受け入れ条件 200ms 以内の内訳: debounce 50ms + tick 数十-100ms + refresh 100ms。
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (state.running) requestWakeup(state);
    }, 50);
  };

  for (const { dir, recursive } of targets) {
    if (!existsSync(dir)) continue;
    (async () => {
      // AbortSignal を渡して ac.abort() で for-await を決定論的に抜けさせる
      const watcher = watch(dir, { recursive, signal: ac.signal });
      try {
        for await (const event of watcher) {
          if (!state.running) break;
          // .team 直下の watcher は task-state.json のみトリガ対象に絞る
          if (!recursive) {
            const name = event.filename ?? "";
            if (name !== "task-state.json" && name !== "task-state.json.tmp") continue;
          }
          schedule();
        }
      } catch (e: any) {
        // AbortController で停止した場合は AbortError が投げられる。正常終了として扱う
        if (e?.name === "AbortError") return;
        log("file_watch_failed", `dir=${dir} ${e.message}`).catch(() => {});
      } finally {
        // 冪等な後処理: 既に close 済みでも問題ない
        try { (watcher as any).close?.(); } catch {}
      }
    })();
  }
}

/**
 * 即時 tick 要求を発行する統一 API。
 * tick 実行中（sleep 未突入）でも wakeupPending に記録されるので取りこぼさない。
 * sleep 中なら state.wakeup?.() が resolve を呼び即座に起床する。
 */
export function requestWakeup(state: DaemonState): void {
  state.wakeupPending = true;
  state.wakeup?.();
}

/** pollInterval まで待つが、wakeup が呼ばれたら即座に返る */
export function sleepUntilWakeup(state: DaemonState): Promise<void> {
  return new Promise((resolve) => {
    // tick 中に requestWakeup で立ったフラグをここで消化する
    if (state.wakeupPending) {
      state.wakeupPending = false;
      // 不変条件「sleep 関数完了時点で state.wakeup は常に null」を維持
      state.wakeup = null;
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      state.wakeup = null;
      state.wakeupPending = false;
      resolve();
    }, state.pollInterval);
    state.wakeup = () => {
      clearTimeout(timer);
      state.wakeup = null;
      state.wakeupPending = false;
      resolve();
    };
  });
}

export async function initInfra(state: DaemonState): Promise<void> {
  await log("infra_init");
  const root = state.projectRoot;
  await mkdir(join(root, ".team/tasks"), { recursive: true });
  await mkdir(join(root, ".team/output"), { recursive: true });
  await mkdir(join(root, ".team/prompts"), { recursive: true });
  await mkdir(join(root, ".team/logs"), { recursive: true });

  // .gitignore
  const gitignore = join(root, ".team/.gitignore");
  if (!existsSync(gitignore)) {
    await writeFile(
      gitignore,
      [
        "# セッション固有（追跡不要）",
        "team.json",
        "master.surface",
        "proxy-port",
        "rate-limit.json",
        "logs/",
        "output/",
        "prompts/",
        "queue/",
        "traces/",
        "sessions/",
        "conductors/",
        "docs-snapshot/",
        "e2e-results/",
        "",
        "# 追跡すべき（上記以外）",
        "# tasks/        — タスク定義・runs の成果物",
        "# artifacts/    — 知見の記録",
        "# specs/        — 要件・設計",
        "# task-state.json — タスク状態（resume に必要）",
        "",
      ].join("\n")
    );
    await log("team_gitignore_created", `path=${gitignore}`);
  } else {
    // T227: 既存 .gitignore に rate-limit.json 行がなければ追記する（冪等）
    try {
      const current = await readFile(gitignore, "utf-8");
      const hasEntry = current
        .split("\n")
        .some((line) => {
          const t = line.trim();
          return t === "rate-limit.json" && !line.trimStart().startsWith("#");
        });
      if (!hasEntry) {
        // proxy-port の直後に挿入、なければ末尾に追記
        const lines = current.split("\n");
        const proxyPortIdx = lines.findIndex((l) => l.trim() === "proxy-port");
        let next: string;
        if (proxyPortIdx >= 0) {
          const head = lines.slice(0, proxyPortIdx + 1);
          const tail = lines.slice(proxyPortIdx + 1);
          next = [...head, "rate-limit.json", ...tail].join("\n");
        } else {
          next = current.endsWith("\n")
            ? current + "rate-limit.json\n"
            : current + "\nrate-limit.json\n";
        }
        await writeFile(gitignore, next);
        await log("team_gitignore_migrated", `path=${gitignore} added=rate-limit.json`);
      }
    } catch (e: any) {
      await log("error", `gitignore migration failed: ${e.message}`);
    }
  }

  // config.json（デフォルト生成）
  const configJson = join(root, ".team/config.json");
  if (!existsSync(configJson)) {
    await writeFile(
      configJson,
      JSON.stringify(
        {
          models: {
            master: "opus",
            conductor: "opus",
            agent: "opus",
          },
          envrcHookPromptSkipped: false,
        },
        null,
        2
      ) + "\n"
    );
    await log("team_config_created", `path=${configJson}`);
  }

  // team.json
  const teamJson = join(root, ".team/team.json");
  if (!existsSync(teamJson)) {
    await writeFile(
      teamJson,
      JSON.stringify(
        {
          project: "",
          phase: "init",
          architecture: "4-tier",
          master: {},
          manager: {},
          conductors: [],
        },
        null,
        2
      ) + "\n"
    );
    await log("team_json_created", `path=${teamJson}`);
  }

  // T216: trace DB を開いて state に格納（hook_signals テーブル含む）
  try {
    state.traceDb = initDB(root);
  } catch (e: any) {
    await log("trace_db_init_failed", `${e?.message ?? e}`);
    state.traceDb = null;
  }
}

export async function startMaster(state: DaemonState, daemonSurface?: string): Promise<void> {
  // マーカーファイルから既存 Master を検出（T195: PID ベース復旧）
  const markerPath = join(state.projectRoot, ".team/master.surface");
  const teamJsonPath = join(state.projectRoot, ".team/team.json");
  let restoredMasterPid: number | undefined;
  try {
    if (existsSync(markerPath)) {
      const surface = (await readFile(markerPath, "utf-8")).trim();
      if (surface) {
        // team.json から master.pid を読む（isMasterAlive が参照するのと同じソース）
        try {
          if (existsSync(teamJsonPath)) {
            const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
            const pid = teamJson?.master?.pid;
            if (typeof pid === "number") restoredMasterPid = pid;
          }
        } catch (e: any) {
          await log("master_check_error", `team.json read failed: ${e.message}`);
        }

        // pid あり: 通常の PID 経路（T195 以降の標準）
        // pid なし: surface 生存確認にフォールバック（v3.46.0 → v3.47.0 マイグレーション互換）
        let alive = false;
        let aliveVia: "pid" | "surface_fallback" | null = null;
        if (restoredMasterPid != null) {
          alive = await isMasterAlive(state.projectRoot);
          if (alive) aliveVia = "pid";
        } else {
          const pane = await cmux.getPaneForSurface(surface, state.workspace ?? undefined);
          alive = pane !== undefined;
          if (alive) {
            aliveVia = "surface_fallback";
            await log(
              "master_alive_via_surface_fallback",
              `${formatSurface(surface, "U")} pane=${pane} reason=team_json_pid_missing`
            );
          }
        }
        if (alive) {
          // proxy ポート変化時: 旧 Master を close して再 spawn
          if (state.proxyPortChanged) {
            await log("master_respawn_proxy_changed", `${formatSurface(surface, "U")} newPort=${state.proxyPort}`);
            await cmux.closeSurface(surface).catch(() => {});
            state.proxyPortChanged = false;  // フラグリセット
            // fall-through して下の spawn コードへ
          } else {
            state.masterSurface = surface;
            state.masterPid = restoredMasterPid;  // フォールバック経路では undefined のまま
            state.masterStatus = "idle";
            if (restoredMasterPid != null) {
              spawnMasterPidWatcher(state, restoredMasterPid);
            }
            await log(
              "master_restored",
              `${formatSurface(surface, "U")}${restoredMasterPid != null ? ` pid=${restoredMasterPid}` : " pid=unknown"} via=${aliveVia}`
            );
            return;
          }
        }
        await log(
          "master_check_failed",
          `${formatSurface(surface, "U")} alive=false reason=${restoredMasterPid != null ? "pid_dead" : "surface_missing"}`
        );
      }
    }
  } catch (e: any) {
    await log("master_check_error", e.message);
  }

  // Master spawn
  await log("master_spawning");
  const master = await spawnMaster(state.projectRoot, daemonSurface);
  if (master) {
    state.masterSurface = master.surface;
    state.masterStatus = "idle";
    await log("master_started", formatSurface(master.surface, "U"));
  } else {
    await log("master_spawn_failed");
  }
}

export async function initializeLayout(
  state: DaemonState,
  daemonSurface?: string,
  resumePlan?: ResumePlanItem[],
): Promise<ResumeAssignment[]> {
  // team.json から既存 Conductor を復元
  const teamJsonPath = join(state.projectRoot, ".team/team.json");
  try {
    if (existsSync(teamJsonPath)) {
      const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
      const conductors: any[] = teamJson.conductors ?? [];
      // 旧 team.json（layout フィールド無し）は "wide" として扱う
      const restoredLayout: LayoutMode =
        teamJson.layout === "16x9" ? "16x9" : "wide";
      if (restoredLayout !== state.layout) {
        await log(
          "layout_mismatch_on_resume",
          `restored=${restoredLayout} current=${state.layout} — existing panes will be kept; run 'cmux-team stop' then 'start --layout=${state.layout}' to rebuild`,
        );
      }

      if (conductors.length > 0) {
        const restored: ConductorState[] = [];
        for (const c of conductors) {
          if (!c.surface) continue;
          // T195: PID alive check で復元判定する。
          // PID が死んでいるものは restored に含めない — 新規作成パスへフォールバックさせる。
          // （full-quit 後の再起動で古い surface を死んだまま復元していたバグへの対策）
          const conductorAlive = typeof c.pid === "number" && cmux.isAlive(c.pid);
          if (!conductorAlive) {
            await log(
              "conductor_restore_skipped",
              `${formatSurface(c.surface, "C")} reason=pid_dead pid=${typeof c.pid === "number" ? c.pid : "null"}`
            );
            continue;
          }
          const restoredAgents: AgentState[] = (c.agents ?? []).map((a: any) => ({
            surface: a.surface,
            role: a.role,
            sessionId: a.sessionId,
            spawnedAt: a.spawnedAt ?? new Date().toISOString(),
            pid: (typeof a.pid === "number" && cmux.isAlive(a.pid)) ? a.pid : undefined,
          }));
          const restoredConductor: ConductorState = {
            surface: c.surface,
            taskRunId: c.taskRunId,
            taskId: c.taskId,
            taskTitle: c.taskTitle,
            worktreePath: c.worktreePath,
            outputDir: c.outputDir,
            startedAt: c.startedAt ?? new Date().toISOString(),
            sessionId: c.sessionId,
            pid: c.pid,
            agents: restoredAgents,
            status: c.status === "running" ? "running" : c.status === "disconnected" ? "disconnected" : "idle",
          };
          restored.push(restoredConductor);
        }

        if (restored.length > 0) {
          state.conductors.clear();
          for (const c of restored) {
            state.conductors.set(c.surface, c);
            // PID watcher を再起動
            if (typeof c.pid === "number") {
              spawnPidWatcher(state, c, c.pid);
            }
            for (const a of c.agents) {
              if (typeof a.pid === "number") {
                spawnAgentPidWatcher(state, c, a, a.pid);
              }
            }
          }
          await log(
            "conductors_restored",
            `count=${restored.length} surfaces=${restored.map(c => formatSurface(c.surface, "C")).join(",")}`
          );
          // team.json 復元パスでは Claude が既に稼働中の前提。
          // resumePlan で与えられた assigned タスクには何もしない（resume 命令は送らない）。
          // 旧コードでは resume_skipped が出ていたため、観測性確保のため noop ログを残す。
          if (resumePlan && resumePlan.length > 0) {
            for (const item of resumePlan) {
              await log(
                "conductor_resume_noop",
                `task_id=${item.taskId} reason=team_json_restored session_id=${item.sessionId}`
              );
            }
          }
          return [];
        }
      }
    }
  } catch (e: any) {
    await log("error", `initializeLayout team.json restore failed: ${e.message}`);
  }

  // 既存なし → 新規作成
  await log(
    "layout_creating_new_slots",
    `count=${state.maxConductors} layout=${state.layout}`,
  );
  const assignments = await initializeConductorSlots(
    state.projectRoot,
    state.conductors,
    state.maxConductors,
    daemonSurface,
    resumePlan,
    state.layout,
    state.mainBranch,
  );
  // 状態登録は CONDUCTOR_REGISTERED メッセージハンドラ（+ フォールバック）で完了済み
  return assignments;
}

/** proxy ポートに TCP 接続して生存確認 */
async function isProxyAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const net = require("net");
    const sock = net.connect({ port, host: "127.0.0.1", timeout: 500 }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
  });
}

export async function tick(state: DaemonState): Promise<void> {
  state.lastUpdate = new Date();
  await scanTasks(state);
  await monitorConductors(state);

  // proxy 死活チェック（死んでいたらログに記録）
  if (state.proxyPort) {
    const alive = await isProxyAlive(state.proxyPort);
    if (!alive) {
      await log("proxy_dead", `port=${state.proxyPort} — Master/Conductor がAPIに接続できない状態`);
    }
  }

  // ソースファイルの mtime 変更を検出
  if (state.sourceMtimes.size > 0) {
    const changedFile = await checkSourceChanged(state.sourceMtimes);
    if (changedFile) {
      await log("source_changed", `file=${changedFile}`);
      state.running = false;
      state.restartRequested = true;
    }
  }
}

export async function handleMessage(state: DaemonState, message: QueueMessage): Promise<void> {
  // T216: hook 全送信ポリシー — ルーティング分岐の前に全シグナルを trace DB に記録する。
  //       失敗しても daemon を落とさないよう try/catch で包む。
  if (state.traceDb) {
    try {
      insertHookSignal(state.traceDb, message);
    } catch (e: any) {
      await log("hook_signal_insert_failed", `type=${message.type} ${e?.message ?? e}`);
    }
  }

  switch (message.type) {
    case "TASK_CREATED": {
      let title = "";
      if (message.taskFile && existsSync(message.taskFile)) {
        try {
          const content = await readFile(message.taskFile, "utf-8");
          title = content.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? "";
        } catch (e: any) {
          await log("error", `handleMessage TASK_CREATED readFile failed: taskFile=${message.taskFile} ${e.message}`);
        }
      }
      await log("task_received", `task_id=${message.taskId}${title ? ` title=${title}` : ""}`);
      // wakeup で即時 tick を発火
      requestWakeup(state);
      break;
    }

    case "TASK_UPDATED": {
      await log("task_updated", `task_id=${message.taskId}`);
      // 任意のタスク変更（title/body/depends-on/status/close/delete/abort 等）で
      // 即時 tick を発火し TUI に反映する
      requestWakeup(state);
      break;
    }

    case "CONDUCTOR_DONE": {
      const conductor = findConductor(state, message.surface);
      if (!conductor) {
        await log(
          "conductor_done_ignored",
          `${formatSurface(message.surface, "C")} reason=not_found`
        );
        break;
      }
      // running 以外でも taskRunId が残っていれば late cleanup を実行する
      // (crashed → disconnected 誤検出からの救済パス)
      if (conductor.status !== "running" && !conductor.taskRunId) {
        await log(
          "conductor_done_ignored",
          `${formatSurface(message.surface, "C")} status=${conductor.status} reason=no_task`
        );
        break;
      }
      // T219: 既存 no_task ガードの後ろに配置 — ここまで到達時点で conductor.taskRunId は truthy.
      //       late_cleanup パスでも走る: disconnected 時の新タスク再 assign 後に残った stale シグナルを弾く.
      //       片方 undefined は旧クライアント互換のためスキップ（D3）.
      if (
        message.taskRunId &&
        conductor.taskRunId &&
        message.taskRunId !== conductor.taskRunId
      ) {
        await log(
          "conductor_done_stale",
          `${formatSurface(message.surface, "C")} message_task_run_id=${message.taskRunId} current_task_run_id=${conductor.taskRunId} reason=stale_task_run_id`
        );
        break;
      }
      if (conductor.status !== "running") {
        await log(
          "conductor_done_late_cleanup",
          `${formatSurface(message.surface, "C")} status=${conductor.status} taskRunId=${conductor.taskRunId}`
        );
      }
      const isSuccess = message.success !== false;
      await log(
        isSuccess ? "conductor_done_signal" : "conductor_error",
        `${formatSurface(message.surface, "C")}${!isSuccess && message.reason ? ` reason=${message.reason}` : ""}${message.exitCode != null ? ` exit_code=${message.exitCode}` : ""}`
      );
      await handleConductorDone(state, conductor);
      break;
    }

    case "AGENT_SPAWNED": {
      const conductor = findConductor(state, message.conductorSurface);
      if (conductor) {
        conductor.agents.push({
          surface: message.surface,
          role: message.role,
          taskTitle: message.taskTitle,
          spawnedAt: message.timestamp,
        });
        notifyStateChanged("daemon.ts:handleMessage:agent-spawned");
        await log(
          "agent_spawned",
          `${formatPair(message.conductorSurface, message.surface, "C", "A")}${message.role ? ` role=${message.role}` : ""}`
        );
      }
      break;
    }

    case "SESSION_STARTED": {
      // Master surface チェック
      if (message.surface === state.masterSurface) {
        state.masterPid = message.pid;
        state.masterStatus = "idle";
        state.masterDisconnectedAt = undefined;
        notifyStateChanged("daemon.ts:handleMessage:session-started-master");
        spawnMasterPidWatcher(state, message.pid);
        await log("master_session_started", `${formatSurface(message.surface, "U")} pid=${message.pid}`);
        break;
      }
      const conductor = findConductor(state, message.surface);
      if (conductor) {
        // n1: 既存の starting/disconnected → idle 遷移ロジックは残す
        if (conductor.status === "starting" || conductor.status === "disconnected") {
          const prevStatus = conductor.status;
          conductor.status = "idle";
          await log(
            prevStatus === "starting" ? "conductor_ready" : "conductor_recovered",
            formatSurface(message.surface, "C")
          );
        }
        // T203: SessionStart hook 経由で受信した sessionId を最新値に追従
        const prevSessionId = conductor.sessionId;
        if (message.sessionId) conductor.sessionId = message.sessionId;
        conductor.pid = message.pid;
        conductor.disconnectedAt = undefined;
        notifyStateChanged("daemon.ts:handleMessage:session-started-conductor");
        spawnPidWatcher(state, conductor, message.pid);

        // T203 C3: assigned タスクに対する /clear シミュレーションで task-state.json も同期更新
        // /clear → SessionStart hook 到達までの間に scanTasks が古い sessionId を書く race を補正する。
        if (
          message.sessionId &&
          prevSessionId !== message.sessionId &&
          conductor.taskId
        ) {
          try {
            const ts = await loadTaskState(state.projectRoot);
            const cur = ts[conductor.taskId];
            // T219: 先頭で stale guard。両方 taskRunId が立っており不一致なら書き込みスキップ.
            //       hook 配布物は taskRunId を知らない（D2）ため、daemon 内部の突合のみで検証する.
            if (
              cur &&
              conductor.taskRunId &&
              cur.taskRunId &&
              cur.taskRunId !== conductor.taskRunId
            ) {
              await log(
                "task_session_update_skipped",
                `${formatSurface(message.surface, "C")} task_id=${conductor.taskId} task_state_task_run_id=${cur.taskRunId} conductor_task_run_id=${conductor.taskRunId} reason=stale_task_run_id`
              );
            } else if (
              cur &&
              cur.status === "assigned" &&
              cur.sessionId !== message.sessionId
            ) {
              ts[conductor.taskId] = { ...cur, sessionId: message.sessionId };
              await saveTaskState(state.projectRoot, ts);
              await log(
                "task_session_updated",
                `${formatSurface(message.surface, "C")} task_id=${conductor.taskId} session_id=${message.sessionId} source=${message.source ?? "-"}`
              );
            }
          } catch (e: any) {
            await log(
              "error",
              `task-state update failed on session_started: ${e?.message ?? e}`
            );
          }
        }

        await log(
          "session_started",
          `${formatSurface(message.surface, "C")} pid=${message.pid} session_id=${message.sessionId ?? "-"} source=${message.source ?? "-"}`
        );
        break;
      }

      // T195: Agent surface か？ 全 Conductor の agents 配列を逆引き
      let agentMatched = false;
      for (const c of state.conductors.values()) {
        const agent = c.agents.find(a => a.surface === message.surface);
        if (agent) {
          // T203: Agent も同様に最新 sessionId を反映
          if (message.sessionId) agent.sessionId = message.sessionId;
          agent.pid = message.pid;
          spawnAgentPidWatcher(state, c, agent, message.pid);
          notifyStateChanged("daemon.ts:handleMessage:session-started-agent");
          await log(
            "session_started",
            `${formatPair(c.surface, message.surface, "C", "A")} pid=${message.pid} session_id=${message.sessionId ?? "-"} source=${message.source ?? "-"}`
          );
          agentMatched = true;
          break;
        }
      }
      if (!agentMatched) {
        await log("session_started_ignored", `${formatSurface(message.surface, "S")} reason=not_found`);
      }
      break;
    }

    case "CONDUCTOR_REGISTERED": {
      // T228: idempotent merge — 既存 state があれば skip（taskId/agents 等を破壊しないため）。
      //   cmdConductor / cmdResume 自身が POST する self-register 方式に変わったため、
      //   resume 経路では initializeConductorSlots が pre-set した state が既に存在する。
      if (state.conductors.has(message.surface)) {
        const existing = state.conductors.get(message.surface)!;
        await log(
          "conductor_register_skipped",
          `${formatSurface(message.surface, "C")} reason=already_registered existing_status=${existing.status} existing_pid=${existing.pid ?? "null"}`,
        );
        break;
      }
      // 新規登録: soft cap（state.conductors.size >= state.maxConductors）を超過する場合は
      //   warning ログを出してから登録を続行する。hard cap にはしない（任意 surface から
      //   Conductor を追加できるのが本変更の目的）。
      if (state.conductors.size >= state.maxConductors) {
        await log(
          "conductor_register_over_cap",
          `${formatSurface(message.surface, "C")} current=${state.conductors.size} max=${state.maxConductors}`,
        );
      }
      state.conductors.set(message.surface, {
        surface: message.surface,
        status: "starting",
        startedAt: message.timestamp,
        agents: [],
      });
      notifyStateChanged("daemon.ts:handleMessage:conductor-registered");
      await log("conductor_registered", formatSurface(message.surface, "C"));
      break;
    }

    case "SESSION_ENDED": {
      // T216: reason=other は Claude Code の曖昧な終了通知（/clear 直後など）を含むため
      //       state 遷移の根拠にしない。insertHookSignal での記録のみで終わらせる。
      //       真の死亡検知は spawnPidWatcher (PID) に委ねる。
      if (message.reason === "other") {
        await log(
          "session_ended_other_ignored",
          `${formatSurface(message.surface, "S")} reason=other — recorded only, no state transition`
        );
        break;
      }
      // Master surface チェック
      if (message.surface === state.masterSurface) {
        state.masterStatus = "disconnected";
        state.masterDisconnectedAt = message.timestamp;
        state.masterPid = undefined;
        notifyStateChanged("daemon.ts:handleMessage:session-ended-master");
        await log("master_session_ended", `${formatSurface(message.surface, "U")}${message.reason ? ` reason=${message.reason}` : ""}`);
        break;
      }
      const conductor = findConductor(state, message.surface);
      if (conductor) {
        // surface が一致しない場合は旧セッションからの stale イベント → 無視
        if (message.surface !== conductor.surface) {
          await log(
            "session_ended_ignored",
            `event=${formatSurface(message.surface, "C")} current=${formatSurface(conductor.surface, "C")}`
          );
          break;
        }
        conductor.status = "disconnected";
        conductor.disconnectedAt = message.timestamp;
        conductor.pid = undefined;
        notifyStateChanged("daemon.ts:handleMessage:session-ended-conductor");
        await log(
          "session_ended",
          `${formatSurface(message.surface, "C")} status=disconnected${message.reason ? ` reason=${message.reason}` : ""}`
        );
      } else {
        // Agent surface かチェック (T181: done マーカーを書き出す)
        for (const c of state.conductors.values()) {
          const idx = c.agents.findIndex(a => a.surface === message.surface);
          if (idx !== -1) {
            const agent = c.agents[idx]!;
            try {
              await writeAgentDone(state.projectRoot, c.surface, agent.surface, {
                status: "crashed",
                reason: message.reason ?? "session_end",
              });
            } catch (e: any) {
              await log("error", `writeAgentDone failed (session_ended): ${e.message}`);
            }
            c.agents.splice(idx, 1);
            notifyStateChanged("daemon.ts:handleMessage:session-ended-agent");
            await log(
              "agent_done",
              `${formatPair(c.surface, message.surface, "C", "A")} trigger=session_ended status=crashed`
            );
            break;
          }
        }
      }
      break;
    }

    case "SESSION_ACTIVE": {
      // Master surface チェック
      if (message.surface === state.masterSurface) {
        state.masterStatus = "running";
        state.masterDisconnectedAt = undefined;
        if (message.pid) state.masterPid = message.pid;
        notifyStateChanged("daemon.ts:handleMessage:session-active-master");
        await log("master_session_active", formatSurface(message.surface, "U"));
        break;
      }
      const conductor = findConductor(state, message.surface);
      if (conductor) {
        conductor.disconnectedAt = undefined;
        if (message.pid) conductor.pid = message.pid;
        if (conductor.status === "disconnected") {
          conductor.status = "running";
          await log("conductor_recovered", `${formatSurface(message.surface, "C")} via=SESSION_ACTIVE new_status=running`);
        } else if (conductor.status === "starting") {
          conductor.status = "idle";
          await log("conductor_ready", `${formatSurface(message.surface, "C")} via=SESSION_ACTIVE`);
        }
        notifyStateChanged("daemon.ts:handleMessage:session-active-conductor");
      }
      break;
    }

    case "SESSION_STOP": {
      // T189/T208: Stop hook の生データを分類し SESSION_ASK / SESSION_IDLE に
      // 合成して再入する。Stop hook は end_turn 時にのみ発火するため、
      // classifier の判定は ASK or IDLE の二択で副作用なしの SKIP は無い。
      if (!message.surface) {
        await log("session_stop_dropped", "reason=empty_surface");
        break;
      }
      const cls = classifyStopPayload(message.payload ?? {}, {
        readTranscriptTail: (p, bytes) => readTranscriptTail(p, bytes),
      });
      await log(
        "session_stop_classified",
        `${formatSurface(message.surface, "C")} case=${cls.kind}` +
          (cls.kind === "ASK" ? ` question=${truncate(cls.question, 60)}` : "")
      );
      // 合成メッセージは型安全に構築するため QueueMessage.parse は行わない（高速パス）
      const synthesized: QueueMessage = cls.kind === "ASK"
        ? {
            type: "SESSION_ASK",
            surface: message.surface,
            question: cls.question,
            pid: message.pid,
            timestamp: message.timestamp,
          }
        : {
            type: "SESSION_IDLE",
            surface: message.surface,
            pid: message.pid,
            timestamp: message.timestamp,
          };
      await handleMessage(state, synthesized);
      break;
    }

    case "SESSION_IDLE": {
      // Master surface チェック
      if (message.surface === state.masterSurface) {
        state.masterStatus = "idle";
        state.masterDisconnectedAt = undefined;
        if (message.pid) state.masterPid = message.pid;
        notifyStateChanged("daemon.ts:handleMessage:session-idle-master");
        await log("master_session_idle", formatSurface(message.surface, "U"));
        break;
      }
      const conductor = findConductor(state, message.surface);
      if (conductor) {
        conductor.disconnectedAt = undefined;  // alive の証拠 (Stop hook からのシグナル)
        if (message.pid) conductor.pid = message.pid;
        // T181: asking → idle/running に戻る経路（Ask 解決後の通常 stop）
        if (conductor.status === "asking") {
          conductor.askQuestion = undefined;
          conductor.status = conductor.taskRunId ? "running" : "idle";
          await log(
            "conductor_ask_resolved",
            `${formatSurface(message.surface, "C")} new_status=${conductor.status}`
          );
        } else if (conductor.status === "disconnected") {
          if (conductor.taskRunId) {
            // タスク実行中だった Conductor が復活 → running に戻すだけ。
            // cleanup は C-1 (CONDUCTOR_DONE) か C-2 (disconnect_timeout) が担う。
            // ここで resetConductor を呼ぶと、生存中の Conductor の worktree を誤削除する
            // (Stop hook はターン境界ごとに発火するため、タスク実行中でも SESSION_IDLE は来る)
            conductor.status = "running";
            await log(
              "conductor_recovered",
              `${formatSurface(message.surface, "C")} via=SESSION_IDLE new_status=running taskRunId=${conductor.taskRunId}`
            );
          } else {
            // taskRunId なし → 通常復帰 (idle)
            conductor.status = "idle";
            await log("conductor_recovered", `${formatSurface(message.surface, "C")} via=SESSION_IDLE`);
          }
        } else if (conductor.status === "starting") {
          conductor.status = "idle";
          await log("conductor_ready", `${formatSurface(message.surface, "C")} via=SESSION_IDLE`);
        }
        notifyStateChanged("daemon.ts:handleMessage:session-idle-conductor");
        await log(
          "session_idle",
          `${formatSurface(message.surface, "C")}`
        );
        break;
      }

      // T181: Conductor にマッチしなければ Agent surface として処理
      let matched = false;
      for (const c of state.conductors.values()) {
        const agent = c.agents.find(a => a.surface === message.surface);
        if (!agent) continue;
        matched = true;
        try {
          await writeAgentDone(state.projectRoot, c.surface, agent.surface, {
            status: "completed",
          });
        } catch (e: any) {
          await log("error", `writeAgentDone failed (session_idle): ${e.message}`);
        }
        // agents リストからは削除しない（idle 中の Agent も生存扱い。SESSION_ENDED / surface_lost で削除）
        await log(
          "agent_done",
          `${formatPair(c.surface, agent.surface, "C", "A")} trigger=session_idle status=completed`
        );
        break;
      }
      if (!matched) {
        await log(
          "session_idle_unknown_surface",
          `${formatSurface(message.surface, "S")} pid=${message.pid ?? ""}`
        );
      }
      break;
    }

    case "SESSION_ASK": {
      // T181: AskUserQuestion 検出時の処理
      // 1) Master は対象外
      if (message.surface === state.masterSurface) {
        await log("master_session_ask_ignored", `${formatSurface(message.surface, "U")}`);
        break;
      }

      // 2) Conductor surface か判定
      const conductor = findConductor(state, message.surface);
      if (conductor) {
        conductor.askQuestion = message.question;
        conductor.status = "asking";
        if (message.pid) conductor.pid = message.pid;
        conductor.disconnectedAt = undefined;
        notifyStateChanged("daemon.ts:handleMessage:session-ask-conductor");
        await log(
          "conductor_asking",
          `${formatSurface(message.surface, "C")} question=${truncate(message.question, 120)}`
        );
        break;
      }

      // 3) Agent surface か判定
      let matched = false;
      for (const c of state.conductors.values()) {
        const agent = c.agents.find(a => a.surface === message.surface);
        if (!agent) continue;
        matched = true;
        try {
          await writeAgentDone(state.projectRoot, c.surface, agent.surface, {
            status: "ask",
            question: message.question,
          });
        } catch (e: any) {
          await log("error", `writeAgentDone failed (session_ask): ${e.message}`);
        }
        await log(
          "agent_ask",
          `${formatPair(c.surface, agent.surface, "C", "A")} question=${truncate(message.question, 120)}`
        );
        // Agent surface は閉じない（Conductor が await-agent で STATUS=ask を受けて対処）
        break;
      }
      if (!matched) {
        await log(
          "session_ask_unknown_surface",
          `${formatSurface(message.surface, "S")} pid=${message.pid ?? ""}`
        );
      }
      break;
    }

    case "SESSION_CLEAR": {
      const conductor = findConductor(state, message.surface);
      if (conductor && (conductor.status === "disconnected" || conductor.status === "starting")) {
        const event = conductor.status === "starting" ? "conductor_ready" : "conductor_recovered";
        conductor.status = "idle";
        conductor.disconnectedAt = undefined;
        // T195: pid 更新は SESSION_STARTED の責務に統一。SESSION_CLEAR で pid を触らない
        notifyStateChanged("daemon.ts:handleMessage:session-clear-idle");
        await log(event, `${formatSurface(message.surface, "C")} via=SESSION_CLEAR`);
      }
      // T219: running 分岐の先頭で taskRunId 一致検証。
      //       destructive な task-state 書き換え + resetConductor の直前で stale を弾く.
      //       disconnected/starting → idle 復帰分岐は destructive でないためガードしない（D7）.
      if (
        conductor &&
        conductor.status === "running" &&
        message.taskRunId &&
        conductor.taskRunId &&
        message.taskRunId !== conductor.taskRunId
      ) {
        await log(
          "session_clear_stale",
          `${formatSurface(message.surface, "C")} message_task_run_id=${message.taskRunId} current_task_run_id=${conductor.taskRunId} reason=stale_task_run_id`
        );
        break;
      }
      if (conductor && conductor.status === "running") {
        // ユーザー手動 /clear → タスク abort + idle リセット
        // forceCloseDisconnectedConductor と同パターン
        const taskId = conductor.taskId;
        if (taskId) {
          try {
            const ts = await loadTaskState(state.projectRoot);
            const current = ts[taskId];
            if (current?.status !== "closed" && current?.status !== "aborted" && current?.status !== "deleted") {
              const journal = `user_clear: ${formatSurface(conductor.surface, "C")} taskRunId=${conductor.taskRunId ?? "-"}`;
              ts[taskId] = { ...current, status: "aborted", abortedAt: new Date().toISOString(), journal };
              await saveTaskState(state.projectRoot, ts);
              await log("task_aborted", `task_id=${taskId} reason=user_clear`);
            }
          } catch (e: any) {
            await log("error", `SESSION_CLEAR task-state update failed: task_id=${taskId} ${e.message}`);
          }
        }
        if (conductor.pidWatcherInterval) {
          clearInterval(conductor.pidWatcherInterval);
          conductor.pidWatcherInterval = undefined;
        }
        // T195: /clear で旧 Claude は死ぬ。次の SESSION_STARTED で新 pid が届くまで保留
        conductor.pid = undefined;
        await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined);
      }
      // idle 時は何もしない（TUI チラつき防止）
      break;
    }

    case "SHUTDOWN":
      await log("shutdown_requested");
      state.running = false;
      notifyStateChanged("daemon.ts:handleMessage:shutdown");
      break;
  }
}

export async function scanTasks(state: DaemonState): Promise<void> {
  const prevOpenTasks = state.openTasks;
  const prevPendingTasks = state.pendingTasks;
  const prevTaskListHash = JSON.stringify(
    state.taskList.map((t) => ({ id: t.id, status: t.status, title: t.title }))
  );

  const { tasks, taskState } = await loadTasks(state.projectRoot);

  const closed = new Set(
    Object.entries(taskState)
      .filter(([_, s]) => s.status === "closed" || s.status === "aborted" || s.status === "deleted")
      .map(([id]) => id)
  );

  const openTasksList = tasks.filter(t => t.status !== "closed" && t.status !== "aborted" && t.status !== "deleted");
  state.openTasks = openTasksList.length;

  const assignedIds = new Set(
    [...state.conductors.values()].map((c) => c.taskId).filter((id): id is string => !!id)
  );

  const executable = sortByPriority(
    filterExecutableTasks(openTasksList, closed, assignedIds)
  );

  // run_after_all タスクの判定
  const runAfterAllExecutable = sortByPriority(
    filterRunAfterAllTasks(openTasksList, closed, assignedIds)
  );

  // 両方を結合（通常タスク優先）
  const allExecutable = [...executable, ...runAfterAllExecutable];
  state.pendingTasks = allExecutable.length;

  // taskList: open を優先表示、残り枠で closed（直近）を表示
  const openTasks = sortOpenTasksForDisplay(openTasksList);
  const closedMetas = tasks.filter(t => t.status === "closed" || t.status === "aborted");
  const closedTasks = [...closedMetas]
    .sort((a, b) => (taskState[b.id]?.closedAt ?? taskState[b.id]?.abortedAt ?? "").localeCompare(taskState[a.id]?.closedAt ?? taskState[a.id]?.abortedAt ?? ""));
  const MAX_CLOSED_DISPLAY = 20;
  const combined = [...openTasks, ...closedTasks.slice(0, MAX_CLOSED_DISPLAY)];
  state.taskList = combined.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    createdAt: t.createdAt,
    assignedAt: taskState[t.id]?.assignedAt,
    closedAt: taskState[t.id]?.closedAt,
    abortedAt: taskState[t.id]?.abortedAt,
    dependsOn: t.dependsOn.filter(dep => !closed.has(dep)),
    baseBranch: t.baseBranch,
    filePath: t.filePath,
  }));

  // 差分検出: taskList / openTasks / pendingTasks のいずれかが変化したら notify
  const newTaskListHash = JSON.stringify(
    state.taskList.map((t) => ({ id: t.id, status: t.status, title: t.title }))
  );
  if (
    state.openTasks !== prevOpenTasks ||
    state.pendingTasks !== prevPendingTasks ||
    newTaskListHash !== prevTaskListHash
  ) {
    notifyStateChanged("daemon.ts:scanTasks:task-list-changed");
  }

  // === スロットリングガード ===
  // stale（リセット時刻を過ぎた復元値）はガードしない。次の API 応答を待つ。
  const throttled5h =
    !isStale(state.rateLimit) &&
    (state.rateLimit?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD;
  if (throttled5h && allExecutable.length > 0) {
    const util = state.rateLimit!.unified5hUtilization!;
    const reset = state.rateLimit!.unified5hReset;
    await log("throttled_rate_limit",
      `5h_utilization=${(util * 100).toFixed(1)}% threshold=${THROTTLE_5H_THRESHOLD * 100}% reset=${reset ?? "unknown"} skipped_tasks=${allExecutable.length}`
    );
    return;
  }

  for (const task of allExecutable) {
    // idle Conductor を探す
    const idleConductor = [...state.conductors.values()].find(c => c.status === "idle");
    if (!idleConductor) {
      await log("throttled", `task_id=${task.id} no_idle_conductor`);
      break;
    }

    // spawn 前にロック（次の tick での二重起動を防止）
    assignedIds.add(task.id);

    let updated: ConductorState;
    try {
      updated = await assignTask(idleConductor, task.id, state.projectRoot, state.mainBranch);
    } catch (e: unknown) {
      if (e instanceof AssignTaskError) {
        if (e.kind === "task") {
          // タスク側の問題 → 該当タスクを abort し Conductor は idle のまま維持
          const ts = await loadTaskState(state.projectRoot);
          ts[task.id] = {
            ...ts[task.id],
            status: "aborted",
            abortedAt: new Date().toISOString(),
            journal: `assign_failed: ${e.reason}`,
          };
          await saveTaskState(state.projectRoot, ts);
          await log(
            "task_aborted",
            `task_id=${task.id} title=${task.title} journal_summary=assign_failed: ${e.reason}`
          );
          // 次のタスクへ。idle Conductor はそのまま維持
          continue;
        }
        // e.kind === "conductor" → 従来通り disconnected
        idleConductor.status = "disconnected";
        idleConductor.disconnectedAt = new Date().toISOString();
        notifyStateChanged("daemon.ts:scanTasks:conductor-disconnected");
        await log(
          "conductor_disconnected",
          `${formatSurface(idleConductor.surface, "C")} reason=assign_failed kind=conductor task_id=${task.id} detail=${e.reason}`
        );
        continue;
      }
      // AssignTaskError 以外の想定外例外（defensive: conductor.ts の catch-all が
      // すべてを AssignTaskError にラップしているためデッドコードに近いが、
      // 将来の変更に備えて最悪ケースとして conductor を落とす）
      await log("error", `assignTask unexpected: task_id=${task.id} ${(e as Error).message}`);
      idleConductor.status = "disconnected";
      idleConductor.disconnectedAt = new Date().toISOString();
      notifyStateChanged("daemon.ts:scanTasks:conductor-disconnected");
      continue;
    }

    state.conductors.set(updated.surface, updated);
    notifyStateChanged("daemon.ts:scanTasks:conductor-updated");
    // task-state.json に assigned + assignedAt + resume 情報を記録
    const ts = await loadTaskState(state.projectRoot);
    ts[task.id] = {
      ...ts[task.id],
      status: 'assigned',
      assignedAt: new Date().toISOString(),
      worktreePath: updated.worktreePath,
      taskRunId: updated.taskRunId,
      conductorSlot: updated.surface,
      sessionId: updated.sessionId,
    };
    await saveTaskState(state.projectRoot, ts);
  }
}

/**
 * Conductor PID 1 tick 分の判定本体（テストから直接呼ぶため export）。
 *
 * @returns `"alive"` = まだ生きている / `"dead"` = 死亡検出して disconnected に遷移 /
 *          `"stopped"` = daemon 停止中で何もせず return / `"stale"` = pid ミスマッチで abort
 */
export async function __testSpawnPidWatcherTick(
  state: DaemonState,
  conductor: ConductorState,
  pid: number
): Promise<"alive" | "dead" | "stopped" | "stale"> {
  if (!state.running) return "stopped";
  if (cmux.isAlive(pid)) return "alive";
  if (conductor.pid !== pid) return "stale";
  conductor.status = "disconnected";
  conductor.disconnectedAt = new Date().toISOString();
  conductor.pid = undefined;
  notifyStateChanged("daemon.ts:spawnPidWatcher:conductor-disconnected");
  // sessionId は保持する（resume で必要）。
  // Conductor 再起動時に SessionStart hook (T203) で最新値に上書きされる。
  await log(
    "session_ended",
    `${formatSurface(conductor.surface, "C")} pid=${pid} status=disconnected reason=pid_watcher`
  );
  return "dead";
}

/** PID ウォッチャー: 指定 PID の終了を検出して disconnected にする */
export function spawnPidWatcher(
  state: DaemonState,
  conductor: ConductorState,
  pid: number
): void {
  if (conductor.pidWatcherInterval) {
    clearInterval(conductor.pidWatcherInterval);
  }
  const checkInterval = setInterval(async () => {
    const result = await __testSpawnPidWatcherTick(state, conductor, pid);
    if (result !== "alive") {
      clearInterval(checkInterval);
      conductor.pidWatcherInterval = undefined;
    }
  }, 1000);
  conductor.pidWatcherInterval = checkInterval;
}

/**
 * Agent PID 1 tick 分の判定本体（テストから直接呼ぶため export）。
 *
 * @returns `"alive"` = まだ生きている / `"dead"` = 死亡検出して agents から削除 /
 *          `"stopped"` = daemon 停止中で何もせず return /
 *          `"noop"` = すでに agents から削除されていて冪等 no-op
 */
export async function __testSpawnAgentPidWatcherTick(
  state: DaemonState,
  conductor: ConductorState,
  agent: AgentState,
  pid: number,
): Promise<"alive" | "dead" | "stopped" | "noop"> {
  if (!state.running) return "stopped";
  if (cmux.isAlive(pid)) return "alive";

  // 冪等性: agents 配列から既に削除されていたら no-op
  const idx = conductor.agents.findIndex(a => a.surface === agent.surface);
  if (idx === -1) {
    await log(
      "agent_pid_watcher_noop",
      `${formatPair(conductor.surface, agent.surface, "C", "A")} reason=already_removed pid=${pid}`
    );
    return "noop";
  }

  try {
    await writeAgentDone(state.projectRoot, conductor.surface, agent.surface, {
      status: "crashed",
      reason: "pid_watcher",
    });
  } catch (e: any) {
    await log("error", `writeAgentDone failed (agent pid_watcher): ${e.message}`);
  }
  conductor.agents.splice(idx, 1);
  notifyStateChanged("daemon.ts:spawnAgentPidWatcher:agent-removed");
  await log(
    "agent_done",
    `${formatPair(conductor.surface, agent.surface, "C", "A")} trigger=pid_watcher status=crashed pid=${pid}`
  );
  return "dead";
}

/**
 * Agent 用 PID ウォッチャー (T195)。
 *
 * 1 秒間隔で `cmux.isAlive(pid)` を呼び、dead を検出したら:
 * - done マーカーを書き出し（status=crashed reason=pid_watcher）
 * - conductor.agents 配列から該当 Agent を削除
 *
 * 冪等性: すでに agents 配列から削除されていた場合は no-op で return する。
 * SESSION_ENDED ハンドラが先に削除していた場合もこの経路に入る。
 */
export function spawnAgentPidWatcher(
  state: DaemonState,
  conductor: ConductorState,
  agent: AgentState,
  pid: number,
): void {
  if (agent.pidWatcherInterval) {
    clearInterval(agent.pidWatcherInterval);
  }
  const checkInterval = setInterval(async () => {
    const result = await __testSpawnAgentPidWatcherTick(state, conductor, agent, pid);
    if (result !== "alive") {
      clearInterval(checkInterval);
      agent.pidWatcherInterval = undefined;
    }
  }, 1000);
  agent.pidWatcherInterval = checkInterval;
}

/**
 * Master PID 1 tick 分の判定本体（テストから直接呼ぶため export）。
 */
export async function __testSpawnMasterPidWatcherTick(
  state: DaemonState,
  pid: number
): Promise<"alive" | "dead" | "stopped" | "stale"> {
  if (!state.running) return "stopped";
  if (cmux.isAlive(pid)) return "alive";
  if (state.masterPid !== pid) return "stale";
  state.masterStatus = "disconnected";
  state.masterDisconnectedAt = new Date().toISOString();
  state.masterPid = undefined;
  notifyStateChanged("daemon.ts:spawnMasterPidWatcher:master-disconnected");
  await log(
    "master_session_ended",
    `${formatSurface(state.masterSurface, "U")} pid=${pid} reason=pid_watcher`
  );
  return "dead";
}

export function spawnMasterPidWatcher(state: DaemonState, pid: number): void {
  if (state.masterPidWatcherInterval) {
    clearInterval(state.masterPidWatcherInterval);
  }
  const checkInterval = setInterval(async () => {
    const result = await __testSpawnMasterPidWatcherTick(state, pid);
    if (result !== "alive") {
      clearInterval(checkInterval);
      state.masterPidWatcherInterval = undefined;
    }
  }, 1000);
  state.masterPidWatcherInterval = checkInterval;
}

/** starting 状態のタイムアウト（秒） */
const STARTING_TIMEOUT_SEC = 60;
/** disconnected 状態のタイムアウト（秒） — 超過で forced cleanup */
const DISCONNECT_TIMEOUT_SEC =
  Number(process.env.CMUX_TEAM_DISCONNECT_TIMEOUT_SEC) || 300;  // 5 分

/**
 * monitorConductors — T195 以降は starting/disconnected のタイムアウト判定のみ。
 *
 * Conductor / Agent の生存確認は `spawnPidWatcher` / `spawnAgentPidWatcher` に
 * 一本化している（push 型 hook + PID watcher）。tree / list-status に依存しない
 * ため、cmux daemon の main thread deadlock（A011）の影響を受けない。
 */
export async function monitorConductors(state: DaemonState): Promise<void> {
  for (const [surface, conductor] of state.conductors) {
    // starting: タイムアウトチェックのみ
    if (conductor.status === "starting") {
      const elapsed = (Date.now() - new Date(conductor.startedAt).getTime()) / 1000;
      if (elapsed > STARTING_TIMEOUT_SEC) {
        conductor.status = "disconnected";
        conductor.disconnectedAt = new Date().toISOString();
        notifyStateChanged("daemon.ts:monitorConductors:starting-timeout");
        await log(
          "conductor_start_timeout",
          `${formatSurface(surface, "C")} elapsed=${Math.round(elapsed)}s`
        );
      }
      continue;
    }

    // disconnected: timeout チェック → forced cleanup。継続チェックはしない
    if (conductor.status === "disconnected") {
      if (conductor.disconnectedAt) {
        const elapsed = (Date.now() - new Date(conductor.disconnectedAt).getTime()) / 1000;
        if (elapsed > DISCONNECT_TIMEOUT_SEC) {
          await log(
            "conductor_disconnect_timeout",
            `${formatSurface(surface, "C")} elapsed=${Math.round(elapsed)}s taskRunId=${conductor.taskRunId ?? "-"}`
          );
          await forceCloseDisconnectedConductor(state, conductor);
        }
      }
      continue;
    }

    // running / idle / asking: 生存確認は spawnPidWatcher / spawnAgentPidWatcher が担当
  }
}

/**
 * disconnected timeout で Conductor の強制クローズ + タスク abort を行う。
 * CLAUDE.md「異常検知時のリカバリーは人間に委ねる」に従い、reopen はしない。
 */
async function forceCloseDisconnectedConductor(
  state: DaemonState,
  conductor: ConductorState
): Promise<void> {
  const taskId = conductor.taskId;
  const taskRunId = conductor.taskRunId;

  // 1. task-state.json に aborted を記録
  if (taskId) {
    try {
      const ts = await loadTaskState(state.projectRoot);
      const current = ts[taskId];
      // 既に closed/aborted/deleted 済みならスキップ（冪等）
      if (
        current?.status !== "closed" &&
        current?.status !== "aborted" &&
        current?.status !== "deleted"
      ) {
        const journal = `disconnect_timeout: ${formatSurface(conductor.surface, "C")} taskRunId=${taskRunId ?? "-"} disconnectedAt=${conductor.disconnectedAt}`;
        ts[taskId] = {
          ...current,
          status: "aborted",
          abortedAt: new Date().toISOString(),
          journal,
        };
        await saveTaskState(state.projectRoot, ts);
        await log(
          "task_aborted",
          `task_id=${taskId} reason=disconnect_timeout journal_summary=${journal}`
        );
      }
    } catch (e: any) {
      await log(
        "error",
        `forceCloseDisconnectedConductor task-state update failed: task_id=${taskId} ${e.message}`
      );
    }
  }

  // 2. pidWatcherInterval をクリア (Minor 4)
  if (conductor.pidWatcherInterval) {
    clearInterval(conductor.pidWatcherInterval);
    conductor.pidWatcherInterval = undefined;
  }

  // 3. resetConductor で worktree/branch/タブ名をクリーンアップ
  await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined);
}

async function handleConductorDone(
  state: DaemonState,
  conductor: ConductorState
): Promise<void> {
  const { journalSummary } = await collectResults(conductor, state.projectRoot);

  if (!conductor.taskId || conductor.taskId === "undefined") {
    await log(
      "error",
      `handleConductorDone: conductor.taskId is undefined ${formatSurface(conductor.surface, "C")}`
    );
  } else {
    await log(
      "task_completed",
      `task_id=${conductor.taskId} ${formatSurface(conductor.surface, "C")}${
        conductor.taskTitle ? ` title=${conductor.taskTitle}` : ""
      }${journalSummary ? ` journal_summary=${journalSummary}` : ""}`
    );
  }

  // Conductor をリセットして idle に戻す
  await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined);
}

export async function updateTeamJson(state: DaemonState): Promise<void> {
  const teamJsonPath = join(state.projectRoot, ".team/team.json");
  try {
    const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
    // master surface が null の場合は既存値を保持（reload 時に消さない）
    if (state.masterSurface) {
      teamJson.master = {
        surface: state.masterSurface,
        status: state.masterStatus,
        pid: state.masterPid,
      };
    }
    teamJson.manager = {
      pid: process.pid,
      type: "typescript",
      status: state.running ? "running" : "stopped",
    };
    teamJson.phase = "running";
    teamJson.layout = state.layout;
    teamJson.conductors = [...state.conductors.values()].map((c) => ({
      surface: c.surface,
      taskRunId: c.taskRunId,
      taskId: c.taskId,
      taskTitle: c.taskTitle,
      status: c.status,
      worktreePath: c.worktreePath,
      outputDir: c.outputDir,
      startedAt: c.startedAt,
      sessionId: c.sessionId,
      pid: c.pid,
      agents: c.agents.map((a) => ({
        surface: a.surface,
        role: a.role,
        sessionId: a.sessionId,
        pid: a.pid,
      })),
    }));
    // アトミック書き込み: tmp → rename で中途半端な書き込みを防止
    const tmpPath = teamJsonPath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(teamJson, null, 2) + "\n");
    await rename(tmpPath, teamJsonPath);
  } catch (e: any) {
    await log("error", `updateTeamJson failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// サイドバーステータス更新
// ---------------------------------------------------------------------------

const SIDEBAR_STATUS_KEY = "claude_code";

type SidebarStatus = {
  label: string;
  icon: string;
  color: string;
  category: "error" | "throttled" | "running" | "running_pending" | "done" | "idle";
};

/** dashboard.tsx からコピー — daemon.ts が React/Ink モジュールに依存しないようにする */
function formatResetRemaining(resetIso: string | null): string {
  if (!resetIso) return "";
  const asNum = Number(resetIso);
  const resetMs = !isNaN(asNum) && asNum > 1e9 ? asNum * 1000 : new Date(resetIso).getTime();
  if (isNaN(resetMs)) return "";
  const sec = Math.floor((resetMs - Date.now()) / 1000);
  if (sec <= 0) return "0m";
  if (sec < 60) return "<1m";
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return h > 0 ? `${d}d${h}h` : `${d}d`;
}

function computeSidebarStatus(
  state: Pick<DaemonState, "conductors" | "rateLimit" | "pendingTasks" | "openTasks">,
  prevCategory: string | null,
): SidebarStatus {
  const conductors = [...state.conductors.values()];
  const runningCount = conductors.filter(c => c.status === "running").length;
  const hasDisconnected = conductors.some(c => c.status === "disconnected");

  // 1. エラー/要対応
  if (hasDisconnected) {
    return {
      label: "! attention",
      icon: "exclamationmark.triangle",
      color: "#FF3B30",
      category: "error",
    };
  }

  // 2. スロットリング
  // stale な復元値では throttle 判定を行わない（§2-4）
  const throttled =
    !isStale(state.rateLimit) &&
    ((state.rateLimit?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD
      || state.rateLimit?.unifiedStatus === "rate_limited");
  if (throttled) {
    const remaining = formatResetRemaining(state.rateLimit?.unified5hReset ?? null);
    return {
      label: remaining ? `⏸ reset ${remaining}` : "⏸ throttled",
      icon: "pause.circle.fill",
      color: "#FF3B30",
      category: "throttled",
    };
  }

  // 3-4. タスク実行中
  if (runningCount > 0) {
    const label = state.pendingTasks > 0
      ? `${runningCount} running +${state.pendingTasks}`
      : `${runningCount} running`;
    return {
      label,
      icon: "bolt.fill",
      color: "#4C8DFF",
      category: state.pendingTasks > 0 ? "running_pending" : "running",
    };
  }

  // 5. 全タスク完了（直前が idle/done 以外の場合のみ）
  if (state.openTasks === 0
    && prevCategory !== null
    && prevCategory !== "idle"
    && prevCategory !== "done") {
    return {
      label: "done",
      icon: "checkmark.circle.fill",
      color: "#34C759",
      category: "done",
    };
  }

  // 6. アイドル（デフォルト）
  return {
    label: "idle",
    icon: "pause.circle.fill",
    color: "#8E8E93",
    category: "idle",
  };
}

export async function updateSidebarStatus(state: DaemonState): Promise<void> {
  if (!state.workspace) return;

  const status = computeSidebarStatus(state, state.lastSidebarCategory);

  // 差分抑制: 前回と同じ値なら cmux 呼び出しをスキップ
  const statusKey = `${status.label}|${status.icon}|${status.color}`;
  if (statusKey === state.lastSidebarStatus) return;
  state.lastSidebarStatus = statusKey;
  state.lastSidebarCategory = status.category;

  await cmux.setStatus(SIDEBAR_STATUS_KEY, status.label, status.icon, status.color, state.workspace);
}

// ============================================================================
// Update check (T187)
// ============================================================================

const UPDATE_PKG_NAME = "@hummer98/cmux-team";

/** package.json から cmux-team 本体の現在バージョンを読む */
async function readCurrentVersion(): Promise<string> {
  const pkgPath = join(dirname(import.meta.path), "../../../package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
  return pkg.version as string;
}

/**
 * update-notifier で最新バージョンを fetch する。
 * 失敗時は null を返す（daemon は落とさない）。
 */
export async function fetchLatestVersion(
  currentVersion: string,
): Promise<{ current: string; latest: string } | null> {
  try {
    const notifier = updateNotifier({
      pkg: { name: UPDATE_PKG_NAME, version: currentVersion },
      updateCheckInterval: 0, // バックグラウンド spawn を抑制
    });
    const info = await notifier.fetchInfo();
    if (!info?.latest) return null;
    return { current: info.current, latest: info.latest };
  } catch (e: any) {
    await log(
      "update_check_failed",
      `reason=${e?.message ?? String(e)} stderr=${e?.stderr ?? ""}`,
    );
    return null;
  }
}

/**
 * 更新チェックを実行し、mode に応じて通知 or update タスク起票する。
 *
 * - mode="notify": state.updateAvailable にセットするだけ（TUI が表示）
 * - mode="task": update タスクを --run-after-all で起票
 * - NO_UPDATE_NOTIFIER=1 で early return
 */
export async function checkUpdateAndNotify(
  state: DaemonState,
  mode: "off" | "notify" | "task",
): Promise<void> {
  if (mode === "off") return;
  if (process.env.NO_UPDATE_NOTIFIER === "1") {
    await log("update_check_skipped", "reason=NO_UPDATE_NOTIFIER=1");
    return;
  }

  let currentVersion: string;
  try {
    currentVersion = await readCurrentVersion();
  } catch (e: any) {
    await log("update_check_failed", `reason=read_pkg ${e.message}`);
    return;
  }

  await log("update_check_started", `current=${currentVersion} mode=${mode}`);
  const result = await fetchLatestVersion(currentVersion);
  if (!result) return;

  const { current, latest } = result;
  if (latest === current) {
    state.updateAvailable = null;
    return;
  }

  state.updateAvailable = {
    current,
    latest,
    detectedAt: new Date().toISOString(),
    createdTaskId: null,
  };
  await log("update_available", `current=${current} latest=${latest} mode=${mode}`);
  notifyStateChanged("daemon.ts:checkUpdateAndNotify:update-available");

  if (mode === "task") {
    await createUpdateTask(state, latest);
  }
}

/**
 * update タスクを --run-after-all で起票する。
 *
 * - 既存 open タスクに `kind: cmux-team-update` があり、同 latest なら skip
 * - 古い latest のタスクが open なら close して再起票（assigned 状態は skip）
 * - run_after_all 競合時は skip + ログ（daemon を落とさない）
 */
export async function createUpdateTask(
  state: DaemonState,
  latest: string,
): Promise<void> {
  const { tasks } = await loadTasks(state.projectRoot);

  // 既存 update タスクを探す
  const existing = tasks.filter(
    (t) => t.kind === "cmux-team-update" && t.status !== "closed",
  );

  for (const ex of existing) {
    // 既存タスクの body から latest を抽出
    let exLatest: string | null = null;
    try {
      const body = await readFile(ex.filePath, "utf-8");
      const m = body.match(/cmux-team@([\d.]+)/);
      if (m) exLatest = m[1] ?? null;
    } catch {}

    if (exLatest === latest) {
      await log(
        "update_task_skipped_duplicate",
        `task_id=${ex.id} latest=${latest}`,
      );
      if (state.updateAvailable) state.updateAvailable.createdTaskId = ex.id;
      return;
    }

    // 古い latest 向けのタスク
    if (ex.status === "assigned" || ex.status === "in_progress") {
      await log(
        "update_task_skipped_assigned_in_progress",
        `task_id=${ex.id} old_latest=${exLatest ?? "unknown"} new_latest=${latest}`,
      );
      return;
    }
    // draft/ready は close して新規起票
    try {
      const taskState = await loadTaskState(state.projectRoot);
      if (taskState[ex.id]) {
        taskState[ex.id] = {
          ...taskState[ex.id]!,
          status: "closed",
          closedAt: new Date().toISOString(),
          journal: `superseded by newer update target v${latest}`,
        };
        await saveTaskState(state.projectRoot, taskState);
        await log(
          "update_task_superseded",
          `task_id=${ex.id} old_latest=${exLatest ?? "unknown"} new_latest=${latest}`,
        );
      }
    } catch (e: any) {
      await log("error", `update_task_supersede_failed: ${e.message}`);
    }
  }

  // 新規起票
  const body = buildUpdateTaskBody(latest);
  try {
    const result = await createTaskProgrammatic(state.projectRoot, {
      title: `cmux-team を v${latest} にアップデート`,
      priority: "low",
      status: "ready",
      runAfterAll: true,
      kind: "cmux-team-update",
      body,
    });
    await log("update_task_created", `task_id=${result.id} latest=${latest}`);
    if (state.updateAvailable) state.updateAvailable.createdTaskId = result.id;
    requestWakeup(state);
    notifyStateChanged("daemon.ts:createUpdateTask:task-created");
  } catch (e: any) {
    if (e?.code === "RUN_AFTER_ALL_CONFLICT") {
      await log(
        "update_task_skipped_run_after_all_conflict",
        `existing_task_id=${e.existingTaskId} latest=${latest}`,
      );
      return;
    }
    await log("error", `createUpdateTask failed: ${e.message}`);
  }
}

function buildUpdateTaskBody(latest: string): string {
  return `cmux-team を v${latest} に更新する。

## 手順

1. 現在の cmux-team インストールパスを確認:
   \`\`\`bash
   which cmux-team
   npm root -g
   \`\`\`
2. グローバルインストール（バージョン固定）:
   \`\`\`bash
   npm install -g @hummer98/cmux-team@${latest}
   \`\`\`
3. バージョン確認:
   \`\`\`bash
   cmux-team --version
   \`\`\`
4. インストールパスが上記 1. と同じか再確認。不一致なら journal に警告として記録する。
5. 完了したら \`cmux-team close-task --task-id <ID> --journal "updated to v${latest}"\` で close。

## 注意

- daemon を再起動する必要がある場合は、Master に確認してから実施すること。
- 複数 Node 環境（Volta / nvm / Homebrew 等）が混在している場合は、パス不一致を必ず journal に記録する。
`;
}
