/**
 * Daemon — メインループ + surface 管理
 */
import { readdir, readFile, writeFile, mkdir, watch, rename } from "fs/promises";
import { existsSync, openSync, readSync, closeSync, fstatSync } from "fs";
import { join, dirname } from "path";
import {
  collectResults,
  initializeConductorSlots,
  launchConductor,
  assignTask,
  resetConductor,
  AssignTaskError,
  type ResumePlanItem,
  type ResumeAssignment,
} from "./conductor";
import { ClaudeCodeBackend } from "./claude-code-backend";
import type { RuntimeBackend, RuntimeEvent } from "./runtime-backend";
import { planLayoutRestore, type LayoutRestorePlan, type RestoreEntry } from "./layout-restore";
import { spawnMaster, persistMasterFile, deleteMasterFile, listMasterFiles } from "./master";
import * as cmux from "./cmux";
import { loadTasks, loadTaskState, saveTaskState, filterExecutableTasks, filterRunAfterAllTasks, sortByPriority, sortOpenTasksForDisplay, createTaskProgrammatic, cascadeAbortToChildren, markTaskAborted, isTerminalStatus } from "./task";
// T303: task-state mutation は applyTaskEvent / updateTaskSessionId 経由のみ
import { applyTaskEvent, updateTaskSessionId, refreshTaskStateFromDisk } from "./state-machine/task-state-store";
import updateNotifier from "update-notifier";
import { log, formatSurface, formatPair } from "./logger";
import { notifyStateChanged } from "./eventBus";
import { classifyStopPayload, DEFAULT_TAIL_BYTES } from "./classify-stop";
import type { AgentState, ConductorState, MasterState, QueueMessage, RateLimitInfo, LayoutMode, Deliverable } from "./schema";
import { THROTTLE_5H_THRESHOLD, LAYOUT_MAX_CONDUCTORS } from "./schema";
import type { Database } from "bun:sqlite";
import { initDB, insertHookSignal, insertTaskSession, updateNotificationEnrichment } from "./trace-store";
import type { NotificationEnrichment } from "./trace-store";
import { isStale5h } from "./rate-limit-persistence";
import { normalizeSurfaceForPath as normalizeSurfaceForPathImpl } from "./paths";
// T279: FSM shadow observer (observe only, no state mutation).
import { shadowObserveConductor } from "./state-machine/shadow";
import type { FsmEvent, ConductorCtx, ConductorStatus } from "./state-machine/events";
// T358: events.jsonl writer
import { emitEvent } from "./events-writer";
import { initTokenDB, releaseLeaseByHolder } from "./token-store";
// T351: dashboard / CLI で共有する pool snapshot 純関数
import { buildPoolSummary, type PoolSummary } from "./pool-summary";
import { isThrottled5h, countPoolTokens } from "./pool-throttle";
// T417: 旧 Conductor 発見マーカーファイル (.team/conductors/conductor.surface:NNN) 残骸の掃除
import { cleanupLegacyConductorMarkers } from "./cleanup";

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
  /** T295: closed 時のみ set される納品方式。旧 closed 行は undefined */
  deliverable?: Deliverable;
}

export interface DaemonState {
  running: boolean;
  bootPhase: "infra" | "conductors" | "master" | "ready";
  /** 複数 Master を surface で索引する（T229）。
   *  単一 Master 時代の masterSurface / masterPid / masterStatus 等は廃止し、
   *  全状態を MasterState 単位で保持する。永続化は `.team/masters/<surface>.json`。 */
  masters: Map<string, MasterState>;
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
  /** 最後に update チェックした時刻（Date.now()） */
  lastUpdateCheckAt: number;
  /** update 検出結果（null = 更新なし、または未チェック） */
  updateAvailable: {
    current: string;
    latest: string;
    detectedAt: string;
  } | null;
  /** auto-update のモード（dashboard のバナー文言分岐に使用）。T294 で `task` を削除 */
  updateMode: "off" | "notify";
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
   *  初期値は空文字。cmdStart が resolveMainBranch の結果で上書きする（T253 で
   *  resolveMainBranch は失敗時に throw するため、設定前にこのフィールドが
   *  Conductor 等に読まれることはない）。下流（conductor.ts / template.ts）にも
   *  空文字ガードを置いて二重防御している。 */
  mainBranch: string;
  /** T216: hook 全送信を記録する trace DB ハンドル。initInfra で遅延初期化 */
  traceDb: Database | null;
  /** Issue #30 M5: RuntimeBackend 実装。config.runtime に応じて選択される。
   *  "claude-code"（デフォルト）→ ClaudeCodeBackend, "opencode" → OpenCodeBackend */
  backend: RuntimeBackend;
  /**
   * opencode server 子プロセス（Issue #37 M2）。
   * config.opencode.agentEnabled が true のとき cmdStart が起動し stopDaemon が終了させる。
   * null = opencode agent 機能が無効または未起動。
   */
  openCodeServerProcess: import("child_process").ChildProcess | null;
  /**
   * T351: token pool DB ハンドル。pool ON ならば cmdStart 起動時に 1 度だけ
   * `initTokenDB()` で open する。pool OFF / 初期化失敗時は null（refreshPoolSnapshot は
   * その場合 state.pool を null に保つ）。daemon 稼働中の config 切替には追従しない
   * （proxy と同じく boot 時 1 回評価で固定）。
   */
  tokenDb: Database | null;
  /**
   * T351: 周期的に再計算される token pool snapshot（dashboard / 外部読み出し用）。
   * default は null。pool OFF / DB 失敗 / state.tokenDb=null のときは null のまま。
   * `refreshPoolSnapshot(state)` がメインループ毎に再計算する。
   */
  pool: PoolSummary | null;
  /**
   * T367: pool ON で `selectToken` / `canSelectAnyToken` に渡す合成 policy。
   * cmdStart で `buildSelectTokenPolicy(PROJECT_ROOT)` を 1 度実行してキャッシュする。
   * pool OFF / 構築失敗時は null。runtime config 切替には追従しない（起動時 1 回固定 + diagnostic）。
   */
  poolPolicy: import("./token-store").SelectTokenPolicy | null;
  /**
   * T367: pool ON config だが `initTokenDB()` が失敗して `tokenDb=null` のまま運用中であることを示すフラグ。
   * scanTasks の throttle ログに `pool_intended=on pool_active=off reason=db_init_failed` を付加する。
   */
  tokenDbInitFailed: boolean;
  /**
   * T353: daemon プロセスの起動時刻（ISO 8601）。daemon_stopped の uptime 計算に使う。
   * createDaemon で空文字で初期化し、cmdStart が daemon_started emit より前に確定させる。
   */
  startedAt: string;
  /**
   * T414: 内部 Web ダッシュボード server の URL（`http://127.0.0.1:<ephemeral>`）。
   * dashboard-server.ts が起動成功時に main.ts でセットし、updateTeamJson が
   * `team.json.dashboardServer.url` として外部に公開する。null = 起動失敗 or 未起動。
   */
  dashboardServerUrl?: string | null;
  /**
   * T416: 自動 GC の周期 timer ハンドル。cmdStart が `setInterval` で仕掛け、
   * stopDaemon が `clearInterval` で解放する。periodic GC が無効な場合は undefined。
   */
  gcInterval?: ReturnType<typeof setInterval>;
  /**
   * T416: 自動 GC の同一プロセス内多重実行ガード。runTeamGC が冒頭で true にし、
   * finally で false に戻す。boot trigger と periodic trigger が衝突した場合に
   * 後発を `team_gc_skipped reason=in_flight` で弾く。
   */
  gcInFlight?: boolean;
}

/**
 * surface 名をファイルパス用に正規化する (T181)。
 * `surface:12` のようなコロンを含む surface 名を `surface_12` に変換。
 * await-agent / daemon 双方で同じ関数を使って一貫した done ファイルパスを組み立てる。
 *
 * T234: 実装は paths.ts に集約（master.ts との重複定義解消）。
 * 既存の import 互換のために ./paths からの再 export を公開する。
 */
export const normalizeSurfaceForPath = normalizeSurfaceForPathImpl;

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
  payload: {
    status: "completed" | "crashed" | "ask" | "api_error";
    reason?: string;
    question?: string;
    // T392: api_error のときに使う
    kind?: string;
    message?: string;
  },
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
  if (payload.kind) lines.push(`kind=${payload.kind}`);
  if (payload.message) {
    const m = payload.message.replace(/\r?\n/g, " ").slice(0, 4096);
    lines.push(`message=${m}`);
  }
  await writeFile(file, lines.join("\n") + "\n");
}

/** T321: agent surface に紐付く token pool lease を解放する。 */
async function releaseAgentTokenLease(agentSurface: string): Promise<void> {
  try {
    const db = initTokenDB();
    releaseLeaseByHolder(db, agentSurface);
  } catch (e: any) {
    await log("error", `releaseAgentTokenLease failed surface=${agentSurface}: ${e?.message ?? e}`);
  }
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
export function findConductor(state: DaemonState, surface: string): ConductorState | undefined {
  const direct = state.conductors.get(surface);
  if (direct) return direct;
  // taskRunId で検索（フォールバック）
  for (const c of state.conductors.values()) {
    if (c.taskRunId === surface) return c;
  }
  return undefined;
}

/**
 * T260: disconnect / disconnect_timeout / broken 遷移時のスナップショットログ用フォーマッタ。
 * 1 行で pid 生存 / 最終 hook 受信時刻 / 経過 / taskRunId を出力する。
 * cmux.isAlive (`process.kill(pid, 0)`) を 1 回だけ同期呼び出しするため
 * blocking はコンマ秒以下で、disconnect 遷移時 / broken 化時のような低頻度経路でのみ呼ぶ。
 */
export function formatConductorSnapshot(conductor: ConductorState): string {
  const pidStr = conductor.pid !== undefined ? String(conductor.pid) : "null";
  const aliveStr = conductor.pid !== undefined ? String(cmux.isAlive(conductor.pid)) : "unknown";
  const lastHook = conductor.lastHookAt ?? "-";
  const elapsed = conductor.lastHookAt
    ? `${Math.round((Date.now() - new Date(conductor.lastHookAt).getTime()) / 1000)}s`
    : "-";
  return `pid=${pidStr} alive=${aliveStr} last_hook_at=${lastHook} elapsed_since_last_hook=${elapsed} taskRunId=${conductor.taskRunId ?? "-"}`;
}

/**
 * T261: user_clear 判定瞬間のスナップショットフォーマッタ。
 *
 * SESSION_CLEAR handler の 2 ブランチ（session_clear_expected / running → user_clear）
 * で発行する `user_clear_decision_snapshot` の detail を組み立てる。
 *
 * 契約 (Finding 1):
 *   - 判定に必要な state はすべて conductor から取り出す（純関数）。
 *   - message 引数は判定時刻を計算するための timestamp 取得用（elapsed_since_clear_sent を
 *     「SESSION_CLEAR 受信時刻 - clearSentAt」で算出する）。I/O は行わない。
 *
 * 出力フォーマット: key=value のスペース区切り 1 行（既存 formatConductorSnapshot と同スタイル）。
 * null 値は文字列リテラル `null` を出す（Decision D10 同様、「値なし」を明示）。
 */
export function formatUserClearDecision(
  conductor: ConductorState,
  message: { timestamp: string },
  decisionReason: string,
): string {
  const clearSentAt = conductor.clearSentAt ?? null;
  const elapsed = clearSentAt
    ? new Date(message.timestamp).getTime() - new Date(clearSentAt).getTime()
    : null;
  const fields = [
    `prev_status=${conductor.status}`,
    `clear_sent_at=${clearSentAt ?? "null"}`,
    `assigning_set_at=${conductor.assigningSetAt ?? "null"}`,
    `session_started_clear_at=${conductor.sessionStartedClearAt ?? "null"}`,
    `elapsed_since_clear_sent=${elapsed ?? "null"}`,
    `prompt_sent_at=${conductor.promptSentAt ?? "null"}`,
    `prompt_bytes=${conductor.promptBytes ?? "null"}`,
    `decision_reason=${decisionReason}`,
  ];
  return fields.join(" ");
}

/**
 * T261: SESSION_IDLE の出所推定（decision log Finding 2 / 4.5）。
 *
 * prev_status と既存の ConductorState フィールドだけで決定論的に 1 値に倒す。
 * 判定不能は "unknown" を返す（Decision D10: サイレント omit せず明示する）。
 *
 * 5000ms 閾値の根拠（Decision D11, Finding 2）:
 *   T253 事例で /clear 送信 → SESSION_IDLE 到達までが約 2 秒だった。
 *   2.5x のマージンを取り 5000ms を保守的な閾値とする。これより長い遅延は
 *   通常 clear_transient ではなく prompt_pending や user 起因と見るのが自然。
 */
function guessSessionIdleSource(
  prevStatus: ConductorState["status"],
  conductor: ConductorState,
  message: { timestamp: string },
): string {
  if (prevStatus === "assigning" && conductor.clearSentAt) {
    const elapsedMs =
      new Date(message.timestamp).getTime() - new Date(conductor.clearSentAt).getTime();
    if (elapsedMs < 5000) return "clear_transient";
  }
  if (prevStatus === "assigning" && !conductor.promptSentAt) {
    return "prompt_pending";
  }
  if (prevStatus === "running" && conductor.taskRunId) {
    return "assigned";
  }
  if (prevStatus === "disconnected") {
    return "recovered";
  }
  return "unknown";
}

/**
 * T260: broken 状態で SESSION_* を受信したときのログ。
 * 既存の `session_event_ignored_broken` は互換のため残しつつ、
 * broken にしたのに hook が届いている＝プロセスが生きている疑いを
 * 並行ログ `broken_conductor_still_alive` として可視化する。
 * 実際に alive かどうかは cmux.isAlive で確かめてから出す。
 */
async function logBrokenIgnore(conductor: ConductorState, event: string): Promise<void> {
  await log(
    "session_event_ignored_broken",
    `${formatSurface(conductor.surface, "C")} event=${event} reason=broken_requires_manual_clear`
  );
  if (conductor.pid !== undefined && cmux.isAlive(conductor.pid)) {
    await log(
      "broken_conductor_still_alive",
      `${formatSurface(conductor.surface, "C")} event=${event} ${formatConductorSnapshot(conductor)}`
    );
  }
}

export async function createDaemon(
  projectRoot: string,
  layout: LayoutMode = "16x9",
  backend?: RuntimeBackend,
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
  const state: DaemonState = {
    running: true,
    bootPhase: "infra",
    masters: new Map(),
    conductors: new Map(),
    projectRoot,
    pollInterval: Number(process.env.CMUX_TEAM_POLL_INTERVAL ?? 10_000),
    maxConductors,
    layout,
    lastUpdate: new Date(),
    pendingTasks: 0,
    openTasks: 0,
    taskList: [],
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
    mainBranch: "",
    traceDb: null,
    backend: backend ?? new ClaudeCodeBackend(),
    openCodeServerProcess: null,
    tokenDb: null,
    pool: null,
    poolPolicy: null,
    tokenDbInitFailed: false,
    startedAt: "",
    dashboardServerUrl: null,
    gcInterval: undefined,
    gcInFlight: false,
  };
  // Issue #30 M3-b Phase 2: opencode 等の非 Claude Code backend のイベントを購読する
  subscribeRuntimeEvents(state);
  return state;
}

/**
 * T351: token pool snapshot を state.pool に再計算して載せる。
 *
 * - state.tokenDb が null（pool OFF / 初期化失敗）→ state.pool を null に固定
 * - tokenDb が non-null → buildPoolSummary を呼んで state.pool に格納
 * - 内部で例外が起きたら state.pool=null に倒し、error ログを残す（次 tick で再試行）
 *
 * cmdStart のメインループ末尾（updateSidebarStatus の後）で毎 tick 呼ぶ前提。
 * daemon は long-running なので毎回 initTokenDB を呼ばず、boot 時 1 度だけ open した
 * ハンドルを使い回す（§7.1 リスク対策）。
 */
export async function refreshPoolSnapshot(state: DaemonState): Promise<void> {
  if (!state.tokenDb) {
    state.pool = null;
    return;
  }
  try {
    state.pool = buildPoolSummary(state.tokenDb, undefined, state.poolPolicy);
  } catch (e: any) {
    state.pool = null;
    await log("error", `refreshPoolSnapshot failed: ${e?.message ?? e}`);
  }
}

/**
 * daemon を停止する（T234）。
 *
 * `state.running = false` に加えて、`spawnPidWatcher` / `spawnAgentPidWatcher` /
 * `spawnMasterPidWatcher` で set された全 `setInterval` を明示的に `clearInterval` する。
 * 各 watcher は次回 tick で `state.running` が false なら self-clear するが、
 * 最大 1 秒ラグが残る。graceful shutdown 時や Bun テストの後片付けでは
 * イベントループを即座に解放したいため、まとめて同期的に stop する。
 *
 * 冪等: 既に stop 済みでも問題なく再呼び出しできる。
 */
export function stopDaemon(state: DaemonState): void {
  state.running = false;

  for (const conductor of state.conductors.values()) {
    if (conductor.pidWatcherInterval) {
      clearInterval(conductor.pidWatcherInterval);
      conductor.pidWatcherInterval = undefined;
    }
    for (const agent of conductor.agents) {
      if (agent.pidWatcherInterval) {
        clearInterval(agent.pidWatcherInterval);
        agent.pidWatcherInterval = undefined;
      }
    }
  }

  for (const master of state.masters.values()) {
    if (master.pidWatcherInterval) {
      clearInterval(master.pidWatcherInterval);
      master.pidWatcherInterval = undefined;
    }
  }

  // T416: 自動 GC の periodic timer を停止する
  if (state.gcInterval) {
    clearInterval(state.gcInterval);
    state.gcInterval = undefined;
  }
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
        "masters/",
        "proxy-port",
        "daemon.pid",
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
        "gh-cache.db",
        "gh-cache.db-shm",
        "gh-cache.db-wal",
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
      const lines = current.split("\n");
      let changed = false;
      const added: string[] = [];

      // T227: rate-limit.json の追加
      const hasRateLimit = lines.some((line) => {
        const t = line.trim();
        return t === "rate-limit.json" && !line.trimStart().startsWith("#");
      });
      if (!hasRateLimit) {
        const proxyPortIdx = lines.findIndex((l) => l.trim() === "proxy-port");
        if (proxyPortIdx >= 0) {
          lines.splice(proxyPortIdx + 1, 0, "rate-limit.json");
        } else {
          lines.push("rate-limit.json");
        }
        changed = true;
        added.push("rate-limit.json");
      }

      // T229: master.surface → masters/ への置換
      const masterSurfaceIdx = lines.findIndex(
        (l) => l.trim() === "master.surface" && !l.trimStart().startsWith("#")
      );
      const hasMastersDir = lines.some((line) => {
        const t = line.trim();
        return t === "masters/" && !line.trimStart().startsWith("#");
      });
      if (masterSurfaceIdx >= 0) {
        if (hasMastersDir) {
          lines.splice(masterSurfaceIdx, 1);
        } else {
          lines[masterSurfaceIdx] = "masters/";
        }
        changed = true;
        added.push("masters/");
      } else if (!hasMastersDir) {
        // rate-limit.json の後ろ、もしくは proxy-port の後ろに追加
        const anchorIdx = lines.findIndex(
          (l) => l.trim() === "rate-limit.json" || l.trim() === "proxy-port"
        );
        if (anchorIdx >= 0) {
          lines.splice(anchorIdx + 1, 0, "masters/");
        } else {
          lines.push("masters/");
        }
        changed = true;
        added.push("masters/");
      }

      // T315: daemon.pid の追加（proxy-port 直後に splice）
      const hasDaemonPid = lines.some((line) => {
        const t = line.trim();
        return t === "daemon.pid" && !line.trimStart().startsWith("#");
      });
      if (!hasDaemonPid) {
        const proxyPortIdx = lines.findIndex((l) => l.trim() === "proxy-port");
        if (proxyPortIdx >= 0) {
          lines.splice(proxyPortIdx + 1, 0, "daemon.pid");
        } else {
          lines.push("daemon.pid");
        }
        changed = true;
        added.push("daemon.pid");
      }

      // T315: gh-cache.db 系 3 項目の追加（末尾側の近傍 anchor 直後に splice）
      for (const name of ["gh-cache.db", "gh-cache.db-shm", "gh-cache.db-wal"]) {
        const hasEntry = lines.some((line) => {
          const t = line.trim();
          return t === name && !line.trimStart().startsWith("#");
        });
        if (hasEntry) continue;

        const anchorCandidates = [
          "gh-cache.db-wal",
          "gh-cache.db-shm",
          "gh-cache.db",
          "rate-limit.json",
          "proxy-port",
        ];
        let anchorIdx = -1;
        for (const anchor of anchorCandidates) {
          const idx = lines.findIndex((l) => l.trim() === anchor);
          if (idx >= 0) {
            anchorIdx = idx;
            break;
          }
        }
        if (anchorIdx >= 0) {
          lines.splice(anchorIdx + 1, 0, name);
        } else {
          lines.push(name);
        }
        changed = true;
        added.push(name);
      }

      if (changed) {
        const tail = current.endsWith("\n") && lines[lines.length - 1] !== "" ? "\n" : "";
        await writeFile(gitignore, lines.join("\n") + tail);
        await log("team_gitignore_migrated", `path=${gitignore} added=${added.join(",")}`);
      }
    } catch (e: any) {
      await log("error", `gitignore migration failed: ${e.message}`);
    }
  }

  // T417: 旧 Conductor 発見マーカーファイル (`.team/conductors/conductor.surface:NNN` 空ファイル)
  // を起動時に掃除する one-shot cleanup。`.gitignore` で `conductors/` は ignore 済みなので
  // 再混入リスクは無く、現役の `surface_NNN/agent-done/` 構造には触れない（cleanup.ts 参照）。
  try {
    const removedLegacy = await cleanupLegacyConductorMarkers(root);
    if (removedLegacy.length > 0) {
      await log(
        "legacy_conductor_markers_cleaned",
        `count=${removedLegacy.length} files=${removedLegacy.join(",")}`,
      );
    }
  } catch (e: any) {
    await log("error", `legacy_conductor_markers_cleanup failed: ${e.message}`);
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
          masters: [],
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

  // T229: 旧 `.team/master.surface` + team.json.master → `.team/masters/<surface>.json` への片道移行
  try {
    await migrateMasterLayout(state);
  } catch (e: any) {
    await log("error", `migrateMasterLayout failed: ${e?.message ?? e}`);
  }
}

/**
 * 旧単一 Master 時代の `.team/master.surface` / `team.json.master` を
 * 新レイアウト `.team/masters/<surface>.json` に一度だけ移行する（T229）。
 *
 * - `.team/masters/` が既に非空: 新レイアウト運用中とみなし何もしない
 * - `.team/master.surface` が存在: surface を読み、team.json.master.pid があれば採用
 *   して `.team/masters/<normalized>.json` を作成 → master.surface を削除
 * - 旧ファイルが無ければ何もしない（新規プロジェクト）
 */
export async function migrateMasterLayout(state: DaemonState): Promise<void> {
  const root = state.projectRoot;
  const markerPath = join(root, ".team/master.surface");
  const mastersDir = join(root, ".team/masters");

  // 既に新レイアウトへ移行済みなら noop
  try {
    const entries = await readdir(mastersDir);
    if (entries.some((e) => e.endsWith(".json"))) {
      // 旧 marker が残っていれば削除だけはする（冪等性のため）
      if (existsSync(markerPath)) {
        try {
          const { unlink } = await import("fs/promises");
          await unlink(markerPath);
          await log("master_layout_migrated", "cleaned_legacy_marker=true");
        } catch {}
      }
      return;
    }
  } catch {
    // mastersDir が無い場合は続行
  }

  if (!existsSync(markerPath)) return;

  let surface: string;
  try {
    surface = (await readFile(markerPath, "utf-8")).trim();
  } catch {
    return;
  }
  if (!surface) return;

  // team.json.master.pid を拾う（PID があれば引き継ぐ）
  let pid: number | undefined;
  try {
    const teamJsonPath = join(root, ".team/team.json");
    if (existsSync(teamJsonPath)) {
      const tj = JSON.parse(await readFile(teamJsonPath, "utf-8"));
      const p = tj?.master?.pid;
      if (typeof p === "number") pid = p;
    }
  } catch {
    // 読み失敗は致命的ではない。pid 不在として進める（restoreMasters が discard する）
  }

  const payload: MasterState = {
    surface,
    pid,
    status: "idle",
    startedAt: new Date().toISOString(),
  };
  try {
    await persistMasterFile(root, payload);
    await log(
      "master_layout_migrated",
      `${formatSurface(surface, "U")}${pid != null ? ` pid=${pid}` : " pid=unknown"} from=master.surface`
    );
  } catch (e: any) {
    await log("error", `master_layout_migrate_persist_failed: ${e?.message ?? e}`);
    return;
  }
  // 旧 marker を削除
  try {
    const { unlink } = await import("fs/promises");
    await unlink(markerPath);
  } catch (e: any) {
    await log("error", `master_layout_migrate_unlink_failed: ${e?.message ?? e}`);
  }
}

/**
 * `.team/masters/` 配下の既存 Master を PID で生存確認して復元する（T229）。
 *
 * - pid 記録あり & isAlive → `state.masters` に登録 + PID watcher 起動
 * - pid 記録なし or pid dead → ファイル削除（discard）
 *
 * 復元件数が 0 の場合は false を返す。呼び出し側は新規 spawn を検討する。
 */
async function restoreMasters(state: DaemonState): Promise<number> {
  const files = await listMasterFiles(state.projectRoot);
  let restored = 0;
  for (const { path, state: m } of files) {
    // pid 必須。未記録は v3.46.0 以前の互換値が残っている可能性があり discard。
    if (typeof m.pid !== "number") {
      await log(
        "master_restore_discarded",
        `${formatSurface(m.surface, "U")} reason=pid_missing path=${path}`
      );
      try {
        await deleteMasterFile(state.projectRoot, m.surface);
      } catch {}
      continue;
    }
    if (!cmux.isAlive(m.pid)) {
      await log(
        "master_restore_discarded",
        `${formatSurface(m.surface, "U")} pid=${m.pid} reason=pid_dead`
      );
      try {
        await deleteMasterFile(state.projectRoot, m.surface);
      } catch {}
      continue;
    }
    // 生存: state に登録し PID watcher を起動
    const restoredState: MasterState = {
      surface: m.surface,
      pid: m.pid,
      status: "idle",
      startedAt: m.startedAt,
      prompt: m.prompt,
    };
    state.masters.set(m.surface, restoredState);
    spawnMasterPidWatcher(state, m.surface, m.pid);
    await log(
      "master_restored",
      `${formatSurface(m.surface, "U")} pid=${m.pid} via=pid`
    );
    restored++;
  }
  return restored;
}

export async function startMaster(state: DaemonState, daemonSurface?: string): Promise<void> {
  // 既存の Master を PID ベースで復元
  let restored = 0;
  try {
    restored = await restoreMasters(state);
  } catch (e: any) {
    await log("master_check_error", e?.message ?? String(e));
  }

  // T230 S8: proxy ポート変更時は全 Master を再起動する。
  //   旧方式: removeMaster + closeSurface で終わり、下流の `restored === 0` で 1 つだけ spawn。
  //   新方式: 対象 Master 数だけ個別に spawnMaster を呼ぶ（複数 Master を維持）。
  //   spawn された pane は内部で cmdLaunchMaster → registerSelfAsMaster を走らせるため、
  //   daemon 側の state mutation は MASTER_REGISTERED handler 経由で行われる（D3 守護）。
  if (state.proxyPortChanged && restored > 0) {
    const respawnCount = state.masters.size;
    for (const surface of [...state.masters.keys()]) {
      await log(
        "master_respawn_proxy_changed",
        `${formatSurface(surface, "U")} newPort=${state.proxyPort}`
      );
      await removeMaster(state, surface, "proxy_port_changed");
      await cmux.closeSurface(surface).catch(() => {});
    }
    state.proxyPortChanged = false;
    restored = 0;
    // close 済み Master の数だけ再 spawn する
    for (let i = 0; i < respawnCount; i++) {
      await log("master_spawning");
      const spawned = await spawnMaster(daemonSurface);
      if (!spawned) {
        await log("master_spawn_failed");
      }
    }
    return;
  }

  // 復元 0 件なら新規 spawn（cmdStart の外部挙動は 1 つ立ち上げ）。
  //   F2 対処: 新関数を設けず `spawnMaster` を直接呼ぶ（D3 守護: state.masters.set は
  //   restoreMasters と MASTER_REGISTERED handler の 2 箇所のみ）。
  if (restored === 0) {
    await log("master_spawning");
    const spawned = await spawnMaster(daemonSurface);
    if (!spawned) {
      await log("master_spawn_failed");
    }
  }
}

/**
 * Master 1 つを state と永続ファイルから取り除く共通処理（T229）。
 * pidWatcherInterval も確実に停止する。
 */
export async function removeMaster(
  state: DaemonState,
  surface: string,
  reason: string,
): Promise<void> {
  const master = state.masters.get(surface);
  if (master?.pidWatcherInterval) {
    clearInterval(master.pidWatcherInterval);
  }
  state.masters.delete(surface);
  try {
    await deleteMasterFile(state.projectRoot, surface);
  } catch (e: any) {
    await log(
      "error",
      `deleteMasterFile failed: ${formatSurface(surface, "U")} reason=${reason} err=${e?.message ?? e}`
    );
  }
  await log("master_removed", `${formatSurface(surface, "U")} reason=${reason}`);
  notifyStateChanged(`daemon.ts:removeMaster:${reason}`);
}

/**
 * team.json の conductor 生データから ConductorState を構築する（A 経路の復元用）。
 * agents の PID alive 判定もここで行う。
 */
function restoreConductorState(c: any): ConductorState {
  const restoredAgents: AgentState[] = (c.agents ?? []).map((a: any) => ({
    surface: a.surface,
    role: a.role,
    sessionId: a.sessionId,
    spawnedAt: a.spawnedAt ?? new Date().toISOString(),
    pid: (typeof a.pid === "number" && cmux.isAlive(a.pid)) ? a.pid : undefined,
    // T236: 旧 team.json に status が無ければ "idle" にフォールバック。
    status: (a.status as AgentState["status"]) ?? "idle",
    // T323: token pool 用 handle（永続化されていれば復元）
    tokenHandle: typeof a.tokenHandle === "string" ? a.tokenHandle : undefined,
  }));
  return {
    surface: c.surface,
    taskRunId: c.taskRunId,
    taskId: c.taskId,
    taskTitle: c.taskTitle,
    worktreePath: c.worktreePath,
    outputDir: c.outputDir,
    startedAt: c.startedAt ?? new Date().toISOString(),
    disconnectedAt: c.disconnectedAt,
    sessionId: c.sessionId,
    pid: c.pid,
    agents: restoredAgents,
    // T260: lastHookAt は永続化対象。team.json に残っていれば復元する。
    lastHookAt: c.lastHookAt,
    // T261: clearSentAt のみ永続化対象。それ以外（promptSentAt / promptBytes /
    //       sessionStartedClearAt）はランタイム限定で、
    //       team.json に書き出していないため復元時も undefined に戻る（意図通り）。
    clearSentAt: c.clearSentAt,
    // T323: token pool 用 handle（永続化されていれば復元）
    tokenHandle: typeof c.tokenHandle === "string" ? c.tokenHandle : undefined,
    // T250: broken は再起動後も保持する（明示 clear まで idle に戻さない）
    status:
      c.status === "running" ? "running"
      : c.status === "disconnected" ? "disconnected"
      : c.status === "broken" ? "broken"
      : "idle",
  };
}

/**
 * 単一タスクの task-state を ready に戻す（unmatched / launch 失敗 / worktree 消失の救済）。
 * 失敗時は error ログのみで握りつぶす（呼び出し側のフローを止めない）。
 *
 * T303: applyTaskEvent(REVERT_TO_READY) 経由。assigned 以外からは reducer noop で
 * silently skip される。
 */
async function revertTaskToReady(
  projectRoot: string,
  taskId: string,
  reason:
    | "worktree_missing"
    | "launch_failed"
    | "unmatched"
    | "unique_violation"
    | "overflow",
): Promise<void> {
  try {
    await applyTaskEvent(projectRoot, {
      taskId,
      event: { type: "REVERT_TO_READY", reason },
      ctx: { hasConductor: false, parentAborted: false },
    });
  } catch (e: any) {
    await log("error", `revertTaskToReady failed: task_id=${taskId} reason=${reason} ${e.message}`);
  }
}

/**
 * planLayoutRestore で組み立てた復帰計画を実際に適用する（T255 §4）。
 *
 * 副作用:
 *   - state.conductors を一括置換（A 経路 + B 経路の pre-set）
 *   - PID watcher を再起動（A 経路）
 *   - C 経路の残骸 surface を close
 *   - B 経路は launchConductor で resume 起動。失敗時は state rollback + task-state を ready に戻す
 *   - taskId 整合性リコンサイル（A 経路で taskState が assigned でなければ taskId クリア）
 *   - unmatched + D 経路を task-state ready 戻しに合流。後段の `initializeLayout` で
 *     `state.maxConductors` まで topup 補充される（事後条件: state.conductors.size === maxConductors）
 *
 * @returns A/B 経路で確定した resume assignments（呼び出し元で main.ts の状態反映ループに渡す）
 */
async function applyRestorePlan(
  state: DaemonState,
  plan: LayoutRestorePlan,
): Promise<ResumeAssignment[]> {
  state.conductors.clear();

  // A: keep-alive
  //    state 登録 + PID watcher 再起動 + taskId 整合性リコンサイル
  // T303: task-state mutation は applyTaskEvent 経由に統一 (変更追跡フラグは撤去)
  const taskState = await loadTaskState(state.projectRoot);
  for (const entry of plan.alive) {
    const c = restoreConductorState(entry.raw);

    // taskId 整合性リコンサイル: taskState が assigned でなければ task 紐付けをクリア
    if (c.taskId) {
      const ts = taskState[c.taskId];
      if (!ts || ts.status !== "assigned") {
        await log(
          "conductor_taskid_reconciled",
          `${formatSurface(c.surface, "C")} task_id=${c.taskId} task_status=${ts?.status ?? "missing"} cleared=true`,
        );
        c.taskId = undefined;
        c.taskRunId = undefined;
        c.worktreePath = undefined;
        c.taskTitle = undefined;
        c.status = "idle";
      }
    }

    state.conductors.set(c.surface, c);
    if (typeof c.pid === "number") {
      spawnPidWatcher(state, c, c.pid);
    }
    for (const a of c.agents) {
      if (typeof a.pid === "number") {
        spawnAgentPidWatcher(state, c, a, a.pid);
      }
    }
  }

  // C (cleanup-stale) + E (discarded) の副作用を共通ヘルパに委譲（T286 Decision D2）。
  await applyDiscardOnly(state, plan);

  // B: resume-existing — sequential に launchConductor (resumeTaskId) を発火
  //    Promise.all で並列化しないこと（Claude Max レート制限回避）
  const assignments: ResumeAssignment[] = [];
  for (const entry of plan.resumeExisting) {
    const surface: string = entry.raw.surface;
    const item = entry.resume!;

    // worktree 消失の late check（main.ts の事前チェック後に削除されるレース対策）
    if (!existsSync(item.worktreePath)) {
      await log(
        "resume_worktree_missing_late",
        `task_id=${item.taskId} ${formatSurface(surface, "C")} worktree=${item.worktreePath}`,
      );
      // T303: REVERT_TO_READY(worktree_missing) — assigned のみ ready に戻す
      await applyTaskEvent(state.projectRoot, {
        taskId: item.taskId,
        event: { type: "REVERT_TO_READY", reason: "worktree_missing" },
        ctx: { hasConductor: false, parentAborted: false },
      });
      // in-memory taskState を再 load 同期 (T303: ヘルパ経由)
      await refreshTaskStateFromDisk(state.projectRoot, taskState);
      continue;
    }

    // pre-set: CONDUCTOR_REGISTERED ハンドラが既存エントリを skip するため、
    //   ここで task 紐付け済み state を立てておけば後続の self-register が
    //   破壊的に上書きしない（T228 idempotent merge）。
    state.conductors.set(surface, {
      surface,
      status: "running",
      startedAt: new Date().toISOString(),
      agents: [],
      taskId: item.taskId,
      taskRunId: item.taskRunId,
      worktreePath: item.worktreePath,
      taskTitle: item.taskTitle,
    });

    try {
      const sessionRef = await launchConductor(state.projectRoot, surface, {
        resumeTaskId: item.taskId,
        mainBranch: state.mainBranch,
      }, ccBackend(state.backend));
      // Issue #30 M3-b: SessionRef を conductor に保存して handleRuntimeEvent のルックアップに使う。
      const conductorForRef = state.conductors.get(surface);
      if (conductorForRef && sessionRef) conductorForRef.runtimeSessionRef = sessionRef as string;
      assignments.push({
        surface,
        taskId: item.taskId,
        taskRunId: item.taskRunId,
        worktreePath: item.worktreePath,
        sessionId: item.sessionId,
        taskTitle: item.taskTitle,
      });
    } catch (e: any) {
      // rollback: pre-set state を消し、task-state を ready に戻す
      state.conductors.delete(surface);
      // T303: REVERT_TO_READY(launch_failed)
      await applyTaskEvent(state.projectRoot, {
        taskId: item.taskId,
        event: { type: "REVERT_TO_READY", reason: "launch_failed" },
        ctx: { hasConductor: false, parentAborted: false },
      });
      await refreshTaskStateFromDisk(state.projectRoot, taskState);
      await log(
        "conductor_resume_launch_failed",
        `task_id=${item.taskId} ${formatSurface(surface, "C")} ${e?.message ?? e}`,
      );
    }
  }

  // D: resume-new-surface + 未マッチ resume → task-state を ready に戻す
  //    partial restore (A or B あり) 経路では D の resume は ready 戻し。
  //    後段の事後条件チェック (layout_conductors_topup) で補充された新 slot に
  //    Manager が次 tick で割り当てる。
  //    全 discard fallback 経路では initializeLayout 側で D を resumePlan として透過する (T346)。
  const allUnmatched: ResumePlanItem[] = [
    ...plan.unmatchedResumes,
    ...plan.resumeNewSurface
      .map(e => e.resume)
      .filter((r): r is ResumePlanItem => !!r),
  ];
  for (const item of allUnmatched) {
    if (taskState[item.taskId]) {
      // T303: REVERT_TO_READY(unmatched)
      await applyTaskEvent(state.projectRoot, {
        taskId: item.taskId,
        event: { type: "REVERT_TO_READY", reason: "unmatched" },
        ctx: { hasConductor: false, parentAborted: false },
      });
      await refreshTaskStateFromDisk(state.projectRoot, taskState);
    }
    await log(
      "resume_unmatched_to_ready",
      `task_id=${item.taskId} session_id=${item.sessionId}`,
    );
  }

  // T303: saveTaskState は applyTaskEvent 内で完結。ここでは呼ばない。
  notifyStateChanged("daemon.ts:applyRestorePlan:restore-applied");
  return assignments;
}

/**
 * 復帰計画 (planLayoutRestore) の C (cleanup-stale) / E (discarded) ブロックのみを適用する
 * 小さなヘルパ (T286 Decision D2 / D16)。
 *
 * ここでの "discard" は「conductor entry を `state.conductors` に登録しないで流す」
 * という広義の意味で、C 経路の close-surface 副作用も含む（Minor #7）。
 *
 * 使用箇所:
 *  - `applyRestorePlan`: A/B/C/D/E 全経路適用時の C/E ブロック共通化（bit-identical 性）
 *  - `initializeLayout`: 全 discard 自己修復 fallback 前の C/E 副作用流し
 *
 * 契約:
 *  - `state.conductors` を mutate しない（entry 登録なし）
 *  - cleanup ループは **sequential 実行**（`Promise.all` 禁止 — T286 Decision D13）
 *    → cmux 側で close-surface 中に new pane 作成リクエストが入るレースを避ける
 *  - `plan.discarded` のうち `reason === "surface_missing_no_task"` のみログ出力
 *    (`pid_dead_idle_cleanup` の行は C 経路の `conductor_stale_surface_closed` で
 *     記録済みのため二重出力を防ぐ — T286 Decision D12)
 *
 * @param _state 将来拡張用（現在未使用だが applyRestorePlan とシグネチャを揃える）
 * @param plan planLayoutRestore の戻り値
 */
async function applyDiscardOnly(
  _state: DaemonState,
  plan: LayoutRestorePlan,
): Promise<void> {
  // C: cleanup-stale — pid_dead + idle の残骸 pane を close（sequential）
  for (const surface of plan.cleanup) {
    await cmux.closeSurface(surface);
    await log(
      "conductor_stale_surface_closed",
      `${formatSurface(surface, "C")} reason=pid_dead_idle`,
    );
  }

  // E: discarded — log のみ（reason === "surface_missing_no_task" のみ）
  for (const d of plan.discarded) {
    if (d.reason === "surface_missing_no_task") {
      await log(
        "conductor_discarded",
        `${formatSurface(d.surface, "C")} reason=${d.reason}`,
      );
    }
  }
}

export async function initializeLayout(
  state: DaemonState,
  daemonSurface?: string,
  resumePlan?: ResumePlanItem[],
): Promise<ResumeAssignment[]> {
  const teamJsonPath = join(state.projectRoot, ".team/team.json");
  let conductorsFromJson: any[] = [];

  // team.json 読み込み + layout mismatch 早期通知（純観測ログ — T286 Decision D11）
  try {
    if (existsSync(teamJsonPath)) {
      const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
      conductorsFromJson = teamJson.conductors ?? [];
      const restoredLayout: LayoutMode =
        teamJson.layout === "wide" ? "wide" : "16x9";
      if (restoredLayout !== state.layout) {
        // 行動案内は削除（T286 fallback が入ると "kept" か "rebuild" かを
        // この地点では判定できないため、事実ベースの観測ログに統一）。
        await log(
          "layout_mismatch_on_resume",
          `restored=${restoredLayout} current=${state.layout}`,
        );
      }
    }
  } catch (e: any) {
    await log("error", `initializeLayout team.json read failed: ${e.message}`);
    conductorsFromJson = [];
  }

  // team.json が空 (or 読めない) → 新規スロット作成パス
  if (conductorsFromJson.length === 0) {
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
      ccBackend(state.backend),
    );
    return assignments;
  }

  // 既存 conductor あり → planLayoutRestore でマトリクス分類 → applyRestorePlan で副作用適用
  const liveSurfaces = await cmux.fetchLiveSurfaces(state.workspace ?? undefined);
  const plan = planLayoutRestore(
    conductorsFromJson,
    liveSurfaces,
    cmux.isAlive,
    resumePlan ?? [],
  );

  // T286 + T346: A=0 かつ B=0 (keep-alive も既存 pane resume も無い) なら
  //   "team.json 空相当" とみなし、C/E 副作用を流してから initializeConductorSlots に倒す。
  //   D 経路 (surface 消失 + running task) の resume は外部 resumePlan と合流させて
  //   新 slot に透過する (T346: R7 廃止 — 復帰時の pane 新規作成を許可)。
  //   発症条件: cmux セッションを完全終了 → 同 workspace で cmux-team start 再投入したとき、
  //   team.json の conductor entry の surface が cmux に全て存在しないケース（KDG-SSO 再現）。
  if (plan.alive.length === 0 && plan.resumeExisting.length === 0) {
    await log(
      "layout_restore_empty_fallback",
      `kept=0 discarded=${plan.discarded.length} layout=${state.layout}`,
    );
    // C/E 副作用を先に流してから新 slot 作成（pane 数が一時的に過剰になる瞬間を避ける）。
    await applyDiscardOnly(state, plan);
    // 外部 resumePlan に D 経路の resume を合流させて透過する。
    // 同一 taskId の重複 (D の resume は resumeByTaskId 経由で外部 resumePlan の同一インスタンス
    // を参照しうる) は Map で一意化する — 同一 taskId を 2 つの pane に launch しないため。
    const allResumePlanMap = new Map<string, ResumePlanItem>();
    for (const r of resumePlan ?? []) allResumePlanMap.set(r.taskId, r);
    for (const e of plan.resumeNewSurface) {
      if (e.resume) allResumePlanMap.set(e.resume.taskId, e.resume);
    }
    const allResumePlan: ResumePlanItem[] = [...allResumePlanMap.values()];
    return await initializeConductorSlots(
      state.projectRoot,
      state.conductors,
      state.maxConductors,
      daemonSurface,
      allResumePlan,
      state.layout,
      state.mainBranch,
      ccBackend(state.backend),
    );
  }

  const assignments = await applyRestorePlan(state, plan);

  // 観測性: 復元結果のサマリーログ
  const keptSurfaces = [
    ...plan.alive.map(e => e.raw.surface as string),
    ...plan.resumeExisting.map(e => e.raw.surface as string),
  ];
  if (keptSurfaces.length > 0) {
    await log(
      "conductors_restored",
      `count=${keptSurfaces.length} surfaces=${keptSurfaces.map(s => formatSurface(s, "C")).join(",")}`,
    );
  }
  // partial restore: 復元 pane 数が maxConductors 未満なら不足分を新規 slot で補充する
  // (T346: R7 廃止 — initializeLayout 完了時点で
  //  pane 数 (newSplit + 既存 alive) === maxConductors を保証する事後条件)。
  if (keptSurfaces.length > 0 && keptSurfaces.length < state.maxConductors) {
    await log(
      "layout_kept_partial",
      `kept=${keptSurfaces.length} max=${state.maxConductors}`,
    );
  }
  const deficit = state.maxConductors - state.conductors.size;
  if (deficit > 0) {
    await log(
      "layout_conductors_topup",
      `have=${state.conductors.size} max=${state.maxConductors} adding=${deficit}`,
    );
    const addl = await initializeConductorSlots(
      state.projectRoot,
      state.conductors,
      deficit,
      daemonSurface,
      undefined,
      state.layout,
      state.mainBranch,
      ccBackend(state.backend),
    );
    assignments.push(...addl);
  }

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

}

export async function handleMessage(state: DaemonState, message: QueueMessage): Promise<void> {
  // T216: hook 全送信ポリシー — ルーティング分岐の前に全シグナルを trace DB に記録する。
  //       失敗しても daemon を落とさないよう try/catch で包む。
  // T266: insertHookSignal は lastInsertRowid を return する。NOTIFICATION case で
  //       updateNotificationEnrichment を呼ぶため hookSignalId を受け取っておく。
  //       他 type では使わない（NULL のまま新 8 列が残る）。
  let hookSignalId: number | null = null;
  if (state.traceDb) {
    try {
      hookSignalId = insertHookSignal(state.traceDb, message);
    } catch (e: any) {
      await log("hook_signal_insert_failed", `type=${message.type} ${e?.message ?? e}`);
    }
  }

  // M3-b Phase 1: hook signal を正規化イベントに変換して backend リスナーに通知する。
  // SESSION_* の state 遷移ロジックは引き続き下記 switch で処理される（Phase 2 で移植予定）。
  // opencode backend では hook signal を使わないため ClaudeCodeBackend のみ対象。
  if (state.backend instanceof ClaudeCodeBackend) {
    state.backend.acceptHookSignal(message);
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
      // T263: success/reason を handleConductorDone に素渡しする。判定ロジックは
      //       handleConductorDone に集約（Decision D10）。ここでは isSuccess を
      //       ログ用に再利用するのみで、分岐判断は引き継がない。
      await handleConductorDone(state, conductor, {
        success: message.success,
        reason: message.reason,
      });
      break;
    }

    case "CONDUCTOR_CLEAR": {
      // T250: broken Conductor を明示的に idle に戻す専用経路。
      //       CONDUCTOR_DONE 流用だと `no_task` guard で早期 break されるため新 message 型で分離。
      const conductor = state.conductors.get(message.surface);
      if (!conductor) {
        await log(
          "conductor_clear_ignored",
          `surface=${message.surface} reason=not_found`
        );
        break;
      }
      if (conductor.status !== "broken") {
        await log(
          "conductor_clear_ignored",
          `${formatSurface(conductor.surface, "C")} status=${conductor.status} reason=not_broken`
        );
        break;
      }
      // cleanup は broken 遷移時点で既に済んでいるが、resetConductor は冪等なので
      // 再度呼んでも worktree 不在時は no-op 的に振る舞う。
      await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, {
        targetStatus: "idle",
        reason: message.reason ?? "cleared",
      }, ccBackend(state.backend));
      // 即時 tick を発火し、次の scanTasks で新タスクを拾えるようにする
      requestWakeup(state);
      break;
    }

    case "AGENT_TOKEN_BOUND": {
      // T323: spawn-agent の selectToken 成功直後に POST される第 2 メッセージ。
      // AGENT_SPAWNED で先に登録された agent.tokenHandle を後追い更新する。
      // race で agent が消えていた場合は warning ログのみ（state 変更なし）。
      const agentSurface = message.surface;
      let target: AgentState | undefined;
      let parentSurface: string | undefined;
      for (const [parent, c] of state.conductors) {
        const ag = c.agents.find((a) => a.surface === agentSurface);
        if (ag) {
          target = ag;
          parentSurface = parent;
          break;
        }
      }
      if (target) {
        if (target.tokenHandle !== message.tokenHandle) {
          target.tokenHandle = message.tokenHandle;
          notifyStateChanged("daemon.ts:handleMessage:agent_token_bound");
        }
        await log(
          "agent_token_bound",
          `${parentSurface ? formatPair(parentSurface, agentSurface, "C", "A") : formatSurface(agentSurface, "A")} handle=${message.tokenHandle}`,
        );
      } else {
        await log(
          "agent_token_bound_orphan",
          `${formatSurface(agentSurface, "A")} handle=${message.tokenHandle} reason=agent_not_found`,
        );
      }
      break;
    }

    case "AGENT_SPAWNED": {
      // T244: SESSION_STARTED F1 fallback で同 surface が master として仮登録されていたら
      //   agent が late register してきた時点で master 仮登録は誤りなので掃除する。
      //   T234 の CONDUCTOR_REGISTERED 側ロジックと対称。
      //   対策 A (main.ts cmdSpawnAgent で AGENT_SPAWNED を Claude 起動前に POST) により
      //   通常経路ではこの race は発生しないはずだが、キュー詰まり・手動 POST 等への保険。
      const staleMaster = state.masters.get(message.surface);
      if (staleMaster?.fallback) {
        await removeMaster(
          state,
          message.surface,
          "agent_spawned_late",
        );
        await log(
          "master_fallback_cleanup",
          `${formatSurface(message.surface, "U")} reason=agent_spawned_late`,
        );
      }

      const conductor = findConductor(state, message.conductorSurface);
      if (conductor) {
        // T260: broken 状態の Conductor から Agent が spawn されるのは
        //       「Conductor を broken 化したが実は生きていた」強い証拠。
        //       SESSION_* と対称に broken_conductor_still_alive を記録する。
        if (conductor.status === "broken") {
          await log(
            "broken_conductor_still_alive",
            `${formatSurface(conductor.surface, "C")} event=AGENT_SPAWNED ${formatConductorSnapshot(conductor)}`
          );
        }
        // T407: 後着 AGENT_SPAWNED 救済路。同 surface の agent が既に存在する場合
        //   (SESSION_STARTED 先着で agent 仮登録された等のレース) は push せず、
        //   sessionId のみ採用 / mismatch なら warn を出す。通常経路 (cmdSpawnAgent
        //   が AGENT_SPAWNED を Claude 起動より前に POST する) ではここに入らない。
        const existingAgent = conductor.agents.find((a) => a.surface === message.surface);
        if (existingAgent) {
          if (message.sessionId) {
            if (!existingAgent.sessionId) {
              existingAgent.sessionId = message.sessionId;
              notifyStateChanged("daemon.ts:handleMessage:agent-spawned-sessionid-late");
            } else if (existingAgent.sessionId !== message.sessionId) {
              await log(
                "session_id_mismatch_at_register_late",
                `${formatPair(conductor.surface, message.surface, "C", "A")} existing_session_id=${existingAgent.sessionId} preinject_session_id=${message.sessionId}`,
              );
            }
          }
          await log(
            "agent_spawn_skipped",
            `${formatPair(conductor.surface, message.surface, "C", "A")} reason=already_registered`,
          );
          break;
        }
        conductor.agents.push({
          surface: message.surface,
          role: message.role,
          taskTitle: message.taskTitle,
          spawnedAt: message.timestamp,
          status: "starting",
          // T407: pre-inject UUID を agent.sessionId に格納。SESSION_STARTED より先着するのが通常順序。
          sessionId: message.sessionId,
          // T392: 新規 agent エントリは lastApiError を持たない
          lastApiError: undefined,
        });
        notifyStateChanged("daemon.ts:handleMessage:agent-spawned");
        // T260: callerSurface/callerPid を agent_spawned ログに載せて、
        //       「想定外の主体（broken Conductor など）からの spawn」を可視化する。
        const callerSuffix = [
          message.callerSurface ? `caller=${formatSurface(message.callerSurface, "C")}` : "",
          message.callerPid !== undefined ? `caller_pid=${message.callerPid}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        await log(
          "agent_spawned",
          `${formatPair(message.conductorSurface, message.surface, "C", "A")}${message.role ? ` role=${message.role}` : ""}${callerSuffix ? ` ${callerSuffix}` : ""}`
        );
      }
      break;
    }

    case "SESSION_STARTED": {
      // Master surface チェック
      const master = state.masters.get(message.surface);
      if (master) {
        master.pid = message.pid;
        master.status = "idle";
        master.disconnectedAt = undefined;
        // T392: 通常状態に遷移したら API エラー情報をクリア
        master.lastApiError = undefined;
        // T408: SessionStart hook 経由で受信した sessionId を最新値に追従。
        // source=startup で既存 master.sessionId と不一致なら mismatch warn を出した上で
        // hook 信頼方針で上書きする。source=clear/compact/resume/undefined は warn 無し上書き
        // （legacy 互換 + T203 既存経路を維持）。state.sessionId 未設定なら warn 無しで採用
        // （POST 順序逆転 / F1 fallback の保険）。Conductor の T407 対称ロジック。
        const prevMasterSessionId = master.sessionId;
        if (message.sessionId) {
          if (
            message.source === "startup" &&
            prevMasterSessionId &&
            prevMasterSessionId !== message.sessionId
          ) {
            await log(
              "session_id_mismatch_at_startup_master",
              `${formatSurface(message.surface, "U")} preinject_session_id=${prevMasterSessionId} hook_session_id=${message.sessionId}`,
            );
          }
          master.sessionId = message.sessionId;
        }
        notifyStateChanged("daemon.ts:handleMessage:session-started-master");
        spawnMasterPidWatcher(state, message.surface, message.pid);
        try {
          await persistMasterFile(state.projectRoot, master);
        } catch (e: any) {
          await log(
            "error",
            `persistMasterFile failed (session_started): ${e?.message ?? e}`
          );
        }
        // using-cmux plugin の SessionStart hook が "[N] Claude Code" に rename
        // するため、Master では hook 発火後に "[N] Master" で上書きする（A016）。
        try {
          const num = message.surface.replace("surface:", "");
          await cmux.renameTab(message.surface, `[${num}] Master`);
        } catch (e: any) {
          await log(
            "error",
            `renameTab failed (master session_started): ${e?.message ?? e}`
          );
        }
        await log("master_session_started", `${formatSurface(message.surface, "U")} pid=${message.pid}`);
        break;
      }
      const conductor = findConductor(state, message.surface);
      if (conductor) {
        // T279: shadow observer 用の prev capture (mutation 前)。
        const shadowPrevStarted: ConductorStatus = conductor.status;
        // T250: broken は明示的クリア (clear-conductor) 以外で解除しない。
        //       自動復帰経路を塞ぎ、観測のため ignore ログを残す。
        if (conductor.status === "broken") {
          await logBrokenIgnore(conductor, "SESSION_STARTED");
          break;
        }
        // T392: error 状態は SESSION_STARTED で自然解除する（taskRunId 有無で running/idle）
        if (conductor.status === "error") {
          conductor.status = conductor.taskRunId ? "running" : "idle";
        }
        // T392: 通常状態に遷移したら API エラー情報をクリア
        conductor.lastApiError = undefined;
        // n1: 既存の starting/disconnected → idle 遷移ロジックは残す
        if (conductor.status === "starting" || conductor.status === "disconnected") {
          const prevStatus = conductor.status;
          conductor.status = "idle";
          await log(
            prevStatus === "starting" ? "conductor_ready" : "conductor_recovered",
            formatSurface(message.surface, "C")
          );
          // T358 §6.10: disconnected → idle 復帰のみ events.jsonl に流す
          // (starting → idle は spec の conductor_recovered ではなく conductor_ready)
          if (prevStatus === "disconnected") {
            await emitEvent({
              event: "conductor_recovered",
              conductor_surface: message.surface,
              new_status: "idle",
            });
          }
          // T302-race: disconnected → idle 復帰時に即 scanTasks を発火し、
          // "ready" 状態で待機中のタスクをこの Conductor に再割り当てする。
          if (prevStatus === "disconnected") {
            requestWakeup(state);
          }
        } else if (conductor.status === "assigning") {
          // T232: assignTask 実行中の /clear 完了 → SESSION_STARTED(source=clear) で running へ遷移
          conductor.status = "running";
          // T261: assigning → running 遷移のタイムスタンプを記録し、
          //       assigning_window_close を via=SESSION_STARTED_clear で発行する。
          //       elapsed は clear 送信 → SESSION_STARTED(source=clear) 受信までの経過 ms。
          conductor.sessionStartedClearAt = message.timestamp;
          const elapsedStartedMs = conductor.clearSentAt
            ? new Date(message.timestamp).getTime() - new Date(conductor.clearSentAt).getTime()
            : null;
          await log(
            "assigning_window_close",
            `${formatSurface(message.surface, "C")} via=SESSION_STARTED_clear elapsed=${elapsedStartedMs ?? "-"}`
          );
          await log(
            "conductor_running",
            `${formatSurface(message.surface, "C")} via=SESSION_STARTED source=${message.source ?? "-"}`
          );
          // T358 §6.9: assigning → running 遷移を events.jsonl に流す
          await emitEvent({
            event: "conductor_running",
            conductor_surface: message.surface,
            task_id: conductor.taskId ?? "",
          });
        }
        // T203: SessionStart hook 経由で受信した sessionId を最新値に追従。
        // T407: source=startup で既存 state.sessionId と不一致なら mismatch warn を出した上で
        //   hook 信頼方針で上書きする。source=clear/compact/resume/undefined は warn 無し上書き
        //   （legacy 互換 + T203 既存経路を維持）。state.sessionId 未設定なら warn 無しで採用
        //   （POST 順序逆転の保険）。
        const prevSessionId = conductor.sessionId;
        if (message.sessionId) {
          if (
            message.source === "startup" &&
            prevSessionId &&
            prevSessionId !== message.sessionId
          ) {
            await log(
              "session_id_mismatch_at_startup",
              `${formatSurface(message.surface, "C")} preinject_session_id=${prevSessionId} hook_session_id=${message.sessionId}`,
            );
          }
          conductor.sessionId = message.sessionId;
        }
        conductor.pid = message.pid;
        conductor.disconnectedAt = undefined;
        // T260: 最後に生存確認できた時刻を記録
        conductor.lastHookAt = message.timestamp;
        notifyStateChanged("daemon.ts:handleMessage:session-started-conductor");
        spawnPidWatcher(state, conductor, message.pid);

        // T203 C3 / T303: updateTaskSessionId に D5 3 段 guard を集約。
        // hook 配布物は taskRunId を知らないが、daemon 内部の突合で mismatch を検出する。
        if (
          message.sessionId &&
          prevSessionId !== message.sessionId &&
          conductor.taskId
        ) {
          try {
            const r = await updateTaskSessionId(
              state.projectRoot,
              conductor.taskId,
              message.sessionId,
              conductor.taskRunId,
            );
            if (r.written) {
              await log(
                "task_session_updated",
                `${formatSurface(message.surface, "C")} task_id=${conductor.taskId} session_id=${message.sessionId} source=${message.source ?? "-"}`
              );
            } else if (r.reason === "taskrun_mismatch") {
              // load → guard 時点の taskRunId をログに残せないので surface/session のみ
              await log(
                "task_session_update_skipped",
                `${formatSurface(message.surface, "C")} task_id=${conductor.taskId} conductor_task_run_id=${conductor.taskRunId ?? "-"} reason=stale_task_run_id`
              );
            }
            // not_assigned / unchanged / no_entry は silent (T303 R3 契約)
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
        // T279: shadow observe (observe only, no mutation).
        try {
          const ev: FsmEvent = {
            type: "SESSION_STARTED",
            source: message.source as "startup" | "resume" | "clear" | "compact" | undefined,
            isMasterSurface: false,
          };
          const cctx: ConductorCtx = {
            hasTaskRunId: conductor.taskRunId != null,
            isMasterSurface: false,
            now: Date.now(),
          };
          await shadowObserveConductor(message.surface, shadowPrevStarted, ev, cctx, conductor.status);
        } catch (e: any) {
          await log("error", `shadow_observe_failed SESSION_STARTED ${e?.message ?? e}`);
        }
        break;
      }

      // T195: Agent surface か？ 全 Conductor の agents 配列を逆引き
      let agentMatched = false;
      for (const c of state.conductors.values()) {
        const agent = c.agents.find(a => a.surface === message.surface);
        if (agent) {
          // T203: Agent も同様に最新 sessionId を反映
          // T407: source=startup で既存 sessionId と不一致なら mismatch warn を出してから上書き。
          if (message.sessionId) {
            const prevAgentSessionId = agent.sessionId;
            if (
              message.source === "startup" &&
              prevAgentSessionId &&
              prevAgentSessionId !== message.sessionId
            ) {
              await log(
                "session_id_mismatch_at_startup",
                `${formatPair(c.surface, message.surface, "C", "A")} preinject_session_id=${prevAgentSessionId} hook_session_id=${message.sessionId}`,
              );
            }
            agent.sessionId = message.sessionId;
          }
          agent.pid = message.pid;
          // T236: TUI spinner 用の status 遷移（starting/idle → running）
          agent.status = "running";
          // T392: 通常状態に遷移したら API エラー情報をクリア
          agent.lastApiError = undefined;
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
        // T230 F1: master/conductor/agent どれにも該当しない場合の fallback。
        //   MASTER_REGISTERED より先に SESSION_STARTED が届くレース（proxy-port 変化時の
        //   再 spawn や handleMessage キュー詰まり）に備え、master として仮 entry を作成し
        //   PID watcher を起動する。MASTER_REGISTERED が後から来ても idempotent skip で
        //   pid/status/startedAt は破壊されない。
        //   agent/conductor は事前登録（AGENT_SPAWNED / CONDUCTOR_REGISTERED）が Claude
        //   起動より前に送信される（T244 で cmdSpawnAgent 側を修正）。通常経路ではここに
        //   到達した SESSION_STARTED は実質 master のみ。キュー詰まり等の保険として
        //   T234/T244 で CONDUCTOR_REGISTERED/AGENT_SPAWNED ハンドラに fallback 掃除を
        //   入れてあるので、誤って master 登録されても late register で回復する。
        //   T234/T244: conductor/agent が後着で登録された場合の掃除用に `fallback: true`。
        const fallback: MasterState = {
          surface: message.surface,
          status: "starting",
          startedAt: message.timestamp,
          pid: message.pid,
          fallback: true,
        };
        state.masters.set(message.surface, fallback);
        try {
          await persistMasterFile(state.projectRoot, fallback);
        } catch (e: any) {
          await log(
            "error",
            `persistMasterFile failed (session_started_fallback): ${e?.message ?? e}`,
          );
        }
        spawnMasterPidWatcher(state, message.surface, message.pid);
        notifyStateChanged("daemon.ts:handleMessage:session-started-master-fallback");
        await log(
          "master_session_started_fallback",
          `${formatSurface(message.surface, "U")} pid=${message.pid} reason=master_registered_not_received_yet`,
        );
      }
      break;
    }

    case "CONDUCTOR_REGISTERED": {
      // T234: SESSION_STARTED F1 fallback で同 surface が master として仮登録されていたら
      //   conductor が late register してきた時点で master 仮登録は誤りなので掃除する。
      //   通常経路では registerSelfAsConductor が claude exec 前に POST されるため発生しないが、
      //   キュー詰まり等でレースが残る可能性に備える。
      const staleMaster = state.masters.get(message.surface);
      if (staleMaster?.fallback) {
        await removeMaster(
          state,
          message.surface,
          "conductor_registered_late",
        );
        await log(
          "master_fallback_cleanup",
          `${formatSurface(message.surface, "U")} reason=conductor_registered_late`,
        );
      }

      // T228: idempotent merge — 既存 state があれば skip（taskId/agents 等を破壊しないため）。
      //   cmdConductor / cmdResume 自身が POST する self-register 方式に変わったため、
      //   resume 経路では initializeConductorSlots が pre-set した state が既に存在する。
      // T407: ただし pre-inject UUID を後着で受け取った場合は、既存 state.sessionId と比較し
      //   未設定なら採用、既存値と異なるなら hook 信頼方針で破棄して warn ログを出す。
      if (state.conductors.has(message.surface)) {
        const existing = state.conductors.get(message.surface)!;
        if (message.sessionId) {
          if (!existing.sessionId) {
            // 既存 state はあるが sessionId は未設定 → pre-inject UUID を採用
            existing.sessionId = message.sessionId;
            notifyStateChanged("daemon.ts:handleMessage:conductor-registered-sessionid-late");
          } else if (existing.sessionId !== message.sessionId) {
            // POST 順序逆転: hook 側で確定済の sessionId を pre-inject 値で巻き戻さない
            await log(
              "session_id_mismatch_at_register_late",
              `${formatSurface(message.surface, "C")} existing_session_id=${existing.sessionId} preinject_session_id=${message.sessionId}`,
            );
          }
        }
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
        // T407: pre-inject UUID を初期 sessionId として記録。SESSION_STARTED より先着するのが通常順序。
        sessionId: message.sessionId,
      });
      notifyStateChanged("daemon.ts:handleMessage:conductor-registered");
      await log("conductor_registered", formatSurface(message.surface, "C"));
      // T279 shadow: REGISTERED 新規登録は reducer 上 no-op (shadow 側も pre-existing state 扱い)。
      try {
        const ev: FsmEvent = { type: "REGISTERED" };
        const cctx: ConductorCtx = { hasTaskRunId: false, now: Date.now() };
        await shadowObserveConductor(message.surface, "starting", ev, cctx, "starting");
      } catch (e: any) {
        await log("error", `shadow_observe_failed REGISTERED ${e?.message ?? e}`);
      }
      break;
    }

    case "MASTER_REGISTERED": {
      // T230: Master 側プロセスが `registerSelfAsMaster` で POST する。
      //   idempotent merge — 既存 state があれば skip（startedAt/pid/status を破壊しないため）。
      //   PID watcher はここでは起動しない。pid は後続の SESSION_STARTED hook で受信する（D6）。
      //   ただし F1 対処として、message.pid が渡されていれば即時 watcher を起動する経路も許容する。
      //   T234: 既存 entry が F1 fallback の場合は「誤登録ではなく正しい推測の確定」なので
      //   entry は残し fallback フラグのみ落とす（SESSION_STARTED で既に得た pid/startedAt を保持）。
      // T408: pre-inject UUID を後着で受け取った場合は、既存 state.sessionId と比較し
      //   未設定なら採用、既存値と異なるなら hook 信頼方針で破棄して warn ログを出す
      //   （Conductor の T407 対称ロジック）。
      const existing = state.masters.get(message.surface);
      if (existing) {
        let sessionUpdated = false;
        if (message.sessionId) {
          if (!existing.sessionId) {
            // 既存 state はあるが sessionId は未設定 → pre-inject UUID を採用
            existing.sessionId = message.sessionId;
            sessionUpdated = true;
          } else if (existing.sessionId !== message.sessionId) {
            // POST 順序逆転: hook 側で確定済の sessionId を pre-inject 値で巻き戻さない
            await log(
              "session_id_mismatch_at_register_late_master",
              `${formatSurface(message.surface, "U")} existing_session_id=${existing.sessionId} preinject_session_id=${message.sessionId}`,
            );
          }
        }
        if (existing.fallback) {
          existing.fallback = undefined;
          try {
            await persistMasterFile(state.projectRoot, existing);
          } catch (e: any) {
            await log(
              "error",
              `persistMasterFile failed (fallback_confirmed): ${e?.message ?? e}`,
            );
          }
          await log(
            "master_fallback_cleanup",
            `${formatSurface(message.surface, "U")} reason=master_registered_confirms_fallback`,
          );
          // 以降も skip 経路を通す（pid/startedAt を破壊しないため）
        } else if (sessionUpdated) {
          // T408: fallback クリーンアップ経路を通らない場合でも、sessionId 採用時は永続化する。
          try {
            await persistMasterFile(state.projectRoot, existing);
          } catch (e: any) {
            await log(
              "error",
              `persistMasterFile failed (master_registered_session_late): ${e?.message ?? e}`,
            );
          }
          notifyStateChanged("daemon.ts:handleMessage:master-registered-sessionid-late");
        }
        await log(
          "master_register_skipped",
          `${formatSurface(message.surface, "U")} reason=already_registered existing_status=${existing.status} existing_pid=${existing.pid ?? "null"}`,
        );
        break;
      }
      const master: MasterState = {
        surface: message.surface,
        status: "starting",
        startedAt: message.timestamp,
        pid: message.pid,
        // T408: pre-inject UUID を初期 sessionId として記録。SESSION_STARTED より先着するのが通常順序。
        sessionId: message.sessionId,
      };
      state.masters.set(message.surface, master);
      try {
        await persistMasterFile(state.projectRoot, master);
      } catch (e: any) {
        await log(
          "error",
          `persistMasterFile failed (master_registered): ${e?.message ?? e}`,
        );
      }
      // F1 第 2 経路: pid が optional で渡されていれば即時 watcher 起動。
      //   通常は SESSION_STARTED で pid を受ける設計だが、将来的に pid 同梱で POST するケースを許容する。
      if (typeof message.pid === "number") {
        spawnMasterPidWatcher(state, message.surface, message.pid);
      }
      notifyStateChanged("daemon.ts:handleMessage:master-registered");
      await log(
        "master_registered",
        `${formatSurface(message.surface, "U")} pid=${message.pid ?? "none"}`,
      );
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
      {
        const master = state.masters.get(message.surface);
        if (master) {
          master.status = "disconnected";
          master.disconnectedAt = message.timestamp;
          master.pid = undefined;
          notifyStateChanged("daemon.ts:handleMessage:session-ended-master");
          try {
            await persistMasterFile(state.projectRoot, master);
          } catch (e: any) {
            await log(
              "error",
              `persistMasterFile failed (session_ended): ${e?.message ?? e}`
            );
          }
          await log(
            "master_session_ended",
            `${formatSurface(message.surface, "U")}${message.reason ? ` reason=${message.reason}` : ""}`
          );
          break;
        }
      }
      const conductor = findConductor(state, message.surface);
      if (conductor) {
        // T279: shadow observer 用の prev capture (mutation 前)。
        const shadowPrevEnded: ConductorStatus = conductor.status;
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
        // T260: disconnect ログのため snapshot を pid クリア前に撮る
        const snapshot = formatConductorSnapshot(conductor);
        conductor.pid = undefined;
        notifyStateChanged("daemon.ts:handleMessage:session-ended-conductor");
        await log(
          "session_ended",
          `${formatSurface(message.surface, "C")} status=disconnected${message.reason ? ` reason=${message.reason}` : ""}`
        );
        // T260: SESSION_ENDED (reason != other) 由来の disconnect を snapshot 付きで出す。
        await log(
          "conductor_disconnected",
          `${formatSurface(message.surface, "C")} reason=session_ended${message.reason ? `:${message.reason}` : ""} ${snapshot}`
        );
        // T358 §6.11: events.jsonl にも SESSION_ENDED 由来の disconnect を流す
        await emitEvent({
          event: "conductor_disconnected",
          conductor_surface: message.surface,
          reason: "session_ended",
          ...(conductor.taskId ? { task_id: conductor.taskId } : {}),
        });
        // T279: shadow observe (observe only).
        try {
          const ev: FsmEvent = { type: "SESSION_ENDED", reason: message.reason };
          const cctx: ConductorCtx = {
            hasTaskRunId: conductor.taskRunId != null,
            now: Date.now(),
          };
          await shadowObserveConductor(message.surface, shadowPrevEnded, ev, cctx, conductor.status);
        } catch (e: any) {
          await log("error", `shadow_observe_failed SESSION_ENDED ${e?.message ?? e}`);
        }
      } else {
        // Agent surface かチェック (T181: done マーカーを書き出す)
        for (const c of state.conductors.values()) {
          const idx = c.agents.findIndex(a => a.surface === message.surface);
          if (idx !== -1) {
            const agent = c.agents[idx]!;
            // T231: close-agent は正常完了、それ以外（kill-agent, session_end 等）は crashed
            const agentStatus = message.reason === "close-agent" ? "completed" : "crashed";
            try {
              await writeAgentDone(state.projectRoot, c.surface, agent.surface, {
                status: agentStatus,
                reason: message.reason ?? "session_end",
              });
            } catch (e: any) {
              await log("error", `writeAgentDone failed (session_ended): ${e.message}`);
            }
            c.agents.splice(idx, 1);
            notifyStateChanged("daemon.ts:handleMessage:session-ended-agent");
            await log(
              "agent_done",
              `${formatPair(c.surface, message.surface, "C", "A")} trigger=session_ended status=${agentStatus}`
            );
            await releaseAgentTokenLease(agent.surface);
            break;
          }
        }
      }
      break;
    }

    case "SESSION_ACTIVE": {
      // Master surface チェック
      {
        const master = state.masters.get(message.surface);
        if (master) {
          master.status = "running";
          master.disconnectedAt = undefined;
          if (message.pid) master.pid = message.pid;
          notifyStateChanged("daemon.ts:handleMessage:session-active-master");
          try {
            await persistMasterFile(state.projectRoot, master);
          } catch (e: any) {
            await log(
              "error",
              `persistMasterFile failed (session_active): ${e?.message ?? e}`
            );
          }
          await log("master_session_active", formatSurface(message.surface, "U"));
          break;
        }
      }
      const conductor = findConductor(state, message.surface);
      if (conductor) {
        // T279: shadow observer 用の prev capture。
        const shadowPrevActive: ConductorStatus = conductor.status;
        // T250: broken は自動復帰経路を塞ぐ（明示 clear-conductor でのみ解除）。
        if (conductor.status === "broken") {
          await logBrokenIgnore(conductor, "SESSION_ACTIVE");
          break;
        }
        conductor.disconnectedAt = undefined;
        // T260: 最後に生存確認できた時刻を記録
        conductor.lastHookAt = message.timestamp;
        if (message.pid) conductor.pid = message.pid;
        if (conductor.status === "disconnected") {
          conductor.status = "running";
          await log("conductor_recovered", `${formatSurface(message.surface, "C")} via=SESSION_ACTIVE new_status=running`);
          // T358 §6.10: events.jsonl にも recovered を流す
          await emitEvent({
            event: "conductor_recovered",
            conductor_surface: message.surface,
            new_status: "running",
          });
        } else if (conductor.status === "starting") {
          conductor.status = "idle";
          await log("conductor_ready", `${formatSurface(message.surface, "C")} via=SESSION_ACTIVE`);
        } else if (conductor.status === "assigning" && conductor.taskRunId) {
          // T232 R1: SESSION_STARTED が配送順逆転で後着する race の保険。
          //          taskRunId が埋まっていれば assigning → running に遷移させる。
          conductor.status = "running";
          await log(
            "conductor_running",
            `${formatSurface(message.surface, "C")} via=SESSION_ACTIVE taskRunId=${conductor.taskRunId}`
          );
          // T358 §6.9: assigning → running 遷移を events.jsonl に流す
          await emitEvent({
            event: "conductor_running",
            conductor_surface: message.surface,
            task_id: conductor.taskId ?? "",
          });
        }
        notifyStateChanged("daemon.ts:handleMessage:session-active-conductor");
        // T279: shadow observe.
        try {
          const ev: FsmEvent = { type: "SESSION_ACTIVE" };
          const cctx: ConductorCtx = {
            hasTaskRunId: conductor.taskRunId != null,
            now: Date.now(),
          };
          await shadowObserveConductor(message.surface, shadowPrevActive, ev, cctx, conductor.status);
        } catch (e: any) {
          await log("error", `shadow_observe_failed SESSION_ACTIVE ${e?.message ?? e}`);
        }
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
      {
        const master = state.masters.get(message.surface);
        if (master) {
          master.status = "idle";
          master.disconnectedAt = undefined;
          if (message.pid) master.pid = message.pid;
          // T392: 通常状態に遷移したら API エラー情報をクリア
          master.lastApiError = undefined;
          notifyStateChanged("daemon.ts:handleMessage:session-idle-master");
          try {
            await persistMasterFile(state.projectRoot, master);
          } catch (e: any) {
            await log(
              "error",
              `persistMasterFile failed (session_idle): ${e?.message ?? e}`
            );
          }
          await log("master_session_idle", formatSurface(message.surface, "U"));
          break;
        }
      }
      const conductor = findConductor(state, message.surface);
      if (conductor) {
        // T250: broken は自動復帰経路を塞ぐ（明示 clear-conductor でのみ解除）。
        if (conductor.status === "broken") {
          await logBrokenIgnore(conductor, "SESSION_IDLE");
          break;
        }
        // T261: prev_status は分岐で conductor.status を書き換える前にスナップショットする。
        //       以降のガード / ログで使い回すため、分岐内で参照しない。
        const prevStatus = conductor.status;
        const sourceGuess = guessSessionIdleSource(prevStatus, conductor, message);
        conductor.disconnectedAt = undefined;  // alive の証拠 (Stop hook からのシグナル)
        // T260: 最後に生存確認できた時刻を記録
        conductor.lastHookAt = message.timestamp;
        if (message.pid) conductor.pid = message.pid;
        // T392: error 状態は SESSION_IDLE で taskRunId 有無で running/idle に戻す
        if (conductor.status === "error") {
          conductor.status = conductor.taskRunId ? "running" : "idle";
        }
        // T392: 通常状態に遷移したら API エラー情報をクリア
        conductor.lastApiError = undefined;
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
            // T358 §6.10: events.jsonl
            await emitEvent({
              event: "conductor_recovered",
              conductor_surface: message.surface,
              new_status: "running",
            });
          } else {
            // taskRunId なし → 通常復帰 (idle)
            conductor.status = "idle";
            await log("conductor_recovered", `${formatSurface(message.surface, "C")} via=SESSION_IDLE`);
            // T358 §6.10: events.jsonl
            await emitEvent({
              event: "conductor_recovered",
              conductor_surface: message.surface,
              new_status: "idle",
            });
          }
        } else if (conductor.status === "starting") {
          conductor.status = "idle";
          await log("conductor_ready", `${formatSurface(message.surface, "C")} via=SESSION_IDLE`);
        }
        // T277: assigning 中の SESSION_IDLE では何もしない（status 変更なし）。
        //       旧 R1 分岐（assigning → running に倒す保険）は撤去した。
        //       正規経路は SESSION_STARTED(source=clear)、fallback は ASSIGNING_TIMEOUT。
        //       観測用の session_idle ログは下で出る。
        notifyStateChanged("daemon.ts:handleMessage:session-idle-conductor");
        // T261: SESSION_IDLE の出所推定 (guessSessionIdleSource) を 1 key として併記。
        //       Agent surface 側（下の agent_done 分岐）には付けない（user_clear 調査対象外）。
        await log(
          "session_idle",
          `${formatSurface(message.surface, "C")} session_idle_source_guess=${sourceGuess}`
        );
        // T279: shadow observe.
        try {
          const ev: FsmEvent = { type: "SESSION_IDLE" };
          const cctx: ConductorCtx = {
            hasTaskRunId: conductor.taskRunId != null,
            now: Date.now(),
          };
          await shadowObserveConductor(message.surface, prevStatus, ev, cctx, conductor.status);
        } catch (e: any) {
          await log("error", `shadow_observe_failed SESSION_IDLE ${e?.message ?? e}`);
        }
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
        // T236: TUI spinner 用の status 遷移（running → idle）
        agent.status = "idle";
        // T392: 通常状態に遷移したら API エラー情報をクリア
        agent.lastApiError = undefined;
        notifyStateChanged("daemon.ts:handleMessage:session-idle-agent");
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
      if (state.masters.has(message.surface)) {
        await log("master_session_ask_ignored", `${formatSurface(message.surface, "U")}`);
        break;
      }

      // 2) Conductor surface か判定
      const conductor = findConductor(state, message.surface);
      if (conductor) {
        // T279: shadow observer 用の prev capture。
        const shadowPrevAsk: ConductorStatus = conductor.status;
        conductor.askQuestion = message.question;
        // T392: error → asking 遷移を明示（status="asking" は無条件代入なので
        //       実質的な分岐は不要だが、SESSION_STARTED / SESSION_IDLE と同じく
        //       lastApiError は SESSION_ASK でも自然解除する）
        conductor.status = "asking";
        // T392: 通常状態に遷移したら API エラー情報をクリア
        conductor.lastApiError = undefined;
        if (message.pid) conductor.pid = message.pid;
        conductor.disconnectedAt = undefined;
        // T260: 最後に生存確認できた時刻を記録
        conductor.lastHookAt = message.timestamp;
        notifyStateChanged("daemon.ts:handleMessage:session-ask-conductor");
        await log(
          "conductor_asking",
          `${formatSurface(message.surface, "C")} question=${truncate(message.question, 120)}`
        );
        // T358 §6.12: events.jsonl にも AskUserQuestion 受信を流す
        await emitEvent({
          event: "conductor_asking",
          conductor_surface: message.surface,
          question: message.question,
        });
        // T279: shadow observe.
        try {
          const ev: FsmEvent = { type: "SESSION_ASK" };
          const cctx: ConductorCtx = {
            hasTaskRunId: conductor.taskRunId != null,
            now: Date.now(),
          };
          await shadowObserveConductor(message.surface, shadowPrevAsk, ev, cctx, conductor.status);
        } catch (e: any) {
          await log("error", `shadow_observe_failed SESSION_ASK ${e?.message ?? e}`);
        }
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
        // T238: TUI spinner / 色変更のための status 遷移。
        //       SESSION_STARTED (running) / SESSION_IDLE (idle) の自然上書きで解除される。
        agent.status = "asking";
        // T392: 通常状態に遷移したら API エラー情報をクリア
        agent.lastApiError = undefined;
        notifyStateChanged("daemon.ts:handleMessage:session-ask-agent");
        // T238: OS 通知を Agent surface に送る (best-effort, fire-and-forget)。
        const subtitle = agent.taskTitle ?? agent.role ?? "Agent";
        const body = truncate(message.question, 200);
        void cmux.notify(message.surface, "Agent asking", body, { subtitle });
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
      // Master の /clear は state 遷移を発生させない（Conductor と違い reset は不要）。
      if (state.masters.has(message.surface)) {
        await log("master_session_clear_ignored", `${formatSurface(message.surface, "U")}`);
        break;
      }
      const conductor = findConductor(state, message.surface);
      // T279: shadow observer 用の prev capture (mutation 前)。
      const shadowPrevClear: ConductorStatus | undefined = conductor?.status;
      // T250: broken は自動復帰経路を塞ぐ（明示 clear-conductor でのみ解除）。
      //       assigning ガードよりも前に置き、下流の destructive 処理に落ちないようにする。
      if (conductor && conductor.status === "broken") {
        await logBrokenIgnore(conductor, "SESSION_CLEAR");
        break;
      }
      // T232: assigning 中の SESSION_CLEAR は daemon 自身が送った /clear の遅延発火。
      //       destructive な処理（task-state 書き換え / resetConductor）をスキップして早期 break する。
      //       これを `disconnected/starting → idle` 分岐より **前** に置くことで、
      //       不意のフォールスルーを防ぐ。
      if (conductor && conductor.status === "assigning") {
        // T261: 「daemon が送った clear を受けた」判定であっても、なぜそう判定したかの
        //       state を 1 行で残す。decision_reason=daemon_assign_clear。
        //       snapshot ログは session_clear_expected より前に出す（時系列で原因→結果）。
        await log(
          "user_clear_decision_snapshot",
          `${formatSurface(message.surface, "C")} case=session_clear_expected ${formatUserClearDecision(conductor, message, "daemon_assign_clear")}`
        );
        await log(
          "session_clear_expected",
          `${formatSurface(message.surface, "C")} reason=daemon_assign_clear taskRunId=${conductor.taskRunId ?? "-"}`
        );
        break;
      }
      if (conductor && (conductor.status === "disconnected" || conductor.status === "starting")) {
        const wasDisconnected = conductor.status === "disconnected";
        const event = conductor.status === "starting" ? "conductor_ready" : "conductor_recovered";
        conductor.status = "idle";
        conductor.disconnectedAt = undefined;
        // T260: 最後に生存確認できた時刻を記録
        conductor.lastHookAt = message.timestamp;
        // T195: pid 更新は SESSION_STARTED の責務に統一。SESSION_CLEAR で pid を触らない
        notifyStateChanged("daemon.ts:handleMessage:session-clear-idle");
        await log(event, `${formatSurface(message.surface, "C")} via=SESSION_CLEAR`);
        // T358 §6.10: disconnected → idle 復帰のみ events.jsonl に流す
        if (wasDisconnected) {
          await emitEvent({
            event: "conductor_recovered",
            conductor_surface: message.surface,
            new_status: "idle",
          });
        }
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
        // T261: user_clear 判定に入る前に snapshot を 1 行出す。
        //       「なぜ user_clear と判定したか」を後から grep で辿れるようにするため、
        //       task_aborted より **前** に出す（時系列で原因→結果）。
        await log(
          "user_clear_decision_snapshot",
          `${formatSurface(message.surface, "C")} case=user_clear ${formatUserClearDecision(conductor, message, "running_with_taskid")}`
        );
        // ユーザー手動 /clear → タスク abort + idle リセット
        // forceCloseDisconnectedConductor と同パターン
        const taskId = conductor.taskId;
        if (taskId) {
          // T290: markTaskAborted に集約（load/冪等ガード/journal/cascade/emit を内部化）
          try {
            const detail = `${formatSurface(conductor.surface, "C")} taskRunId=${conductor.taskRunId ?? "-"}`;
            const { revertedChildren } = await markTaskAborted(
              state.projectRoot,
              taskId,
              "user_clear",
              detail,
            );
            if (revertedChildren.length > 0) {
              notifyStateChanged("daemon.ts:handleMessage:session-clear-cascade");
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
        await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, undefined, ccBackend(state.backend));
      }
      // idle 時は何もしない（TUI チラつき防止）
      // T236: Conductor にマッチしなかった場合 Agent surface として status をリセット
      //       （/clear 後は次のターン開始を意味するため running に戻す）。
      //       destructive な処理（task-state / worktree 等）は行わない。
      if (!conductor) {
        for (const c of state.conductors.values()) {
          const agent = c.agents.find(a => a.surface === message.surface);
          if (!agent) continue;
          agent.status = "running";
          notifyStateChanged("daemon.ts:handleMessage:session-clear-agent");
          await log(
            "session_clear_agent_reset",
            `${formatPair(c.surface, agent.surface, "C", "A")} new_status=running`
          );
          break;
        }
      }
      // T279: shadow observe (conductor マッチ時のみ).
      if (conductor && shadowPrevClear !== undefined) {
        try {
          // manualUserInitiated: running + taskRunId 一致のケースを user 発 /clear と判定する
          // (daemon.ts:2174-2218 のガード通過経路)。それ以外は false で daemon 側 /clear と扱う。
          const manual =
            shadowPrevClear === "running" &&
            (!message.taskRunId || !conductor.taskRunId || message.taskRunId === conductor.taskRunId);
          const ev: FsmEvent = { type: "SESSION_CLEAR", manualUserInitiated: manual };
          const cctx: ConductorCtx = {
            hasTaskRunId: conductor.taskRunId != null,
            now: Date.now(),
          };
          await shadowObserveConductor(message.surface, shadowPrevClear, ev, cctx, conductor.status);
        } catch (e: any) {
          await log("error", `shadow_observe_failed SESSION_CLEAR ${e?.message ?? e}`);
        }
      }
      break;
    }

    case "NOTIFICATION": {
      // T266: Claude Code Notification hook の pure logging。
      // - state 遷移は起こさない（native OS 通知抑止と収集のみが目的）
      // - 入口で既に insertHookSignal 済み（T216 不変条件維持）、ここでは UPDATE で enrichment を追記
      // - DB 不在 or 入口 INSERT 失敗時は UPDATE せず skip log のみ残す（Minor 3）
      if (hookSignalId === null || !state.traceDb) {
        await log(
          "notification_skipped",
          `reason=${state.traceDb ? "insert_failed" : "no_db"} ${formatSurface(message.surface, "S")}`,
        );
        break;
      }
      const enrichment = resolveNotificationEnrichment(state, message);
      try {
        updateNotificationEnrichment(state.traceDb, hookSignalId, enrichment);
      } catch (e: any) {
        await log(
          "notification_enrichment_failed",
          `id=${hookSignalId} ${e?.message ?? e}`,
        );
      }
      await log("notification_received", formatNotificationLog(message, enrichment));
      break;
    }

    case "STOP_FAILURE": {
      // T392: Claude Code StopFailure hook 受信。target を逆引きして status="error" + lastApiError 上書き。
      const target = resolveStopFailureTarget(state, message);
      const kind = message.payload.error;
      const errorMessage = message.payload.last_assistant_message;
      const at = message.timestamp;

      if (!target) {
        await log(
          "stop_failure_unknown_surface",
          `${formatSurface(message.surface, "S")} kind=${kind}`,
        );
        await emitEvent({
          event: "api_error_received",
          role: "unknown",
          surface: message.surface,
          kind,
          message: errorMessage,
        });
        break;
      }

      if (target.role === "master") {
        const m = target.master;
        m.status = "error";
        m.lastApiError = { kind, message: errorMessage, at };
        notifyStateChanged("daemon.ts:handleMessage:stop-failure-master");
        try {
          await persistMasterFile(state.projectRoot, m);
        } catch (e: any) {
          await log("error", `persistMasterFile failed (stop_failure): ${e?.message ?? e}`);
        }
        await log(
          "api_error_received",
          `${formatSurface(m.surface, "U")} role=master kind=${kind}`,
        );
        await emitEvent({
          event: "api_error_received",
          role: "master",
          surface: m.surface,
          kind,
          message: errorMessage,
        });
      } else if (target.role === "conductor") {
        const c = target.conductor;
        c.status = "error";
        c.lastApiError = { kind, message: errorMessage, at };
        notifyStateChanged("daemon.ts:handleMessage:stop-failure-conductor");
        await log(
          "api_error_received",
          `${formatSurface(c.surface, "C")} role=conductor kind=${kind}`,
        );
        await emitEvent({
          event: "api_error_received",
          role: "conductor",
          surface: c.surface,
          kind,
          message: errorMessage,
        });
      } else {
        // agent
        const a = target.agent;
        const c = target.parent;
        a.status = "error";
        a.lastApiError = { kind, message: errorMessage, at };
        notifyStateChanged("daemon.ts:handleMessage:stop-failure-agent");
        // done file を書いて Conductor の await-agent に伝える
        try {
          await writeAgentDone(state.projectRoot, c.surface, a.surface, {
            status: "api_error",
            kind,
            message: errorMessage,
          });
        } catch (e: any) {
          await log("error", `writeAgentDone failed (stop_failure): ${e?.message ?? e}`);
        }
        await log(
          "api_error_received",
          `${formatPair(c.surface, a.surface, "C", "A")} role=agent kind=${kind}`,
        );
        await emitEvent({
          event: "api_error_received",
          role: "agent",
          surface: a.surface,
          kind,
          message: errorMessage,
        });
      }
      break;
    }

    case "SHUTDOWN":
      await log("shutdown_requested");
      // T234: 全 pidWatcher の clearInterval も同時に実行
      stopDaemon(state);
      notifyStateChanged("daemon.ts:handleMessage:shutdown");
      break;
  }
}

/**
 * T392: STOP_FAILURE hook の送信元 surface から target (master / conductor / agent) を逆引きする。
 * 優先順位は NotificationMessage と同じ:
 *   1. message.role === "master" → state.masters.get(surface)
 *   2. message.role === "conductor" → findConductor(state, surface)
 *   3. message.role === "agent" → conductors.agents[] を走査
 *   4. role 不在の場合 fallback: masters.has → conductors.get → agents 走査
 *   ※ settings.json は --role を必ず送る契約なので 4 は実質 dead code（将来互換のため維持）
 *   5. 全部 miss → undefined
 */
type StopFailureTarget =
  | { role: "master"; master: MasterState }
  | { role: "conductor"; conductor: ConductorState }
  | { role: "agent"; agent: AgentState; parent: ConductorState };

export function resolveStopFailureTarget(
  state: DaemonState,
  message: import("./schema").StopFailureMessage,
): StopFailureTarget | undefined {
  const surface = message.surface;
  if (message.role === "master") {
    const m = state.masters.get(surface);
    if (m) return { role: "master", master: m };
  } else if (message.role === "conductor") {
    const c = findConductor(state, surface);
    if (c) return { role: "conductor", conductor: c };
  } else if (message.role === "agent") {
    for (const c of state.conductors.values()) {
      const agent = c.agents.find((a) => a.surface === surface);
      if (agent) return { role: "agent", agent, parent: c };
    }
  }
  // fallback (契約上 role は常に来る、将来互換のため経路を維持)
  const m = state.masters.get(surface);
  if (m) return { role: "master", master: m };
  const c = findConductor(state, surface);
  if (c) return { role: "conductor", conductor: c };
  for (const conductor of state.conductors.values()) {
    const agent = conductor.agents.find((a) => a.surface === surface);
    if (agent) return { role: "agent", agent, parent: conductor };
  }
  return undefined;
}

/**
 * T266: NOTIFICATION hook の送信元 surface から role / task_id 等を逆引きする。
 * 優先順位:
 *   1. message.role（hook 側で埋まった canonical 値）
 *   2. state.masters.has(surface) → master
 *   3. findConductorBySurface(surface) → conductor + task_id
 *   4. conductors.agents[] を走査して一致する surface → agent + 親 Conductor の task_id
 *   5. 上記いずれも hit しない → role="unknown"
 *
 * notification_type / message は payload 内のキーを優先順位順に try する。
 */
export function resolveNotificationEnrichment(
  state: DaemonState,
  message: import("./schema").NotificationMessage,
): NotificationEnrichment {
  const surface = message.surface;
  const payload = message.payload ?? {};
  const payloadMessage =
    typeof payload.message === "string"
      ? payload.message
      : typeof payload.body === "string"
        ? payload.body
        : typeof payload.title === "string"
          ? payload.title
          : null;
  const payloadNType =
    typeof payload.notification_type === "string"
      ? payload.notification_type
      : typeof payload.type === "string"
        ? payload.type
        : typeof payload.subtype === "string"
          ? payload.subtype
          : null;

  const base: NotificationEnrichment = {
    surfaceUuid: message.surfaceUuid ?? null,
    workspaceUuid: message.workspaceUuid ?? null,
    message: payloadMessage,
    notificationType: payloadNType,
  };

  // 1. hook 側の canonical role を第一ソースとして採用
  if (message.role === "master") {
    return { ...base, role: "master" };
  }
  if (message.role === "conductor") {
    const c = state.conductors.get(surface);
    return {
      ...base,
      role: "conductor",
      taskId: c?.taskId ?? null,
      conductorSurface: surface,
    };
  }
  if (message.role === "agent") {
    // agent の親 Conductor を逆引き
    for (const c of state.conductors.values()) {
      const agent = c.agents.find((a) => a.surface === surface);
      if (agent) {
        return {
          ...base,
          role: "agent",
          taskId: c.taskId ?? null,
          conductorSurface: c.surface,
          agentRole: agent.role ?? null,
        };
      }
    }
    return { ...base, role: "agent" };
  }

  // 2〜5. hook に role が無い場合の fallback 逆引き
  if (state.masters.has(surface)) {
    return { ...base, role: "master" };
  }
  const c = state.conductors.get(surface);
  if (c) {
    return {
      ...base,
      role: "conductor",
      taskId: c.taskId ?? null,
      conductorSurface: surface,
    };
  }
  for (const conductor of state.conductors.values()) {
    const agent = conductor.agents.find((a) => a.surface === surface);
    if (agent) {
      return {
        ...base,
        role: "agent",
        taskId: conductor.taskId ?? null,
        conductorSurface: conductor.surface,
        agentRole: agent.role ?? null,
      };
    }
  }
  return { ...base, role: "unknown" };
}

/**
 * T266: NOTIFICATION を manager.log に 1 行で記録するためのフォーマット。
 * 例:
 *   C[192/22D8F9] role=conductor task_id=265 ntype=idle_prompt message="..." pid=80850
 */
export function formatNotificationLog(
  message: import("./schema").NotificationMessage,
  enrichment: NotificationEnrichment,
): string {
  const roleChar: import("./logger").SurfaceRole =
    enrichment.role === "master"
      ? "U"
      : enrichment.role === "conductor"
        ? "C"
        : enrichment.role === "agent"
          ? "A"
          : "S";

  const surfaceLabel = formatSurface(
    message.surface,
    roleChar,
    enrichment.surfaceUuid ?? undefined,
  );

  const parts: string[] = [surfaceLabel];
  parts.push(`role=${enrichment.role ?? "unknown"}`);
  if (enrichment.taskId) parts.push(`task_id=${enrichment.taskId}`);
  if (enrichment.agentRole) parts.push(`agent_role=${enrichment.agentRole}`);
  if (enrichment.notificationType) parts.push(`ntype=${enrichment.notificationType}`);
  parts.push(`message=${escapeLogMessage(enrichment.message)}`);
  parts.push(`pid=${message.pid}`);
  return parts.join(" ");
}

/**
 * T266: NOTIFICATION message のログ用エスケープ（D8）。
 * JSON.stringify で quote wrap + 制御文字エスケープを一括処理し、80 文字で truncate する。
 * truncate は JSON.stringify 前に行い、最終出力長は多少揺れる（parseability 優先 — Minor 2）。
 */
export function escapeLogMessage(raw: string | null | undefined): string {
  if (raw == null) return '""';
  const truncated = raw.length > 80 ? raw.slice(0, 77) + "..." : raw;
  return JSON.stringify(truncated);
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
      .filter(([_, s]) => isTerminalStatus(s.status))
      .map(([id]) => id)
  );

  const openTasksList = tasks.filter(t => !isTerminalStatus(t.status));
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
    deliverable: taskState[t.id]?.deliverable,
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

  // === スロットリングガード（T367 pool-aware）===
  // pool 有効時は canSelectAnyToken 経由で admit 候補ゼロを throttled とする。
  // pool 無効時は従来通り `unified5hUtilization >= THROTTLE_5H_THRESHOLD` を見る。
  // stale（リセット時刻を過ぎた復元値）は pool 無効経路でのみガード対象（pool 有効経路は SQLite が真実）。
  const throttled5h = isThrottled5h(state.tokenDb, state.rateLimit, {
    running: state.running,
    bootReady: state.bootPhase === "ready",
    policy: state.poolPolicy ?? undefined,
  });
  if (throttled5h && allExecutable.length > 0) {
    const util = state.rateLimit?.unified5hUtilization ?? null;
    const reset = state.rateLimit?.unified5hReset ?? null;
    const utilStr = util != null ? `${(util * 100).toFixed(1)}%` : "n/a";
    if (state.tokenDb !== null && state.poolPolicy) {
      const c = countPoolTokens(state.tokenDb, state.poolPolicy);
      await log(
        "throttled_rate_limit",
        `mode=pool pool=${c.available}/${c.total} selectable=${c.selectable} stale=${c.stale} 5h_utilization=${utilStr} threshold=95% reset=${reset ?? "unknown"} skipped_tasks=${allExecutable.length}`,
      );
    } else {
      const intended = state.tokenDbInitFailed
        ? " (pool_intended=on pool_active=off reason=db_init_failed)"
        : "";
      await log(
        "throttled_rate_limit",
        `mode=single${intended} 5h_utilization=${utilStr} threshold=${THROTTLE_5H_THRESHOLD * 100}% reset=${reset ?? "unknown"} skipped_tasks=${allExecutable.length}`,
      );
    }
    return;
  }

  // === Exclusive lock ガード ===
  // exclusive: true のタスクが assigned の間は他の全 assignment を停止する。
  // drain は parseTaskMeta で exclusive=true → runAfterAll=true に強制されるため
  // 既存の run_after_all 経路に乗る。ここでは「exclusive run 中は後続を出さない」
  // ことを保証する。
  const assignedExclusiveTaskIds = new Set(
    tasks.filter((t) => t.exclusive && assignedIds.has(t.id)).map((t) => t.id),
  );
  if (assignedExclusiveTaskIds.size > 0 && allExecutable.length > 0) {
    await log(
      "exclusive_lock_active",
      `task_ids=${[...assignedExclusiveTaskIds].join(",")} pending=${allExecutable.length}`,
    );
    return;
  }

  // === run_after_all lock ガード (T398) ===
  // runAfterAll: true && !exclusive のタスクが assigned の間、normal タスクの新規
  // assignment を停止する。他の run_after_all は並走可能（単独実行を保証したい場合は
  // --exclusive を使う）。
  // 評価順序: exclusive lock guard が先に return しているため、ここに到達した時点で
  //           exclusive な assigned は存在しない。defense-in-depth で `!t.exclusive` を付ける。
  const assignedRunAfterAllTaskIds = new Set(
    tasks
      .filter((t) => t.runAfterAll && !t.exclusive && assignedIds.has(t.id))
      .map((t) => t.id),
  );
  let dispatchTargets = allExecutable;
  if (assignedRunAfterAllTaskIds.size > 0 && executable.length > 0) {
    await log(
      "run_after_all_lock_active",
      `task_ids=${[...assignedRunAfterAllTaskIds].join(",")} pending_normal=${executable.length}`,
    );
    dispatchTargets = runAfterAllExecutable;
  }

  for (const task of dispatchTargets) {
    // idle Conductor を探す
    const idleConductor = [...state.conductors.values()].find(c => c.status === "idle");
    if (!idleConductor) {
      await log("throttled", `task_id=${task.id} no_idle_conductor`);
      break;
    }

    // spawn 前にロック（次の tick での二重起動を防止）
    assignedIds.add(task.id);

    // T279 shadow: assignTask 前の Conductor status を撮る (idle 前提だが safety)。
    const shadowPrevAssign: ConductorStatus = idleConductor.status;
    let updated: ConductorState;
    try {
      updated = await assignTask(idleConductor, task.id, state.projectRoot, state.mainBranch, ccBackend(state.backend));
    } catch (e: unknown) {
      if (e instanceof AssignTaskError) {
        if (e.kind === "task") {
          // タスク側の問題 → 該当タスクを abort し Conductor は idle のまま維持
          // T290: markTaskAborted に集約（load/冪等ガード/journal/cascade/emit を内部化）
          try {
            const { revertedChildren } = await markTaskAborted(
              state.projectRoot,
              task.id,
              "assign_failed",
              e.reason,
              { taskTitle: task.title, extraLogFields: { kind: "task" } },
            );
            if (revertedChildren.length > 0) {
              notifyStateChanged("daemon.ts:scanTasks:assign-failed-cascade");
            }
          } catch (err: any) {
            await log(
              "error",
              `markTaskAborted(assign_failed) failed: task_id=${task.id} ${err.message}`,
            );
          }
          // T232 R2: 保険 — assigning をセット済みで task kind 例外が飛んだ場合
          //          （現コードでは到達し得ないが将来変更への防衛）、disconnected に倒す。
          if (idleConductor.status === "assigning") {
            idleConductor.status = "disconnected";
            idleConductor.disconnectedAt = new Date().toISOString();
            notifyStateChanged("daemon.ts:scanTasks:assigning-fallback-disconnected");
            await log(
              "conductor_disconnected",
              `${formatSurface(idleConductor.surface, "C")} reason=assigning_stuck kind=task task_id=${task.id} ${formatConductorSnapshot(idleConductor)}`
            );
            // T358 §6.11: events.jsonl
            await emitEvent({
              event: "conductor_disconnected",
              conductor_surface: idleConductor.surface,
              reason: "assign_failed",
              task_id: task.id,
            });
          }
          // 次のタスクへ。idle Conductor はそのまま維持
          try {
            const ev: FsmEvent = { type: "ASSIGN", ok: false, errorKind: "task" };
            const cctx: ConductorCtx = { hasTaskRunId: idleConductor.taskRunId != null, now: Date.now() };
            await shadowObserveConductor(idleConductor.surface, shadowPrevAssign, ev, cctx, idleConductor.status);
          } catch (se: any) {
            await log("error", `shadow_observe_failed ASSIGN(task-fail) ${se?.message ?? se}`);
          }
          continue;
        }
        // e.kind === "conductor" → 従来通り disconnected
        idleConductor.status = "disconnected";
        idleConductor.disconnectedAt = new Date().toISOString();
        notifyStateChanged("daemon.ts:scanTasks:conductor-disconnected");
        await log(
          "conductor_disconnected",
          `${formatSurface(idleConductor.surface, "C")} reason=assign_failed kind=conductor task_id=${task.id} detail=${e.reason} ${formatConductorSnapshot(idleConductor)}`
        );
        // T358 §6.11: events.jsonl
        await emitEvent({
          event: "conductor_disconnected",
          conductor_surface: idleConductor.surface,
          reason: "assign_failed",
          task_id: task.id,
        });
        try {
          const ev: FsmEvent = { type: "ASSIGN", ok: false, errorKind: "conductor" };
          const cctx: ConductorCtx = { hasTaskRunId: idleConductor.taskRunId != null, now: Date.now() };
          await shadowObserveConductor(idleConductor.surface, shadowPrevAssign, ev, cctx, idleConductor.status);
        } catch (se: any) {
          await log("error", `shadow_observe_failed ASSIGN(conductor-fail) ${se?.message ?? se}`);
        }
        continue;
      }
      // AssignTaskError 以外の想定外例外（defensive: conductor.ts の catch-all が
      // すべてを AssignTaskError にラップしているためデッドコードに近いが、
      // 将来の変更に備えて最悪ケースとして conductor を落とす）。
      // T232 R2: assigning 状態で抜けた場合も確実に disconnected に倒す。
      await log("error", `assignTask unexpected: task_id=${task.id} ${(e as Error).message}`);
      idleConductor.status = "disconnected";
      idleConductor.disconnectedAt = new Date().toISOString();
      notifyStateChanged("daemon.ts:scanTasks:conductor-disconnected");
      try {
        const ev: FsmEvent = { type: "ASSIGN", ok: false, errorKind: "conductor" };
        const cctx: ConductorCtx = { hasTaskRunId: idleConductor.taskRunId != null, now: Date.now() };
        await shadowObserveConductor(idleConductor.surface, shadowPrevAssign, ev, cctx, idleConductor.status);
      } catch (se: any) {
        await log("error", `shadow_observe_failed ASSIGN(unexpected) ${se?.message ?? se}`);
      }
      continue;
    }

    state.conductors.set(updated.surface, updated);
    notifyStateChanged("daemon.ts:scanTasks:conductor-updated");
    // T279 shadow: ASSIGN 成功 — idle → assigning。
    try {
      const ev: FsmEvent = { type: "ASSIGN", ok: true };
      const cctx: ConductorCtx = { hasTaskRunId: updated.taskRunId != null, now: Date.now() };
      await shadowObserveConductor(updated.surface, shadowPrevAssign, ev, cctx, updated.status);
    } catch (se: any) {
      await log("error", `shadow_observe_failed ASSIGN(ok) ${se?.message ?? se}`);
    }
    // task-state.json に assigned + assignedAt + resume 情報を記録。
    // T303: terminal race ガードは applyTaskEvent(ASSIGN_OK) の reducer noop に集約。
    const r = await applyAssignCommit(state, task.id, updated);
    if (!r.committed) continue;
  }
}

/**
 * T303: assign 完了書き込みを applyTaskEvent(ASSIGN_OK) 経由に集約。
 *
 * reducer の ASSIGN_OK は `state === "ready"` のみ assigned に遷移、それ以外は noop。
 * noop 時の分岐:
 *   - prev ∈ { closed, aborted, deleted } → terminal race (T302 旧挙動互換)。
 *     `assign_skipped` ログ + resetConductor で worktree / branch を巻き戻す
 *   - それ以外 (assigned / draft / unknown) → scanTasks のバグ or race。
 *     過剰 reset を避けるため `assign_skipped_unexpected` ログのみ残し reset しない
 */
async function applyAssignCommit(
  state: DaemonState,
  taskId: string,
  updated: ConductorState,
): Promise<{ committed: boolean; reason?: "terminal" | "non_ready"; currentStatus?: string }> {
  const result = await applyTaskEvent(state.projectRoot, {
    taskId,
    event: { type: "ASSIGN_OK" },
    ctx: { hasConductor: true, parentAborted: false },
    patch: (_prev, next) =>
      next === "assigned"
        ? {
            merge: {
              assignedAt: new Date().toISOString(),
              worktreePath: updated.worktreePath,
              taskRunId: updated.taskRunId,
              conductorSlot: updated.surface,
              sessionId: updated.sessionId,
            },
          }
        : {},
    // T358 M6: events.jsonl の task_assigned に conductor surface / taskRunId を載せる。
    eventStream: {
      conductorSurface: updated.surface,
      taskRunId: updated.taskRunId ?? "",
    },
  });

  if (result.committed) {
    return { committed: true };
  }

  const prev = result.prev;
  if (prev === "closed" || prev === "aborted" || prev === "deleted") {
    await log(
      "assign_skipped",
      `${formatSurface(updated.surface, "C")} task_id=${taskId} reason=terminal prev=${prev} taskRunId=${updated.taskRunId ?? "-"}`,
    );
    await resetConductor(updated, state.projectRoot, state.workspace ?? undefined, undefined, ccBackend(state.backend));
    return { committed: false, reason: "terminal", currentStatus: prev };
  }

  // assigned / draft / undefined からの noop。scanTasks のバグ or race の兆候。
  // reset せず警告のみ。
  await log(
    "assign_skipped_unexpected",
    `${formatSurface(updated.surface, "C")} task_id=${taskId} prev=${prev ?? "missing"} (scanTasks selected non-ready)`,
  );
  return { committed: false, reason: "non_ready", currentStatus: prev };
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
  // T279 shadow: PID_DIED の prev 状態を disconnected 代入前に撮る。
  const shadowPrevPidDied: ConductorStatus = conductor.status;
  conductor.status = "disconnected";
  conductor.disconnectedAt = new Date().toISOString();
  // T260: disconnect ログのため snapshot を pid クリア前に撮る
  //       (formatConductorSnapshot は conductor.pid を参照するため)
  const snapshot = formatConductorSnapshot(conductor);
  conductor.pid = undefined;
  notifyStateChanged("daemon.ts:spawnPidWatcher:conductor-disconnected");
  // sessionId は保持する（resume で必要）。
  // Conductor 再起動時に SessionStart hook (T203) で最新値に上書きされる。
  await log(
    "session_ended",
    `${formatSurface(conductor.surface, "C")} pid=${pid} status=disconnected reason=pid_watcher`
  );
  // T260: disconnect 遷移の原因・状態を一本で追跡できるよう snapshot 付きで出す。
  await log(
    "conductor_disconnected",
    `${formatSurface(conductor.surface, "C")} reason=pid_dead ${snapshot}`
  );
  // T358 §6.11: events.jsonl
  await emitEvent({
    event: "conductor_disconnected",
    conductor_surface: conductor.surface,
    reason: "pid_dead",
    ...(conductor.taskId ? { task_id: conductor.taskId } : {}),
  });
  try {
    const ev: FsmEvent = { type: "PID_DIED" };
    const cctx: ConductorCtx = { hasTaskRunId: conductor.taskRunId != null, now: Date.now() };
    await shadowObserveConductor(conductor.surface, shadowPrevPidDied, ev, cctx, conductor.status);
  } catch (e: any) {
    await log("error", `shadow_observe_failed PID_DIED ${e?.message ?? e}`);
  }
  return "dead";
}

/**
 * RuntimeBackend から ClaudeCodeBackend を取り出すヘルパー。
 * opencode backend の場合は undefined を返す（conductor 関数は ClaudeCodeBackend を期待）。
 * Claude Code 固有の操作（launchConductor / assignTask 等）に渡す時に使う。
 */
export function ccBackend(backend: RuntimeBackend): ClaudeCodeBackend | undefined {
  return backend instanceof ClaudeCodeBackend ? backend : undefined;
}

// ---------------------------------------------------------------------------
// Issue #30 M3-b Phase 2: RuntimeBackend.onEvent() のサブスクリプション
// ---------------------------------------------------------------------------

/**
 * backend.onEvent() を購読して RuntimeEvent を handleRuntimeEvent に流す。
 *
 * ClaudeCodeBackend の場合は SESSION_* → handleMessage() で処理されるため
 * 購読しない（二重処理防止）。opencode 等の非 Claude Code backend でのみ有効。
 *
 * createDaemon() 内で呼ぶことで daemon 起動時に一度だけ登録される。
 */
export function subscribeRuntimeEvents(state: DaemonState): void {
  if (state.backend instanceof ClaudeCodeBackend) {
    // Claude Code は SESSION_* → handleMessage で処理されるため不要
    return;
  }
  state.backend.onEvent((event) => {
    handleRuntimeEvent(state, event).catch((e: any) => {
      log("error", `handleRuntimeEvent error: ${e?.message ?? e}`);
    });
  });
}

/**
 * opencode backend からの RuntimeEvent を daemon 状態機械に適用する。
 *
 * Claude Code の SESSION_* ハンドラ（handleMessage）に相当する、
 * runtime-agnostic な状態遷移ロジック。PID watcher の代わりに session_ended
 * イベントで死亡を検知する。
 *
 * session ref → conductor のルックアップは conductor.runtimeSessionRef を使う。
 * launchConductor() が spawn() の返り値を daemon.ts で保存することで確立される。
 */
async function handleRuntimeEvent(state: DaemonState, event: RuntimeEvent): Promise<void> {
  if (!state.running) return;

  // conductor を runtimeSessionRef で逆引きする
  function findConductorByRef(ref: string): ConductorState | undefined {
    for (const c of state.conductors.values()) {
      if (c.runtimeSessionRef === ref) return c;
    }
    return undefined;
  }

  // opencode Agent を surface（"oc:<sessionRef>"）で逆引きする（Issue #37 M3）
  function findOcAgent(ref: string): { agent: AgentState; conductor: ConductorState } | undefined {
    const surface = `oc:${ref}`;
    for (const c of state.conductors.values()) {
      const agent = c.agents.find(a => a.surface === surface);
      if (agent) return { agent, conductor: c };
    }
    return undefined;
  }

  switch (event.type) {
    case "session_started": {
      const conductor = findConductorByRef(event.sessionRef as string);
      if (!conductor) break;
      if (conductor.status === "starting" || conductor.status === "disconnected") {
        conductor.status = "idle";
        notifyStateChanged("daemon.ts:handleRuntimeEvent:session-started");
        await log("conductor_ready", formatSurface(conductor.surface, "C"));
      } else if (conductor.status === "assigning") {
        conductor.status = "running";
        notifyStateChanged("daemon.ts:handleRuntimeEvent:session-started-running");
        await log("conductor_running", `${formatSurface(conductor.surface, "C")} via=runtime_event`);
        // T358 §6.9: events.jsonl
        await emitEvent({
          event: "conductor_running",
          conductor_surface: conductor.surface,
          task_id: conductor.taskId ?? "",
        });
      }
      break;
    }

    case "session_idle": {
      const conductor = findConductorByRef(event.sessionRef as string);
      if (conductor) {
        if (conductor.status === "running" || conductor.status === "starting") {
          conductor.status = "idle";
          notifyStateChanged("daemon.ts:handleRuntimeEvent:session-idle");
          await log("conductor_idle", `${formatSurface(conductor.surface, "C")} via=runtime_event`);
          requestWakeup(state);
        }
        break;
      }
      // opencode Agent の idle → done-file に STATUS=completed を書く（Issue #37 M3）
      const idleEntry = findOcAgent(event.sessionRef as string);
      if (idleEntry) {
        await writeAgentDone(state.projectRoot, idleEntry.conductor.surface, idleEntry.agent.surface, {
          status: "completed",
        });
        await log(
          "oc_agent_done",
          `agent=${idleEntry.agent.surface} conductor=${formatSurface(idleEntry.conductor.surface, "C")} status=completed`,
        );
        await releaseAgentTokenLease(idleEntry.agent.surface);
      }
      break;
    }

    case "session_ended": {
      const conductor = findConductorByRef(event.sessionRef as string);
      if (conductor) {
        // session_ended は死亡通知なので disconnected 状態へ遷移する
        if (conductor.status !== "broken") {
          conductor.status = "disconnected";
          conductor.disconnectedAt = new Date().toISOString();
          notifyStateChanged("daemon.ts:handleRuntimeEvent:session-ended");
          await log(
            "conductor_session_ended",
            `${formatSurface(conductor.surface, "C")} reason=${event.reason ?? "unknown"} via=runtime_event`,
          );
        }
        break;
      }
      // opencode Agent の session 終了 → done-file に STATUS=crashed を書く（Issue #37 M3）
      const endedEntry = findOcAgent(event.sessionRef as string);
      if (endedEntry) {
        await writeAgentDone(state.projectRoot, endedEntry.conductor.surface, endedEntry.agent.surface, {
          status: "crashed",
          reason: event.reason ?? "session_ended",
        });
        await log(
          "oc_agent_done",
          `agent=${endedEntry.agent.surface} conductor=${formatSurface(endedEntry.conductor.surface, "C")} status=crashed reason=${event.reason ?? "unknown"}`,
        );
        await releaseAgentTokenLease(endedEntry.agent.surface);
      }
      break;
    }

    case "permission_asked": {
      // opencode Agent の permission_asked → done-file に STATUS=ask を書く（Issue #37 M3）
      const askEntry = findOcAgent(event.sessionRef as string);
      if (askEntry) {
        await writeAgentDone(state.projectRoot, askEntry.conductor.surface, askEntry.agent.surface, {
          status: "ask",
          question: event.title,
        });
        await log(
          "oc_agent_done",
          `agent=${askEntry.agent.surface} conductor=${formatSurface(askEntry.conductor.surface, "C")} status=ask title=${event.title}`,
        );
        break;
      }
      const conductor = findConductorByRef(event.sessionRef as string);
      const suffix = conductor ? formatSurface(conductor.surface, "C") : `ref=${event.sessionRef}`;
      await log("permission_asked", `${suffix} title=${event.title} permRef=${event.permissionRef}`);
      break;
    }

    case "session_reset": {
      // opencode では reset = abort + create。session_started が後続する想定。
      const conductor = findConductorByRef(event.sessionRef as string);
      if (!conductor) break;
      if (event.newSessionRef) {
        conductor.runtimeSessionRef = event.newSessionRef as string;
      }
      conductor.status = "starting";
      notifyStateChanged("daemon.ts:handleRuntimeEvent:session-reset");
      await log("conductor_reset", `${formatSurface(conductor.surface, "C")} via=runtime_event`);
      break;
    }
  }
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
  await releaseAgentTokenLease(agent.surface);
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
  surface: string,
  pid: number
): Promise<"alive" | "dead" | "stopped" | "stale" | "gone"> {
  if (!state.running) return "stopped";
  if (cmux.isAlive(pid)) return "alive";
  const master = state.masters.get(surface);
  if (!master) return "gone";
  if (master.pid !== pid) return "stale";
  master.status = "disconnected";
  master.disconnectedAt = new Date().toISOString();
  master.pid = undefined;
  notifyStateChanged("daemon.ts:spawnMasterPidWatcher:master-disconnected");
  try {
    await persistMasterFile(state.projectRoot, master);
  } catch (e: any) {
    await log(
      "error",
      `persistMasterFile failed (pid_watcher): ${e?.message ?? e}`
    );
  }
  await log(
    "master_session_ended",
    `${formatSurface(surface, "U")} pid=${pid} reason=pid_watcher`
  );
  return "dead";
}

export function spawnMasterPidWatcher(
  state: DaemonState,
  surface: string,
  pid: number,
): void {
  const master = state.masters.get(surface);
  if (master?.pidWatcherInterval) {
    clearInterval(master.pidWatcherInterval);
    master.pidWatcherInterval = undefined;
  }
  const checkInterval = setInterval(async () => {
    const result = await __testSpawnMasterPidWatcherTick(state, surface, pid);
    if (result !== "alive") {
      clearInterval(checkInterval);
      const current = state.masters.get(surface);
      if (current && current.pidWatcherInterval === checkInterval) {
        current.pidWatcherInterval = undefined;
      }
    }
  }, 1000);
  if (master) master.pidWatcherInterval = checkInterval;
}

/** starting 状態のタイムアウト（秒） */
const STARTING_TIMEOUT_SEC = 60;
/**
 * assigning 状態のタイムアウト（秒） — 超過で disconnected に倒す（T232）。
 *
 * /clear 送信から SESSION_STARTED(source=clear) 到達までの実測遅延は ~10 秒。
 * 10 倍のマージンを取って 60 秒とする。これを超えたら disconnected → 5 分 timeout
 * → forced close の経路で人間が認識できる形に落ちる。
 */
const ASSIGNING_TIMEOUT_SEC = 60;
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
    // T250: broken はユーザーの明示操作（clear-conductor / abort-task / restart-task）
    //       でのみ解除される。timeout 判定の対象外（2 度目の timeout を発火させない）。
    if (conductor.status === "broken") {
      continue;
    }
    // starting: タイムアウトチェックのみ
    if (conductor.status === "starting") {
      const elapsed = (Date.now() - new Date(conductor.startedAt).getTime()) / 1000;
      if (elapsed > STARTING_TIMEOUT_SEC) {
        const shadowPrevStartingTO: ConductorStatus = conductor.status;
        conductor.status = "disconnected";
        conductor.disconnectedAt = new Date().toISOString();
        notifyStateChanged("daemon.ts:monitorConductors:starting-timeout");
        await log(
          "conductor_start_timeout",
          `${formatSurface(surface, "C")} elapsed=${Math.round(elapsed)}s`
        );
        // T358 §6.14: events.jsonl
        await emitEvent({
          event: "conductor_start_timeout",
          conductor_surface: surface,
          elapsed_ms: Math.round(elapsed * 1000),
        });
        try {
          const ev: FsmEvent = { type: "TIMEOUT", kind: "starting" };
          const cctx: ConductorCtx = { hasTaskRunId: conductor.taskRunId != null, now: Date.now() };
          await shadowObserveConductor(surface, shadowPrevStartingTO, ev, cctx, conductor.status);
        } catch (e: any) {
          await log("error", `shadow_observe_failed TIMEOUT(starting) ${e?.message ?? e}`);
        }
      }
      continue;
    }

    // T232: assigning: タイムアウト → disconnected に倒す（SESSION_STARTED 未到達時の保険）
    if (conductor.status === "assigning") {
      const elapsed = (Date.now() - new Date(conductor.startedAt).getTime()) / 1000;
      if (elapsed > ASSIGNING_TIMEOUT_SEC) {
        // T261: timeout で assigning 窓を閉じる際も close ログを発行。
        //       elapsed は clearSentAt 基準（ms 単位）。clearSentAt 不在なら "-"。
        const elapsedTimeoutMs = conductor.clearSentAt
          ? Date.now() - new Date(conductor.clearSentAt).getTime()
          : null;
        await log(
          "assigning_window_close",
          `${formatSurface(surface, "C")} via=timeout elapsed=${elapsedTimeoutMs ?? "-"}`
        );
        const shadowPrevAssigningTO: ConductorStatus = conductor.status;
        conductor.status = "disconnected";
        conductor.disconnectedAt = new Date().toISOString();
        notifyStateChanged("daemon.ts:monitorConductors:assigning-timeout");
        await log(
          "conductor_assign_timeout",
          `${formatSurface(surface, "C")} elapsed=${Math.round(elapsed)}s taskRunId=${conductor.taskRunId ?? "-"}`
        );
        // T358 §6.15: events.jsonl
        await emitEvent({
          event: "conductor_assign_timeout",
          conductor_surface: surface,
          task_run_id: conductor.taskRunId ?? "",
          elapsed_ms: Math.round(elapsed * 1000),
        });
        try {
          const ev: FsmEvent = { type: "TIMEOUT", kind: "assigning" };
          const cctx: ConductorCtx = { hasTaskRunId: conductor.taskRunId != null, now: Date.now() };
          await shadowObserveConductor(surface, shadowPrevAssigningTO, ev, cctx, conductor.status);
        } catch (e: any) {
          await log("error", `shadow_observe_failed TIMEOUT(assigning) ${e?.message ?? e}`);
        }
      }
      continue;
    }

    // disconnected: timeout チェック → forced cleanup。継続チェックはしない
    if (conductor.status === "disconnected") {
      if (conductor.disconnectedAt) {
        const elapsed = (Date.now() - new Date(conductor.disconnectedAt).getTime()) / 1000;
        if (elapsed > DISCONNECT_TIMEOUT_SEC) {
          // T260: taskRunId は snapshot 内で 1 回だけ出す（二重出力を避ける）。
          await log(
            "conductor_disconnect_timeout",
            `${formatSurface(surface, "C")} elapsed=${Math.round(elapsed)}s ${formatConductorSnapshot(conductor)}`
          );
          // T358 §6.16: events.jsonl
          await emitEvent({
            event: "conductor_disconnect_timeout",
            conductor_surface: surface,
            ...(conductor.taskId ? { task_id: conductor.taskId } : {}),
            elapsed_ms: Math.round(elapsed * 1000),
          });
          const shadowPrevDisconnectedTO: ConductorStatus = conductor.status;
          await forceCloseDisconnectedConductor(state, conductor);
          try {
            const ev: FsmEvent = { type: "TIMEOUT", kind: "disconnected" };
            const cctx: ConductorCtx = { hasTaskRunId: conductor.taskRunId != null, now: Date.now() };
            await shadowObserveConductor(surface, shadowPrevDisconnectedTO, ev, cctx, conductor.status);
          } catch (e: any) {
            await log("error", `shadow_observe_failed TIMEOUT(disconnected) ${e?.message ?? e}`);
          }
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
 *
 * T250: 自動 idle 化は廃止。resetConductor を `targetStatus: "broken"` で呼び、
 * 確定した異常状態として state.conductors に残す（cleanup 済みだが可視化のため）。
 * ユーザーが `cmux-team clear-conductor --surface <id>` で明示的に idle に戻すまで、
 * 次のタスク割当候補から除外され続ける。
 */
async function forceCloseDisconnectedConductor(
  state: DaemonState,
  conductor: ConductorState
): Promise<void> {
  const taskId = conductor.taskId;
  const taskRunId = conductor.taskRunId;

  // 1. task-state.json に aborted を記録
  // T290: markTaskAborted に集約（load/冪等ガード/journal/cascade/emit を内部化）
  if (taskId) {
    try {
      const detail = `${formatSurface(conductor.surface, "C")} taskRunId=${taskRunId ?? "-"} disconnectedAt=${conductor.disconnectedAt}`;
      const { revertedChildren } = await markTaskAborted(
        state.projectRoot,
        taskId,
        "disconnect_timeout",
        detail,
      );
      if (revertedChildren.length > 0) {
        notifyStateChanged("daemon.ts:forceCloseDisconnectedConductor:cascade");
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

  // 3. resetConductor で worktree/branch/タブ名をクリーンアップし broken 状態に遷移
  //    ログ（conductor_broken）は resetConductor 内で発行される（集約ポリシー D12）。
  await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, {
    targetStatus: "broken",
    reason: "disconnect_timeout",
  }, ccBackend(state.backend));
}

async function handleConductorDone(
  state: DaemonState,
  conductor: ConductorState,
  opts?: { success?: boolean; reason?: string },
): Promise<void> {
  // T279 shadow: prev は resetConductor が呼ばれる前の status。
  const shadowPrevDone: ConductorStatus = conductor.status;
  const { journalSummary } = await collectResults(conductor, state.projectRoot);
  const taskId = conductor.taskId;

  // T263: success=false && task-state=assigned の「人間判断待ち」経路を判定する。
  //       ログは conductor_done_unresolved、worktree/branch は温存（preserveWorktree=true）。
  //       closed/aborted/deleted は既に完結しているので worktree は消して良い（Decision D2）。
  //       task-state entry なし (missing) は race 対策で保守側に倒し温存（Decision D4）。
  //       Design Review Finding 2: collectResults も task-state.json を読むが double-read の
  //       性能影響は無視できるため統合せず。可読性優先。
  const taskState = await loadTaskState(state.projectRoot);
  const currentStatus = taskId ? taskState[taskId]?.status : undefined;
  const success = opts?.success !== false;
  const unresolved =
    !success &&
    currentStatus !== "closed" &&
    currentStatus !== "aborted" &&
    currentStatus !== "deleted";
  // T274: success=true でも task-state が assigned のまま残っていれば close-task が
  //       skip されたと判定し daemon が代替で closed に倒す（auto-close）。
  //       missing = entry 自体が無い場合は state 書き込みを skip し warn ログのみ残す。
  const stateMismatchOnSuccess =
    success &&
    Boolean(taskId) &&
    taskId !== "undefined" &&
    currentStatus === "assigned";
  const stateMissingOnSuccess =
    success &&
    Boolean(taskId) &&
    taskId !== "undefined" &&
    currentStatus === undefined;

  if (!taskId || taskId === "undefined") {
    await log(
      "error",
      `handleConductorDone: conductor.taskId is undefined ${formatSurface(conductor.surface, "C")}`
    );
  } else if (unresolved) {
    // 「判断必要レポート」未完結ケース。worktree は温存され人間判断待ち。
    // grep 用に worktreePath を出力し `cd <path>` で直接調査できるようにする。
    await log(
      "conductor_done_unresolved",
      `task_id=${taskId} ${formatSurface(conductor.surface, "C")}` +
        ` task_state=${currentStatus ?? "missing"}` +
        ` reason=${opts?.reason ?? "-"}` +
        ` worktreePath=${conductor.worktreePath ?? "-"}` +
        (conductor.taskTitle ? ` title=${conductor.taskTitle}` : "") +
        (journalSummary ? ` journal_summary=${journalSummary}` : "")
    );
    // T358 §6.13: events.jsonl にも conductor_done_unresolved を流す。
    // (markTaskAborted が並行して task_aborted reason=judgment_pending を emit する設計)
    await emitEvent({
      event: "conductor_done_unresolved",
      task_id: taskId,
      conductor_surface: conductor.surface,
      worktree_path: conductor.worktreePath ?? "",
      journal_summary: journalSummary ?? "",
    });
    // T269: preserveWorktree 経路でも task-state は `aborted` に倒す。
    //       assigned のまま残すと applyResumeTransitions が resume 対象と誤分類する。
    // T290: markTaskAborted に集約。journal は `reason=judgment_pending;
    //       conductor_done_unresolved: <opts.reason> (worktree=...) taskRunId=...` 形式。
    //       log reason（judgment_pending）と journal prefix は同一引数から組み立てるため
    //       T269 の型乖離は構造的に再発不能。
    try {
      const detail = `conductor_done_unresolved: ${opts?.reason ?? "-"} (worktree=${conductor.worktreePath ?? "-"}) taskRunId=${conductor.taskRunId ?? "-"}`;
      const { revertedChildren, idempotentSkip, existingStatus } = await markTaskAborted(
        state.projectRoot,
        taskId,
        "judgment_pending",
        detail,
        { taskTitle: conductor.taskTitle },
      );
      if (idempotentSkip) {
        await log(
          "conductor_done_unresolved_skip",
          `task_id=${taskId} reason=already_closed_or_aborted status=${existingStatus}`
        );
      } else if (revertedChildren.length > 0) {
        notifyStateChanged("daemon.ts:handleConductorDone:unresolved-cascade");
      }
    } catch (e: any) {
      await log("error", `handleConductorDone judgment_pending update failed: task_id=${taskId} ${e.message}`);
    }
  } else if (stateMismatchOnSuccess) {
    // T274 / T303: Conductor が close-task を skip したまま --success true を送った経路。
    //       state だけ取り残されるのを防ぐため daemon が代替で close に倒す。
    //       pattern は T263/T269 の unresolved inline 書き換えブロック（daemon.ts:2940-2966）と対称。
    //
    //       reducer も `task_completed_state_mismatch` brief を emit するが、wrapper は
    //       追加 context (worktreePath / title / journal_summary) を載せて詳細版を出す
    //       (grep で同イベント名の 2 行がヒットする設計 — dashboard / trace 互換維持)。
    await log(
      "task_completed_state_mismatch",
      `task_id=${taskId} ${formatSurface(conductor.surface, "C")}` +
        ` prev_status=assigned reason=missing_close_task` +
        ` worktreePath=${conductor.worktreePath ?? "-"}` +
        (conductor.taskTitle ? ` title=${conductor.taskTitle}` : "") +
        (journalSummary ? ` journal_summary=${journalSummary}` : "")
    );
    try {
      const journal = `auto_closed_by_daemon: CONDUCTOR_DONE without close-task (taskRunId=${conductor.taskRunId ?? "-"})`;
      // T295: close-task が呼ばれなかった時点で納品物は不明。`kind: "none"` を書いて
      //       `closed 時は deliverable が必須` の契約を daemon 経由でも維持する。
      await applyTaskEvent(state.projectRoot, {
        taskId,
        event: { type: "CLOSE", autoClosed: true },
        ctx: { hasConductor: true, parentAborted: false },
        patch: (_prev, next) =>
          next === "closed"
            ? {
                merge: {
                  closedAt: new Date().toISOString(),
                  journal,
                  deliverable: { kind: "none" as const },
                },
              }
            : {},
        // T358 M5: events.jsonl の task_completed_state_mismatch に詳細 context を渡す。
        eventStream: {
          conductorSurface: conductor.surface,
          worktreePath: conductor.worktreePath ?? "",
          journalSummary: journalSummary ?? "",
        },
      });
      await log(
        "task_completed",
        `task_id=${taskId} ${formatSurface(conductor.surface, "C")}${
          conductor.taskTitle ? ` title=${conductor.taskTitle}` : ""
        } auto_closed=true worktreePath=${conductor.worktreePath ?? "-"}${
          journalSummary ? ` journal_summary=${journalSummary}` : ""
        }`
      );
      // T303 R8: trace DB insert は呼び出し側責務
      if (state.traceDb) {
        try {
          insertTaskSession(state.traceDb, {
            timestamp: new Date().toISOString(),
            task_id: taskId,
            task_run_id: conductor.taskRunId,
            session_id: conductor.sessionId ?? "",
            role: "conductor",
            surface: conductor.surface,
            event: "closed",
          });
        } catch (e: any) {
          await log("error", `T274 trace DB closed insert failed: ${e?.message ?? e}`);
        }
      }
    } catch (e: any) {
      await log("error", `handleConductorDone auto-close failed: task_id=${taskId} ${e.message}`);
    }
  } else if (stateMissingOnSuccess) {
    // T274: task-state にエントリが無いのに --success true。race or 手動削除後の goodbye。
    //       source of truth が無いため state 書き込みは skip し warn ログのみ残す。worktree は削除。
    await log(
      "task_completed_state_missing",
      `task_id=${taskId} ${formatSurface(conductor.surface, "C")}` +
        ` reason=missing_state_entry` +
        (conductor.taskTitle ? ` title=${conductor.taskTitle}` : "")
    );
  } else {
    await log(
      "task_completed",
      `task_id=${taskId} ${formatSurface(conductor.surface, "C")}${
        conductor.taskTitle ? ` title=${conductor.taskTitle}` : ""
      }${journalSummary ? ` journal_summary=${journalSummary}` : ""}`
    );
    // T358 M3: events.jsonl の task_completed は通常完了経路のみ emit。
    // auto-close 経路 (stateMismatchOnSuccess === true) は task_completed_state_mismatch のみ。
    if (taskId && taskId !== "undefined") {
      await emitEvent({
        event: "task_completed",
        task_id: taskId,
        conductor_surface: conductor.surface,
        worktree_path: conductor.worktreePath ?? "",
        journal_summary: journalSummary ?? "",
      });
    }
  }

  // Conductor をリセットして idle に戻す（unresolved 時は worktree/branch を温存）
  await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, {
    preserveWorktree: unresolved,
  }, ccBackend(state.backend));

  // T279 shadow: handleConductorDone 完了後に reducer と比較する。
  //   reducer 側は {success, unresolved, currentTaskStatus} から分岐を決める。
  //   late_cleanup 分岐 (state !== running/asking) は reducer では no-op → 実 state も
  //   resetConductor により idle になるため diff が載る可能性がある（設計上の既知差分）。
  try {
    const ev: FsmEvent = {
      type: "DONE",
      success,
      unresolved,
      currentTaskStatus: currentStatus as any,
    };
    const cctx: ConductorCtx = {
      hasTaskRunId: conductor.taskRunId != null,
      now: Date.now(),
    };
    await shadowObserveConductor(
      conductor.surface,
      shadowPrevDone,
      ev,
      cctx,
      conductor.status,
    );
  } catch (e: any) {
    await log("error", `shadow_observe_failed DONE ${e?.message ?? e}`);
  }
}

export async function updateTeamJson(state: DaemonState): Promise<void> {
  const teamJsonPath = join(state.projectRoot, ".team/team.json");
  try {
    const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
    // T229: 複数 Master を masters 配列で表現する。旧 master フィールドは必ず削除。
    teamJson.masters = [...state.masters.values()].map((m) => ({
      surface: m.surface,
      status: m.status,
      pid: m.pid,
      startedAt: m.startedAt,
      // T323: token pool 用 handle（proxy が auth_hash 解決時に書き戻す）
      tokenHandle: m.tokenHandle,
    }));
    delete teamJson.master;
    teamJson.manager = {
      pid: process.pid,
      type: "typescript",
      status: state.running ? "running" : "stopped",
    };
    teamJson.phase = "running";
    teamJson.layout = state.layout;
    // T414: 内部 Web ダッシュボードの URL を外部に公開する。dashboard 起動失敗時は
    // フィールド自体を削除する（古い値が残らないように）。
    if (state.dashboardServerUrl) {
      teamJson.dashboardServer = { url: state.dashboardServerUrl, schemaVersion: 1 };
    } else {
      delete teamJson.dashboardServer;
    }
    teamJson.conductors = [...state.conductors.values()].map((c) => ({
      surface: c.surface,
      taskRunId: c.taskRunId,
      taskId: c.taskId,
      taskTitle: c.taskTitle,
      status: c.status,
      worktreePath: c.worktreePath,
      outputDir: c.outputDir,
      startedAt: c.startedAt,
      // T250: broken Conductor が再起動後も経過時間を表示できるよう disconnectedAt を永続化する。
      disconnectedAt: c.disconnectedAt,
      // T260: 再起動後も「最後に生存確認できた時刻」を復元できるよう永続化する（次の SESSION_* で上書きされる）。
      lastHookAt: c.lastHookAt,
      // T261: daemon 再起動後も user_clear_decision_snapshot で「clear からの経過 ms」を
      //       算出できるよう永続化する。promptSentAt 等の他 T261 フィールドは永続化しない
      //       （restoreConductors 時に undefined に戻るのが仕様）。
      clearSentAt: c.clearSentAt,
      sessionId: c.sessionId,
      pid: c.pid,
      // T323: token pool 用 handle（proxy が auth_hash 解決時に書き戻す）
      tokenHandle: c.tokenHandle,
      agents: c.agents.map((a) => ({
        surface: a.surface,
        role: a.role,
        sessionId: a.sessionId,
        pid: a.pid,
        status: a.status,
        // T323: token pool 用 handle（spawn-agent 経路で AGENT_TOKEN_BOUND が反映）
        tokenHandle: a.tokenHandle,
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
  state: Pick<
    DaemonState,
    | "conductors"
    | "rateLimit"
    | "pendingTasks"
    | "openTasks"
    | "tokenDb"
    | "running"
    | "bootPhase"
    | "poolPolicy"
  >,
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

  // 2. スロットリング（T367 pool-aware）
  // pool 有効時は canSelectAnyToken の真偽が真実。pool 無効時は従来挙動を完全保持。
  // `unifiedStatus === "rate_limited"` の OR は **pool 無効経路でのみ** 上乗せする
  // （pool 有効時は SQLite の状態が単一アカウントの観測値より優先される）。
  const baseThrottled = isThrottled5h(state.tokenDb, state.rateLimit, {
    running: state.running,
    bootReady: state.bootPhase === "ready",
    policy: state.poolPolicy ?? undefined,
  });
  const throttled =
    baseThrottled ||
    (state.tokenDb === null &&
      state.running &&
      state.bootPhase === "ready" &&
      !isStale5h(state.rateLimit) &&
      state.rateLimit?.unifiedStatus === "rate_limited");
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
 * 更新チェックを実行し、notify モードのときのみ state.updateAvailable を埋める（TUI バナー表示）。
 *
 * - mode="off": 何もしない
 * - mode="notify": fetchInfo して state.updateAvailable を更新（install は行わない）
 * - NO_UPDATE_NOTIFIER=1 で early return
 *
 * T294 (v4.5.0): `task` モード（update タスク自動起票）を削除した。手動更新は
 * `npm install -g @hummer98/cmux-team@<latest>` を直接実行する（banner に表示）。
 */
export async function checkUpdateAndNotify(
  state: DaemonState,
  mode: "off" | "notify",
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
  };
  await log("update_available", `current=${current} latest=${latest} mode=${mode}`);
  notifyStateChanged("daemon.ts:checkUpdateAndNotify:update-available");
}
