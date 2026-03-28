import { z } from "zod";

// --- キューメッセージ ---

export const TaskCreatedMessage = z.object({
  type: z.literal("TASK_CREATED"),
  taskId: z.string(),
  taskFile: z.string(),
  timestamp: z.string().datetime(),
});

export const TodoMessage = z.object({
  type: z.literal("TODO"),
  content: z.string().min(1),
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
  timestamp: z.string().datetime(),
});

export const AgentDoneMessage = z.object({
  type: z.literal("AGENT_DONE"),
  conductorId: z.string(),
  surface: z.string(),
  timestamp: z.string().datetime(),
});

export const ShutdownMessage = z.object({
  type: z.literal("SHUTDOWN"),
  timestamp: z.string().datetime(),
});

export const QueueMessage = z.discriminatedUnion("type", [
  TaskCreatedMessage,
  TodoMessage,
  ConductorDoneMessage,
  AgentSpawnedMessage,
  AgentDoneMessage,
  ShutdownMessage,
]);

export type QueueMessage = z.infer<typeof QueueMessage>;
export type TaskCreatedMessage = z.infer<typeof TaskCreatedMessage>;
export type TodoMessage = z.infer<typeof TodoMessage>;
export type ConductorDoneMessage = z.infer<typeof ConductorDoneMessage>;

// --- Agent 状態 ---

export interface AgentState {
  surface: string;
  role?: string;
  spawnedAt: string;
}

// --- Conductor 状態 ---

export const ConductorState = z.object({
  conductorId: z.string(),
  taskId: z.string(),
  taskTitle: z.string().optional(),
  surface: z.string(),
  worktreePath: z.string(),
  outputDir: z.string(),
  startedAt: z.string().datetime(),
});

export type ConductorState = z.infer<typeof ConductorState> & {
  agents: AgentState[];
  doneCandidate: boolean;
};
