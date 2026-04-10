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
import type { ConductorState, RateLimitInfo } from "./schema";
import type { AgentState } from "./schema";
import { log } from "./logger";
import { t } from "./i18n";
import { loadArtifacts } from "./artifact";
import type { ArtifactMeta } from "./artifact";

const LOG_VISIBLE_LINES = 30;
const TASK_VISIBLE_LINES = 5;
const JOURNAL_VISIBLE_LINES = 30;

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
 * 優先順: CMUX_MD_VIEWER → glow → cat
 */
async function resolveMarkdownViewer(): Promise<string> {
  const envViewer = process.env.CMUX_MD_VIEWER;
  if (envViewer) return envViewer;

  // glow が利用可能か確認
  const glowPath = Bun.which("glow");
  if (glowPath) return "glow";

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

/** リセットまでの残り時間を 1d4h / 3h12m / 45m 形式で整形（最大2単位） */
function formatResetRemaining(resetIso: string | null): string {
  if (!resetIso) return "";
  const resetMs = new Date(resetIso).getTime();
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

/** 使用率のプログレスバーを1つ生成 */
function buildUtilizationBar(label: string, utilization: number, resetIso: string | null): { text: string; color: typeof GREEN } {
  const pct = Math.round(utilization * 100);
  const barWidth = 10;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  const color = pct >= 90 ? RED : pct >= 70 ? YELLOW : GREEN;
  const remaining = formatResetRemaining(resetIso);
  const suffix = remaining ? ` ${remaining}` : "";
  return { text: `${label}: ${pct}% ${bar}${suffix}`, color };
}

/** レート制限の表示文字列を生成（各パーツが個別の色を持つ） */
function buildRateLimitDisplay(rateLimit: RateLimitInfo | null): { parts: Array<{ text: string; color: typeof GREEN }> } {
  if (!rateLimit) {
    return { parts: [{ text: "Rate: --", color: GRAY }] };
  }

  // unified データがある場合: 5h/7d 使用率を表示
  if (rateLimit.unified5hUtilization != null || rateLimit.unified7dUtilization != null) {
    const parts: Array<{ text: string; color: typeof GREEN }> = [];
    const forceRed = rateLimit.unifiedStatus === "rate_limited";

    if (rateLimit.unified5hUtilization != null) {
      const h5 = buildUtilizationBar("5h", rateLimit.unified5hUtilization, rateLimit.unified5hReset);
      parts.push({ text: h5.text, color: forceRed ? RED : h5.color });
    }
    if (rateLimit.unified7dUtilization != null) {
      const d7 = buildUtilizationBar("7d", rateLimit.unified7dUtilization, rateLimit.unified7dReset);
      parts.push({ text: d7.text, color: forceRed ? RED : d7.color });
    }

    return { parts };
  }

  // フォールバック: 従来の TPM 表示
  if (rateLimit.tokensLimit === 0) {
    return { parts: [{ text: "Rate: --", color: GRAY }] };
  }
  const pct = Math.round((rateLimit.tokensRemaining / rateLimit.tokensLimit) * 100);
  const barWidth = 10;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  const color = pct >= 50 ? GREEN : pct >= 20 ? YELLOW : RED;
  return { parts: [{ text: `TPM: ${pct}% ${bar}`, color }] };
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
      const surface = detail.match(/surface=surface:(\S+)/)?.[1] ?? "";
      const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
      result.push({ time, icon: nerdIcon("\uf04b", "[▶]"), taskId, message: title || `${detail.match(/conductor_id=(\S+)/)?.[1] ?? ""} started`, level: "warn", surface: surface || undefined, iconColor: YELLOW });
    } else if (event === "task_completed") {
      const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
      if (!isValidTaskId(taskId)) continue;
      const surface = detail.match(/surface=surface:(\S+)/)?.[1] ?? "";
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

// --- 状態型 ---

interface AppState {
  daemon: DaemonState;
  activeTab: "journal" | "artifacts" | "log";
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
  focusedArea: "global" | "tasks" | "journal" | "log" | "artifacts";
  journalScrollOffset: number;  // 0 = 先頭（最新）、正の数 = 下にスクロールした行数（古い方へ）
  journalAutoScroll: boolean;   // true = 最新に自動追従
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
    dsVariant: "unstyled",
    style: { dim: true },
    focusable: false,
  });
}

// --- ビュー構築 ---

function buildMasterSection(state: DaemonState) {
  if (!state.masterSurface) {
    return ui.row({ gap: 1 }, [
      ui.text("○", { style: { fg: GRAY } }),
      ui.text("not spawned", { style: { fg: GRAY } }),
    ]);
  }

  const surfaceLabel = `[${state.masterSurface.replace("surface:", "")}]`;
  const status = state.masterStatus ?? "idle";

  if (status === "disconnected") {
    return ui.row({ gap: 1 }, [
      ui.text("⚠", { style: { fg: YELLOW } }),
      ui.text(surfaceLabel),
      ui.text("disconnected", { style: { fg: YELLOW } }),
    ]);
  }

  if (status === "running") {
    const frame = SPINNER_FRAMES[spinnerTick % SPINNER_FRAMES.length];
    spinnerTick++;
    const children = [
      ui.text(frame!, { style: { fg: YELLOW } }),
      ui.text(surfaceLabel),
    ];
    if (state.masterPrompt) {
      children.push(ui.text(state.masterPrompt, { style: { fg: GRAY } }));
    }
    return ui.row({ gap: 1 }, children);
  }

  // idle
  return ui.row({ gap: 1 }, [
    ui.text("●", { style: { fg: GREEN } }),
    ui.text(surfaceLabel),
  ]);
}

function buildConductorRow(c: ConductorState & { agents: AgentState[]; status: string }, repoUrl: string | null, spinnerFrame: number = 0) {
  const isStarting = c.status === "starting";
  const isIdle = c.status === "idle";
  const isDisconnected = c.status === "disconnected";
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
  } else if (isIdle) {
    children.push(
      ui.row({ gap: 1 }, [
        ui.text("○", dimStyle),
        ui.text(`[${surface}]`, dimStyle),
        ui.text("idle", { dim: true }),
      ])
    );
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
    const icon = roleIcons[a.role ?? ""] ?? "🔧";
    const prefix = i === agents.length - 1 ? "└─" : "├─";
    const label = a.taskTitle ?? a.role ?? "";
    children.push(
      ui.row({ gap: 1 }, [
        ui.text(`   ${prefix}`, { dim: true }),
        ui.text(`[${a.surface.replace("surface:", "")}]`, { style: { fg: CYAN } }),
        ui.text(`${icon} ${label}`),
      ])
    );
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
      entry.surface ? ui.text(`[${entry.surface}]`, { dim: true }) : null,
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

  for (let i = 0; i < filtered.length; i++) {
    const a = filtered[i]!;
    const isSelected = i === state.artifactCursor;
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

/**
 * 選択中の artifact を外部ビューアで開く
 * TUI を一時停止し、ビューア終了後に復帰する
 */
async function openArtifactInViewer(
  app: NodeApp<AppState>,
  filePath: string,
  onResumed: () => void,
): Promise<void> {
  const viewer = await resolveMarkdownViewer();

  // TUI 停止中は app.update を呼ばない
  dashboardActive = false;
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }

  // TUI を停止
  await app.stop();

  try {
    // ビューアをサブプロセスとして実行（TTY を引き継ぐ）
    const proc = Bun.spawn([viewer, filePath], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  } catch {
    // ビューアが見つからない等のエラー → cat にフォールバック
    try {
      const fallback = Bun.spawn(["cat", filePath], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      await fallback.exited;
    } catch {}
  } finally {
    // TUI を再開（ビューア・フォールバック両方が失敗しても確実に復帰）
    await app.start();
    onResumed();
  }
}

// --- アプリインスタンス管理 ---

let appInstance: NodeApp<AppState> | null = null;
let spinnerInterval: ReturnType<typeof setInterval> | null = null;
/** TUI が表示中かどうか（ビューア表示中は false にして app.update を防ぐ） */
let dashboardActive = false;

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
    },
    config: { executionMode: "inline" },
  });

  function buildViewWithApp(state: AppState) {
    const { daemon, repoUrl } = state;
    const startingCount = [...daemon.conductors.values()].filter(c => c.status === "starting").length;
    const runningCount = [...daemon.conductors.values()].filter(c => c.status === "running").length;
    const assignedTaskIds = new Set([...daemon.conductors.values()].map(c => c.taskId));

    // レスポンシブヘッダー
    // 基本: cmux-team [STOPPED|STARTING|vX.Y.Z]
    const headerParts = [
      !daemon.running ? "STOPPED" : daemon.bootPhase !== "ready" ? "STARTING" : (state.version ? `v${state.version}` : ""),
    ].filter(Boolean);
    const headerSubtitle = headerParts.join("  ");

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
          const rightText = rl.parts.map(p => p.text).join("  ");
          const fill = "─".repeat(Math.max(1, 80 - left.length - rightText.length));
          return ui.row({ gap: 0 }, [
            ui.text(`${left} ${fill} `, { dim: true }),
            ...rl.parts.flatMap((p, i) => [
              ...(i > 0 ? [ui.text("  ", { dim: true })] : []),
              ui.text(p.text, { style: { fg: p.color } }),
            ]),
          ]);
        })(),
        // Master セクション
        sectionTitle("Master"),
        buildMasterSection(daemon),
        // Conductors セクション
        sectionTitle(`Conductors${startingCount > 0 ? ` ${startingCount} starting` : ""}${runningCount > 0 ? ` ${runningCount} running` : ""}`),
        buildConductorsSection(daemon, repoUrl, state.spinnerFrame),
        // Tasks セクション（クリックでフォーカス）
        ui.button({
          id: "section-tasks",
          label: `─ Tasks ${daemon.openTasks} open ${HR_FILL}`,
          px: 0,
          dsVariant: "unstyled",
          style: { dim: true },
          focusable: false,
          onPress: () => { try { app.update((s) => ({ ...s, focusedArea: "tasks" })); } catch {} },
        }),
        ui.column({ gap: 0 }, taskRows),
        // Journal / Artifacts / Log タブ（クリックでタブ切り替え + フォーカス）
        ui.row({ gap: 1 }, [
          ui.button({
            id: "tab-journal",
            label: "Journal",
            px: 1,
            style: state.activeTab === "journal" ? { bold: true } : { dim: true },
            onPress: () => { try { app.update((s) => ({ ...s, activeTab: "journal", focusedArea: "journal" })); } catch {} },
          }),
          ui.button({
            id: "tab-artifacts",
            label: "Artifacts",
            px: 1,
            style: state.activeTab === "artifacts" ? { bold: true } : { dim: true },
            onPress: () => { try { app.update((s) => ({ ...s, activeTab: "artifacts", focusedArea: "artifacts" })); } catch {} },
          }),
          ui.button({
            id: "tab-log",
            label: "Log",
            px: 1,
            style: state.activeTab === "log" ? { bold: true } : { dim: true },
            onPress: () => { try { app.update((s) => ({ ...s, activeTab: "log", focusedArea: "log" })); } catch {} },
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
              ui.kbd("ESC"), ui.text("back"),
            ]
          : state.focusedArea === "journal"
          ? [
              ui.kbd("↑/↓"), ui.text("scroll"),
              ui.kbd("g/G"), ui.text("top/bottom"),
              ui.kbd("ESC"), ui.text("back"),
            ]
          : state.focusedArea === "log"
          ? [
              ui.kbd("↑/↓"), ui.text("scroll"),
              ui.kbd("g/G"), ui.text("top/bottom"),
              ui.kbd("ESC"), ui.text("back"),
            ]
          : state.focusedArea === "artifacts"
          ? [
              ui.kbd("↑/↓"), ui.text("select"),
              ui.kbd("Enter"), ui.text("open"),
              ui.kbd("s"), ui.text(`sort:${state.artifactSort}`),
              ui.kbd("f"), ui.text(state.artifactTypeFilter ? `type:${state.artifactTypeFilter}` : "filter"),
              ui.kbd("ESC"), ui.text("back"),
            ]
          : [ // global
              ui.kbd("T"), ui.text("tasks"),
              ui.kbd("J"), ui.text("journal"),
              ui.kbd("L"), ui.text("log"),
              ui.kbd("A"), ui.text("artifacts"),
              ui.kbd("r"), ui.text("reload"),
              ui.kbd("q"), ui.text("quit"),
              ui.kbd("Q"), ui.text("full quit"),
            ],
      }),
    });
  }

  app.view(buildViewWithApp);

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
        default:
          return s;
      }
    }),
    "1": () => app.update((s) => ({ ...s, activeTab: "journal" })),
    "2": () => app.update((s) => ({ ...s, activeTab: "artifacts" })),
    "3": () => app.update((s) => ({ ...s, activeTab: "log" })),
    Tab: () => app.update((s) => {
      const tabs: AppState["activeTab"][] = ["journal", "artifacts", "log"];
      const idx = tabs.indexOf(s.activeTab);
      return { ...s, activeTab: tabs[(idx + 1) % tabs.length]! };
    }),
    T: () => app.update((s) => ({ ...s, focusedArea: "tasks" })),
    J: () => app.update((s) => ({ ...s, activeTab: "journal", focusedArea: "journal" })),
    L: () => app.update((s) => ({ ...s, activeTab: "log", focusedArea: "log" })),
    A: () => app.update((s) => ({ ...s, activeTab: "artifacts", focusedArea: "artifacts" })),
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

  // 2000ms ごとに状態更新
  const refresh = async () => {
    const newDaemon = getState();
    const lines = await readLogLines(newDaemon.projectRoot);
    const journalEntries = parseJournalEntries(lines);
    const repoUrl = await resolveGitHubRepoUrl(newDaemon.projectRoot);
    const artifacts = await loadArtifacts(newDaemon.projectRoot);

    try {
      app.update((s) => {
        // フォーカス中は自動スクロールしない
        const journalAuto = s.journalAutoScroll && s.focusedArea !== "journal";
        const logAuto = s.logAutoScroll && s.focusedArea !== "log";

        // 自動スクロール OFF 時: 新エントリ分だけ offset を増加して表示位置を保持
        const journalDelta = journalEntries.length - s.journalEntries.length;
        const logDelta = lines.length - s.logLines.length;

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
        daemon.masterStatus === "running" ||
        [...daemon.conductors.values()].some(c => c.status === "running" || c.status === "starting");

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

  return { scheduleRefresh };
}

function cleanup() {
  dashboardActive = false;
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }
}

export function unmountDashboard(): void {
  cleanup();
  if (appInstance) {
    appInstance.stop();
    appInstance = null;
  }
}
