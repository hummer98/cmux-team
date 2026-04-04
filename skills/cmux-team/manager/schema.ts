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
  conductorSurface: z.string(),
  surface: z.string(),
  role: z.string().optional(),
  taskTitle: z.string().optional(),
  timestamp: z.string().datetime(),
});

export const SessionStartedMessage = z.object({
  type: z.literal("SESSION_STARTED"),
  surface: z.string(),
  pid: z.number(),
  sessionId: z.string().optional(),
  timestamp: z.string().datetime(),
});

export const SessionEndedMessage = z.object({
  type: z.literal("SESSION_ENDED"),
  surface: z.string(),
  pid: z.number().optional(),
  reason: z.string().optional(),
  timestamp: z.string().datetime(),
});

export const ConductorRegisteredMessage = z.object({
  type: z.literal("CONDUCTOR_REGISTERED"),
  surface: z.string(),
  paneId: z.string(),
  timestamp: z.string().datetime(),
});

export const SessionActiveMessage = z.object({
  type: z.literal("SESSION_ACTIVE"),
  surface: z.string(),
  pid: z.number().optional(),
  timestamp: z.string().datetime(),
});

export const SessionIdleMessage = z.object({
  type: z.literal("SESSION_IDLE"),
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
  ConductorRegisteredMessage,
  AgentSpawnedMessage,
  SessionStartedMessage,
  SessionEndedMessage,
  SessionActiveMessage,
  SessionIdleMessage,
  ShutdownMessage,
]);

export type QueueMessage = z.infer<typeof QueueMessage>;
export type TaskCreatedMessage = z.infer<typeof TaskCreatedMessage>;
export type ConductorDoneMessage = z.infer<typeof ConductorDoneMessage>;
export type ConductorRegisteredMessage = z.infer<typeof ConductorRegisteredMessage>;

// --- Agent 状態 ---

export interface AgentState {
  surface: string;
  role?: string;
  taskTitle?: string;
  spawnedAt: string;
  sessionId?: string;
}

// --- Conductor 状態 ---

export const ConductorState = z.object({
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
  status: "starting" | "idle" | "running" | "done" | "disconnected";
  paneId?: string;
};
