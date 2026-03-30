/**
 * TUI Dashboard — Rezi フルスクリーンダッシュボード
 *
 * 既存の dashboard.tsx (Ink ベース) を Rezi TUI フレームワークで書き直し。
 * Ink版と同等の情報量・レイアウトを実現。
 * 上部: ヘッダー（ステータス・PID・conductors・tasks）
 * 中部: Master / Conductors / Tasks パネル
 * 下部: journal / log タブ切り替え（残りスペースを全て使う）
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

// --- Journal/Log テキスト行構築（ui.logsConsole の代替） ---

function buildJournalRows(entries: JournalEntry[]) {
  if (entries.length === 0) {
    return [ui.text("no journal entries", { dim: true })];
  }
  return entries.map((entry) =>
    ui.row({ gap: 1 }, [
      ui.text(entry.time, { dim: true }),
      ui.text(entry.icon),
      ui.text(`#${entry.taskId.padStart(3, "0")}`, { bold: true }),
      ui.text(entry.message),
    ])
  );
}

function buildLogRows(lines: string[]) {
  if (lines.length === 0) {
    return [ui.text("no log entries", { dim: true })];
  }
  return lines.map((line) => {
    const parsed = parseLogLine(line);
    return ui.row({ gap: 1 }, [
      ui.text(parsed.time, { dim: true }),
      ui.text(parsed.event),
      ui.text(parsed.detail),
    ]);
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
      journalEntries: [],
      logLines: [],
      version: opts?.version ?? "",
    },
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
      `conductors ${runningCount}/${daemon.maxConductors}`,
      `tasks ${daemon.openTasks} open`,
    ];
    // ヘッダーは常に PID・poll・ready を含める
    // （Rezi ではターミナル幅に応じた制御が難しいため全部表示）
    headerParts.splice(1, 0, `PID ${process.pid}`);
    if (daemon.pendingTasks > 0) {
      headerParts.push(`${daemon.pendingTasks} ready`);
    }
    const headerSubtitle = headerParts.join("  ");

    // タスク一覧（ui.column + map で可変高さ — virtualList は固定高さで空白が出るため）
    const taskRows = daemon.taskList.length === 0
      ? [ui.text("no tasks", { dim: true })]
      : daemon.taskList.map((task) => buildTaskRow(task, assignedTaskIds.has(task.id)));

    // タブコンテンツ（ui.logsConsole の代わりに ui.column + ui.text で確実に表示）
    const tabLabel = state.activeTab === "journal" ? "Journal" : "Log";
    const tabContent = state.activeTab === "journal"
      ? buildJournalRows(state.journalEntries)
      : buildLogRows(state.logLines.slice(-200));

    // タブ
    const tabs = [
      {
        key: "journal",
        label: "Journal",
        content: ui.column({ gap: 0 }, buildJournalRows(state.journalEntries)),
      },
      {
        key: "log",
        label: "Log",
        content: ui.column({ gap: 0 }, buildLogRows(state.logLines.slice(-200))),
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
        // Conductors セクション（フルタイトル表示）
        ui.panel(`Conductors ${daemon.conductors.size}/${daemon.maxConductors}`, [buildConductorsSection(daemon)]),
        // Tasks セクション（可変高さ）
        ui.panel(`Tasks ${daemon.openTasks} open`, taskRows),
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
  });

  appInstance = app;

  // 2000ms ごとに状態更新
  const refresh = async () => {
    const newDaemon = getState();
    const lines = await readLogLines(newDaemon.projectRoot);
    const journalEntries = parseJournalEntries(lines);

    app.update((s) => ({
      ...s,
      daemon: newDaemon,
      logLines: lines,
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
