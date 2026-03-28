/**
 * TUI Dashboard — ink フルスクリーンダッシュボード
 *
 * top のようなフルスクリーン表示。ターミナルサイズにレスポンシブ。
 * 上部: ヘッダー（ステータス・PID・uptime）
 * 中部: Master / Conductors / Tasks パネル
 * 下部: journal / log タブ切り替え（残りスペースを全て使う）
 */
import React, { useState, useEffect } from "react";
import { render, Text, Box, useStdout, useInput } from "ink";
import { readFile } from "fs/promises";
import { join } from "path";
import type { DaemonState } from "./daemon";

type ActiveTab = "journal" | "log";

interface DashboardProps {
  getState: () => DaemonState;
  version?: string;
  onReload?: () => void;
  onQuit?: () => void;
}

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    const handler = () => {
      setSize({
        columns: stdout?.columns ?? 80,
        rows: stdout?.rows ?? 24,
      });
    };
    stdout?.on("resize", handler);
    return () => { stdout?.off("resize", handler); };
  }, [stdout]);

  return size;
}

function useLogTail(projectRoot: string, lineCount: number) {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    const logFile = join(projectRoot, ".team/logs/manager.log");
    const read = async () => {
      try {
        const content = await readFile(logFile, "utf-8");
        const all = content.trim().split("\n").filter(Boolean);
        setLines(all.slice(-lineCount));
      } catch {
        setLines([]);
      }
    };
    read();
    const interval = setInterval(read, 2000);
    return () => clearInterval(interval);
  }, [projectRoot, lineCount]);

  return lines;
}

// --- ジャーナルエントリ ---
interface JournalEntry {
  time: string;  // HH:MM
  icon: string;  // [+], [▶], [✓]
  taskId: string;
  message: string;
  color: string;
}

function useJournalEntries(projectRoot: string): JournalEntry[] {
  const [entries, setEntries] = useState<JournalEntry[]>([]);

  useEffect(() => {
    const logFile = join(projectRoot, ".team/logs/manager.log");
    const read = async () => {
      try {
        const content = await readFile(logFile, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);
        const result: JournalEntry[] = [];

        for (const line of lines) {
          const match = line.match(/^\[([^\]]+)\]\s+(\S+)\s*(.*)/);
          if (!match) continue;
          const ts = match[1] ?? "";
          const event = match[2] ?? "";
          const detail = match[3] ?? "";
          const time = utcToLocal(ts); // HH:MM:SS（ローカル時刻）

          if (event === "task_received") {
            const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
            const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
            result.push({ time, icon: "[+]", taskId, message: title, color: "cyan" });
          } else if (event === "conductor_started") {
            const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
            const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
            result.push({ time, icon: "[▶]", taskId, message: title || `${detail.match(/conductor_id=(\S+)/)?.[1] ?? ""} started`, color: "yellow" });
          } else if (event === "task_completed") {
            const taskId = detail.match(/task_id=(\S+)/)?.[1] ?? "?";
            const title = detail.match(/title=(.+?)(?:\s+\w+=|$)/)?.[1] ?? "";
            const summary = detail.match(/journal_summary=(.+)/)?.[1] ?? "";
            result.push({ time, icon: "[✓]", taskId, message: summary || title || detail, color: "green" });
          }
        }

        setEntries(result);
      } catch {
        setEntries([]);
      }
    };
    read();
    const interval = setInterval(read, 2000);
    return () => clearInterval(interval);
  }, [projectRoot]);

  return entries;
}

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

// --- ヘッダーバー ---
function Header({ state, cols }: { state: DaemonState; cols: number }) {
  const status = state.running ? "RUNNING" : "STOPPED";
  const statusColor = state.running ? "green" : "red";
  const uptime = formatUptime(state.lastUpdate.getTime() - (state.pollInterval * 10)); // 近似

  return (
    <Box width={cols}>
      <Text bold color="cyan"> cmux-team </Text>
      <Text> </Text>
      <Text bold color={statusColor}>{status}</Text>
      <Text>  PID </Text>
      <Text bold>{process.pid}</Text>
      <Text>  poll </Text>
      <Text>{state.pollInterval / 1000}s</Text>
      <Text>  conductors </Text>
      <Text bold color="yellow">{state.conductors.size}</Text>
      <Text>/{state.maxConductors}</Text>
      <Text>  tasks </Text>
      <Text bold>{state.openTasks}</Text>
      <Text> open</Text>
      {state.pendingTasks > 0 && (
        <>
          <Text> </Text>
          <Text bold color="green">{state.pendingTasks}</Text>
          <Text> ready</Text>
        </>
      )}
    </Box>
  );
}

// --- セパレーター ---
function Sep({ cols, label }: { cols: number; label: string }) {
  const line = "─".repeat(Math.max(0, cols - label.length - 3));
  return (
    <Text dimColor>─ <Text bold dimColor={false}>{label}</Text> {line}</Text>
  );
}

// --- Master セクション ---
function MasterSection({ state }: { state: DaemonState }) {
  if (state.masterSurface) {
    return (
      <Box paddingLeft={1}>
        <Text color="green">● </Text>
        <Text>[{state.masterSurface.replace("surface:", "")}]</Text>
      </Box>
    );
  }
  return (
    <Box paddingLeft={1}>
      <Text color="red">○ not spawned</Text>
    </Box>
  );
}

// --- Conductor セクション ---
function ConductorsSection({ state, cols }: { state: DaemonState; cols: number }) {
  const conductors = [...state.conductors.values()];
  if (conductors.length === 0) {
    return (
      <Box paddingLeft={1}>
        <Text dimColor>idle — waiting for tasks</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {conductors.map((c) => {
        const elapsed = formatElapsed(c.startedAt);
        const agents = c.agents || [];
        return (
          <Box key={c.conductorId} flexDirection="column">
            <Box paddingLeft={1}>
              <Text color="yellow">● </Text>
              <Text>[{c.surface.replace("surface:", "")}]</Text>
              <Text bold> #{c.taskId.padStart(3, '0')}</Text>
              {c.taskTitle && <Text color="white"> {c.taskTitle}</Text>}
              <Text dimColor> {elapsed}</Text>
            </Box>
            {agents.map((a, i) => (
              <Box key={a.surface} paddingLeft={3}>
                <Text dimColor>{i === agents.length - 1 ? "└─ " : "├─ "}</Text>
                <Text color="cyan">[{a.surface.replace("surface:", "")}]</Text>
                {a.role && <Text> {a.role}</Text>}
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

// --- タスクセクション ---
function TasksSection({ state, cols }: { state: DaemonState; cols: number }) {
  if (state.taskList.length === 0) {
    return (
      <Box paddingLeft={1}>
        <Text dimColor>no tasks</Text>
      </Box>
    );
  }

  const assignedTaskIds = new Set(
    [...state.conductors.values()].map((c) => c.taskId)
  );

  return (
    <Box flexDirection="column">
      {state.taskList.map((task) => {
        const assigned = assignedTaskIds.has(task.id);
        const isClosed = task.status === "closed";
        const isDraft = !assigned && task.status === "draft";
        const color = assigned ? "green" : task.status === "ready" ? "yellow" : isClosed ? "gray" : undefined;
        const title = task.isTodo ? `TODO: ${task.title}` : task.title;
        const elapsed = task.createdAt ? ` ${formatElapsed(task.createdAt)}` : "";
        const label = assigned ? "running" : task.status;
        return (
          <Box key={task.id} paddingLeft={1}>
            <Text color={color} dimColor={isClosed}>{isClosed ? "○" : "●"} </Text>
            <Text color={color} bold dimColor={isClosed}>{task.id.padStart(3, '0')}</Text>
            <Text color={color} dimColor={isClosed}> [{label}] {title}</Text>
            {elapsed && <Text dimColor>{elapsed}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}

// --- ログセクション ---
function formatLogLine(line: string, cols: number): { time: string; event: string; detail: string; color: string } {
  const match = line.match(/^\[([^\]]+)\]\s+(\S+)\s*(.*)/);
  if (!match) return { time: "", event: "", detail: line.slice(0, cols - 2), color: "white" };
  const ts = match[1] ?? "";
  const event = match[2] ?? "";
  const detail = match[3] ?? "";
  const time = utcToLocal(ts);
  const isError = event === "error";
  const isComplete = event.includes("completed");
  const color = isError ? "red" : isComplete ? "green" : "white";
  return { time, event, detail: detail.slice(0, Math.max(0, cols - time.length - event.length - 5)), color };
}

function LogSection({ lines, cols }: { lines: string[]; cols: number }) {
  if (lines.length === 0) {
    return (
      <Box paddingLeft={1}>
        <Text dimColor>no log entries</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const { time, event, detail, color } = formatLogLine(line, cols);
        return (
          <Box key={i} paddingLeft={1}>
            <Text dimColor>{time} </Text>
            <Text color={color}>{event} </Text>
            <Text>{detail}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// --- ジャーナルセクション ---
function JournalSection({ entries, cols }: { entries: JournalEntry[]; cols: number }) {
  if (entries.length === 0) {
    return (
      <Box paddingLeft={1}>
        <Text dimColor>no journal entries</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {entries.map((entry, i) => {
        const maxMsg = Math.max(0, cols - entry.time.length - entry.icon.length - entry.taskId.length - 7);
        return (
          <Box key={i} paddingLeft={1}>
            <Text dimColor>{entry.time} </Text>
            <Text color={entry.color}>{entry.icon} </Text>
            <Text bold>#{entry.taskId.padStart(3, '0')} </Text>
            <Text>{entry.message.slice(0, maxMsg)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// --- メインダッシュボード ---
function Dashboard({ getState, version, onReload, onQuit }: DashboardProps) {
  const [state, setState] = useState(getState());
  const [activeTab, setActiveTab] = useState<ActiveTab>("journal");
  const { columns: cols, rows } = useTerminalSize();

  useEffect(() => {
    const interval = setInterval(() => {
      setState({ ...getState() });
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  useInput((input, key) => {
    if (input === "1") setActiveTab("journal");
    if (input === "2") setActiveTab("log");
    if (key.tab) setActiveTab((prev) => (prev === "journal" ? "log" : "journal"));
    if (input === "r" && onReload) onReload();
    if (input === "q" && onQuit) onQuit();
  });

  // レイアウト計算
  // header=1, sep=1, master=1, sep=1, conductor=max(1,N), sep=1, tasks=max(1,N), sep=1, footer=1, keyhint=1
  const conductorCount = Math.max(1, state.conductors.size);
  const tasksCount = Math.max(1, state.taskList.length);
  const fixedLines = 1 + 1 + 1 + 1 + conductorCount + 1 + tasksCount + 1 + 1 + 1;
  const contentLines = Math.max(1, rows - fixedLines);
  const logTail = useLogTail(state.projectRoot, contentLines);
  const journalEntries = useJournalEntries(state.projectRoot);
  const visibleJournal = journalEntries.slice(-contentLines);

  const tabLabel = activeTab === "journal" ? "Journal" : "Log";

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Header state={state} cols={cols} />
      <Sep cols={cols} label="Master" />
      <MasterSection state={state} />
      <Sep cols={cols} label={`Conductors ${state.conductors.size}/${state.maxConductors}`} />
      <ConductorsSection state={state} cols={cols} />
      <Sep cols={cols} label="Tasks" />
      <TasksSection state={state} cols={cols} />
      <Sep cols={cols} label={tabLabel} />
      <Box flexDirection="column" height={contentLines} overflow="hidden">
        {activeTab === "journal" ? (
          <JournalSection entries={visibleJournal} cols={cols} />
        ) : (
          <LogSection lines={logTail} cols={cols} />
        )}
      </Box>
      <Box justifyContent="space-between" width={cols}>
        <Box>
          <Text backgroundColor={activeTab === "journal" ? "white" : "gray"} color={activeTab === "journal" ? "black" : "white"} bold> 1 </Text>
          <Text>journal </Text>
          <Text backgroundColor={activeTab === "log" ? "white" : "gray"} color={activeTab === "log" ? "black" : "white"} bold> 2 </Text>
          <Text>log </Text>
          <Text backgroundColor="gray" color="white" bold> r </Text>
          <Text>reload </Text>
          <Text backgroundColor="gray" color="white" bold> q </Text>
          <Text>quit</Text>
        </Box>
        {version && <Text dimColor>v{version}</Text>}
      </Box>
    </Box>
  );
}

let inkInstance: ReturnType<typeof render> | null = null;

export function unmountDashboard(): void {
  if (inkInstance) {
    inkInstance.unmount();
    inkInstance.cleanup();
    inkInstance = null;
  }
}

export function startDashboard(
  getState: () => DaemonState,
  opts?: { version?: string; onReload?: () => void; onQuit?: () => void }
): void {
  inkInstance = render(<Dashboard getState={getState} version={opts?.version} onReload={opts?.onReload} onQuit={opts?.onQuit} />);
}
