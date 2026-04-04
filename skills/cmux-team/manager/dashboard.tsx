/**
 * TUI Dashboard — Rezi フルスクリーンダッシュボード
 *
 * 既存の dashboard.tsx (Ink ベース) を Rezi TUI フレームワークで書き直し。
 * Ink版と同等の情報量・レイアウトを実現。
 * 上部: ヘッダー（ステータス・PID・conductors・tasks）
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
import { log } from "./logger";
import { loadArtifacts } from "./artifact";
import type { ArtifactMeta } from "./artifact";

const LOG_VISIBLE_LINES = 30;

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
const GREEN = rgb(0, 255, 0);
const YELLOW = rgb(255, 255, 0);
const RED = rgb(255, 0, 0);
const CYAN = rgb(0, 255, 255);
const GRAY = rgb(170, 170, 170);

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerTick = 0;

// --- ジャーナルエントリ ---

interface JournalEntry {
  time: string;  // HH:MM:SS
  icon: string;  // [+], [▶], [✓]
  taskId: string;
  message: string;
  level: "info" | "warn" | "error";
}

// --- ヘルパー ---

function formatUptime(startMs: number): string {
  const sec = Math.floor((Date.now() - startMs) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

function utcToLocal(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleTimeString("ja-JP", {
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
      const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
      result.push({ time, icon: "[+]", taskId, message: title, level: "info" });
    } else if (event === "conductor_started") {
      const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
      const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
      result.push({ time, icon: "[▶]", taskId, message: title || `${detail.match(/conductor_id=(\S+)/)?.[1] ?? ""} started`, level: "warn" });
    } else if (event === "task_completed") {
      const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
      const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
      const summary = detail.match(/journal_summary=(.+)/)?.[1] ?? "";
      result.push({ time, icon: "[✓]", taskId, message: summary || title || detail, level: "info" });
    } else if (event === "task_aborted") {
      const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
      const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
      result.push({ time, icon: "[✕]", taskId, message: title || "aborted", level: "error" });
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
  version: string;
  repoUrl: string | null;
  confirmingFullQuit?: boolean;
  logScrollOffset: number;   // 0 = 最下部（最新）、正の数 = 上にスクロールした行数
  logAutoScroll: boolean;    // true = 最新に自動追従
}

// --- セクションタイトル（Ink 版と同じ "─ Title ──────" スタイル） ---

const HR_FILL = "─".repeat(120);

function sectionTitle(label: string) {
  return ui.text(`─ ${label} ${HR_FILL}`, { dim: true });
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
    return ui.row({ gap: 1 }, [
      ui.text(frame!, { style: { fg: YELLOW } }),
      ui.text(surfaceLabel),
    ]);
  }

  // idle
  return ui.row({ gap: 1 }, [
    ui.text("●", { style: { fg: GREEN } }),
    ui.text(surfaceLabel),
  ]);
}

function buildConductorRow(c: ConductorState & { agents: AgentState[]; status: string }, repoUrl: string | null) {
  const isIdle = c.status === "idle";
  const isDone = c.status === "done";
  const isDisconnected = c.status === "disconnected";
  const elapsed = formatElapsed(c.startedAt);
  const surface = c.surface.replace("surface:", "");

  const children = [];

  // メイン行
  const dimStyle = { style: { fg: GRAY } };
  if (isIdle) {
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
    const iconColor = isDone ? GRAY : YELLOW;
    const iconChar = isDone ? "✓" : "●";
    children.push(
      ui.row({ gap: 1 }, [
        ui.text(iconChar, { style: { fg: iconColor } }),
        ui.text(`[${surface}]`, isDone ? dimStyle : {}),
        ui.text(taskId, { bold: !isDone, ...(isDone ? dimStyle : {}) }),
        c.taskTitle ? buildTitleWithLinks(c.taskTitle, repoUrl, isDone ? dimStyle : {}) : null,
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

function buildConductorsSection(state: DaemonState, repoUrl: string | null) {
  const conductors = [...state.conductors.values()];
  if (conductors.length === 0) {
    return ui.text("idle — waiting for tasks", { dim: true });
  }
  return ui.column({ gap: 0 }, conductors.map((c) => buildConductorRow(c as any, repoUrl)));
}

function buildTaskRow(task: TaskSummary, assigned: boolean, repoUrl: string | null) {
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
    ? utcToLocal(task.abortedAt).slice(0, 5)
    : isClosed && task.closedAt
    ? utcToLocal(task.closedAt).slice(0, 5)
    : !isClosed && task.createdAt ? formatElapsed(task.createdAt) : "";

  // ステータス別の色（Ink版と同等）
  const color = isAborted ? RED : isClosed ? GRAY : assigned ? GREEN : isBlocked ? RED : task.status === "ready" ? YELLOW : undefined;
  const colorStyle = color ? { style: { fg: color } } : {};

  return ui.row({ gap: 1 }, [
    ui.text(icon, colorStyle),
    ui.text(taskId, { bold: !isClosed, ...colorStyle }),
    ui.text(`[${label}]`, colorStyle),
    buildTitleWithLinks(task.title, repoUrl, colorStyle),
    timeInfo ? ui.text(timeInfo, colorStyle) : null,
  ]);
}

// --- Journal/Log テキスト行構築（ui.logsConsole の代替） ---

const journalIconColors: Record<string, number> = {
  "[+]": CYAN,
  "[▶]": YELLOW,
  "[✓]": GREEN,
  "[✕]": RED,
};

function buildJournalRows(entries: JournalEntry[], repoUrl: string | null) {
  if (entries.length === 0) {
    return [ui.text("no journal entries", { dim: true })];
  }
  return entries.map((entry) => {
    const iconColor = journalIconColors[entry.icon];
    return ui.row({ gap: 1 }, [
      ui.text(entry.time, { dim: true }),
      ui.text(entry.icon, iconColor ? { style: { fg: iconColor } } : {}),
      ui.text(`T${entry.taskId.padStart(3, "0")}`, { bold: true }),
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
  refreshInterval: ReturnType<typeof setInterval> | null,
  restartRefresh: () => void,
): Promise<void> {
  const viewer = await resolveMarkdownViewer();

  // refresh を一時停止
  if (refreshInterval) clearInterval(refreshInterval);

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
    restartRefresh();
  }
}

// --- アプリインスタンス管理 ---

let appInstance: NodeApp<AppState> | null = null;
let refreshInterval: ReturnType<typeof setInterval> | null = null;

export async function startDashboard(
  getState: () => DaemonState,
  opts?: { version?: string; onReload?: () => void; onQuit?: () => void; onFullQuit?: () => void }
): Promise<void> {
  const daemonState = getState();
  let confirmingFullQuit = false;

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
      version: opts?.version ?? "",
      repoUrl: null,
      logScrollOffset: 0,
      logAutoScroll: true,
    },
    config: { executionMode: "inline" },
  });

  function buildViewWithApp(state: AppState) {
    const { daemon, repoUrl } = state;
    const runningCount = [...daemon.conductors.values()].filter(c => c.status === "running").length;
    const assignedTaskIds = new Set([...daemon.conductors.values()].map(c => c.taskId));

    // レスポンシブヘッダー（Ink版と同等のロジック）
    // 基本: cmux-team RUNNING conductors N/M tasks N open
    // cols >= 65: + PID XXXX
    // cols >= 75: + poll Ns
    // cols >= 85: + N ready (pendingTasks > 0)
    const headerParts = [
      daemon.running ? "RUNNING" : "STOPPED",
      `PID ${process.pid}`,
      `tasks ${daemon.openTasks} open`,
    ];
    if (daemon.pendingTasks > 0) {
      headerParts.push(`${daemon.pendingTasks} ready`);
    }
    const headerSubtitle = headerParts.join("  ");

    // タスク一覧（ui.column + map で可変高さ — virtualList は固定高さで空白が出るため）
    const taskRows = daemon.taskList.length === 0
      ? [ui.text("no tasks", { dim: true })]
      : daemon.taskList.map((task) => buildTaskRow(task, assignedTaskIds.has(task.id), repoUrl));

    return ui.page({
      body: ui.column({ gap: 0 }, [
        // ヘッダー行（sectionTitle と同じスタイル）
        ui.text(`─ cmux-team ${headerSubtitle}${state.version ? ` v${state.version}` : ""} ${HR_FILL}`, { dim: true }),
        // Master セクション
        sectionTitle("Master"),
        buildMasterSection(daemon),
        // Conductors セクション
        sectionTitle(`Conductors${runningCount > 0 ? ` ${runningCount} running` : ""}`),
        buildConductorsSection(daemon, repoUrl),
        // Tasks セクション
        sectionTitle(`Tasks ${daemon.openTasks} open`),
        ui.column({ gap: 0 }, taskRows),
        // Journal / Artifacts / Log タブ（クリック + キーボード 1/2/3 で切り替え）
        ui.row({ gap: 1 }, [
          ui.button({
            id: "tab-journal",
            label: "Journal",
            px: 1,
            style: state.activeTab === "journal" ? { bold: true } : { dim: true },
            onPress: () => { try { app.update((s) => ({ ...s, activeTab: "journal" })); } catch {} },
          }),
          ui.button({
            id: "tab-artifacts",
            label: "Artifacts",
            px: 1,
            style: state.activeTab === "artifacts" ? { bold: true } : { dim: true },
            onPress: () => { try { app.update((s) => ({ ...s, activeTab: "artifacts" })); } catch {} },
          }),
          ui.button({
            id: "tab-log",
            label: "Log",
            px: 1,
            style: state.activeTab === "log" ? { bold: true } : { dim: true },
            onPress: () => { try { app.update((s) => ({ ...s, activeTab: "log" })); } catch {} },
          }),
        ]),
        ui.column({ gap: 0 },
          state.activeTab === "journal"
            ? buildJournalRows([...state.journalEntries].reverse(), repoUrl)
            : state.activeTab === "artifacts"
            ? buildArtifactRows(state)
            : (() => {
                const total = state.logLines.length;
                let endIdx = total - state.logScrollOffset;
                if (endIdx < LOG_VISIBLE_LINES) endIdx = Math.min(total, LOG_VISIBLE_LINES);
                const startIdx = Math.max(0, endIdx - LOG_VISIBLE_LINES);
                return buildLogRows(state.logLines.slice(startIdx, endIdx));
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
          : state.activeTab === "artifacts"
          ? [
              ui.kbd("j/k"),
              ui.text("select"),
              ui.kbd("Enter"),
              ui.text("open"),
              ui.kbd("s"),
              ui.text(`sort:${state.artifactSort}`),
              ui.kbd("f"),
              ui.text(state.artifactTypeFilter ? `type:${state.artifactTypeFilter}` : "filter"),
              ui.kbd("1-3"),
              ui.text("tabs"),
              ui.kbd("q"),
              ui.text("quit"),
            ]
          : state.activeTab === "log"
          ? [
              ui.kbd("j/k"),
              ui.text("scroll"),
              ui.kbd("g/G"),
              ui.text("top/bottom"),
              ui.kbd("1-3"),
              ui.text("tabs"),
              ui.kbd("r"),
              ui.text("reload"),
              ui.kbd("q"),
              ui.text("quit"),
              ui.kbd("Q"),
              ui.text("full quit"),
            ]
          : [
              ui.kbd("1"),
              ui.text("journal"),
              ui.kbd("2"),
              ui.text("artifacts"),
              ui.kbd("3"),
              ui.text("log"),
              ui.kbd("r"),
              ui.text("reload"),
              ui.kbd("q"),
              ui.text("quit"),
              ui.kbd("Q"),
              ui.text("full quit"),
            ],
      }),
    });
  }

  app.view(buildViewWithApp);

  // キーバインド
  app.keys({
    "1": () => app.update((s) => ({ ...s, activeTab: "journal" })),
    "2": () => app.update((s) => ({ ...s, activeTab: "artifacts" })),
    "3": () => app.update((s) => ({ ...s, activeTab: "log" })),
    Tab: () => app.update((s) => {
      const tabs: AppState["activeTab"][] = ["journal", "artifacts", "log"];
      const idx = tabs.indexOf(s.activeTab);
      return { ...s, activeTab: tabs[(idx + 1) % tabs.length]! };
    }),
    // Artifacts タブ専用キー
    Enter: (ctx) => {
      const currentState = ctx.state;
      if (currentState.activeTab !== "artifacts") return;
      const filtered = getFilteredArtifacts(currentState);
      if (filtered.length === 0) return;
      const selected = filtered[currentState.artifactCursor];
      if (!selected) return;

      openArtifactInViewer(
        app,
        selected.filePath,
        refreshInterval,
        () => {
          refreshInterval = setInterval(refresh, 2000);
          refresh();
        },
      ).catch((e: any) => { log("viewer_error", e?.message ?? String(e)).catch(() => {}); });
    },
    j: () => app.update((s) => {
      if (s.activeTab === "artifacts") {
        const filtered = getFilteredArtifacts(s);
        return { ...s, artifactCursor: Math.min(s.artifactCursor + 1, filtered.length - 1) };
      }
      if (s.activeTab === "log") {
        const maxOffset = Math.max(0, s.logLines.length - LOG_VISIBLE_LINES);
        return { ...s, logScrollOffset: Math.min(s.logScrollOffset + 1, maxOffset), logAutoScroll: false };
      }
      return s;
    }),
    k: () => app.update((s) => {
      if (s.activeTab === "artifacts") {
        return { ...s, artifactCursor: Math.max(s.artifactCursor - 1, 0) };
      }
      if (s.activeTab === "log") {
        const newOffset = Math.max(s.logScrollOffset - 1, 0);
        return { ...s, logScrollOffset: newOffset, logAutoScroll: newOffset === 0 };
      }
      return s;
    }),
    G: () => app.update((s) => {
      if (s.activeTab === "log") {
        return { ...s, logScrollOffset: 0, logAutoScroll: true };
      }
      return s;
    }),
    g: () => app.update((s) => {
      if (s.activeTab === "log") {
        const maxOffset = Math.max(0, s.logLines.length - LOG_VISIBLE_LINES);
        return { ...s, logScrollOffset: maxOffset, logAutoScroll: false };
      }
      return s;
    }),
    s: () => app.update((s) => {
      if (s.activeTab !== "artifacts") return s;
      const sorts: AppState["artifactSort"][] = ["id", "created", "updated"];
      const idx = sorts.indexOf(s.artifactSort);
      return { ...s, artifactSort: sorts[(idx + 1) % sorts.length]!, artifactCursor: 0 };
    }),
    f: () => app.update((s) => {
      if (s.activeTab !== "artifacts") return s;
      const types = [null, "research", "decision", "session", "spec", "report"];
      const idx = types.indexOf(s.artifactTypeFilter);
      return { ...s, artifactTypeFilter: types[(idx + 1) % types.length]!, artifactCursor: 0 };
    }),
    r: () => opts?.onReload?.(),
    q: () => {
      cleanup();
      opts?.onQuit?.();
    },
    Q: () => {
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
      app.update((s) => ({ ...s, confirmingFullQuit: false }));
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
      app.update((s) => ({
        ...s,
        daemon: newDaemon,
        logLines: lines,
        journalEntries,
        repoUrl,
        artifacts,
        logScrollOffset: s.logAutoScroll ? 0 : s.logScrollOffset,
      }));
    } catch (e: any) {
      // lifecycle operation already in flight — skip this tick
      log("dashboard_update_error", e?.message ?? String(e)).catch(() => {});
    }
  };

  try {
    await app.start();
  } catch (e: any) {
    cleanup();
    console.error(`❌ ダッシュボード起動失敗: ${e.message}`);
    console.error("ヒント: TTY 環境で cmux-team start を実行してください");
    return;
  }

  // app.start() 完了後に refresh を開始（start 中に update すると lifecycle error）
  refreshInterval = setInterval(refresh, 2000);
  refresh();
}

function cleanup() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

export function unmountDashboard(): void {
  cleanup();
  if (appInstance) {
    appInstance.stop();
    appInstance = null;
  }
}
