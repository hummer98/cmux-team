/**
 * TUI Dashboard — ink フルスクリーンダッシュボード
 *
 * top のようなフルスクリーン表示。ターミナルサイズにレスポンシブ。
 * 上部: ヘッダー（ステータス・PID・uptime）
 * 中部: Master / Conductors / Tasks パネル
 * 下部: manager.log の末尾（残りスペースを全て使う）
 */
import React, { useState, useEffect } from "react";
import { render, Text, Box, useStdout } from "ink";
import { readFile } from "fs/promises";
import { join } from "path";
import type { DaemonState } from "./daemon";

interface DashboardProps {
  getState: () => DaemonState;
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

function formatUptime(startMs: number): string {
  const sec = Math.floor((Date.now() - startMs) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
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
        <Text>{state.masterSurface}</Text>
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
        return (
          <Box key={c.conductorId} paddingLeft={1}>
            <Text color="yellow">● </Text>
            <Text>{c.surface}</Text>
            <Text dimColor> task=</Text>
            <Text bold>{c.taskId}</Text>
            {c.taskTitle && <Text color="white"> {c.taskTitle}</Text>}
            <Text dimColor> {elapsed}</Text>
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
  const time = ts.slice(11, 19);
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

// --- メインダッシュボード ---
function Dashboard({ getState }: DashboardProps) {
  const [state, setState] = useState(getState());
  const { columns: cols, rows } = useTerminalSize();

  useEffect(() => {
    const interval = setInterval(() => {
      setState({ ...getState() });
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  // レイアウト計算
  // header=1, sep=1, master=1, sep=1, conductor=max(1,N), sep=1, footer余白=1
  const conductorCount = Math.max(1, state.conductors.size);
  const fixedLines = 1 + 1 + 1 + 1 + conductorCount + 1 + 1;
  const logLines = Math.max(1, rows - fixedLines);
  const logTail = useLogTail(state.projectRoot, logLines);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Header state={state} cols={cols} />
      <Sep cols={cols} label="Master" />
      <MasterSection state={state} />
      <Sep cols={cols} label={`Conductors ${state.conductors.size}/${state.maxConductors}`} />
      <ConductorsSection state={state} cols={cols} />
      <Sep cols={cols} label="Log" />
      <Box flexDirection="column" height={logLines} overflow="hidden">
        <LogSection lines={logTail} cols={cols} />
      </Box>
    </Box>
  );
}

export function startDashboard(getState: () => DaemonState): void {
  render(<Dashboard getState={getState} />);
}
