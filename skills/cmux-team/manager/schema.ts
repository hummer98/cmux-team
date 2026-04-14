import { z } from "zod";

// --- キューメッセージ ---

export const TaskCreatedMessage = z.object({
  type: z.literal("TASK_CREATED"),
  taskId: z.string(),
  taskFile: z.string(),
  timestamp: z.string().datetime(),
});

export const TaskUpdatedMessage = z.object({
  type: z.literal("TASK_UPDATED"),
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

export const SessionAskMessage = z.object({
  type: z.literal("SESSION_ASK"),
  surface: z.string(),
  question: z.string(),
  pid: z.number().optional(),
  conductorId: z.string().optional(),
  timestamp: z.string().datetime(),
});

export const SessionClearMessage = z.object({
  type: z.literal("SESSION_CLEAR"),
  surface: z.string(),
  conductorId: z.string().optional(),
  pid: z.number().optional(),
  timestamp: z.string().datetime(),
});

export const ConductorSessionMessage = z.object({
  type: z.literal("CONDUCTOR_SESSION"),
  surface: z.string(),
  sessionId: z.string(),
  timestamp: z.string().datetime(),
});

export const ShutdownMessage = z.object({
  type: z.literal("SHUTDOWN"),
  timestamp: z.string().datetime(),
});

export const QueueMessage = z.discriminatedUnion("type", [
  TaskCreatedMessage,
  TaskUpdatedMessage,
  ConductorDoneMessage,
  ConductorRegisteredMessage,
  AgentSpawnedMessage,
  SessionStartedMessage,
  SessionEndedMessage,
  SessionActiveMessage,
  SessionIdleMessage,
  SessionAskMessage,
  SessionClearMessage,
  ConductorSessionMessage,
  ShutdownMessage,
]);

export type QueueMessage = z.infer<typeof QueueMessage>;
export type TaskCreatedMessage = z.infer<typeof TaskCreatedMessage>;
export type TaskUpdatedMessage = z.infer<typeof TaskUpdatedMessage>;
export type ConductorDoneMessage = z.infer<typeof ConductorDoneMessage>;
export type ConductorRegisteredMessage = z.infer<typeof ConductorRegisteredMessage>;
export type ConductorSessionMessage = z.infer<typeof ConductorSessionMessage>;
export type SessionAskMessage = z.infer<typeof SessionAskMessage>;

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
  startedAt: z.string().datetime(),
  pid: z.number().optional(),
  sessionId: z.string().optional(),
  disconnectedAt: z.string().datetime().optional(),
  // T180: cmux tree タイムアウト連続失敗カウンタ
  //   - tree 成功時に reset される
  //   - 閾値超過で `kind=cmux_unresponsive` として disconnected 化
  //   - 既存セッション互換のため optional
  treeFailureCount: z.number().optional(),
  treeFailureFirstAt: z.string().datetime().optional(),
  // T181: AskUserQuestion 検出時の質問本文（hook が SESSION_ASK で通知）
  askQuestion: z.string().optional(),
});

export type ConductorState = z.infer<typeof ConductorState> & {
  agents: AgentState[];
  status: "starting" | "idle" | "running" | "asking" | "disconnected";
  paneId?: string;
  pidWatcherInterval?: ReturnType<typeof setInterval>;
};

// --- レート制限情報 ---

export interface RateLimitInfo {
  /** tokens remaining（分単位ウィンドウ） */
  tokensRemaining: number;
  /** tokens limit（分単位ウィンドウ） */
  tokensLimit: number;
  /** tokens reset（ISO 8601） */
  tokensReset: string;
  /** input tokens remaining */
  inputTokensRemaining: number;
  /** output tokens remaining */
  outputTokensRemaining: number;
  /** unified 5h 使用率（0.0-1.0、null = ヘッダーなし） */
  unified5hUtilization: number | null;
  /** unified 7d 使用率（0.0-1.0、null = ヘッダーなし） */
  unified7dUtilization: number | null;
  /** unified 5h リセット時刻（unix timestamp 文字列、null = ヘッダーなし） */
  unified5hReset: string | null;
  /** unified 7d リセット時刻（unix timestamp 文字列、null = ヘッダーなし） */
  unified7dReset: string | null;
  /** unified ステータス（allowed/rate_limited、null = ヘッダーなし） */
  unifiedStatus: string | null;
  /** 最終更新時刻 */
  updatedAt: string;
}

// --- スロットリング閾値 ---

/** 5h unified utilization がこの値以上なら新規タスク割り当てを停止 */
export const THROTTLE_5H_THRESHOLD = 0.90;

// --- レイアウトモード ---

export const LayoutMode = z.enum(["wide", "16x9"]);
export type LayoutMode = z.infer<typeof LayoutMode>;

/** 各 layout で作成する Conductor 数（env CMUX_TEAM_MAX_CONDUCTORS 未指定時の既定値） */
export const LAYOUT_MAX_CONDUCTORS: Record<LayoutMode, number> = {
  wide: 3,
  "16x9": 2,
};

// --- Auto update mode ---

export const AutoUpdateMode = z.enum(["off", "notify", "task"]);
export type AutoUpdateMode = z.infer<typeof AutoUpdateMode>;

/**
 * config / env の生値を AutoUpdateMode に正規化する。
 * - boolean: true→"task", false→"off"（T186 後方互換）
 * - string: "off"/"notify"/"task" のみ許容。それ以外は throw
 * - undefined/null: "off"
 */
export function normalizeAutoUpdate(val: unknown): AutoUpdateMode {
  if (val === undefined || val === null) return "off";
  if (typeof val === "boolean") return val ? "task" : "off";
  if (typeof val === "string") {
    const v = val.trim().toLowerCase();
    if (v === "off" || v === "notify" || v === "task") return v;
    throw new Error(`unknown autoUpdate value: ${JSON.stringify(val)} (expected off|notify|task|true|false)`);
  }
  throw new Error(`unknown autoUpdate value type: ${typeof val}`);
}
