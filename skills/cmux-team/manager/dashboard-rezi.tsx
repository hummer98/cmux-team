/**
 * TUI Dashboard — Rezi フルスクリーンダッシュボード (PoC)
 *
 * 既存の dashboard.tsx (Ink ベース) を Rezi TUI フレームワークで書き直した PoC。
 * ui.page + ui.tabs + ui.logsConsole を使い、マウス操作にも対応。
 */
import { ui } from "@rezi-ui/core";
import { createNodeApp, type NodeApp } from "@rezi-ui/node";
import { readFile } from "fs/promises";
import { join } from "path";
import type { DaemonState, TaskSummary } from "./daemon";
import type { ConductorState } from "./schema";
import type { AgentState } from "./schema";

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
  const isComplete = event.includes("completed");
  const level = isError ? "error" as const : isComplete ? "info" as const : "info" as const;
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
  logEntries: Array<{ id: string; timestamp: number; level: "info" | "warn" | "error"; source: string; message: string }>;
  journalEntries: JournalEntry[];
  logScrollTop: number;
  journalScrollTop: number;
  version: string;
}

// --- ビュー構築 ---

function buildMasterSection(state: DaemonState) {
  if (state.masterSurface) {
    return ui.row({ gap: 1 }, [
      ui.status("online"),
      ui.text(`[${state.masterSurface.replace("surface:", "")}]`),
    ]);
  }
  return ui.row({ gap: 1 }, [
    ui.status("offline"),
    ui.text("not spawned"),
  ]);
}

function buildConductorRow(c: ConductorState & { agents: AgentState[]; status: string }) {
  const isIdle = c.status === "idle";
  const isDone = c.status === "done";
  const elapsed = formatElapsed(c.startedAt);
  const surface = c.surface.replace("surface:", "");

  const children = [];

  // メイン行
  if (isIdle) {
    children.push(
      ui.row({ gap: 1 }, [
        ui.status("away"),
        ui.text(`[${surface}]`),
        ui.text("idle", { dim: true }),
      ])
    );
  } else {
    const taskId = `#${(c.taskId ?? "").padStart(3, "0")}`;
    children.push(
      ui.row({ gap: 1 }, [
        ui.status(isDone ? "offline" : "busy"),
        ui.text(`[${surface}]`),
        ui.text(taskId, { bold: !isDone }),
        c.taskTitle ? ui.text(c.taskTitle) : null,
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
        ui.text(`   ${prefix}`),
        ui.text(`[${a.surface.replace("surface:", "")}]`),
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

  return ui.row({ gap: 1 }, [
    ui.text(icon, { dim: isClosed }),
    ui.text(taskId, { bold: !isClosed, dim: isClosed }),
    ui.text(`[${label}]`, { dim: isClosed }),
    ui.text(task.title),
    timeInfo ? ui.text(timeInfo, { dim: true }) : null,
  ]);
}

function buildView(state: AppState) {
  const { daemon } = state;
  const runningCount = [...daemon.conductors.values()].filter(c => c.status === "running").length;
  const assignedTaskIds = new Set([...daemon.conductors.values()].map(c => c.taskId));

  // ヘッダー情報
  const headerSubtitle = [
    daemon.running ? "RUNNING" : "STOPPED",
    `PID ${process.pid}`,
    `conductors ${runningCount}/${daemon.maxConductors}`,
    `tasks ${daemon.openTasks} open`,
    daemon.pendingTasks > 0 ? `${daemon.pendingTasks} ready` : null,
  ].filter(Boolean).join("  ");

  // タスク一覧
  const tasksContent = daemon.taskList.length === 0
    ? [ui.text("no tasks", { dim: true })]
    : daemon.taskList.map(t => buildTaskRow(t, assignedTaskIds.has(t.id)));

  // ジャーナルタブの内容
  const journalLogEntries = state.journalEntries.map((entry, i) => ({
    id: `journal-${i}`,
    timestamp: Date.now(),
    level: entry.level,
    source: entry.icon,
    message: `#${entry.taskId.padStart(3, "0")} ${entry.message}`,
  }));

  // タブ
  const tabs = [
    {
      key: "journal",
      label: "Journal",
      content: state.journalEntries.length === 0
        ? ui.text("no journal entries", { dim: true })
        : ui.logsConsole({
            id: "journal-console",
            entries: journalLogEntries,
            autoScroll: true,
            scrollTop: state.journalScrollTop,
            showTimestamps: false,
            showSource: true,
            onScroll: () => {},
          }),
    },
    {
      key: "log",
      label: "Log",
      content: state.logEntries.length === 0
        ? ui.text("no log entries", { dim: true })
        : ui.logsConsole({
            id: "log-console",
            entries: state.logEntries,
            autoScroll: true,
            scrollTop: state.logScrollTop,
            showTimestamps: true,
            showSource: false,
            onScroll: () => {},
          }),
    },
  ];

  return ui.page({
    header: ui.header({
      title: "cmux-team",
      subtitle: headerSubtitle,
      actions: state.version ? [ui.text(`v${state.version}`, { dim: true })] : [],
    }),
    body: ui.column({ gap: 0 }, [
      // Master セクション
      ui.panel("Master", [buildMasterSection(daemon)]),
      // Conductors セクション
      ui.panel(`Conductors ${daemon.conductors.size}/${daemon.maxConductors}`, [buildConductorsSection(daemon)]),
      // Tasks セクション
      ui.panel("Tasks", tasksContent),
      // タブ（Journal / Log）
      ui.tabs({
        id: "main-tabs",
        tabs,
        activeTab: state.activeTab,
        onChange: () => {},
      }),
    ]),
    footer: ui.statusBar({
      left: [
        ui.kbd("1"),
        ui.text("journal"),
        ui.kbd("2"),
        ui.text("log"),
        ui.kbd("r"),
        ui.text("reload"),
        ui.kbd("q"),
        ui.text("quit"),
      ],
    }),
  });
}

// --- アプリインスタンス管理 ---

let appInstance: NodeApp<AppState> | null = null;
let refreshInterval: ReturnType<typeof setInterval> | null = null;

export function startDashboard(
  getState: () => DaemonState,
  opts?: { version?: string; onReload?: () => void; onQuit?: () => void }
): void {
  const daemonState = getState();

  const app = createNodeApp<AppState>({
    initialState: {
      daemon: daemonState,
      activeTab: "journal",
      logEntries: [],
      journalEntries: [],
      logScrollTop: 0,
      journalScrollTop: 0,
      version: opts?.version ?? "",
    },
  });

  app.view(buildView);

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
  });

  appInstance = app;

  // 2000ms ごとに状態更新
  const refresh = async () => {
    const newDaemon = getState();
    const lines = await readLogLines(newDaemon.projectRoot);
    const journalEntries = parseJournalEntries(lines);
    const logEntries = lines.slice(-200).map((line, i) => {
      const parsed = parseLogLine(line);
      return {
        id: `log-${i}`,
        timestamp: new Date(line.match(/^\[([^\]]+)\]/)?.[1] ?? "").getTime() || Date.now(),
        level: parsed.level,
        source: parsed.event,
        message: `${parsed.event} ${parsed.detail}`,
      };
    });

    app.update((s) => ({
      ...s,
      daemon: newDaemon,
      logEntries,
      journalEntries,
    }));
  };

  refreshInterval = setInterval(refresh, 2000);
  // 初回読み込み
  refresh();

  app.start();
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
