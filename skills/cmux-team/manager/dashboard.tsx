/**
 * TUI Dashboard — ink ベースのリアルタイムステータス表示
 */
import React, { useState, useEffect } from "react";
import { render, Text, Box, Newline } from "ink";
import type { DaemonState } from "./daemon";

interface DashboardProps {
  getState: () => DaemonState;
}

function Dashboard({ getState }: DashboardProps) {
  const [state, setState] = useState(getState());

  useEffect(() => {
    const interval = setInterval(() => {
      setState({ ...getState() });
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const uptime = Math.floor(
    (Date.now() - state.lastUpdate.getTime()) / 1000
  );

  const conductorList = [...state.conductors.values()];

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold color="cyan">
          cmux-team v3.0
        </Text>
        <Text> | </Text>
        <Text color={state.running ? "green" : "red"}>
          {state.running ? "RUNNING" : "STOPPED"}
        </Text>
        <Text> | PID: {process.pid}</Text>
      </Box>

      <Box marginTop={1}>
        <Text bold>Master</Text>
      </Box>
      <Box paddingLeft={2}>
        {state.masterSurface ? (
          <Text color="green">{state.masterSurface} (alive)</Text>
        ) : (
          <Text color="red">not spawned</Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text bold>
          Conductors ({conductorList.length}/{state.maxConductors})
        </Text>
      </Box>
      {conductorList.length === 0 ? (
        <Box paddingLeft={2}>
          <Text dimColor>idle</Text>
        </Box>
      ) : (
        conductorList.map((c) => (
          <Box key={c.conductorId} paddingLeft={2}>
            <Text color="yellow">{c.surface}</Text>
            <Text> task={c.taskId}</Text>
            <Text dimColor> {c.conductorId}</Text>
          </Box>
        ))
      )}

      <Box marginTop={1}>
        <Text bold>Tasks</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text>open: {state.openTasks}</Text>
        <Text> | pending: {state.pendingTasks}</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          poll: {state.pollInterval / 1000}s | last: {uptime}s ago
        </Text>
      </Box>
    </Box>
  );
}

export function startDashboard(getState: () => DaemonState): void {
  render(<Dashboard getState={getState} />);
}
