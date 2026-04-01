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

// --- 名前付きカラー定数（Ink 版と同等） ---
const GREEN = rgb(0, 255, 0);
const YELLOW = rgb(255, 255, 0);
const RED = rgb(255, 0, 0);
const CYAN = rgb(0, 255, 255);
const GRAY = rgb(170, 170, 170);

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
  activeTab: "journal" | "log";
  journalEntries: JournalEntry[];
  logLines: string[];
  version: string;
  confirmingFullQuit?: boolean;
}

// --- セクションタイトル（Ink 版と同じ "─ Title ──────" スタイル） ---

const HR_FILL = "─".repeat(120);

function sectionTitle(label: string) {
  return ui.text(`─ ${label} ${HR_FILL}`, { dim: true });
}

// --- ビュー構築 ---

function buildMasterSection(state: DaemonState) {
  if (state.masterSurface) {
    return ui.row({ gap: 1 }, [
      ui.text("●", { style: { fg: GREEN } }),
      ui.text(`[${state.masterSurface.replace("surface:", "")}]`),
    ]);
  }
  return ui.row({ gap: 1 }, [
    ui.text("○", { style: { fg: RED } }),
    ui.text("not spawned", { style: { fg: RED } }),
  ]);
}

function buildConductorRow(c: ConductorState & { agents: AgentState[]; status: string }) {
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
    const taskId = `#${(c.taskId ?? "").padStart(3, "0")}`;
    const disconnectedElapsed = c.disconnectedAt ? formatElapsed(c.disconnectedAt) : "";
    children.push(
      ui.row({ gap: 1 }, [
        ui.text("⚠", { style: { fg: YELLOW } }),
        ui.text(`[${surface}]`),
        ui.text(taskId, { bold: true }),
        c.taskTitle ? ui.text(c.taskTitle) : null,
        ui.text(`disconnected ${disconnectedElapsed}`, { style: { fg: YELLOW } }),
      ])
    );
  } else {
    const taskId = `#${(c.taskId ?? "").padStart(3, "0")}`;
    const iconColor = isDone ? GRAY : YELLOW;
    const iconChar = isDone ? "✓" : "●";
    children.push(
      ui.row({ gap: 1 }, [
        ui.text(iconChar, { style: { fg: iconColor } }),
        ui.text(`[${surface}]`, isDone ? dimStyle : {}),
        ui.text(taskId, { bold: !isDone, ...(isDone ? dimStyle : {}) }),
        c.taskTitle ? ui.text(c.taskTitle, isDone ? dimStyle : {}) : null,
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

function buildConductorsSection(state: DaemonState) {
  const conductors = [...state.conductors.values()];
  if (conductors.length === 0) {
    return ui.text("idle — waiting for tasks", { dim: true });
  }
  return ui.column({ gap: 0 }, conductors.map((c) => buildConductorRow(c as any)));
}

function buildTaskRow(task: TaskSummary, assigned: boolean) {
  const isClosed = task.status === "closed";
  const icon = isClosed ? "○" : "●";
  const label = assigned ? "running" : task.status;
  const taskId = task.id.padStart(3, "0");
  const timeInfo = isClosed && task.closedAt
    ? utcToLocal(task.closedAt).slice(0, 5)
    : !isClosed && task.createdAt ? formatElapsed(task.createdAt) : "";

  // ステータス別の色（Ink版と同等）
  const color = assigned ? GREEN : task.status === "ready" ? YELLOW : isClosed ? GRAY : undefined;
  const colorStyle = color ? { style: { fg: color } } : {};

  return ui.row({ gap: 1 }, [
    ui.text(icon, colorStyle),
    ui.text(taskId, { bold: !isClosed, ...colorStyle }),
    ui.text(`[${label}]`, colorStyle),
    ui.text(task.title, colorStyle),
    timeInfo ? ui.text(timeInfo, colorStyle) : null,
  ]);
}

// --- Journal/Log テキスト行構築（ui.logsConsole の代替） ---

const journalIconColors: Record<string, number> = {
  "[+]": CYAN,
  "[▶]": YELLOW,
  "[✓]": GREEN,
};

function buildJournalRows(entries: JournalEntry[]) {
  if (entries.length === 0) {
    return [ui.text("no journal entries", { dim: true })];
  }
  return entries.map((entry) => {
    const iconColor = journalIconColors[entry.icon];
    return ui.row({ gap: 1 }, [
      ui.text(entry.time, { dim: true }),
      ui.text(entry.icon, iconColor ? { style: { fg: iconColor } } : {}),
      ui.text(`#${entry.taskId.padStart(3, "0")}`, { bold: true }),
      ui.text(entry.message),
    ]);
  });
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
      version: opts?.version ?? "",
    },
    config: { executionMode: "inline" },
  });

  function buildViewWithApp(state: AppState) {
    const { daemon } = state;
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
      : daemon.taskList.map((task) => buildTaskRow(task, assignedTaskIds.has(task.id)));

    return ui.page({
      body: ui.column({ gap: 0 }, [
        // ヘッダー行（sectionTitle と同じスタイル）
        ui.text(`─ cmux-team ${headerSubtitle}${state.version ? ` v${state.version}` : ""} ${HR_FILL}`, { dim: true }),
        // Master セクション
        sectionTitle("Master"),
        buildMasterSection(daemon),
        // Conductors セクション
        sectionTitle(`Conductors${runningCount > 0 ? ` ${runningCount} running` : ""}`),
        buildConductorsSection(daemon),
        // Tasks セクション
        sectionTitle(`Tasks ${daemon.openTasks} open`),
        ui.column({ gap: 0 }, taskRows),
        // Journal / Log タブ（クリック + キーボード 1/2 で切り替え）
        ui.row({ gap: 1 }, [
          ui.button({
            id: "tab-journal",
            label: "Journal",
            px: 1,
            style: state.activeTab === "journal" ? { bold: true } : { dim: true },
            onPress: () => { try { app.update((s) => ({ ...s, activeTab: "journal" })); } catch {} },
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
            ? buildJournalRows(state.journalEntries)
            : buildLogRows(state.logLines.slice(-200))
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
          : [
              ui.kbd("1"),
              ui.text("journal"),
              ui.kbd("2"),
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
    "2": () => app.update((s) => ({ ...s, activeTab: "log" })),
    Tab: () => app.update((s) => ({ ...s, activeTab: s.activeTab === "journal" ? "log" : "journal" })),
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

    try {
      app.update((s) => ({
        ...s,
        daemon: newDaemon,
        logLines: lines,
        journalEntries,
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
