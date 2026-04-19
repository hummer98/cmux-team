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
import { onStateChanged } from "./eventBus";
import { buildRateLimitDisplay, type RateLimitColor } from "./rate-limit-display";
import { isStale5h } from "./rate-limit-persistence";
import { t } from "./i18n";
import { loadArtifacts } from "./artifact";
import type { ArtifactMeta } from "./artifact";
import { listProjectInstructions, readProjectInstructions } from "./agent-instructions";
import { loadConfig, type TeamConfig } from "./config";
import type { AgentRole } from "./schema";
import { AGENT_ROLES } from "./schema";
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

const LOG_VISIBLE_LINES = 30;
const TASK_VISIBLE_LINES = 5;
const JOURNAL_VISIBLE_LINES = 30;
const ARTIFACT_VISIBLE_LINES = 12;
const SETTINGS_PREVIEW_LINES = 20;

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

let spinnerTick = 0;

// --- ジャーナルエントリ ---

interface JournalEntry {
  time: string;  // HH:MM:SS
  icon: string;  // Nerd Font アイコン or フォールバック
  taskId: string;
  message: string;
  level: "info" | "warn" | "error";
  surface?: string;    // surface 名（dim 表示用）
  iconColor?: number;  // アイコンの色を直接保持
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

function parseJournalEntries(lines: string[]): JournalEntry[] {
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
  items.push({ kind: "config", label: "layout", value: cfg.layout ?? "wide (default)" });
  items.push({
    kind: "config",
    label: "autoUpdate",
    value: typeof cfg.autoUpdate === "boolean"
      ? (cfg.autoUpdate ? "task (legacy true)" : "off (legacy false)")
      : (cfg.autoUpdate ?? "off (default)"),
  });
  items.push({ kind: "config", label: "mainBranch", value: cfg.mainBranch ?? "(unresolved)" });
  items.push({
    kind: "config",
    label: "sleepPrevention",
    value: cfg.sleepPrevention === false ? "false" : "true (default)",
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
      role: AgentRole;
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
  activeTab: "journal" | "artifacts" | "log" | "settings" | "issues";
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
  focusedArea: "global" | "tasks" | "journal" | "log" | "artifacts" | "settings" | "issues";
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

function buildMasterSection(state: DaemonState) {
  const masters = [...state.masters.values()];
  if (masters.length === 0) {
    return ui.row({ gap: 1 }, [
      ui.text("○", { style: { fg: GRAY } }),
      ui.text("not spawned", { style: { fg: GRAY } }),
    ]);
  }

  // 複数 Master 表示: 各 Master を縦に並べる。1 つのみの場合も同じ経路で出す。
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

function buildConductorRow(c: ConductorState & { agents: AgentState[]; status: string }, repoUrl: string | null, spinnerFrame: number = 0) {
  const isStarting = c.status === "starting";
  const isAssigning = c.status === "assigning";
  const isIdle = c.status === "idle";
  const isDisconnected = c.status === "disconnected";
  const isBroken = c.status === "broken";
  const isAsking = c.status === "asking";
  const elapsed = formatElapsed(c.startedAt);
  const surface = c.surface.replace("surface:", "");

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
    const isAgentAsking = a.status === "asking";
    const isAgentRunning = a.status === "running" || a.status === "starting";
    if (isAgentAsking) {
      children.push(
        ui.row({ gap: 1 }, [
          ui.text(`   ${prefix}`, { dim: true }),
          ui.text(`[${a.surface.replace("surface:", "")}]`, { style: { fg: YELLOW } }),
          ui.text("?", { style: { fg: YELLOW } }),
          ui.text(`${roleIcon} ${label}`, { style: { fg: YELLOW } }),
        ])
      );
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
      children.push(
        ui.row({ gap: 1 }, [
          ui.text(`   ${prefix}`, { dim: true }),
          ui.text(`[${a.surface.replace("surface:", "")}]`, { style: { fg: CYAN } }),
          ui.text(`${roleIcon} ${label}`, { dim: true }),
        ])
      );
    }
  }

  return ui.column({ gap: 0 }, children);
}

function buildConductorsSection(state: DaemonState, repoUrl: string | null, spinnerFrame: number = 0) {
  const conductors = [...state.conductors.values()];
  if (conductors.length === 0) {
    return ui.text("idle — waiting for tasks", { dim: true });
  }
  return ui.column({ gap: 0 }, conductors.map((c) => buildConductorRow(c as any, repoUrl, spinnerFrame)));
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

  // ボタンモード: ui.button でクリック可能な行を返す
  if (buttonConfig) {
    const branchPart = task.baseBranch ? ` ${nerdIcon("\ue0a0", "⎇")} ${task.baseBranch}` : "";
    const flatLabel = `${icon} ${taskId} ${statusDisplay}${branchPart} ${task.title}${timeInfo ? ` ${timeInfo}` : ""}`;
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
    ]);
  }

  return ui.row({ gap: 1 }, [
    ui.text(icon, mergeStyle(colorStyle)),
    ui.text(taskId, mergeStyle({ bold: !isClosed, ...colorStyle })),
    ui.text(statusDisplay, mergeStyle(colorStyle)),
    branchEl,
    buildTitleWithLinks(task.title, repoUrl, mergeStyle(colorStyle)),
    timeInfo ? ui.text(timeInfo, mergeStyle(colorStyle)) : null,
  ]);
}

// --- Journal/Log テキスト行構築（ui.logsConsole の代替） ---

function buildJournalRows(entries: JournalEntry[], repoUrl: string | null) {
  if (entries.length === 0) {
    return [ui.text("no journal entries", { dim: true })];
  }
  return entries.filter((e) => isValidTaskId(e.taskId)).map((entry) => {
    return ui.row({ gap: 1 }, [
      ui.text(entry.time, { dim: true }),
      ui.text(entry.icon, entry.iconColor ? { style: { fg: entry.iconColor } } : {}),
      ui.text(`T${entry.taskId.padStart(3, "0")}`, { bold: true }),
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
    for (let i = 0; i < state.issueItems.length; i++) {
      const item = state.issueItems[i]!;
      const isSelected = i === state.issueCursor;
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
/** TUI が表示中かどうか（ビューア表示中は false にして app.update を防ぐ） */
let dashboardActive = false;
let eventBusUnsubscribe: (() => void) | null = null;

export async function startDashboard(
  getState: () => DaemonState,
  opts?: { version?: string; onReload?: () => void; onQuit?: () => void; onFullQuit?: () => void }
): Promise<{ scheduleRefresh: () => void }> {
  const daemonState = getState();
  let confirmingFullQuit = false;

  // OSC 8 ハイパーリンクを有効化（ターミナル自動検出に依存せず明示的に設定）
  process.env.REZI_TERMINAL_SUPPORTS_OSC8 = "1";

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
    },
    config: { executionMode: "inline" },
  });

  function buildViewWithApp(state: AppState) {
    const { daemon, repoUrl } = state;
    const startingCount = [...daemon.conductors.values()].filter(c => c.status === "starting").length;
    const assigningCount = [...daemon.conductors.values()].filter(c => c.status === "assigning").length;
    const runningCount = [...daemon.conductors.values()].filter(c => c.status === "running").length;
    const askingCount = [...daemon.conductors.values()].filter(c => c.status === "asking").length;
    const brokenCount = [...daemon.conductors.values()].filter(c => c.status === "broken").length;
    const assignedTaskIds = new Set([...daemon.conductors.values()].map(c => c.taskId));

    // レスポンシブヘッダー
    // スロットリング判定（stale な観測値はガードで除外する）。5h 軸のみを参照する（T281）。
    const isThrottled =
      !isStale5h(daemon.rateLimit) &&
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
          const rl = buildRateLimitDisplay(daemon.rateLimit);
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
        // Update 通知バナー（T187）— updateAvailable が非 null のときのみ挿入
        ...(daemon.updateAvailable
          ? [(() => {
              const ua = daemon.updateAvailable!;
              let suffix: string;
              if (ua.createdTaskId) {
                suffix = `(task created: T${ua.createdTaskId})`;
              } else if (daemon.updateMode === "task") {
                suffix = `(task skipped — check logs)`;
              } else {
                suffix = `(run: cmux-team self-update)`;
              }
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
        sectionTitle(`Conductors${startingCount > 0 ? ` ${startingCount} starting` : ""}${assigningCount > 0 ? ` ${assigningCount} assigning` : ""}${askingCount > 0 ? ` ${askingCount} asking` : ""}${runningCount > 0 ? ` ${runningCount} running` : ""}${brokenCount > 0 ? ` ${brokenCount} broken` : ""}`),
        buildConductorsSection(daemon, repoUrl, state.spinnerFrame),
        // Tasks セクション（クリックでフォーカス）
        ui.button({
          id: "section-tasks",
          label: `─ Tasks ${daemon.openTasks} open ${HR_FILL}`,
          px: 0,
          style: { dim: true },
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
            style: state.activeTab === "journal" ? { bold: true } : { dim: true },
            onPress: () => switchTab("journal"),
          }),
          ui.button({
            id: "tab-artifacts",
            label: "Artifacts",
            px: 1,
            style: state.activeTab === "artifacts" ? { bold: true } : { dim: true },
            onPress: () => switchTab("artifacts"),
          }),
          ui.button({
            id: "tab-log",
            label: "Log",
            px: 1,
            style: state.activeTab === "log" ? { bold: true } : { dim: true },
            onPress: () => switchTab("log"),
          }),
          ui.button({
            id: "tab-settings",
            label: "Settings",
            px: 1,
            style: state.activeTab === "settings" ? { bold: true } : { dim: true },
            onPress: () => switchTab("settings"),
          }),
          ui.button({
            id: "tab-issues",
            label: t("gh_tui_tab_title"),
            px: 1,
            style: state.activeTab === "issues" ? { bold: true } : { dim: true },
            onPress: () => switchTab("issues"),
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
              ui.kbd("g/G"), ui.text("top/bottom"),
              ui.kbd("A"), ui.text("artifacts"),
              ui.kbd("L"), ui.text("log"),
              ui.kbd("ESC"), ui.text("back"),
            ]
          : state.focusedArea === "log"
          ? [
              ui.kbd("↑/↓"), ui.text("scroll"),
              ui.kbd("g/G"), ui.text("top/bottom"),
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
          : state.focusedArea === "issues"
          ? [
              ui.kbd("↑/↓"), ui.text("select"),
              ui.kbd("Enter/O"), ui.text("view"),
              ui.kbd("R"), ui.text("sync"),
              ui.kbd("B"), ui.text("browser"),
              ui.kbd("J"), ui.text("journal"),
              ui.kbd("ESC"), ui.text("back"),
            ]
          : [ // global
              ui.kbd("T"), ui.text("tasks"),
              ui.kbd("J"), ui.text("journal"),
              ui.kbd("L"), ui.text("log"),
              ui.kbd("A"), ui.text("artifacts"),
              ui.kbd("4"), ui.text("settings"),
              ui.kbd("5"), ui.text("issues"),
              ui.kbd("r"), ui.text("reload"),
              ui.kbd("q"), ui.text("quit"),
              ui.kbd("Q"), ui.text("full quit"),
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
        default:
          return s;
      }
    }),
    "1": () => switchTab("journal"),
    "2": () => switchTab("artifacts"),
    "3": () => switchTab("log"),
    "4": () => switchTab("settings"),
    "5": () => switchTab("issues"),
    Tab: (ctx) => {
      const tabs: AppState["activeTab"][] = ["journal", "artifacts", "log", "settings", "issues"];
      const idx = tabs.indexOf(ctx.state.activeTab);
      const next = tabs[(idx + 1) % tabs.length]!;
      switchTab(next);
    },
    T: () => app.update((s) => ({ ...s, focusedArea: "tasks" })),
    J: () => switchTab("journal"),
    L: () => switchTab("log"),
    A: () => switchTab("artifacts"),
    I: () => switchTab("issues"),
    R: (ctx) => {
      if (ctx.state.focusedArea !== "issues") return;
      syncIssuesFromGh().catch((e: any) => {
        log("issues_sync_error", e?.message ?? String(e)).catch(() => {});
      });
    },
    B: (ctx) => {
      if (ctx.state.focusedArea !== "issues") return;
      const item = ctx.state.issueItems[ctx.state.issueCursor];
      if (!item?.issue.html_url) return;
      try {
        Bun.spawn(["open", item.issue.html_url], { stdio: ["ignore", "ignore", "ignore"] });
      } catch (e: any) {
        log("issues_open_browser_failed", e?.message ?? String(e)).catch(() => {});
      }
    },
    O: (ctx) => {
      if (ctx.state.focusedArea !== "issues") return;
      openSelectedIssueInViewer(ctx.state).catch((e: any) => {
        log("viewer_error", e?.message ?? String(e)).catch(() => {});
      });
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
      return s;
    }),
    G: () => app.update((s) => {
      // G = 末尾（最古）へ、autoScroll OFF
      if (s.focusedArea === "journal") {
        const maxOffset = Math.max(0, s.journalEntries.length - JOURNAL_VISIBLE_LINES);
        return { ...s, journalScrollOffset: maxOffset, journalAutoScroll: false };
      }
      if (s.focusedArea === "log") {
        const maxOffset = Math.max(0, s.logLines.length - LOG_VISIBLE_LINES);
        return { ...s, logScrollOffset: maxOffset, logAutoScroll: false };
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
    Q: (ctx) => {
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
