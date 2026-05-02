/**
 * TUI Dashboard — Rezi フルスクリーンダッシュボード
 *
 * 既存の dashboard.tsx (Ink ベース) を Rezi TUI フレームワークで書き直し。
 * Ink版と同等の情報量・レイアウトを実現。
 * 上部: ヘッダー（ステータス・conductors・tasks）
 * 中部: Master / Conductors / Tasks パネル
 * 下部: journal / log タブ切り替え（残りスペースを全て使う）
 */
import { ui, rgb } from "@rezi-ui/core";
import { createNodeApp, type NodeApp } from "@rezi-ui/node";
import { readFile } from "fs/promises";
import { join } from "path";
import type { DaemonState, TaskSummary } from "./daemon";
import type { ConductorState } from "./schema";
import type { AgentState } from "./schema";
import { THROTTLE_5H_THRESHOLD } from "./schema";
import { log } from "./logger";
import { installDashboardConsoleRedirect } from "./dashboard-console-redirect";
import { formatDeliverable } from "./task";
import { onStateChanged } from "./eventBus";
import { buildRateLimitDisplay, type RateLimitColor } from "./rate-limit-display";
import { isStale5h } from "./rate-limit-persistence";
import { t } from "./i18n";
import { loadArtifacts } from "./artifact";
import type { ArtifactMeta } from "./artifact";
import { listProjectInstructions, readProjectInstructions } from "./agent-instructions";
import {
  loadConfig,
  resolveMetricsRefreshIntervalMs,
  resolveProjectTokenPool,
  type TeamConfig,
} from "./config";
import { listTokens, getLatestUsageSnapshot } from "./token-store";
import type { OverlayRole } from "./schema";
import { resolveOriginRepo } from "./gh-cache-repo";
import { resolveGithubToken, tokenHash } from "./gh-cache-auth";
import {
  openGhCacheDB,
  listIssues,
  getIssueLabels,
  getIssueAssignees,
  getSyncMeta,
} from "./gh-cache-store";
import { displayState } from "./gh-cache-format";
import type { IssueRow, LabelRow, AssigneeRow } from "./gh-cache-types";
import { syncIncremental, RateLimitExhaustedError } from "./gh-cache-sync";
import { writeFile } from "fs/promises";
import { tmpdir } from "os";
import {
  getLatestApiUsageRow,
  getProjection5h,
  getProjection7d,
} from "./trace-store";
import {
  buildMetricsRows,
  buildPoolTokenRowFromSnapshot,
  type MetricsData,
  type PoolTokenRow,
} from "./dashboard-metrics";
import { openDashboardUrlInBrowser } from "./browser-open";
// T351: pool capacity / per-surface handle 表示
import { buildPoolHeaderDisplay } from "./pool-header-display";
import type { PoolSummary } from "./pool-summary";
import { hasPoolHeadroomFromSummary } from "./pool-throttle";

const LOG_VISIBLE_LINES = 30;
const TASK_VISIBLE_LINES = 5;
const JOURNAL_VISIBLE_LINES = 30;
const ARTIFACT_VISIBLE_LINES = 12;
const ISSUE_VISIBLE_LINES = 20;
const SETTINGS_PREVIEW_LINES = 20;

/**
 * T354 (F2): Metrics タブの表示行数を画面サイズから決める純粋関数。
 *
 * RESERVED_LINES = ヘッダー / Master / Conductors / Tasks / footer + 余白の合計（実測 ≈ 12-14）。
 * 過小に取るとスクロール時に下端が切れ、過大に取ると metrics 行が圧迫される。
 *
 * テストから差し替えできるよう (a) `process.stdout.rows` と
 * (b) 環境変数 `CMUX_TEAM_METRICS_VISIBLE_LINES` を引数で受ける。
 */
export const RESERVED_LINES = 14;

export function computeMetricsVisibleLines(
  stdoutRows: number | undefined,
  envOverride: string | undefined,
): number {
  // 環境変数が最優先（NaN / 0 / 負は無視して通常パスへ落とす）
  if (envOverride !== undefined && envOverride !== "") {
    const parsed = parseInt(envOverride, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.max(8, Math.min(80, parsed));
    }
  }
  const total = typeof stdoutRows === "number" && Number.isFinite(stdoutRows)
    ? stdoutRows
    : 30 + RESERVED_LINES;
  const candidate = total - RESERVED_LINES;
  return Math.max(8, Math.min(80, candidate));
}

function getMetricsVisibleLines(): number {
  return computeMetricsVisibleLines(
    process.stdout.rows,
    process.env.CMUX_TEAM_METRICS_VISIBLE_LINES,
  );
}

// --- GitHub リポジトリ URL 解決 ---

let cachedRepoUrl: string | null = null;

async function resolveGitHubRepoUrl(projectRoot: string): Promise<string | null> {
  if (cachedRepoUrl !== null) return cachedRepoUrl || null;

  try {
    // team.json の github_repo を確認
    const teamJsonPath = join(projectRoot, ".team", "team.json");
    try {
      const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
      if (teamJson.github_repo) {
        cachedRepoUrl = teamJson.github_repo;
        return cachedRepoUrl;
      }
    } catch {}

    // git remote get-url origin からパース
    const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const url = output.trim();
    // SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/git@github\.com:(.+?)(?:\.git)?$/);
    if (sshMatch) {
      cachedRepoUrl = `https://github.com/${sshMatch[1]}`;
      return cachedRepoUrl;
    }
    // HTTPS: https://github.com/owner/repo.git
    const httpsMatch = url.match(/https:\/\/github\.com\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      cachedRepoUrl = `https://github.com/${httpsMatch[1]}`;
      return cachedRepoUrl;
    }
  } catch {}

  cachedRepoUrl = "";
  return null;
}

function buildTitleWithLinks(
  text: string,
  repoUrl: string | null,
  baseStyle?: Record<string, any>,
): any {
  if (!repoUrl) return ui.text(text, baseStyle ?? {});

  const parts: any[] = [];
  let lastIndex = 0;
  const regex = /#(\d+)/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // マッチ前のテキスト
    if (match.index > lastIndex) {
      parts.push(ui.text(text.slice(lastIndex, match.index), baseStyle ?? {}));
    }
    // GitHub issue リンク
    const issueNum = match[1];
    parts.push(ui.link({
      url: `${repoUrl}/issues/${issueNum}`,
      label: `#${issueNum}`,
      style: { fg: rgb(100, 149, 237) },  // cornflower blue
      focusable: false,
    }));
    lastIndex = match.index + match[0].length;
  }

  if (parts.length === 0) return ui.text(text, baseStyle ?? {});

  // 残りテキスト
  if (lastIndex < text.length) {
    parts.push(ui.text(text.slice(lastIndex), baseStyle ?? {}));
  }

  return parts.length === 1 ? parts[0] : ui.row({ gap: 0 }, parts);
}

/**
 * Markdown ビューアコマンドを解決する
 * 優先順: CMUX_TEAM_MD_VIEWER → mo → cat
 */
export async function resolveMarkdownViewer(): Promise<string> {
  const envViewer = process.env.CMUX_TEAM_MD_VIEWER;
  if (envViewer) return envViewer;

  // mo が利用可能か確認
  const moPath = Bun.which("mo");
  if (moPath) return "mo";

  return "cat";
}

// --- 名前付きカラー定数（Ink 版と同等） ---
const GREEN = rgb(0, 160, 0);
const YELLOW = rgb(200, 160, 0);
const RED = rgb(180, 40, 40);
const CYAN = rgb(0, 180, 180);
const GRAY = rgb(130, 130, 130);

function nerdIcon(nerd: string, fallback: string): string {
  return process.env.CMUX_NERD_FONT === "0" ? fallback : nerd;
}

// T392: API エラー種別ごとのアイコン。未知 kind は ⚠ を fallback として返す。
export const API_ERROR_ICONS: Record<string, string> = {
  rate_limit: "⏳",
  authentication_failed: "🔒",
  billing_error: "💰",
  server_error: "⚡",
};

export function apiErrorIcon(kind: string | undefined): string {
  if (!kind) return "⚠";
  return API_ERROR_ICONS[kind] ?? "⚠";
}

/** API エラーメッセージを 80 字 truncate（改行は空白に置換） */
export function truncateApiErrorMessage(msg: string | undefined): string {
  if (!msg) return "";
  const oneLine = msg.replace(/\r?\n/g, " ");
  return oneLine.length > 80 ? oneLine.slice(0, 77) + "..." : oneLine;
}

let spinnerTick = 0;

// --- ジャーナルエントリ ---

export interface JournalEntry {
  time: string;  // HH:MM:SS
  icon: string;  // Nerd Font アイコン or フォールバック
  taskId: string;
  message: string;
  level: "info" | "warn" | "error";
  surface?: string;    // surface 名（dim 表示用）
  iconColor?: number;  // アイコンの色を直接保持
  /** T353: dim 表示するか（daemon_stopped 用）。buildJournalRows が icon style にマージする */
  dim?: boolean;
}

/**
 * T353: daemon ライフサイクルイベント (boot_completed / daemon_stopped) は taskId を持たないため、
 * sentinel taskId として `__daemon__` を使う。buildJournalRows は sentinel を filter で通過させ、
 * `T###` 列は出さずに描画する。`isValidTaskId` が `__daemon__` を弾く挙動は変えない。
 */
export const DAEMON_SENTINEL_TASK_ID = "__daemon__";

/**
 * T353: 経過秒数を `Xs` / `Xm Ys` / `Xh Ym` 形式に整形する。
 * 既存の `formatUptime` (startMs ベース、空白なし) と紛らわしいが、こちらは sec ベース + 空白あり。
 */
export function formatUptimeSec(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// --- ヘルパー ---

function formatUptime(startMs: number): string {
  const sec = Math.floor((Date.now() - startMs) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

function utcToLocal(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatElapsed(isoDate: string): string {
  const sec = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

/** 経過時間のコンパクト表示（ダッシュボード用） */
function compactElapsed(startIso: string, endIso?: string): string {
  const startMs = new Date(startIso).getTime();
  const endMs = endIso ? new Date(endIso).getTime() : Date.now();
  const sec = Math.floor((endMs - startMs) / 1000);
  if (sec < 60) return "<1m";
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

const RATE_LIMIT_COLOR_MAP: Record<RateLimitColor, number> = {
  green: GREEN,
  yellow: YELLOW,
  red: RED,
  gray: GRAY,
};

/** rate-limit-display の RateLimitColor を Rezi の RGB 値にマップする */
function mapRateLimitColor(color: RateLimitColor): number {
  return RATE_LIMIT_COLOR_MAP[color];
}

// --- ログ・ジャーナル解析 ---

function parseLogLine(line: string): { time: string; event: string; detail: string; level: "info" | "warn" | "error" } {
  const match = line.match(/^\[([^\]]+)\]\s+(\S+)\s*(.*)/);
  if (!match) return { time: "", event: "", detail: line, level: "info" };
  const ts = match[1] ?? "";
  const event = match[2] ?? "";
  const detail = match[3] ?? "";
  const time = utcToLocal(ts);
  const isError = event === "error";
  const level = isError ? "error" as const : "info" as const;
  return { time, event, detail, level };
}

function isValidTaskId(id: string): boolean {
  return id !== "" && id !== "?" && id !== "undefined";
}

/**
 * detail 文字列から surface 識別子を抽出する (T192)。
 *
 * 対応フォーマット:
 *   - 旧: `surface=surface:NNN` → `surface:NNN` を返す
 *   - 新: `C[NNN]` / `A[NNN]` / `M[NNN]` / `U[NNN]` / `S[NNN]` → `surface:NNN` を返す
 *
 * 戻り値は旧フォーマット互換の `surface:NNN` 形式で、JournalEntry.surface に格納される。
 */
function extractSurface(detail: string): string {
  const old = detail.match(/surface=surface:(\S+)/);
  if (old) return `surface:${old[1]}`;
  const fmt = detail.match(/\b[CAMUS]\[(\d+)\]/);
  if (fmt) return `surface:${fmt[1]}`;
  return "";
}

export function parseJournalEntries(lines: string[]): JournalEntry[] {
  const result: JournalEntry[] = [];
  for (const line of lines) {
    const match = line.match(/^\[([^\]]+)\]\s+(\S+)\s*(.*)/);
    if (!match) continue;
    const ts = match[1] ?? "";
    const event = match[2] ?? "";
    const detail = match[3] ?? "";
    const time = utcToLocal(ts);

    if (event === "task_received") {
      const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
      if (!isValidTaskId(taskId)) continue;
      const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
      result.push({ time, icon: nerdIcon("\uf055", "[+]"), taskId, message: title, level: "info", iconColor: CYAN });
    } else if (event === "conductor_started") {
      const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
      if (!isValidTaskId(taskId)) continue;
      const surface = extractSurface(detail);
      const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
      result.push({ time, icon: nerdIcon("\uf04b", "[▶]"), taskId, message: title || `${detail.match(/conductor_id=(\S+)/)?.[1] ?? ""} started`, level: "warn", surface: surface || undefined, iconColor: YELLOW });
    } else if (event === "task_completed") {
      const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
      if (!isValidTaskId(taskId)) continue;
      const surface = extractSurface(detail);
      const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
      const summary = detail.match(/journal_summary=(.+)/)?.[1] ?? "";
      result.push({ time, icon: nerdIcon("\uf058", "[✓]"), taskId, message: summary || title || detail, level: "info", surface: surface || undefined, iconColor: GREEN });
    } else if (event === "task_aborted") {
      const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
      if (!isValidTaskId(taskId)) continue;
      const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
      const summary = detail.match(/journal_summary=(.+)/)?.[1] ?? "";
      result.push({ time, icon: nerdIcon("\uf057", "[✕]"), taskId, message: summary || title || "aborted", level: "error", iconColor: RED });
    } else if (event === "task_deleted") {
      const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
      if (!isValidTaskId(taskId)) continue;
      const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
      const summary = detail.match(/journal_summary=(.+)/)?.[1] ?? "";
      result.push({ time, icon: nerdIcon("\uf056", "[−]"), taskId, message: summary || title || "deleted", level: "warn", iconColor: YELLOW });
    } else if (event === "boot_completed") {
      // T353: daemon 起動マーカー。空 detail (拡張前の互換) なら "fresh start" にフォールバック
      const version = detail.match(/version=(\S+)/)?.[1] ?? "";
      const restored = parseInt(detail.match(/restored_conductors=(\d+)/)?.[1] ?? "0", 10);
      const openTasks = parseInt(detail.match(/open_tasks=(\d+)/)?.[1] ?? "0", 10);
      const summary = restored === 0
        ? "— fresh start"
        : `— resumed ${restored} conductor${restored === 1 ? "" : "s"} / ${openTasks} open task${openTasks === 1 ? "" : "s"}`;
      const versionStr = version ? ` ${version}` : "";
      result.push({
        time,
        icon: nerdIcon("", "▲"),
        taskId: DAEMON_SENTINEL_TASK_ID,
        message: `daemon started${versionStr} ${summary}`.trim(),
        level: "info",
        iconColor: CYAN,
      });
    } else if (event === "daemon_stopped") {
      // T353: daemon 終了マーカー。dim 表示で目立たせない
      const uptimeSec = parseInt(detail.match(/uptime_sec=(\d+)/)?.[1] ?? "0", 10);
      result.push({
        time,
        icon: nerdIcon("", "▼"),
        taskId: DAEMON_SENTINEL_TASK_ID,
        message: `daemon stopped (uptime ${formatUptimeSec(uptimeSec)})`,
        level: "info",
        iconColor: CYAN,
        dim: true,
      });
    } else if (event === "resume_worktree_missing_late") {
      // T353: resume B 経路の worktree 不在検出
      const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
      if (!isValidTaskId(taskId)) continue;
      const surface = extractSurface(detail);
      result.push({
        time,
        icon: nerdIcon("", "[✕]"),
        taskId,
        message: "resume failed — worktree_missing",
        level: "error",
        surface: surface || undefined,
        iconColor: RED,
      });
    } else if (event === "conductor_resume_launch_failed") {
      // T353: resume B 経路の launchConductor 失敗
      const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
      if (!isValidTaskId(taskId)) continue;
      const surface = extractSurface(detail);
      // detail は "task_id=N C[surface] <error.message>" 形式。先頭 2 token を落とした残りを reason とする
      const reason = detail.replace(/^task_id=\S+\s+\S+\s*/, "").trim() || "unknown";
      result.push({
        time,
        icon: nerdIcon("", "[✕]"),
        taskId,
        message: `resume failed — launch_error: ${reason}`,
        level: "error",
        surface: surface || undefined,
        iconColor: RED,
      });
    }
  }
  return result;
}

async function readLogLines(projectRoot: string): Promise<string[]> {
  try {
    const logFile = join(projectRoot, ".team/logs/manager.log");
    const content = await readFile(logFile, "utf-8");
    return content.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function loadSettingsItems(projectRoot: string): Promise<SettingsItem[]> {
  const items: SettingsItem[] = [];
  items.push({ kind: "section", label: "Agent Instructions Overlays (.team/agent-instructions/)" });

  const list = await listProjectInstructions(projectRoot);
  for (const entry of list) {
    let preview: string[] = [];
    let truncated = false;
    if (entry.exists) {
      const body = await readProjectInstructions(projectRoot, entry.role);
      if (body) {
        const allLines = body.split("\n");
        preview = allLines.slice(0, SETTINGS_PREVIEW_LINES);
        truncated = allLines.length > SETTINGS_PREVIEW_LINES;
      }
    }
    items.push({
      kind: "overlay",
      role: entry.role,
      exists: entry.exists,
      size: entry.size,
      filePath: join(projectRoot, ".team/agent-instructions", `${entry.role}.md`),
      preview,
      truncated,
    });
  }

  items.push({ kind: "section", label: "Team Config (.team/config.json)" });
  const cfg: TeamConfig = await loadConfig(projectRoot);
  items.push({ kind: "config", label: "layout", value: cfg.layout ?? "16x9 (default)" });
  items.push({
    kind: "config",
    label: "autoUpdate",
    value: cfg.autoUpdate ?? "off (default)",
  });
  items.push({ kind: "config", label: "mainBranch", value: cfg.mainBranch ?? "(unresolved)" });
  items.push({
    kind: "config",
    label: "sleepPrevention",
    value: cfg.sleepPrevention === false ? "false" : "true (default)",
  });
  // T354: Metrics タブの再描画間隔
  items.push({
    kind: "config",
    label: "metricsRefreshIntervalMs",
    value: `${resolveMetricsRefreshIntervalMs(cfg)}${
      cfg.metricsRefreshIntervalMs === undefined ? " (default)" : ""
    }`,
  });

  return items;
}

// --- 状態型 ---

/**
 * Settings タブで表示する項目。
 * - overlay: `.team/agent-instructions/<role>.md` の存在・サイズ・プレビュー
 * - config: `.team/config.json` の 1 行サマリ
 * - section: 区切り見出しのみ（preview 無し）
 */
type SettingsItem =
  | { kind: "section"; label: string }
  | {
      kind: "overlay";
      role: OverlayRole;
      exists: boolean;
      size: number;
      filePath: string;
      preview: string[]; // 最大 SETTINGS_PREVIEW_LINES 行。exists=false なら空
      truncated: boolean;
    }
  | {
      kind: "config";
      label: string;
      value: string;
    };

export interface IssueListItem {
  issue: IssueRow;
  labels: LabelRow[];
  assignees: AssigneeRow[];
}

export interface AppState {
  daemon: DaemonState;
  activeTab: "journal" | "artifacts" | "log" | "settings" | "issues" | "metrics";
  journalEntries: JournalEntry[];
  logLines: string[];
  artifacts: ArtifactMeta[];
  artifactCursor: number;
  artifactSort: "id" | "created" | "updated";
  artifactTypeFilter: string | null;
  artifactSearch: string | null;
  taskCursor: number;
  version: string;
  repoUrl: string | null;
  confirmingFullQuit?: boolean;
  logScrollOffset: number;   // 0 = 先頭（最新）、正の数 = 下にスクロールした行数（古い方へ）
  logAutoScroll: boolean;    // true = 最新に自動追従
  spinnerFrame: number;      // スピナーアニメーション用フレームカウンター
  focusedArea: "global" | "tasks" | "journal" | "log" | "artifacts" | "settings" | "issues" | "metrics";
  journalScrollOffset: number;  // 0 = 先頭（最新）、正の数 = 下にスクロールした行数（古い方へ）
  journalAutoScroll: boolean;   // true = 最新に自動追従
  settingsItems: SettingsItem[];
  settingsCursor: number;
  // ── gh-cache Issues タブ (T272 Phase 3) ─────────────────────────
  issuesAvailability: "available" | "non_git" | "no_auth" | "unknown";
  issueItems: IssueListItem[];
  issueCursor: number;
  issueSyncing: boolean;
  issueLastSync: string | null;  // 表示用（ISO 文字列 or null）
  issueLastError: string | null;
  // ── Metrics タブ (T307) ──────────────────────────────────────────
  metricsData: MetricsData | null;
  metricsError: string | null;
  metricsLastLoadedMs: number;
  metricsScrollOffset: number;
  /** T415: O キー押下時の no-op / open 失敗通知。次の loadMetricsData で自動クリア */
  metricsStatusMessage: string | null;
}

// --- スピナー定義 ---

const SPINNER_FRAMES = ["▖", "▘", "▝", "▗"];  // boxBounce
const SPINNER_INTERVAL = 180;

// --- セクションタイトル（Ink 版と同じ "─ Title ──────" スタイル） ---

const HR_FILL = "─".repeat(120);

function sectionTitle(label: string) {
  return ui.button({
    id: `section-${label}`,
    label: `─ ${label} ${HR_FILL}`,
    px: 0,
    style: { dim: true },
    focusable: false,
  });
}

// --- ビュー構築 ---

export function buildMasterSection(state: DaemonState) {
  const masters = [...state.masters.values()];
  if (masters.length === 0) {
    return ui.row({ gap: 1 }, [
      ui.text("○", { style: { fg: GRAY } }),
      ui.text("not spawned", { style: { fg: GRAY } }),
    ]);
  }

  // 複数 Master 表示: 各 Master を縦に並べる。1 つのみの場合も同じ経路で出す。
  // T374: per-surface decoration (handle / util / cap / ⚠) は撤去（A024 §per-handle 行は出さない）
  const rows = masters.map((m) => {
    const surfaceLabel = `[${m.surface.replace("surface:", "")}]`;
    const status = m.status ?? "idle";

    if (status === "disconnected") {
      return ui.row({ gap: 1 }, [
        ui.text("⚠", { style: { fg: YELLOW } }),
        ui.text(surfaceLabel),
        ui.text("disconnected", { style: { fg: YELLOW } }),
      ]);
    }

    if (status === "error") {
      // T392: API エラー表示。kind 別アイコン + RED + 80 字 truncated message。
      const icon = apiErrorIcon(m.lastApiError?.kind);
      const truncated = truncateApiErrorMessage(m.lastApiError?.message);
      const children = [
        ui.text(icon, { style: { fg: RED } }),
        ui.text(surfaceLabel),
        ui.text(`error ${m.lastApiError?.kind ?? ""}`.trim(), { style: { fg: RED } }),
      ];
      if (truncated) {
        children.push(ui.text(truncated, { style: { fg: GRAY } }));
      }
      return ui.row({ gap: 1 }, children);
    }

    if (status === "running") {
      const frame = SPINNER_FRAMES[spinnerTick % SPINNER_FRAMES.length];
      const children = [
        ui.text(frame!, { style: { fg: YELLOW } }),
        ui.text(surfaceLabel),
      ];
      if (m.prompt) {
        children.push(ui.text(m.prompt, { style: { fg: GRAY } }));
      }
      return ui.row({ gap: 1 }, children);
    }

    // idle
    return ui.row({ gap: 1 }, [
      ui.text("●", { style: { fg: GREEN } }),
      ui.text(surfaceLabel),
    ]);
  });
  if (masters.some((m) => m.status === "running")) spinnerTick++;
  return rows.length === 1 ? rows[0]! : ui.column({ gap: 0 }, rows);
}

/**
 * T326: テスト用に export。Conductor 1 行 + 配下 Agent サブツリーを ui ノードとして組み立てる。
 *
 * T374: per-surface decoration (handle / util / cap / ⚠) は撤去（A024 §per-handle 行は出さない）。
 *       旧 `buildConductorRowWithPool` (4 引数) は当関数に統合された。
 */
export function buildConductorRow(
  c: ConductorState & { agents: AgentState[]; status: string },
  repoUrl: string | null,
  spinnerFrame: number = 0,
) {
  const isStarting = c.status === "starting";
  const isAssigning = c.status === "assigning";
  const isIdle = c.status === "idle";
  const isDisconnected = c.status === "disconnected";
  const isBroken = c.status === "broken";
  const isAsking = c.status === "asking";
  const isError = !isAsking && c.status === "error";
  const elapsed = formatElapsed(c.startedAt);
  const surface = c.surface.replace("surface:", "");
  // T392: lastApiError は AgentState/MasterState/ConductorState のオプション拡張。
  const cLastApiError = (c as ConductorState).lastApiError;

  const children = [];

  // メイン行
  const dimStyle = { style: { fg: GRAY } };
  if (isStarting) {
    const spinChar = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
    children.push(
      ui.row({ gap: 1 }, [
        ui.text(spinChar, { style: { fg: CYAN } }),
        ui.text(`[${surface}]`, { style: { fg: CYAN } }),
        ui.text("starting…", { style: { fg: CYAN } }),
      ])
    );
  } else if (isAssigning) {
    // T232: assigning 状態は「タスク割り当て中（/clear → SESSION_STARTED 待ち）」
    //       starting と同じトーン（spinner + CYAN + 省略記号）で表示する。
    const spinChar = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
    const taskParts: ReturnType<typeof ui.text>[] = [];
    if (c.taskId) {
      taskParts.push(ui.text(`T${c.taskId.padStart(3, "0")}`, { bold: true }));
    }
    if (c.taskTitle) {
      taskParts.push(buildTitleWithLinks(c.taskTitle, repoUrl));
    }
    children.push(
      ui.row({ gap: 1 }, [
        ui.text(spinChar, { style: { fg: CYAN } }),
        ui.text(`[${surface}]`, { style: { fg: CYAN } }),
        ...taskParts,
        ui.text("assigning…", { style: { fg: CYAN } }),
      ])
    );
  } else if (isIdle) {
    children.push(
      ui.row({ gap: 1 }, [
        ui.text("○", dimStyle),
        ui.text(`[${surface}]`, dimStyle),
        ui.text("idle", { dim: true }),
      ])
    );
  } else if (isAsking) {
    const taskParts: ReturnType<typeof ui.text>[] = [];
    if (c.taskId) {
      taskParts.push(ui.text(`T${c.taskId.padStart(3, "0")}`, { bold: true }));
    }
    if (c.taskTitle) {
      taskParts.push(buildTitleWithLinks(c.taskTitle, repoUrl));
    }
    children.push(
      ui.row({ gap: 1 }, [
        ui.text("⚠", { style: { fg: YELLOW } }),
        ui.text(`[${surface}]`),
        ...taskParts,
        ui.text("asking", { style: { fg: YELLOW } }),
        ui.text(elapsed, { dim: true }),
      ])
    );
    const q = (c.askQuestion ?? "").replace(/\s+/g, " ").trim();
    if (q) {
      const shown = q.length > 120 ? q.slice(0, 117) + "..." : q;
      children.push(
        ui.row({ gap: 1 }, [
          ui.text("  ?", { style: { fg: YELLOW } }),
          ui.text(shown, { dim: true }),
        ])
      );
    }
  } else if (isError) {
    // T392: API エラー表示 (StopFailure hook 受信)。kind 別アイコン + RED + 80 字 truncated message。
    const icon = apiErrorIcon(cLastApiError?.kind);
    const truncated = truncateApiErrorMessage(cLastApiError?.message);
    const taskParts: ReturnType<typeof ui.text>[] = [];
    if (c.taskId) {
      taskParts.push(ui.text(`T${c.taskId.padStart(3, "0")}`, { bold: true }));
    }
    if (c.taskTitle) {
      taskParts.push(buildTitleWithLinks(c.taskTitle, repoUrl));
    }
    children.push(
      ui.row({ gap: 1 }, [
        ui.text(icon, { style: { fg: RED } }),
        ui.text(`[${surface}]`),
        ...taskParts,
        ui.text(`error ${cLastApiError?.kind ?? ""}`.trim(), { style: { fg: RED } }),
      ])
    );
    if (truncated) {
      children.push(
        ui.row({ gap: 1 }, [
          ui.text("  ", { dim: true }),
          ui.text(truncated, { style: { fg: GRAY } }),
        ])
      );
    }
  } else if (isDisconnected) {
    const disconnectedElapsed = c.disconnectedAt ? formatElapsed(c.disconnectedAt) : "";
    const taskParts: ReturnType<typeof ui.text>[] = [];
    if (c.taskId) {
      taskParts.push(ui.text(`T${c.taskId.padStart(3, "0")}`, { bold: true }));
    }
    if (c.taskTitle) {
      taskParts.push(buildTitleWithLinks(c.taskTitle, repoUrl));
    }
    children.push(
      ui.row({ gap: 1 }, [
        ui.text("⚠", { style: { fg: YELLOW } }),
        ui.text(`[${surface}]`),
        ...taskParts,
        ui.text(`disconnected ${disconnectedElapsed}`, { style: { fg: YELLOW } }),
      ])
    );
  } else if (isBroken) {
    // T250: broken 状態の Conductor は RED + ⨯ で明示。disconnectedAt を経過時間として表示し、
    //       clear-conductor CLI での明示解除を促す。
    const brokenElapsed = c.disconnectedAt ? formatElapsed(c.disconnectedAt) : "";
    children.push(
      ui.row({ gap: 1 }, [
        ui.text("⨯", { style: { fg: RED } }),
        ui.text(`[${surface}]`),
        ui.text(`broken ${brokenElapsed}`, { style: { fg: RED } }),
        ui.text("use clear-conductor", { dim: true }),
      ])
    );
  } else {
    const taskId = `T${(c.taskId ?? "").padStart(3, "0")}`;
    const iconChar = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
    children.push(
      ui.row({ gap: 1 }, [
        ui.text(iconChar, { style: { fg: YELLOW } }),
        ui.text(`[${surface}]`),
        ui.text(taskId, { bold: true }),
        c.taskTitle ? buildTitleWithLinks(c.taskTitle, repoUrl) : null,
        ui.text(elapsed, { dim: true }),
      ])
    );
  }

  // Agent サブツリー
  const agents = c.agents || [];
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!;
    const roleIcons: Record<string, string> = {
      impl: "⚙", implementer: "⚙",
      docs: "📝", dockeeper: "📝",
      reviewer: "🔍", review: "🔍",
      researcher: "🔬", research: "🔬",
      tester: "🧪", test: "🧪",
      architect: "📐", design: "📐",
    };
    const roleIcon = roleIcons[a.role ?? ""] ?? "🔧";
    const prefix = i === agents.length - 1 ? "└─" : "├─";
    const label = a.taskTitle ?? a.role ?? "";
    // T236: status に応じて spinner / role アイコンを切り替え。
    //       status undefined は古い team.json 復元経路で起きうる → idle 相当で描画。
    // T238: status === "asking" のときは YELLOW + ? マーク + ラベル YELLOW で強調。
    // T392: status === "error" のときは RED + kind 別アイコン + truncated message。
    //       asking 優先（asking と error が並立した瞬間でも asking を優先表示）。
    const isAgentAsking = a.status === "asking";
    const isAgentError = !isAgentAsking && a.status === "error";
    const isAgentRunning = !isAgentError && (a.status === "running" || a.status === "starting");
    if (isAgentAsking) {
      children.push(
        ui.row({ gap: 1 }, [
          ui.text(`   ${prefix}`, { dim: true }),
          ui.text(`[${a.surface.replace("surface:", "")}]`, { style: { fg: YELLOW } }),
          ui.text("?", { style: { fg: YELLOW } }),
          ui.text(roleIcon, { style: { fg: YELLOW } }),
          ui.text(label, { style: { fg: YELLOW } }),
        ])
      );
    } else if (isAgentError) {
      const icon = apiErrorIcon(a.lastApiError?.kind);
      const truncated = truncateApiErrorMessage(a.lastApiError?.message);
      const row1 = [
        ui.text(`   ${prefix}`, { dim: true }),
        ui.text(`[${a.surface.replace("surface:", "")}]`, { style: { fg: RED } }),
        ui.text(icon, { style: { fg: RED } }),
        ui.text(label, { style: { fg: RED } }),
      ];
      children.push(ui.row({ gap: 1 }, row1));
      if (truncated) {
        children.push(
          ui.row({ gap: 1 }, [
            ui.text(`     `, { dim: true }),
            ui.text(truncated, { style: { fg: GRAY } }),
          ])
        );
      }
    } else if (isAgentRunning) {
      const spinChar = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
      children.push(
        ui.row({ gap: 1 }, [
          ui.text(`   ${prefix}`, { dim: true }),
          ui.text(`[${a.surface.replace("surface:", "")}]`, { style: { fg: CYAN } }),
          ui.text(spinChar, { style: { fg: CYAN } }),
          ui.text(label),
        ])
      );
    } else {
      // T352: idle 行は roleIcon を plain（dim 解除）、taskTitle のみ dim を維持。
      children.push(
        ui.row({ gap: 1 }, [
          ui.text(`   ${prefix}`, { dim: true }),
          ui.text(`[${a.surface.replace("surface:", "")}]`, { style: { fg: CYAN } }),
          ui.text(roleIcon),
          ui.text(label, { dim: true }),
        ])
      );
    }
  }

  return ui.column({ gap: 0 }, children);
}

function buildConductorsSection(
  state: DaemonState,
  repoUrl: string | null,
  spinnerFrame: number = 0,
) {
  const conductors = [...state.conductors.values()];
  if (conductors.length === 0) {
    return ui.text("idle — waiting for tasks", { dim: true });
  }
  return ui.column(
    { gap: 0 },
    conductors.map((c) => buildConductorRow(c as any, repoUrl, spinnerFrame)),
  );
}

/**
 * T326: Conductors セクションタイトル文字列を組み立てる純関数。
 * `startDashboard` 内 inline で組まれていた文字列を切り出したもので、
 * 生成結果は完全一致する（挙動不変リファクタ）。テスト容易性のために export する。
 */
export function formatConductorsSectionLabel(conductors: readonly { status: string }[]): string {
  let startingCount = 0;
  let assigningCount = 0;
  let askingCount = 0;
  let runningCount = 0;
  let brokenCount = 0;
  let errorCount = 0;
  for (const c of conductors) {
    switch (c.status) {
      case "starting": startingCount++; break;
      case "assigning": assigningCount++; break;
      case "asking": askingCount++; break;
      case "running": runningCount++; break;
      case "broken": brokenCount++; break;
      case "error": errorCount++; break;
    }
  }
  return `Conductors${startingCount > 0 ? ` ${startingCount} starting` : ""}${assigningCount > 0 ? ` ${assigningCount} assigning` : ""}${askingCount > 0 ? ` ${askingCount} asking` : ""}${runningCount > 0 ? ` ${runningCount} running` : ""}${brokenCount > 0 ? ` ${brokenCount} broken` : ""}${errorCount > 0 ? ` ${errorCount} error` : ""}`;
}

function buildTaskRow(
  task: TaskSummary,
  assigned: boolean,
  repoUrl: string | null,
  styleOverride?: Record<string, any>,
  buttonConfig?: { id: string; onPress: () => void },
) {
  const isAborted = task.status === "aborted";
  const isClosed = task.status === "closed" || isAborted;
  const icon = isAborted ? "✕" : isClosed ? "○" : "●";
  const isBlocked = !isClosed && !assigned && task.dependsOn.length > 0;
  const blockedLabel = isBlocked
    ? `blocked T${task.dependsOn.map(d => d.padStart(3, "0")).join(",T")}`
    : null;
  const label = isAborted ? "aborted" : isClosed ? "closed" : assigned ? "running" : blockedLabel ?? task.status;
  const taskId = `T${task.id.padStart(3, "0")}`;
  const timeInfo = isAborted && task.abortedAt
    ? `${utcToLocal(task.abortedAt).slice(0, 5)}${task.assignedAt ? ` (${compactElapsed(task.assignedAt, task.abortedAt)})` : ""}`
    : isClosed && task.closedAt
    ? `${utcToLocal(task.closedAt).slice(0, 5)}${task.assignedAt ? ` (${compactElapsed(task.assignedAt, task.closedAt)})` : task.createdAt ? ` (${compactElapsed(task.createdAt, task.closedAt)})` : ""}`
    : assigned && task.assignedAt
    ? `${utcToLocal(task.assignedAt).slice(0, 5)} (${compactElapsed(task.assignedAt)})`
    : task.createdAt
    ? utcToLocal(task.createdAt).slice(0, 5)
    : "";

  // ステータス別の色（Ink版と同等）
  const color = isAborted ? RED : isClosed ? GRAY : assigned ? GREEN : isBlocked ? RED : task.status === "ready" ? YELLOW : undefined;
  const colorStyle = color ? { style: { fg: color } } : {};

  // ステータスの Nerd Font アイコン
  const statusIcons: Record<string, { nerd: string; fallback: string }> = {
    running: { nerd: "\uf04b", fallback: "[running]" },
    closed: { nerd: "\uf00c", fallback: "[closed]" },
    ready: { nerd: "\u25c6", fallback: "[ready]" },
    aborted: { nerd: "\uf00d", fallback: "[aborted]" },
    blocked: { nerd: "\uf023", fallback: "[blocked]" },
    draft: { nerd: "\uf040", fallback: "[draft]" },
  };
  // blocked ラベルは "blocked T001,T002" のようになるため、先頭を見てマッチ
  const statusKey = label.startsWith("blocked") ? "blocked" : label;
  const iconInfo = statusIcons[statusKey] ?? { nerd: `[${label}]`, fallback: `[${label}]` };
  const statusDisplay = nerdIcon(iconInfo.nerd, iconInfo.fallback);

  // T295: closed 行の末尾に納品方式の short 表記を付ける。旧 closed 行（deliverable 無し）は null。
  // aborted は納品概念が無いため対象外（null）。
  const deliverableSuffix = isClosed && !isAborted && task.deliverable
    ? formatDeliverable(task.deliverable, "short")
    : null;

  // ボタンモード: ui.button でクリック可能な行を返す
  if (buttonConfig) {
    const branchPart = task.baseBranch ? ` ${nerdIcon("\ue0a0", "⎇")} ${task.baseBranch}` : "";
    const deliverablePart = deliverableSuffix ? ` ${deliverableSuffix}` : "";
    const flatLabel = `${icon} ${taskId} ${statusDisplay}${branchPart} ${task.title}${timeInfo ? ` ${timeInfo}` : ""}${deliverablePart}`;
    const btnStyle: Record<string, any> = {};
    if (color) btnStyle.fg = color;
    if (!isClosed) btnStyle.bold = true;
    if (styleOverride?.style) Object.assign(btnStyle, styleOverride.style);
    return ui.button({
      id: buttonConfig.id,
      label: flatLabel,
      px: 0,
      dsVariant: "ghost",
      focusable: false,
      style: Object.keys(btnStyle).length > 0 ? btnStyle : undefined,
      onPress: buttonConfig.onPress,
    });
  }

  const mergeStyle = (base: Record<string, any>) => {
    if (!styleOverride) return base;
    const merged = { ...base, ...styleOverride };
    if (base.style || styleOverride.style) {
      merged.style = { ...(base.style ?? {}), ...(styleOverride.style ?? {}) };
    }
    return merged;
  };

  const branchEl = task.baseBranch
    ? ui.text(`${nerdIcon("\ue0a0", "⎇")} ${task.baseBranch}`, mergeStyle({ dim: true }))
    : null;

  // styleOverride 時は gap: 0 + 手動スペースで underline を途切れさせない
  if (styleOverride) {
    const sp = (s: string) => ` ${s}`;
    return ui.row({ gap: 0 }, [
      ui.text(icon, mergeStyle(colorStyle)),
      ui.text(sp(taskId), mergeStyle({ bold: !isClosed, ...colorStyle })),
      ui.text(sp(statusDisplay), mergeStyle(colorStyle)),
      branchEl ? ui.text(sp(`${nerdIcon("\ue0a0", "⎇")} ${task.baseBranch}`), mergeStyle({ dim: true })) : null,
      buildTitleWithLinks(` ${task.title}`, repoUrl, mergeStyle(colorStyle)),
      timeInfo ? ui.text(sp(timeInfo), mergeStyle(colorStyle)) : null,
      deliverableSuffix ? ui.text(sp(deliverableSuffix), mergeStyle({ dim: true })) : null,
    ]);
  }

  return ui.row({ gap: 1 }, [
    ui.text(icon, mergeStyle(colorStyle)),
    ui.text(taskId, mergeStyle({ bold: !isClosed, ...colorStyle })),
    ui.text(statusDisplay, mergeStyle(colorStyle)),
    branchEl,
    buildTitleWithLinks(task.title, repoUrl, mergeStyle(colorStyle)),
    timeInfo ? ui.text(timeInfo, mergeStyle(colorStyle)) : null,
    deliverableSuffix ? ui.text(deliverableSuffix, mergeStyle({ dim: true })) : null,
  ]);
}

// --- Journal/Log テキスト行構築（ui.logsConsole の代替） ---

export function buildJournalRows(entries: JournalEntry[], repoUrl: string | null) {
  if (entries.length === 0) {
    return [ui.text("no journal entries", { dim: true })];
  }
  // T353: daemon sentinel taskId は filter を通し T### 列はスキップ。dim flag は icon style にマージ
  return entries
    .filter((e) => isValidTaskId(e.taskId) || e.taskId === DAEMON_SENTINEL_TASK_ID)
    .map((entry) => {
      const isDaemon = entry.taskId === DAEMON_SENTINEL_TASK_ID;
      const dimStyle = entry.dim ? { dim: true } : {};
      const iconStyle = entry.iconColor
        ? { style: { fg: entry.iconColor }, ...dimStyle }
        : dimStyle;
      return ui.row({ gap: 1 }, [
        ui.text(entry.time, { dim: true }),
        ui.text(entry.icon, iconStyle),
        isDaemon ? null : ui.text(`T${entry.taskId.padStart(3, "0")}`, { bold: true }),
        entry.surface ? ui.text(`[${entry.surface.replace("surface:", "")}]`, { dim: true }) : null,
        buildTitleWithLinks(entry.message, repoUrl),
      ]);
    });
}

// --- Artifacts タブ ---

const artifactTypeColors: Record<string, number> = {
  research: CYAN,
  decision: YELLOW,
  session: GREEN,
  spec: rgb(180, 130, 255),
  report: rgb(255, 165, 0),
};

function getFilteredArtifacts(state: AppState): ArtifactMeta[] {
  let list = [...state.artifacts];

  // タイプ絞り込み
  if (state.artifactTypeFilter) {
    list = list.filter(a => a.type === state.artifactTypeFilter);
  }

  // 検索
  if (state.artifactSearch) {
    const q = state.artifactSearch.toLowerCase();
    list = list.filter(a =>
      a.id.toLowerCase().includes(q) ||
      a.title.toLowerCase().includes(q) ||
      a.type.toLowerCase().includes(q) ||
      (a.task?.toLowerCase().includes(q) ?? false) ||
      (a.tags?.some(t => t.toLowerCase().includes(q)) ?? false)
    );
  }

  // ソート
  if (state.artifactSort === "created") {
    list.sort((a, b) => b.created.localeCompare(a.created));
  } else if (state.artifactSort === "updated") {
    list.sort((a, b) => (b.updated ?? b.created).localeCompare(a.updated ?? a.created));
  } else {
    // id 順（デフォルト）
    list.sort((a, b) => a.id.localeCompare(b.id));
  }

  return list;
}

function buildArtifactRows(state: AppState): any[] {
  const filtered = getFilteredArtifacts(state);

  if (filtered.length === 0) {
    return [ui.text("no artifacts", { dim: true })];
  }

  const rows: any[] = [];

  // フィルタ/検索インジケータ
  const indicators: string[] = [];
  if (state.artifactTypeFilter) indicators.push(`type:${state.artifactTypeFilter}`);
  if (state.artifactSearch) indicators.push(`search:"${state.artifactSearch}"`);
  if (state.artifactSort !== "id") indicators.push(`sort:${state.artifactSort}`);
  if (indicators.length > 0) {
    rows.push(ui.text(`  ${indicators.join("  ")}`, { dim: true }));
  }

  // カーソル追従スクロール（Tasks タブ L1094-1100 と同じ式）
  let artifactStartIdx = 0;
  if (filtered.length > ARTIFACT_VISIBLE_LINES) {
    artifactStartIdx = Math.max(
      0,
      Math.min(
        state.artifactCursor - ARTIFACT_VISIBLE_LINES + 1,
        filtered.length - ARTIFACT_VISIBLE_LINES,
      ),
    );
    if (state.artifactCursor < artifactStartIdx) artifactStartIdx = state.artifactCursor;
  }
  const visibleArtifacts = filtered.slice(artifactStartIdx, artifactStartIdx + ARTIFACT_VISIBLE_LINES);

  for (let i = 0; i < visibleArtifacts.length; i++) {
    const a = visibleArtifacts[i]!;
    const globalIdx = artifactStartIdx + i;
    const isSelected = globalIdx === state.artifactCursor;
    const typeColor = artifactTypeColors[a.type] ?? GRAY;
    const date = a.created ? utcToLocal(a.created).slice(0, 5) : "";

    const parts = [
      ui.text(isSelected ? ">" : " ", isSelected ? { bold: true } : {}),
      ui.text(a.id, { style: { bold: isSelected, fg: typeColor } }),
      ui.text(`[${a.type}]`, { style: { fg: typeColor } }),
      ui.text(a.title, isSelected ? { bold: true } : {}),
      date ? ui.text(date, { dim: true }) : null,
      a.task ? ui.text(a.task, { dim: true }) : null,
    ];

    rows.push(ui.row({ gap: 1 }, parts));
  }

  // プレビュー（選択中 artifact の body 冒頭5行）
  if (filtered.length > 0 && state.artifactCursor < filtered.length) {
    const selected = filtered[state.artifactCursor]!;
    const previewLines = selected.body.split("\n").slice(0, 5);
    rows.push(ui.text(""));
    rows.push(ui.text(`── ${selected.id}: ${selected.title} ──`, { dim: true }));
    for (const line of previewLines) {
      rows.push(ui.text(line, { dim: true }));
    }
    if (selected.body.split("\n").length > 5) {
      rows.push(ui.text("  ...", { dim: true }));
    }
  }

  return rows;
}

/**
 * gh-cache Issues タブの行を描画する (T272 Phase 3)
 *
 * - 非 git / 認証なしなら disabled メッセージ
 * - sync 中はプログレス行
 * - エラーがあれば最下行に表示
 */
export function buildIssueRows(state: AppState): any[] {
  if (state.issuesAvailability === "non_git") {
    return [ui.text(t("gh_tui_disabled_non_git"), { dim: true })];
  }
  if (state.issuesAvailability === "no_auth") {
    return [ui.text(t("gh_tui_disabled_no_auth"), { dim: true })];
  }

  const rows: any[] = [];
  if (state.issueLastSync) {
    rows.push(
      ui.text(
        `last sync: ${state.issueLastSync}${state.issueSyncing ? " • " + t("gh_tui_syncing") : ""}`,
        { dim: true },
      ),
    );
  } else if (state.issueSyncing) {
    rows.push(ui.text(t("gh_tui_syncing"), { dim: true }));
  }

  if (state.issueItems.length === 0) {
    rows.push(ui.text(t("gh_issue_empty"), { dim: true }));
  } else {
    // カーソル追従スクロール（buildArtifactRows L845-857 と同じ式）
    let issueStartIdx = 0;
    if (state.issueItems.length > ISSUE_VISIBLE_LINES) {
      issueStartIdx = Math.max(
        0,
        Math.min(
          state.issueCursor - ISSUE_VISIBLE_LINES + 1,
          state.issueItems.length - ISSUE_VISIBLE_LINES,
        ),
      );
      if (state.issueCursor < issueStartIdx) issueStartIdx = state.issueCursor;
    }
    const visibleIssues = state.issueItems.slice(
      issueStartIdx,
      issueStartIdx + ISSUE_VISIBLE_LINES,
    );

    for (let i = 0; i < visibleIssues.length; i++) {
      const item = visibleIssues[i]!;
      const globalIdx = issueStartIdx + i;
      const isSelected = globalIdx === state.issueCursor;
      const stateStr = displayState(item.issue).padEnd(7);
      const typePrefix = item.issue.type === "pr" ? "PR" : "  ";
      const parts = [
        ui.text(isSelected ? ">" : " ", isSelected ? { bold: true } : {}),
        ui.text(typePrefix, { dim: true }),
        ui.text(`#${item.issue.number}`, { style: { bold: isSelected, fg: GRAY } }),
        ui.text(stateStr, { dim: true }),
        ui.text(item.issue.title, isSelected ? { bold: true } : {}),
        item.labels.length > 0
          ? ui.text(`[${item.labels.map((l) => l.name).join(", ")}]`, { dim: true })
          : null,
      ];
      rows.push(ui.row({ gap: 1 }, parts));
    }
  }

  if (state.issueLastError) {
    rows.push(ui.text(""));
    rows.push(ui.text(state.issueLastError, { dim: true }));
  }

  return rows;
}

function buildLogRows(lines: string[]) {
  if (lines.length === 0) {
    return [ui.text("no log entries", { dim: true })];
  }
  return lines.map((line) => {
    const parsed = parseLogLine(line);
    const eventColor = parsed.level === "error" ? RED
      : parsed.event.includes("completed") ? GREEN
      : undefined;
    return ui.row({ gap: 1 }, [
      ui.text(parsed.time, { dim: true }),
      ui.text(parsed.event, eventColor ? { style: { fg: eventColor } } : {}),
      ui.text(parsed.detail),
    ]);
  });
}

function buildSettingsRows(state: AppState): any[] {
  const items = state.settingsItems;
  if (items.length === 0) {
    return [ui.text("loading settings…", { dim: true })];
  }

  const rows: any[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const isSelected = i === state.settingsCursor;
    const cursor = isSelected ? ">" : " ";

    if (item.kind === "section") {
      rows.push(ui.text(""));
      rows.push(ui.text(`── ${item.label} ──`, { dim: true }));
      continue;
    }

    if (item.kind === "overlay") {
      const status = item.exists ? "✓" : "✗";
      const statusColor = item.exists ? GREEN : GRAY;
      const sizeLabel = item.exists ? `${item.size} bytes` : "(not set)";
      rows.push(
        ui.row({ gap: 1 }, [
          ui.text(cursor, isSelected ? { bold: true } : {}),
          ui.text(status, { style: { fg: statusColor } }),
          ui.text(item.role, { style: { bold: isSelected } }),
          ui.text(sizeLabel, { dim: true }),
        ]),
      );
      continue;
    }

    // config
    rows.push(
      ui.row({ gap: 1 }, [
        ui.text(cursor, isSelected ? { bold: true } : {}),
        ui.text(item.label, { style: { bold: isSelected } }),
        ui.text("=", { dim: true }),
        ui.text(item.value),
      ]),
    );
  }

  // プレビュー（選択中アイテム）
  const selected = items[state.settingsCursor];
  if (selected) {
    rows.push(ui.text(""));
    if (selected.kind === "overlay") {
      const path = selected.filePath.replace(state.daemon.projectRoot + "/", "");
      rows.push(ui.text(`── ${selected.role} (${path}) ──`, { dim: true }));
      if (!selected.exists) {
        rows.push(ui.text("  (no overlay set)", { dim: true }));
        rows.push(ui.text(`  set: cmux-team set-agent-instructions --role ${selected.role} --from-file <path>`, { dim: true }));
      } else {
        for (const line of selected.preview) {
          rows.push(ui.text(line, { dim: true }));
        }
        if (selected.truncated) {
          rows.push(ui.text("  …", { dim: true }));
        }
      }
    } else if (selected.kind === "config") {
      rows.push(ui.text(`── ${selected.label} ──`, { dim: true }));
      rows.push(ui.text(`  ${selected.value}`, { dim: true }));
    }
  }

  return rows;
}

/**
 * 選択中の artifact を外部ビューアで開く
 * mo ビューア: TUI を停止せずバックグラウンドで起動し cmux browser open で表示
 * cat フォールバック: TUI を一時停止し、終了後に復帰する
 */
/** 既存のブラウザ surface を検索して ref を返す（なければ null） */
async function findExistingBrowserSurface(): Promise<string | null> {
  const workspace = process.env.CMUX_WORKSPACE_ID;
  const args = ["cmux", "tree", "--json"];
  if (workspace) args.push("--workspace", workspace);

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  try {
    const tree = JSON.parse(output);
    for (const w of tree.windows ?? []) {
      for (const ws of w.workspaces ?? []) {
        for (const p of ws.panes ?? []) {
          for (const s of p.surfaces ?? []) {
            if (s.type === "browser") return s.ref;
          }
        }
      }
    }
  } catch {}
  return null;
}

async function openArtifactInViewer(
  app: NodeApp<AppState>,
  filePath: string,
  onResumed: () => void,
): Promise<void> {
  const viewer = await resolveMarkdownViewer();

  if (viewer === "mo") {
    // mo をバックグラウンドで起動し、--json で file-specific URL を取得
    const moProc = Bun.spawn(["mo", filePath, "--json"], { stdout: "pipe", stderr: "ignore" });
    const moOutput = await new Response(moProc.stdout).text();
    await moProc.exited;

    // JSON から file-specific URL を取得（フォールバック付き）
    let viewerUrl = "http://localhost:6275";
    try {
      const parsed = JSON.parse(moOutput);
      if (parsed.files?.[0]?.url) {
        viewerUrl = parsed.files[0].url;
      }
    } catch {}

    // 既存ブラウザ surface を再利用（なければ新規作成）
    const browserSurface = await findExistingBrowserSurface();
    if (browserSurface) {
      Bun.spawn(["cmux", "browser", browserSurface, "goto", viewerUrl], { stdio: ["ignore", "ignore", "ignore"] });
    } else {
      Bun.spawn(["cmux", "browser", "open", viewerUrl], { stdio: ["ignore", "ignore", "ignore"] });
    }
    return;
  }

  // cat フォールバック: TUI を一時停止して実行
  dashboardActive = false;
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
  await app.stop();

  try {
    const proc = Bun.spawn(["cat", filePath], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  } catch {}

  await app.start();
  onResumed();
}

// --- アプリインスタンス管理 ---

let appInstance: NodeApp<AppState> | null = null;
let spinnerInterval: ReturnType<typeof setInterval> | null = null;
/** T307: Metrics タブ active 中の 1s polling。非 active で null に戻す。 */
let metricsInterval: ReturnType<typeof setInterval> | null = null;
/** TUI が表示中かどうか（ビューア表示中は false にして app.update を防ぐ） */
let dashboardActive = false;
let eventBusUnsubscribe: (() => void) | null = null;

export async function startDashboard(
  getState: () => DaemonState,
  opts?: { version?: string; onReload?: () => void; onQuit?: () => void; onFullQuit?: () => void }
): Promise<{ scheduleRefresh: () => void }> {
  const daemonState = getState();
  let confirmingFullQuit = false;

  // T354: dashboard 内で参照する config の cache。startDashboard 起動時に 1 回だけ
  // loadConfig し、Settings タブの reload で更新する（Metrics の interval / poolTokens
  // フィルタはこのキャッシュを参照する）。daemon 稼働中の config 変更は Manager 再起動時に反映。
  let cachedConfig: TeamConfig = await loadConfig(daemonState.projectRoot);

  // OSC 8 ハイパーリンクを有効化（ターミナル自動検出に依存せず明示的に設定）
  process.env.REZI_TERMINAL_SUPPORTS_OSC8 = "1";

  // T409: console.warn / error を manager.log にリダイレクト。
  // 依存ライブラリが stderr に書き込んで TUI 描画バッファを貫通する残骸を防ぐ。
  // すり替え解除は不要（dashboard プロセスは exit 時に消える）。
  installDashboardConsoleRedirect();

  const app = createNodeApp<AppState>({
    initialState: {
      daemon: daemonState,
      activeTab: "journal",
      journalEntries: [],
      logLines: [],
      artifacts: [],
      artifactCursor: 0,
      artifactSort: "id",
      artifactTypeFilter: null,
      artifactSearch: null,
      taskCursor: 0,
      version: opts?.version ?? "",
      repoUrl: null,
      logScrollOffset: 0,
      logAutoScroll: true,
      spinnerFrame: 0,
      focusedArea: "global",
      journalScrollOffset: 0,
      journalAutoScroll: true,
      settingsItems: [],
      settingsCursor: 0,
      issuesAvailability: "unknown",
      issueItems: [],
      issueCursor: 0,
      issueSyncing: false,
      issueLastSync: null,
      issueLastError: null,
      metricsData: null,
      metricsError: null,
      metricsLastLoadedMs: 0,
      metricsScrollOffset: 0,
      metricsStatusMessage: null,
    },
    config: { executionMode: "inline" },
  });

  function buildViewWithApp(state: AppState) {
    const { daemon, repoUrl } = state;
    const conductorsSectionLabel = formatConductorsSectionLabel([...daemon.conductors.values()]);
    const assignedTaskIds = new Set([...daemon.conductors.values()].map(c => c.taskId));

    // レスポンシブヘッダー
    // T367: pool-aware スロットリング判定。
    // - boot/running ガードを最上位に置く（headerSubtitle 優先度と整合）
    // - pool 有効 + pool snapshot 有り → 純粋関数 hasPoolHeadroomFromSummary 経由（SQLite 触らない）
    // - pool 有効だが pool=null（refreshPoolSnapshot 失敗 fallback）→ rate-limit 経路にフォールバック
    // - pool 無効 → 従来 5h 軸 + THROTTLE_5H_THRESHOLD
    const isThrottled =
      !daemon.running || daemon.bootPhase !== "ready"
        ? false
        : daemon.tokenDb !== null && daemon.pool !== null
          ? !hasPoolHeadroomFromSummary(Array.from(daemon.pool.perHandle.values()))
          : !isStale5h(daemon.rateLimit) &&
            (daemon.rateLimit?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD;

    const headerParts = [
      !daemon.running ? "STOPPED"
        : daemon.bootPhase !== "ready" ? "STARTING"
        : isThrottled ? null
        : (state.version ? `v${state.version}` : ""),
    ].filter(Boolean);

    // スロットリング表示テキスト
    let throttleLabel = "";
    if (isThrottled && daemon.running && daemon.bootPhase === "ready") {
      throttleLabel = "⏸ THROTTLED";
    }

    const headerSubtitle = throttleLabel || headerParts.join("  ");

    // タスク一覧（カーソル選択 + スクロール対応）
    const totalTasks = daemon.taskList.length;
    let taskStartIdx = 0;
    if (totalTasks > TASK_VISIBLE_LINES) {
      taskStartIdx = Math.max(0, Math.min(state.taskCursor - TASK_VISIBLE_LINES + 1, totalTasks - TASK_VISIBLE_LINES));
      if (state.taskCursor < taskStartIdx) taskStartIdx = state.taskCursor;
    }
    const visibleTasks = daemon.taskList.slice(taskStartIdx, taskStartIdx + TASK_VISIBLE_LINES);
    const tasksFocused = state.focusedArea === "tasks";
    const taskRows = totalTasks === 0
      ? [ui.text("no tasks", { dim: true })]
      : visibleTasks.map((task, i) => {
          const globalIdx = taskStartIdx + i;
          const isSelected = globalIdx === state.taskCursor;
          const cursorStyle = tasksFocused && isSelected ? { style: { underline: true } } : undefined;
          return buildTaskRow(task, assignedTaskIds.has(task.id), repoUrl, cursorStyle, {
            id: `task-${task.id}`,
            onPress: () => { try { app.update((s) => ({ ...s, focusedArea: "tasks", taskCursor: globalIdx })); } catch {} },
          });
        });

    return ui.page({
      body: ui.column({ gap: 0 }, [
        // ヘッダー行（sectionTitle と同じスタイル）
        (() => {
          const rl = daemon.pool != null
            ? buildPoolHeaderDisplay(daemon.pool)
            : buildRateLimitDisplay(daemon.rateLimit);
          const portLabel = daemon.proxyPort ? ` :${daemon.proxyPort}` : "";
          const left = `─ cmux-team ${headerSubtitle}${portLabel}`;
          const rightText = rl.parts.map((p, i) => (i > 0 ? (p.group ? "  " : " ") : "") + p.text).join("");
          const fill = "─".repeat(Math.max(1, 80 - left.length - rightText.length));

          // スロットリング中: headerSubtitle 部分を赤色で表示
          if (isThrottled && throttleLabel) {
            const prefix = "─ cmux-team ";
            return ui.row({ gap: 0 }, [
              ui.text(prefix, { dim: true }),
              ui.text(`${throttleLabel}${portLabel}`, { style: { fg: RED, blink: true } }),
              ui.text(` ${fill} `, { dim: true }),
              ...rl.parts.flatMap((p, i) => [
                ...(i > 0 ? [ui.text("  ", { dim: true })] : []),
                ui.text(p.text, { style: { fg: mapRateLimitColor(p.color) } }),
              ]),
            ]);
          }

          return ui.row({ gap: 0 }, [
            ui.text(`${left} ${fill} `, { dim: true }),
            ...rl.parts.flatMap((p, i) => [
              ...(i > 0 ? [ui.text(p.group ? "  " : " ", { dim: true })] : []),
              ui.text(p.text, { style: { fg: mapRateLimitColor(p.color) } }),
            ]),
          ]);
        })(),
        // Update 通知バナー（T187 / T294）— updateAvailable が非 null のときのみ挿入
        ...(daemon.updateAvailable
          ? [(() => {
              const ua = daemon.updateAvailable!;
              const suffix = `(upgrade: npm i -g @hummer98/cmux-team@${ua.latest})`;
              return ui.text(
                `⬆ update available: v${ua.current} → v${ua.latest}  ${suffix}`,
                { style: { fg: YELLOW, bold: true } },
              );
            })()]
          : []),
        // Master セクション
        sectionTitle("Master"),
        buildMasterSection(daemon),
        // Conductors セクション
        sectionTitle(conductorsSectionLabel),
        buildConductorsSection(daemon, repoUrl, state.spinnerFrame),
        // Tasks セクション（クリックでフォーカス）
        ui.button({
          id: "section-tasks",
          label: `─ Tasks ${daemon.openTasks} open ${HR_FILL}`,
          px: 0,
          style: state.focusedArea === "tasks" ? { bold: true } : { dim: true },
          focusable: false,
          onPress: () => { try { app.update((s) => ({ ...s, focusedArea: "tasks" })); } catch {} },
        }),
        ui.column({ gap: 0 }, taskRows),
        // Journal / Artifacts / Log / Settings タブ（クリックでタブ切り替え + フォーカス）
        ui.row({ gap: 1 }, [
          ui.button({
            id: "tab-journal",
            label: "Journal",
            px: 1,
            focusable: false,
            style: state.activeTab === "journal" ? { bold: true } : { dim: true },
            onPress: () => switchTab("journal"),
          }),
          ui.button({
            id: "tab-artifacts",
            label: "Artifacts",
            px: 1,
            focusable: false,
            style: state.activeTab === "artifacts" ? { bold: true } : { dim: true },
            onPress: () => switchTab("artifacts"),
          }),
          ui.button({
            id: "tab-log",
            label: "Log",
            px: 1,
            focusable: false,
            style: state.activeTab === "log" ? { bold: true } : { dim: true },
            onPress: () => switchTab("log"),
          }),
          ui.button({
            id: "tab-settings",
            label: "Settings",
            px: 1,
            focusable: false,
            style: state.activeTab === "settings" ? { bold: true } : { dim: true },
            onPress: () => switchTab("settings"),
          }),
          ui.button({
            id: "tab-issues",
            label: t("gh_tui_tab_title"),
            px: 1,
            focusable: false,
            style: state.activeTab === "issues" ? { bold: true } : { dim: true },
            onPress: () => switchTab("issues"),
          }),
          ui.button({
            id: "tab-metrics",
            label: t("metrics_tab_title"),
            px: 1,
            focusable: false,
            style: state.activeTab === "metrics" ? { bold: true } : { dim: true },
            onPress: () => switchTab("metrics"),
          }),
        ]),
        ui.column({ gap: 0 },
          state.activeTab === "journal"
            ? (() => {
                // 逆順表示: 最新が先頭、offset=0 で最新を表示
                const reversed = [...state.journalEntries].reverse();
                const total = reversed.length;
                const startIdx = Math.min(state.journalScrollOffset, Math.max(0, total - JOURNAL_VISIBLE_LINES));
                const endIdx = Math.min(startIdx + JOURNAL_VISIBLE_LINES, total);
                return buildJournalRows(reversed.slice(startIdx, endIdx), repoUrl);
              })()
            : state.activeTab === "artifacts"
            ? buildArtifactRows(state)
            : state.activeTab === "settings"
            ? buildSettingsRows(state)
            : state.activeTab === "issues"
            ? buildIssueRows(state)
            : state.activeTab === "metrics"
            ? (() => {
                const rows = buildMetricsRows(
                  state.metricsData,
                  state.metricsError,
                  state.metricsStatusMessage,
                );
                const total = rows.length;
                const visible = getMetricsVisibleLines();
                const startIdx = Math.min(
                  state.metricsScrollOffset,
                  Math.max(0, total - visible),
                );
                const endIdx = Math.min(startIdx + visible, total);
                return rows.slice(startIdx, endIdx);
              })()
            : (() => {
                // 逆順表示: 最新が先頭、offset=0 で最新を表示
                const reversed = [...state.logLines].reverse();
                const total = reversed.length;
                const startIdx = Math.min(state.logScrollOffset, Math.max(0, total - LOG_VISIBLE_LINES));
                const endIdx = Math.min(startIdx + LOG_VISIBLE_LINES, total);
                return buildLogRows(reversed.slice(startIdx, endIdx));
              })()
        ),
      ]),
      footer: ui.statusBar({
        left: state.confirmingFullQuit
          ? [
              ui.text("Full quit: close all surfaces and shut down?", { bold: true }),
              ui.kbd("Y"),
              ui.text("yes"),
              ui.kbd("n"),
              ui.text("cancel"),
            ]
          : state.focusedArea === "tasks"
          ? [
              ui.kbd("↑/↓"), ui.text("scroll"),
              ui.kbd("Enter"), ui.text("open"),
              ui.kbd("J"), ui.text("journal"),
              ui.kbd("A"), ui.text("artifacts"),
              ui.kbd("L"), ui.text("log"),
              ui.kbd("ESC"), ui.text("back"),
            ]
          : state.focusedArea === "journal"
          ? [
              ui.kbd("↑/↓"), ui.text("scroll"),
              ui.kbd("g/Ctrl+G"), ui.text("top/bottom"),
              ui.kbd("A"), ui.text("artifacts"),
              ui.kbd("L"), ui.text("log"),
              ui.kbd("ESC"), ui.text("back"),
            ]
          : state.focusedArea === "log"
          ? [
              ui.kbd("↑/↓"), ui.text("scroll"),
              ui.kbd("g/Ctrl+G"), ui.text("top/bottom"),
              ui.kbd("J"), ui.text("journal"),
              ui.kbd("A"), ui.text("artifacts"),
              ui.kbd("ESC"), ui.text("back"),
            ]
          : state.focusedArea === "artifacts"
          ? [
              ui.kbd("↑/↓"), ui.text("select"),
              ui.kbd("Enter"), ui.text("open"),
              ui.kbd("s"), ui.text(`sort:${state.artifactSort}`),
              ui.kbd("f"), ui.text(state.artifactTypeFilter ? `type:${state.artifactTypeFilter}` : "filter"),
              ui.kbd("J"), ui.text("journal"),
              ui.kbd("L"), ui.text("log"),
              ui.kbd("ESC"), ui.text("back"),
            ]
          : state.focusedArea === "settings"
          ? [
              ui.kbd("↑/↓"), ui.text("select"),
              ui.kbd("Enter"), ui.text("open"),
              ui.kbd("J"), ui.text("journal"),
              ui.kbd("A"), ui.text("artifacts"),
              ui.kbd("L"), ui.text("log"),
              ui.kbd("ESC"), ui.text("back"),
            ]
          : state.activeTab === "issues"
          ? [
              ui.kbd("↑/↓"), ui.text("select"),
              ui.kbd("Enter/O"), ui.text("view"),
              ui.kbd("Ctrl+R"), ui.text("sync"),
              ui.kbd("B"), ui.text("browser"),
              ui.kbd("J"), ui.text("journal"),
              ui.kbd("ESC"), ui.text("back"),
            ]
          : state.focusedArea === "metrics"
          ? [
              ui.kbd("↑/↓"), ui.text("scroll"),
              ui.kbd("g/Ctrl+G"), ui.text("top/bottom"),
              ui.kbd("O"), ui.text(t("metrics_open_browser_hint")),
              ui.kbd("J"), ui.text("journal"),
              ui.kbd("A"), ui.text("artifacts"),
              ui.kbd("L"), ui.text("log"),
              ui.kbd("I"), ui.text("issues"),
              ui.kbd("ESC"), ui.text("back"),
            ]
          : [ // global
              ui.kbd("T"), ui.text("tasks"),
              ui.kbd("J"), ui.text("journal"),
              ui.kbd("L"), ui.text("log"),
              ui.kbd("A"), ui.text("artifacts"),
              ui.kbd("4"), ui.text("settings"),
              ui.kbd("5"), ui.text("issues"),
              ui.kbd("M"), ui.text("metrics"),
              ui.kbd("r"), ui.text("reload"),
              ui.kbd("q"), ui.text("quit"),
              ui.kbd("Ctrl+Q"), ui.text("full quit"),
            ],
      }),
    });
  }

  app.view(buildViewWithApp);

  // タブ切り替えヘルパー: activeTab と focusedArea をタブ軸で同期させる
  type TabId = AppState["activeTab"];
  const FOCUSED_AREA_FOR_TAB: Record<TabId, AppState["focusedArea"]> = {
    journal: "journal",
    artifacts: "artifacts",
    log: "log",
    settings: "settings",
    issues: "issues",
    metrics: "metrics",
  };
  // D17: refresh() が settings 再読み込みすべきかどうか判定するためのミラー
  let currentActiveTab: TabId = "journal";
  function switchTab(tab: TabId) {
    try {
      currentActiveTab = tab;
      app.update((s) => ({ ...s, activeTab: tab, focusedArea: FOCUSED_AREA_FOR_TAB[tab] }));
      // settings に切り替えた直後は即時ロード
      if (tab === "settings") {
        refresh().catch(() => {});
      }
      // issues に切り替えたら cache から即時ロード
      if (tab === "issues") {
        loadIssuesFromCache().catch(() => {});
      }
      // metrics に切り替えたら 1s interval で loadMetricsData を起動、他タブに切ったら stop
      if (tab === "metrics") {
        startMetricsTimer();
      } else {
        stopMetricsTimer();
      }
    } catch {}
  }

  // キーバインド
  app.keys({
    Up: () => app.update((s) => {
      switch (s.focusedArea) {
        case "tasks":
          return { ...s, taskCursor: Math.max(s.taskCursor - 1, 0) };
        case "journal": {
          // Up = 新しい方へ（offset 減少）
          const newOffset = Math.max(s.journalScrollOffset - 1, 0);
          return { ...s, journalScrollOffset: newOffset, journalAutoScroll: newOffset === 0 };
        }
        case "log": {
          // Up = 新しい方へ（offset 減少）
          const newOffset = Math.max(s.logScrollOffset - 1, 0);
          return { ...s, logScrollOffset: newOffset, logAutoScroll: newOffset === 0 };
        }
        case "artifacts": {
          return { ...s, artifactCursor: Math.max(s.artifactCursor - 1, 0) };
        }
        case "settings": {
          // section 項目はスキップ（preview が出ないので cursor を合わせる意味がない）
          let c = s.settingsCursor - 1;
          while (c >= 0 && s.settingsItems[c]?.kind === "section") c--;
          return { ...s, settingsCursor: Math.max(c, 0) };
        }
        case "issues": {
          return { ...s, issueCursor: Math.max(s.issueCursor - 1, 0) };
        }
        case "metrics": {
          return { ...s, metricsScrollOffset: Math.max(s.metricsScrollOffset - 1, 0) };
        }
        default:
          return s;
      }
    }),
    Down: () => app.update((s) => {
      switch (s.focusedArea) {
        case "tasks":
          return { ...s, taskCursor: Math.min(s.taskCursor + 1, Math.max(s.daemon.taskList.length - 1, 0)) };
        case "journal": {
          // Down = 古い方へ（offset 増加）
          const maxOffset = Math.max(0, s.journalEntries.length - JOURNAL_VISIBLE_LINES);
          return { ...s, journalScrollOffset: Math.min(s.journalScrollOffset + 1, maxOffset), journalAutoScroll: false };
        }
        case "log": {
          // Down = 古い方へ（offset 増加）
          const maxOffset = Math.max(0, s.logLines.length - LOG_VISIBLE_LINES);
          return { ...s, logScrollOffset: Math.min(s.logScrollOffset + 1, maxOffset), logAutoScroll: false };
        }
        case "artifacts": {
          const filtered = getFilteredArtifacts(s);
          return { ...s, artifactCursor: Math.min(s.artifactCursor + 1, filtered.length - 1) };
        }
        case "settings": {
          const max = s.settingsItems.length - 1;
          let c = s.settingsCursor + 1;
          while (c <= max && s.settingsItems[c]?.kind === "section") c++;
          return { ...s, settingsCursor: Math.min(c, max) };
        }
        case "issues": {
          const max = Math.max(s.issueItems.length - 1, 0);
          return { ...s, issueCursor: Math.min(s.issueCursor + 1, max) };
        }
        case "metrics": {
          // T354 S11: maxOffset で clamp（buildMetricsRows は dashboard.tsx 側で保持する
          // metricsData/metricsError から都度組み立てて長さを推定する）。
          const rows = buildMetricsRows(
            s.metricsData,
            s.metricsError,
            s.metricsStatusMessage,
          );
          const maxOffset = Math.max(0, rows.length - getMetricsVisibleLines());
          return {
            ...s,
            metricsScrollOffset: Math.min(s.metricsScrollOffset + 1, maxOffset),
          };
        }
        default:
          return s;
      }
    }),
    "1": () => switchTab("journal"),
    "2": () => switchTab("artifacts"),
    "3": () => switchTab("log"),
    "4": () => switchTab("settings"),
    "5": () => switchTab("issues"),
    "6": () => switchTab("metrics"),
    Tab: (ctx) => {
      const tabs: AppState["activeTab"][] = ["journal", "artifacts", "log", "settings", "issues", "metrics"];
      const idx = tabs.indexOf(ctx.state.activeTab);
      const next = tabs[(idx + 1) % tabs.length]!;
      switchTab(next);
    },
    T: () => app.update((s) => ({ ...s, focusedArea: "tasks" })),
    J: () => switchTab("journal"),
    L: () => switchTab("log"),
    A: () => switchTab("artifacts"),
    I: () => switchTab("issues"),
    M: () => switchTab("metrics"),
    "ctrl+r": (ctx) => {
      if (ctx.state.activeTab !== "issues") return;
      syncIssuesFromGh().catch((e: any) => {
        log("issues_sync_error", e?.message ?? String(e)).catch(() => {});
      });
    },
    B: (ctx) => {
      if (ctx.state.activeTab !== "issues") return;
      const item = ctx.state.issueItems[ctx.state.issueCursor];
      if (!item?.issue.html_url) return;
      try {
        Bun.spawn(["open", item.issue.html_url], { stdio: ["ignore", "ignore", "ignore"] });
      } catch (e: any) {
        log("issues_open_browser_failed", e?.message ?? String(e)).catch(() => {});
      }
    },
    O: (ctx) => {
      // T415: Issues タブと Metrics タブで共有される大文字 O キー。activeTab で分岐。
      if (ctx.state.activeTab === "issues") {
        openSelectedIssueInViewer(ctx.state).catch((e: any) => {
          log("viewer_error", e?.message ?? String(e)).catch(() => {});
        });
        return;
      }
      if (ctx.state.activeTab === "metrics") {
        const url = ctx.state.metricsData?.dashboardServerUrl ?? null;
        const r = openDashboardUrlInBrowser(url);
        if (!r.ok) {
          const msg =
            r.reason === "no_url"
              ? t("metrics_url_not_running")
              : `open failed: ${r.reason ?? ""}`;
          log(
            "metrics_open_browser_failed",
            `reason=${r.reason ?? ""} url=${url ?? ""}`,
          ).catch(() => {});
          app.update((s) => ({ ...s, metricsStatusMessage: msg }));
        }
        return;
      }
    },
    // Artifacts タブ専用キー
    Enter: (ctx) => {
      const currentState = ctx.state;
      // tasks タブ: 選択中タスクをビューアで開く
      if (currentState.focusedArea === "tasks") {
        const { taskList } = currentState.daemon;
        const selected = taskList[currentState.taskCursor];
        if (!selected?.filePath) return;

        openArtifactInViewer(
          app,
          selected.filePath,
          () => {
            dashboardActive = true;
            spinnerInterval = setInterval(() => {
              try { app.update((s) => ({ ...s, spinnerFrame: s.spinnerFrame + 1 })); } catch {}
            }, SPINNER_INTERVAL);
            refresh();
          },
        ).catch((e: any) => { log("viewer_error", e?.message ?? String(e)).catch(() => {}); });
        return;
      }
      // settings タブ: 選択中 overlay をビューアで開く
      if (currentState.focusedArea === "settings") {
        const item = currentState.settingsItems[currentState.settingsCursor];
        if (!item || item.kind !== "overlay" || !item.exists) return;

        openArtifactInViewer(
          app,
          item.filePath,
          () => {
            dashboardActive = true;
            spinnerInterval = setInterval(() => {
              try { app.update((s) => ({ ...s, spinnerFrame: s.spinnerFrame + 1 })); } catch {}
            }, SPINNER_INTERVAL);
            refresh();
          },
        ).catch((e: any) => { log("viewer_error", e?.message ?? String(e)).catch(() => {}); });
        return;
      }
      // issues タブ: 選択中 issue を formatIssueShow でビューアに表示
      if (currentState.focusedArea === "issues") {
        openSelectedIssueInViewer(currentState).catch((e: any) => {
          log("viewer_error", e?.message ?? String(e)).catch(() => {});
        });
        return;
      }

      if (currentState.focusedArea !== "artifacts") return;
      const filtered = getFilteredArtifacts(currentState);
      if (filtered.length === 0) return;
      const selected = filtered[currentState.artifactCursor];
      if (!selected) return;

      openArtifactInViewer(
        app,
        selected.filePath,
        () => {
          dashboardActive = true;
          spinnerInterval = setInterval(() => {
            try { app.update((s) => ({ ...s, spinnerFrame: s.spinnerFrame + 1 })); } catch {}
          }, SPINNER_INTERVAL);
          refresh();
        },
      ).catch((e: any) => { log("viewer_error", e?.message ?? String(e)).catch(() => {}); });
    },
    g: () => app.update((s) => {
      // g = 先頭（最新）へ、autoScroll ON
      if (s.focusedArea === "journal") {
        return { ...s, journalScrollOffset: 0, journalAutoScroll: true };
      }
      if (s.focusedArea === "log") {
        return { ...s, logScrollOffset: 0, logAutoScroll: true };
      }
      if (s.focusedArea === "metrics") {
        return { ...s, metricsScrollOffset: 0 };
      }
      return s;
    }),
    "ctrl+g": () => app.update((s) => {
      // G = 末尾（最古）へ、autoScroll OFF
      if (s.focusedArea === "journal") {
        const maxOffset = Math.max(0, s.journalEntries.length - JOURNAL_VISIBLE_LINES);
        return { ...s, journalScrollOffset: maxOffset, journalAutoScroll: false };
      }
      if (s.focusedArea === "log") {
        const maxOffset = Math.max(0, s.logLines.length - LOG_VISIBLE_LINES);
        return { ...s, logScrollOffset: maxOffset, logAutoScroll: false };
      }
      if (s.focusedArea === "metrics") {
        const rows = buildMetricsRows(
          s.metricsData,
          s.metricsError,
          s.metricsStatusMessage,
        );
        const maxOffset = Math.max(0, rows.length - getMetricsVisibleLines());
        return { ...s, metricsScrollOffset: maxOffset };
      }
      return s;
    }),
    s: () => app.update((s) => {
      if (s.focusedArea !== "artifacts") return s;
      const sorts: AppState["artifactSort"][] = ["id", "created", "updated"];
      const idx = sorts.indexOf(s.artifactSort);
      return { ...s, artifactSort: sorts[(idx + 1) % sorts.length]!, artifactCursor: 0 };
    }),
    f: () => app.update((s) => {
      if (s.focusedArea !== "artifacts") return s;
      const types = [null, "research", "decision", "session", "spec", "report"];
      const idx = types.indexOf(s.artifactTypeFilter);
      return { ...s, artifactTypeFilter: types[(idx + 1) % types.length]!, artifactCursor: 0 };
    }),
    r: (ctx) => { if (ctx.state.focusedArea === "global") opts?.onReload?.(); },
    q: (ctx) => {
      if (ctx.state.focusedArea !== "global") return;
      cleanup();
      opts?.onQuit?.();
    },
    "ctrl+q": (ctx) => {
      if (ctx.state.focusedArea !== "global") return;
      confirmingFullQuit = true;
      app.update((s) => ({ ...s, confirmingFullQuit: true }));
    },
    Y: () => {
      if (confirmingFullQuit) {
        cleanup();
        opts?.onFullQuit?.();
      }
    },
    n: () => {
      confirmingFullQuit = false;
      app.update((s) => ({ ...s, confirmingFullQuit: false }));
    },
    Escape: () => {
      confirmingFullQuit = false;
      app.update((s) => ({ ...s, confirmingFullQuit: false, focusedArea: "global" }));
    },
  });

  appInstance = app;

  // --- gh-cache Issues タブ用ヘルパ (T272 Phase 3) ---

  /**
   * キャッシュ DB から issue/PR 一覧を読み出して state に反映する。
   * 非 git / 認証なしの場合は availability を更新して早期 return する。
   */
  async function loadIssuesFromCache(): Promise<void> {
    const projectRoot = getState().projectRoot;
    try {
      const repoInfo = await resolveOriginRepo(projectRoot);
      if (!repoInfo) {
        app.update((s) => ({ ...s, issuesAvailability: "non_git" }));
        return;
      }
      const auth = await resolveGithubToken(repoInfo.host);
      if (!auth.token) {
        app.update((s) => ({ ...s, issuesAvailability: "no_auth" }));
        return;
      }
      const db = openGhCacheDB(projectRoot, repoInfo, tokenHash(auth.token));
      try {
        const rows = listIssues(db, { state: "open", limit: 100 });
        const items: IssueListItem[] = rows.map((r) => ({
          issue: r,
          labels: getIssueLabels(db, r.number),
          assignees: getIssueAssignees(db, r.number),
        }));
        const meta = getSyncMeta(db);
        app.update((s) => ({
          ...s,
          issuesAvailability: "available",
          issueItems: items,
          issueCursor: Math.min(s.issueCursor, Math.max(items.length - 1, 0)),
          issueLastSync: meta?.last_incremental_sync ?? meta?.last_full_sync ?? null,
          issueLastError: null,
        }));
      } finally {
        db.close();
      }
    } catch (e: any) {
      log("issues_load_error", e?.message ?? String(e)).catch(() => {});
      app.update((s) => ({
        ...s,
        issueLastError: e?.message ?? String(e),
      }));
    }
  }

  // ── Metrics タブ (T307) ────────────────────────────────────────────────
  //
  // Rec #1 反映: DB 接続は daemon の `state.traceDb` をそのまま reuse する。
  // dashboard は `startDashboard(() => state, ...)` 経由で daemon と同一プロセス
  // 内 inline 実行 (main.ts:706 / `config: { executionMode: "inline" }`) されて
  // おり、`state.traceDb` は writer として確立済み。毎秒 open/close する代わりに
  // 同じハンドルで read する（better-sqlite3 / bun:sqlite は同プロセス内の
  // multi-statement 使用が安全）。plan.md Decision D9 の旧根拠「別プロセス想定」は
  // 事実と食い違っていたため Rec #1 に従い reuse 方式に倒した。
  // T354: METRICS_POLL_INTERVAL_MS は config 化された（resolveMetricsRefreshIntervalMs）。
  // T415: aggregateApiUsageByRole/Task は Web ダッシュボードに移管されたため
  // METRICS_TASK_TOP_N / METRICS_WINDOW_MS は本ファイルで不要になった。

  /**
   * T354 S10: token pool 有効時の selectable token 一覧を PoolTokenRow[] に組み立てる。
   * pool 無効 / state.tokenDb=null なら null を返す（dashboard-metrics 側で section 自体を非表示）。
   */
  function buildPoolTokenRows(daemon: DaemonState, projectConfig: TeamConfig): PoolTokenRow[] | null {
    if (!daemon.tokenDb || daemon.pool === null) return null;
    const policy = resolveProjectTokenPool(projectConfig);
    try {
      const tokens = listTokens(daemon.tokenDb, { selectableOnly: true });
      // include で強制候補化された handle を別途取得（selectableOnly=false で全件 → include だけ抽出）
      const includeSet = new Set(policy.include);
      const excludeSet = new Set(policy.exclude);
      let candidates = tokens.filter((t) => !excludeSet.has(t.handle));
      if (includeSet.size > 0) {
        const all = listTokens(daemon.tokenDb, { selectableOnly: false });
        for (const tok of all) {
          if (
            includeSet.has(tok.handle) &&
            !excludeSet.has(tok.handle) &&
            !candidates.find((c) => c.handle === tok.handle)
          ) {
            candidates.push(tok);
          }
        }
      }

      const now = Date.now();
      const rows: PoolTokenRow[] = candidates.map((tok) => {
        const snap = getLatestUsageSnapshot(daemon.tokenDb!, tok.id);
        return buildPoolTokenRowFromSnapshot(tok.handle, snap, now);
      });
      // util_5h DESC、同 util は handle ASC（plan §2-5 / S14 確認順）
      rows.sort((a, b) => {
        const av = a.util5h ?? -1;
        const bv = b.util5h ?? -1;
        if (av !== bv) return bv - av;
        return a.handle.localeCompare(b.handle);
      });
      return rows;
    } catch (e: any) {
      log("metrics_pool_load_error", e?.message ?? String(e)).catch(() => {});
      return [];
    }
  }

  function loadMetricsData(): void {
    const daemon = getState();
    const db = daemon.traceDb;
    if (!db) {
      app.update((s) => ({
        ...s,
        metricsData: {
          nowMs: Date.now(),
          projection5h: null,
          projection7d: null,
          poolTokens: null,
          dashboardServerUrl: daemon.dashboardServerUrl ?? null,
          latestRowRole: null,
          latestRowSurface: null,
          latestRowTimestampMs: null,
        },
        metricsError: null,
        // T415: 次の tick で statusMessage は自動クリア（D6 / R6）
        metricsStatusMessage: null,
        metricsLastLoadedMs: Date.now(),
      }));
      return;
    }

    try {
      const now = Date.now();

      const latest = getLatestApiUsageRow(db);
      const projection5h = getProjection5h(db, now);
      const projection7d = getProjection7d(db, now);

      const latestTsMs = latest?.timestamp
        ? Date.parse(latest.timestamp)
        : null;

      const poolTokens = buildPoolTokenRows(daemon, cachedConfig);

      const metrics: MetricsData = {
        nowMs: now,
        projection5h,
        projection7d,
        poolTokens,
        dashboardServerUrl: daemon.dashboardServerUrl ?? null,
        latestRowRole: latest?.role ?? null,
        latestRowSurface: latest?.surface ?? null,
        latestRowTimestampMs:
          latestTsMs !== null && !Number.isNaN(latestTsMs) ? latestTsMs : null,
      };

      app.update((s) => ({
        ...s,
        metricsData: metrics,
        metricsError: null,
        // T415: 次の tick で statusMessage は自動クリア（D6 / R6）
        metricsStatusMessage: null,
        metricsLastLoadedMs: now,
      }));
    } catch (e: any) {
      // D10: stale-while-error — 既存 metricsData は残し error のみ差し替える
      log("metrics_load_error", e?.message ?? String(e)).catch(() => {});
      app.update((s) => ({
        ...s,
        metricsError: e?.message ?? String(e),
      }));
    }
  }

  function startMetricsTimer(): void {
    stopMetricsTimer();
    // 即時 1 回
    try { loadMetricsData(); } catch {}
    // T354: cachedConfig を使う（Manager 再起動を伴わない config 切替には追従しない）。
    const intervalMs = resolveMetricsRefreshIntervalMs(cachedConfig);
    metricsInterval = setInterval(() => {
      try { loadMetricsData(); } catch {}
    }, intervalMs);
  }

  function stopMetricsTimer(): void {
    if (metricsInterval) {
      clearInterval(metricsInterval);
      metricsInterval = null;
    }
  }

  /**
   * incremental sync を走らせてから再ロードする。
   * R キーから呼ばれる。rate limit 到達時はエラー表示のみ。
   */
  async function syncIssuesFromGh(): Promise<void> {
    const projectRoot = getState().projectRoot;
    const repoInfo = await resolveOriginRepo(projectRoot);
    if (!repoInfo) {
      app.update((s) => ({ ...s, issuesAvailability: "non_git" }));
      return;
    }
    const auth = await resolveGithubToken(repoInfo.host);
    if (!auth.token) {
      app.update((s) => ({ ...s, issuesAvailability: "no_auth" }));
      return;
    }
    app.update((s) => ({ ...s, issueSyncing: true, issueLastError: null }));
    const db = openGhCacheDB(projectRoot, repoInfo, tokenHash(auth.token));
    try {
      await syncIncremental({
        db,
        repoInfo,
        auth: { ...auth, token: auth.token },
      });
      app.update((s) => ({ ...s, issueSyncing: false }));
    } catch (e: any) {
      const msg =
        e instanceof RateLimitExhaustedError
          ? `rate limit: remaining=${e.rateLimit.remaining ?? "?"} reset=${e.rateLimit.resetAt ?? "?"}`
          : e?.message ?? String(e);
      app.update((s) => ({ ...s, issueSyncing: false, issueLastError: msg }));
    } finally {
      db.close();
    }
    await loadIssuesFromCache();
  }

  /**
   * 選択中 issue を formatIssueShow でファイルに吐き、openArtifactInViewer で開く。
   */
  async function openSelectedIssueInViewer(state: AppState): Promise<void> {
    const item = state.issueItems[state.issueCursor];
    if (!item) return;
    const { formatIssueShow } = await import("./gh-cache-format");
    const { getIssueComments, getPrReviews, getPrReviewComments } = await import(
      "./gh-cache-store"
    );
    const projectRoot = getState().projectRoot;
    const repoInfo = await resolveOriginRepo(projectRoot);
    if (!repoInfo) return;
    const auth = await resolveGithubToken(repoInfo.host);
    if (!auth.token) return;
    const db = openGhCacheDB(projectRoot, repoInfo, tokenHash(auth.token));
    let content: string;
    try {
      const comments = getIssueComments(db, item.issue.number);
      const rel: any = {
        issue: item.issue,
        labels: item.labels,
        assignees: item.assignees,
        comments,
      };
      if (item.issue.type === "pr") {
        rel.reviews = getPrReviews(db, item.issue.number);
        rel.reviewComments = getPrReviewComments(db, item.issue.number);
      }
      content = formatIssueShow(rel);
    } finally {
      db.close();
    }
    const tmpPath = join(tmpdir(), `cmux-team-issue-${item.issue.number}.md`);
    await writeFile(tmpPath, content, "utf-8");
    await openArtifactInViewer(app, tmpPath, () => {
      dashboardActive = true;
      spinnerInterval = setInterval(() => {
        try {
          app.update((s) => ({ ...s, spinnerFrame: s.spinnerFrame + 1 }));
        } catch {}
      }, SPINNER_INTERVAL);
      refresh();
    });
  }

  // 2000ms ごとに状態更新
  const refresh = async () => {
    const newDaemon = getState();
    const lines = await readLogLines(newDaemon.projectRoot);
    const journalEntries = parseJournalEntries(lines);
    const repoUrl = await resolveGitHubRepoUrl(newDaemon.projectRoot);
    const artifacts = await loadArtifacts(newDaemon.projectRoot);

    // D17: Settings タブ表示中のみ overlay/config を再読み込み
    const settingsItems = currentActiveTab === "settings"
      ? await loadSettingsItems(newDaemon.projectRoot)
      : null;
    // T354: Settings 表示中は cachedConfig も同期して Metrics の interval / pool token
    //       フィルタが反映されるようにする。
    if (currentActiveTab === "settings") {
      try {
        cachedConfig = await loadConfig(newDaemon.projectRoot);
      } catch {}
    }

    try {
      app.update((s) => {
        // フォーカス中は自動スクロールしない
        const journalAuto = s.journalAutoScroll && s.focusedArea !== "journal";
        const logAuto = s.logAutoScroll && s.focusedArea !== "log";

        // 自動スクロール OFF 時: 新エントリ分だけ offset を増加して表示位置を保持
        const journalDelta = journalEntries.length - s.journalEntries.length;
        const logDelta = lines.length - s.logLines.length;

        // settings 再読み込みは activeTab === "settings" のときのみ
        const nextSettingsItems = s.activeTab === "settings" && settingsItems
          ? settingsItems
          : s.settingsItems;
        const nextSettingsCursor = Math.min(
          s.settingsCursor,
          Math.max(nextSettingsItems.length - 1, 0),
        );

        return {
          ...s,
          daemon: newDaemon,
          logLines: lines,
          journalEntries,
          repoUrl,
          artifacts,
          journalScrollOffset: journalAuto ? 0 : s.journalScrollOffset + Math.max(0, journalDelta),
          logScrollOffset: logAuto ? 0 : s.logScrollOffset + Math.max(0, logDelta),
          taskCursor: Math.min(s.taskCursor, Math.max(newDaemon.taskList.length - 1, 0)),
          settingsItems: nextSettingsItems,
          settingsCursor: nextSettingsCursor,
        };
      });
    } catch (e: any) {
      // lifecycle operation already in flight — skip this tick
      log("dashboard_update_error", e?.message ?? String(e)).catch(() => {});
    }
  };

  try {
    await app.start();
  } catch (e: any) {
    cleanup();
    console.error(t("dashboard_startup_failed", { message: e.message }));
    console.error(t("dashboard_startup_hint"));
    return { scheduleRefresh: () => {} };
  }

  // app.start() 完了後に spinner を開始（start 中に update すると lifecycle error）
  // refresh は daemon の tick 後に scheduleRefresh 経由で呼ばれる（ポーリング不要）
  dashboardActive = true;
  let wasAnimating = false;

  spinnerInterval = setInterval(() => {
    try {
      const daemon = getState();
      const needsAnimation =
        [...daemon.masters.values()].some(m => m.status === "running") ||
        [...daemon.conductors.values()].some(c => c.status === "running" || c.status === "starting" || c.status === "assigning") ||
        // T236: Conductor が idle でも Agent のみ running/starting の状況で spinner フレームを前進させる
        [...daemon.conductors.values()].some(c => (c.agents ?? []).some(a => a.status === "running" || a.status === "starting"));

      if (needsAnimation) {
        wasAnimating = true;
        app.update((s) => ({ ...s, daemon, spinnerFrame: s.spinnerFrame + 1 }));
      } else if (wasAnimating) {
        // アニメーション → idle 遷移時: 最後の1回で idle 状態を反映
        wasAnimating = false;
        app.update((s) => ({ ...s, daemon }));
      }
    } catch {}
  }, SPINNER_INTERVAL);
  refresh();

  // debounce 付き refresh スケジューラ（daemon の state 変更時に呼ばれる）
  let refreshDebounce: ReturnType<typeof setTimeout> | null = null;
  const scheduleRefresh = () => {
    if (!dashboardActive) return;
    if (refreshDebounce) return;
    refreshDebounce = setTimeout(() => {
      refreshDebounce = null;
      if (dashboardActive) refresh().catch(() => {});
    }, 100);
  };

  // eventBus: 実 state mutation 直後の即時 TUI refresh
  if (eventBusUnsubscribe) {
    eventBusUnsubscribe();
    eventBusUnsubscribe = null;
  }
  eventBusUnsubscribe = onStateChanged(() => scheduleRefresh());

  return { scheduleRefresh };
}

function cleanup() {
  dashboardActive = false;
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
  if (eventBusUnsubscribe) {
    eventBusUnsubscribe();
    eventBusUnsubscribe = null;
  }
}

export function unmountDashboard(): void {
  cleanup();
  if (appInstance) {
    appInstance.stop();
    appInstance = null;
  }
}
