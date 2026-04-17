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
  taskRunId: z.string().optional(),
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
  source: z.enum(["startup", "resume", "clear", "compact"]).optional(),
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
  timestamp: z.string().datetime(),
});

// T189/T208: Stop hook からの生データ（Manager 側で ASK/IDLE に分類する）
export const SessionStopMessage = z.object({
  type: z.literal("SESSION_STOP"),
  surface: z.string(),
  pid: z.number(),
  timestamp: z.string().datetime(),
  payload: z.object({
    transcript_path: z.string().optional(),
  }),
});

export const SessionClearMessage = z.object({
  type: z.literal("SESSION_CLEAR"),
  surface: z.string(),
  taskRunId: z.string().optional(),
  pid: z.number().optional(),
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
  SessionStopMessage,
  SessionClearMessage,
  ShutdownMessage,
]);

export type QueueMessage = z.infer<typeof QueueMessage>;
export type TaskCreatedMessage = z.infer<typeof TaskCreatedMessage>;
export type TaskUpdatedMessage = z.infer<typeof TaskUpdatedMessage>;
export type ConductorDoneMessage = z.infer<typeof ConductorDoneMessage>;
export type ConductorRegisteredMessage = z.infer<typeof ConductorRegisteredMessage>;
export type SessionAskMessage = z.infer<typeof SessionAskMessage>;
export type SessionStopMessage = z.infer<typeof SessionStopMessage>;
export type SessionStartedMessage = z.infer<typeof SessionStartedMessage>;
export type SessionEndedMessage = z.infer<typeof SessionEndedMessage>;

// --- Agent 状態 ---

export interface AgentState {
  surface: string;
  role?: string;
  taskTitle?: string;
  spawnedAt: string;
  sessionId?: string;
  pid?: number;
  pidWatcherInterval?: ReturnType<typeof setInterval>;
}

// --- Master 状態 ---

export const MasterStateSchema = z.object({
  surface: z.string(),
  pid: z.number().optional(),
  status: z.enum(["idle", "running", "disconnected"]),
  startedAt: z.string().datetime(),
  disconnectedAt: z.string().datetime().optional(),
  prompt: z.string().optional(),
});

export type MasterState = z.infer<typeof MasterStateSchema> & {
  pidWatcherInterval?: ReturnType<typeof setInterval>;
};

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
  // T181: AskUserQuestion 検出時の質問本文（hook が SESSION_ASK で通知）
  askQuestion: z.string().optional(),
});

export type ConductorState = z.infer<typeof ConductorState> & {
  agents: AgentState[];
  status: "starting" | "assigning" | "idle" | "running" | "asking" | "disconnected";
  pidWatcherInterval?: ReturnType<typeof setInterval>;
};

// --- レート制限情報 ---

/**
 * RateLimitInfo の Zod スキーマ。
 * `.team/rate-limit.json` への永続化・復元時に `safeParse` でフィールド健全性を検証する。
 */
export const RateLimitInfoSchema = z.object({
  /** tokens remaining（分単位ウィンドウ） */
  tokensRemaining: z.number(),
  /** tokens limit（分単位ウィンドウ） */
  tokensLimit: z.number(),
  /** tokens reset（ISO 8601） */
  tokensReset: z.string(),
  /** input tokens remaining */
  inputTokensRemaining: z.number(),
  /** output tokens remaining */
  outputTokensRemaining: z.number(),
  /** unified 5h 使用率（0.0-1.0、null = ヘッダーなし） */
  unified5hUtilization: z.number().nullable(),
  /** unified 7d 使用率（0.0-1.0、null = ヘッダーなし） */
  unified7dUtilization: z.number().nullable(),
  /** unified 5h リセット時刻（unix timestamp 文字列、null = ヘッダーなし） */
  unified5hReset: z.string().nullable(),
  /** unified 7d リセット時刻（unix timestamp 文字列、null = ヘッダーなし） */
  unified7dReset: z.string().nullable(),
  /** unified ステータス（allowed/rate_limited、null = ヘッダーなし） */
  unifiedStatus: z.string().nullable(),
  /** 最終更新時刻 */
  updatedAt: z.string(),
});

export type RateLimitInfo = z.infer<typeof RateLimitInfoSchema>;

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

// --- Main branch resolution (T213) ---

export const MainBranchSource = z.enum(["config", "detected", "fallback"]);
export type MainBranchSource = z.infer<typeof MainBranchSource>;

export interface MainBranchResolution {
  branch: string;
  source: MainBranchSource;
}

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
