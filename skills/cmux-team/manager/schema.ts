import { z } from "zod";

// --- キューメッセージ ---

export const TaskCreatedMessage = z.object({
  type: z.literal("TASK_CREATED"),
  taskId: z.string(),
  taskFile: z.string(),
  timestamp: z.string().datetime(),
});

export const ConductorDoneMessage = z.object({
  type: z.literal("CONDUCTOR_DONE"),
  conductorId: z.string(),
  sessionId: z.string().optional(),
  transcriptPath: z.string().optional(),
  surface: z.string(),
  success: z.boolean(),
  reason: z.string().optional(),
  exitCode: z.number().optional(),
  timestamp: z.string().datetime(),
});

export const AgentSpawnedMessage = z.object({
  type: z.literal("AGENT_SPAWNED"),
  conductorId: z.string(),
  surface: z.string(),
  role: z.string().optional(),
  taskTitle: z.string().optional(),
  timestamp: z.string().datetime(),
});

export const AgentDoneMessage = z.object({
  type: z.literal("AGENT_DONE"),
  conductorId: z.string(),
  surface: z.string(),
  timestamp: z.string().datetime(),
});

export const SessionStartedMessage = z.object({
  type: z.literal("SESSION_STARTED"),
  conductorId: z.string(),
  surface: z.string(),
  pid: z.number(),
  sessionId: z.string().optional(),
  timestamp: z.string().datetime(),
});

export const SessionEndedMessage = z.object({
  type: z.literal("SESSION_ENDED"),
  conductorId: z.string(),
  surface: z.string(),
  pid: z.number().optional(),
  reason: z.string().optional(),
  timestamp: z.string().datetime(),
});

export const SessionActiveMessage = z.object({
  type: z.literal("SESSION_ACTIVE"),
  conductorId: z.string(),
  surface: z.string(),
  pid: z.number().optional(),
  timestamp: z.string().datetime(),
});

export const SessionIdleMessage = z.object({
  type: z.literal("SESSION_IDLE"),
  conductorId: z.string(),
  surface: z.string(),
  pid: z.number().optional(),
  timestamp: z.string().datetime(),
});

export const ShutdownMessage = z.object({
  type: z.literal("SHUTDOWN"),
  timestamp: z.string().datetime(),
});

export const QueueMessage = z.discriminatedUnion("type", [
  TaskCreatedMessage,
  ConductorDoneMessage,
  AgentSpawnedMessage,
  AgentDoneMessage,
  SessionStartedMessage,
  SessionEndedMessage,
  SessionActiveMessage,
  SessionIdleMessage,
  ShutdownMessage,
]);

export type QueueMessage = z.infer<typeof QueueMessage>;
export type TaskCreatedMessage = z.infer<typeof TaskCreatedMessage>;
export type ConductorDoneMessage = z.infer<typeof ConductorDoneMessage>;

// --- Agent 状態 ---

export interface AgentState {
  surface: string;
  role?: string;
  taskTitle?: string;
  spawnedAt: string;
}

// --- Conductor 状態 ---

export const ConductorState = z.object({
  conductorId: z.string(),
  taskRunId: z.string().optional(),
  taskId: z.string().optional(),
  taskTitle: z.string().optional(),
  surface: z.string(),
  worktreePath: z.string().optional(),
  outputDir: z.string().optional(),
  taskStatusFile: z.string().optional(),
  startedAt: z.string().datetime(),
  pid: z.number().optional(),
  sessionId: z.string().optional(),
  disconnectedAt: z.string().datetime().optional(),
});

export type ConductorState = z.infer<typeof ConductorState> & {
  agents: AgentState[];
  status: "idle" | "running" | "done" | "disconnected";
  paneId?: string;
};
