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

// T250: broken Conductor を明示的にクリアするメッセージ（`cmux-team clear-conductor` が送る）。
// CONDUCTOR_DONE を流用すると daemon.ts の `no_task` ガードで早期 break されるため、
// 専用 handler を持つ新 message 型として分離する（A015 の決定 2 項）。
export const ConductorClearMessage = z.object({
  type: z.literal("CONDUCTOR_CLEAR"),
  surface: z.string(),
  reason: z.string().optional(),
  timestamp: z.string().datetime(),
});

export const AgentSpawnedMessage = z.object({
  type: z.literal("AGENT_SPAWNED"),
  conductorSurface: z.string(),
  surface: z.string(),
  role: z.string().optional(),
  taskTitle: z.string().optional(),
  // T260: spawn-agent CLI プロセスの発行元情報（broken な Conductor から
  // Agent が spawn され続ける現象の事後追跡用）。optional で互換性維持。
  callerPid: z.number().optional(),
  callerSurface: z.string().optional(),
  // T407: spawn-agent 側で事前発行した UUID v4 を同梱し、daemon 側で
  // agent.sessionId に格納して `task_sessions` の agent_spawned 行に書く。
  // hook 由来 SESSION_STARTED より先着するのが通常順序。
  sessionId: z.string().optional(),
  timestamp: z.string().datetime(),
});

// T323: spawn-agent 経路で selectToken が成功した直後に第 2 メッセージとして POST される。
// AGENT_SPAWNED 自体は時系列の前段（surface 作成 → AGENT_SPAWNED → Claude 起動）を確定させる
// 役割に専念し、tokenHandle 紐付けは本メッセージで後追いする（T244 race を破壊しないため分離）。
export const AgentTokenBoundMessage = z.object({
  type: z.literal("AGENT_TOKEN_BOUND"),
  surface: z.string(),
  tokenHandle: z.string(),
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
  // T407: cmdConductor 側で事前発行した UUID v4 を同梱し、daemon 側で
  // conductor.sessionId に格納して `task_sessions` の assigned 行に書く。
  // hook 由来 SESSION_STARTED より先着するのが通常順序。
  // optional のままにして、Master / 旧バージョンのクライアントとの互換性を保つ。
  sessionId: z.string().optional(),
  timestamp: z.string().datetime(),
});

// T230: Master の self-register メッセージ（pane 内 `cmux-team spawn-master` が
// claude 起動前に POST する）。pid は hook 経由の SESSION_STARTED で後追いするため optional。
export const MasterRegisteredMessage = z.object({
  type: z.literal("MASTER_REGISTERED"),
  surface: z.string(),
  pid: z.number().optional(),
  // T408: cmdLaunchMaster 側で事前発行した UUID v4 を同梱し、daemon 側で
  // master.sessionId に格納する。hook 由来 SESSION_STARTED より先着するのが通常順序。
  // optional のままにして、旧バージョンのクライアントとの互換性を保つ。
  // task_sessions テーブルへの master 行追加は scope 外（Master は tool_use を発火しない）。
  sessionId: z.string().optional(),
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

// T266: Claude Code Notification hook からの通知。
// hook 側で分岐せず丸ごと daemon に渡し、payload は任意 JSON で受ける。
// - surfaceUuid / workspaceUuid は cmux 側の env 実在性が環境依存のため UUID 形式制約はかけない（空文字→undefined 正規化は呼出し側で行う）
// - role は hook 側で埋めた canonical 値。daemon が逆引きに失敗した場合の fallback 情報
// - payload は Claude Code の stdin JSON（schema 非公開）を丸ごと保存
export const NotificationMessage = z.object({
  type: z.literal("NOTIFICATION"),
  surface: z.string(),
  surfaceUuid: z.string().optional(),
  workspaceUuid: z.string().optional(),
  pid: z.number(),
  role: z.enum(["master", "conductor", "agent"]).optional(),
  payload: z.record(z.string(), z.any()).optional(),
  timestamp: z.string().datetime(),
});

// T392: Claude Code StopFailure hook 受信時のメッセージ。
// payload.error は 4 種別（rate_limit / authentication_failed / billing_error / server_error）+
// forward-compat の string union。role は hook 側で hardcode する契約。
// pid は NotificationMessage / SessionStopMessage と同じく required（settings.json は --pid "$PPID" を必ず付ける）。
export const StopFailureMessage = z.object({
  type: z.literal("STOP_FAILURE"),
  surface: z.string(),
  pid: z.number(),
  role: z.enum(["master", "conductor", "agent"]).optional(),
  payload: z.object({
    session_id: z.string().optional(),
    transcript_path: z.string().optional(),
    error: z.string(),
    last_assistant_message: z.string().optional(),
  }),
  timestamp: z.string().datetime(),
});

// T379: Claude Code の PreToolUse / PostToolUse hook 受信時のメッセージ。
// hook 側で分岐せず stdin 生 JSON を payload に丸ごと持たせ、daemon が trace DB に書き込む。
// - toolName: payload.tool_name と同値（trace DB の専用列に分離する集計用ショートカット）
// - sessionId: hook stdin の session_id（task_sessions と JOIN するため optional だが基本は埋まる）
// - role: settings.json テンプレートで `--role` flag によりハードコードされる
// - payload: tool_input / tool_response を含む生 JSON。tool_response.content は trace 記録前に 1KB に切り詰める
export const PreToolUseMessage = z.object({
  type: z.literal("PRE_TOOL_USE"),
  surface: z.string(),
  pid: z.number(),
  role: z.enum(["master", "conductor", "agent"]).optional(),
  sessionId: z.string().optional(),
  toolName: z.string(),
  payload: z.record(z.string(), z.any()).optional(),
  timestamp: z.string().datetime(),
});

export const PostToolUseMessage = z.object({
  type: z.literal("POST_TOOL_USE"),
  surface: z.string(),
  pid: z.number(),
  role: z.enum(["master", "conductor", "agent"]).optional(),
  sessionId: z.string().optional(),
  toolName: z.string(),
  payload: z.record(z.string(), z.any()).optional(),
  timestamp: z.string().datetime(),
});

// T379: Conductor の Bash deny script が `cmux send` 系を拒否したときに送るメッセージ。
// Claude Code 側からは PreToolUse hook の exit 2 が deny を発火させるが、その事実は
// Claude Code から daemon に通知されないため、hook script 側で明示的に send する。
// 集計上は「hook block 率」として扱う（現状は Conductor の Bash deny 率に限定）。
export const PreToolUseDeniedMessage = z.object({
  type: z.literal("PRE_TOOL_USE_DENIED"),
  surface: z.string(),
  pid: z.number(),
  role: z.enum(["master", "conductor", "agent"]).optional(),
  reason: z.string().optional(),
  timestamp: z.string().datetime(),
});

export const QueueMessage = z.discriminatedUnion("type", [
  TaskCreatedMessage,
  TaskUpdatedMessage,
  ConductorDoneMessage,
  ConductorClearMessage,
  ConductorRegisteredMessage,
  MasterRegisteredMessage,
  AgentSpawnedMessage,
  AgentTokenBoundMessage,
  SessionStartedMessage,
  SessionEndedMessage,
  SessionActiveMessage,
  SessionIdleMessage,
  SessionAskMessage,
  SessionStopMessage,
  SessionClearMessage,
  NotificationMessage,
  StopFailureMessage,
  PreToolUseMessage,
  PostToolUseMessage,
  PreToolUseDeniedMessage,
  ShutdownMessage,
]);

export type QueueMessage = z.infer<typeof QueueMessage>;
export type TaskCreatedMessage = z.infer<typeof TaskCreatedMessage>;
export type TaskUpdatedMessage = z.infer<typeof TaskUpdatedMessage>;
export type ConductorDoneMessage = z.infer<typeof ConductorDoneMessage>;
export type ConductorClearMessage = z.infer<typeof ConductorClearMessage>;
export type ConductorRegisteredMessage = z.infer<typeof ConductorRegisteredMessage>;
export type MasterRegisteredMessage = z.infer<typeof MasterRegisteredMessage>;
export type SessionAskMessage = z.infer<typeof SessionAskMessage>;
export type SessionStopMessage = z.infer<typeof SessionStopMessage>;
export type SessionStartedMessage = z.infer<typeof SessionStartedMessage>;
export type SessionEndedMessage = z.infer<typeof SessionEndedMessage>;
export type NotificationMessage = z.infer<typeof NotificationMessage>;
export type StopFailureMessage = z.infer<typeof StopFailureMessage>;
export type AgentTokenBoundMessage = z.infer<typeof AgentTokenBoundMessage>;
export type PreToolUseMessage = z.infer<typeof PreToolUseMessage>;
export type PostToolUseMessage = z.infer<typeof PostToolUseMessage>;
export type PreToolUseDeniedMessage = z.infer<typeof PreToolUseDeniedMessage>;

// --- Deliverable (T295) ---

/**
 * T295: `close-task` で記録する納品方式。discriminated union で kind ごとに
 * 必須フィールドを型レベルで分離する。`task-state.json` の closed 行に
 * optional フィールドとして書き込まれる（旧 closed 行は undefined のまま読める）。
 *
 * - `files`: 調査系 / ドキュメント系 / branch を残さない納品。納品物パスの配列を必須
 * - `merged`: ローカル feature branch を main に ff-only マージした納品。branch 名 + SHA 必須
 * - `pr`: GitHub PR を open した納品。PR URL 必須
 * - `none`: 納品物なし（judgment_pending / auto-close / 調査のみで決着等）
 */
export const Deliverable = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("files"), files: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("merged"), branch: z.string(), sha: z.string() }),
  z.object({ kind: z.literal("pr"), prUrl: z.string() }),
  z.object({ kind: z.literal("none") }),
]);
export type Deliverable = z.infer<typeof Deliverable>;

// --- Agent 状態 ---

export interface AgentState {
  surface: string;
  role?: string;
  taskTitle?: string;
  spawnedAt: string;
  sessionId?: string;
  pid?: number;
  pidWatcherInterval?: ReturnType<typeof setInterval>;
  // T236: TUI spinner のために Conductor と対称の status を持つ。
  // AGENT_SPAWNED で "starting"、SESSION_STARTED で "running"、SESSION_IDLE で "idle"。
  // T238: SESSION_ASK で "asking"。SESSION_STARTED/IDLE で自然上書きにより解除される。
  // T392: StopFailure hook 受信で "error"。次の SESSION_STARTED/IDLE/ASK で自然解除。
  status: "starting" | "running" | "idle" | "asking" | "error";
  // T323: token pool 機能でこの Agent が使用しているトークンの handle。
  // spawn-agent 経路で selectToken 成功時に AGENT_TOKEN_BOUND 経由で daemon へ反映される。
  tokenHandle?: string;
  // T392: StopFailure hook 受信時の最新 API エラー情報。
  // 上書きは hook 受信時のみ。AGENT_SPAWNED / SESSION_STARTED / SESSION_IDLE で undefined に戻る。
  // team.json には永続化される（pidWatcherInterval と違い JSON serialize 可）。
  lastApiError?: {
    kind: string;
    message?: string;
    at: string;
  };
}

// --- Master 状態 ---

export const MasterStateSchema = z.object({
  surface: z.string(),
  pid: z.number().optional(),
  // T230: "starting" は MASTER_REGISTERED handler で set される初期状態。
  // SESSION_STARTED 到達で running へ遷移する。永続ファイルに "starting" が残っても
  // `restoreMasters` が idle に hardcode reset するため後方互換は壊れない。
  // T392: "error" = StopFailure hook 受信時。次の SESSION_STARTED/IDLE で自然解除。
  status: z.enum(["starting", "idle", "running", "disconnected", "error"]),
  startedAt: z.string().datetime(),
  disconnectedAt: z.string().datetime().optional(),
  prompt: z.string().optional(),
  // T323: token pool 機能でこの Master が使用しているトークンの handle。
  // proxy.ts が auth_hash → tokens.db の handle を解決して書き戻す。
  tokenHandle: z.string().optional(),
  // T408: cmdLaunchMaster 側で事前発行した UUID v4。MASTER_REGISTERED で daemon に
  // 通知され、SESSION_STARTED hook 経由で更新もされる。team.json に永続化される。
  // 旧バージョンの team.json (sessionId 無し) でも parse 可能となるよう optional。
  sessionId: z.string().optional(),
  // T392: StopFailure hook 受信時の最新 API エラー情報。team.json に永続化される。
  lastApiError: z
    .object({
      kind: z.string(),
      message: z.string().optional(),
      at: z.string().datetime(),
    })
    .optional(),
});

export type MasterState = z.infer<typeof MasterStateSchema> & {
  pidWatcherInterval?: ReturnType<typeof setInterval>;
  /**
   * T234: SESSION_STARTED の F1 fallback で作成された仮 master 登録を示すランタイム限定マーカー。
   * MASTER_REGISTERED 本登録 / CONDUCTOR_REGISTERED 到着時に掃除対象を識別する。
   * 永続化しない（`persistMasterFile` は payload に含めない）。
   */
  fallback?: boolean;
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
  // T260: 最後に SESSION_* hook を受信した時刻（ISO 8601）。
  // disconnect snapshot ログ (formatConductorSnapshot) で「最後に生存確認できた時刻」として使う。
  // team.json に永続化するため、daemon 再起動後は古い値で復元される
  // （次の SESSION_* 受信で上書きされるので許容）。
  lastHookAt: z.string().datetime().optional(),
  // T261: user_clear 誤判定調査のための判定根拠スナップショット用フィールド群。
  // daemon.ts の formatUserClearDecision / SESSION_IDLE の source_guess で読み出す。
  //
  // 永続化対象（team.json に残す）:
  //   - clearSentAt: daemon 再起動後も「clear からの経過 ms」を user_clear_decision_snapshot
  //     で計算できるよう残す。再起動後は古い値が残り得るが、判定分岐には影響せずログ表示のみ。
  clearSentAt: z.string().datetime().optional(),
  // ランタイム限定（永続化しない — restoreConductors で undefined に戻る）:
  //   - promptSentAt / promptBytes: assignTask でプロンプト送信完了時刻とサイズ
  //   - sessionStartedClearAt: SESSION_STARTED(source=clear) で assigning → running 遷移した時刻
  //   - assigningSetAt: assignTask が status="assigning" にセットした時刻（T265）
  promptSentAt: z.string().datetime().optional(),
  promptBytes: z.number().optional(),
  sessionStartedClearAt: z.string().datetime().optional(),
  assigningSetAt: z.string().datetime().optional(),
  // T323: token pool 機能でこの Conductor が使用しているトークンの handle。
  // proxy.ts が auth_hash → tokens.db の handle を解決して書き戻す。
  tokenHandle: z.string().optional(),
  // T392: StopFailure hook 受信時の最新 API エラー情報。team.json に永続化される。
  lastApiError: z
    .object({
      kind: z.string(),
      message: z.string().optional(),
      at: z.string().datetime(),
    })
    .optional(),
});

export type ConductorState = z.infer<typeof ConductorState> & {
  agents: AgentState[];
  // T250: "broken" = disconnect timeout 到達後の確定した異常状態。
  // cleanup 済み（worktree / branch / siblings）だが、state.conductors には残す。
  // ユーザーが `cmux-team clear-conductor` で明示的に idle に戻すまで保持される。
  // T392: "error" = StopFailure hook 受信時。次の SESSION_STARTED/IDLE で自然解除。
  status:
    | "starting"
    | "assigning"
    | "idle"
    | "running"
    | "asking"
    | "disconnected"
    | "broken"
    | "error";
  pidWatcherInterval?: ReturnType<typeof setInterval>;
  /** Issue #30 M3-b: spawn 時に backend から返却された SessionRef。
   *  opencode backend では opencode session ID、claude-code では surface 文字列。
   *  handleRuntimeEvent が session ref → conductor のルックアップに使う。 */
  runtimeSessionRef?: string;
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

// --- Agent ロール (T247) ---

/**
 * Agent ロール列挙。`.team/agent-instructions/<role>.md` の role 名と
 * spawn-agent の --role 引数の canonical 値の両方で使う。
 */
export const AgentRole = z.enum([
  "researcher",
  "architect",
  "planner",
  "design-reviewer",
  "implementer",
  "inspector",
  "dockeeper",
  "task-manager",
]);
export type AgentRole = z.infer<typeof AgentRole>;
export const AGENT_ROLES: readonly AgentRole[] = AgentRole.options;

/**
 * role エイリアスを正規化する。未知 role は undefined を返す。
 * 現状のエイリアス: `impl` → `implementer`, `reviewer` → `design-reviewer`
 * （conductor-role.md の heredoc サンプルが歴史的に `--role impl` を使っているため）。
 */
export function normalizeAgentRole(raw: string): AgentRole | undefined {
  const alias: Record<string, AgentRole> = {
    impl: "implementer",
    reviewer: "design-reviewer",
  };
  const key = alias[raw] ?? raw;
  const parsed = AgentRole.safeParse(key);
  return parsed.success ? parsed.data : undefined;
}

// --- Overlay 対応ロール (T342) ---

/**
 * `.team/agent-instructions/<role>.md` overlay の対象ロール列挙。
 * `AgentRole` 8 件に加えて `master` / `conductor` を含む 10 件のタプル。
 *
 * - spawn-agent の `--role` 引数は引き続き `AgentRole` のみ受け付ける
 *   （`requireSpawnableAgentRole`）。master / conductor は agent として spawn できない
 * - get/set/delete/list-agent-instructions と
 *   generateMasterPrompt / generateConductorRolePrompt の overlay 経路は
 *   `OverlayRole` を受け付ける
 */
export const OverlayRole = z.enum([
  ...AgentRole.options,
  "master",
  "conductor",
] as const);
export type OverlayRole = z.infer<typeof OverlayRole>;
export const OVERLAY_ROLES: readonly OverlayRole[] = OverlayRole.options;

/**
 * `OverlayRole` 用の正規化。`AgentRole` のエイリアス（`impl` / `reviewer`）も継承する。
 * 未知 role は `undefined` を返す。
 */
export function normalizeOverlayRole(raw: string): OverlayRole | undefined {
  const agent = normalizeAgentRole(raw);
  if (agent) return agent;
  const parsed = OverlayRole.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

// --- レイアウトモード ---

export const LayoutMode = z.enum(["wide", "16x9"]);
export type LayoutMode = z.infer<typeof LayoutMode>;

/** 各 layout で作成する Conductor 数（env CMUX_TEAM_MAX_CONDUCTORS 未指定時の既定値） */
export const LAYOUT_MAX_CONDUCTORS: Record<LayoutMode, number> = {
  wide: 3,
  "16x9": 2,
};

// --- Main branch resolution (T213) ---

export const MainBranchSource = z.enum(["config", "detected"]);
export type MainBranchSource = z.infer<typeof MainBranchSource>;

export interface MainBranchResolution {
  branch: string;
  source: MainBranchSource;
}

// --- Worktree base resolution (T242) ---

export const WorktreeBaseSource = z.enum([
  "explicit",
  "config-local-ahead",
  "config-origin",
  "config-local",
  "head-fallback",
]);
export type WorktreeBaseSource = z.infer<typeof WorktreeBaseSource>;

export interface WorktreeBaseResolution {
  startPoint: string | null;
  source: WorktreeBaseSource;
  baseLabel: string;
}

// --- Auto update mode ---

export const AutoUpdateMode = z.enum(["off", "notify"]);
export type AutoUpdateMode = z.infer<typeof AutoUpdateMode>;

/**
 * config / env の生値を AutoUpdateMode に正規化する（T294）。
 * - string: "off"/"notify" のみ許容。それ以外は throw
 * - undefined/null: "off"
 *
 * T294 (v4.5.0): `"task"` と boolean 後方互換（true→"task" / false→"off"）を削除した。
 * 旧値が残っている場合は明示的に throw してユーザーに移行ガイドを示す。
 */
export function normalizeAutoUpdate(val: unknown): AutoUpdateMode {
  if (val === undefined || val === null) return "off";
  if (typeof val === "string") {
    const v = val.trim().toLowerCase();
    if (v === "off" || v === "notify") return v;
    throw new Error(
      `unknown autoUpdate value: ${JSON.stringify(val)} (expected "off" or "notify"; ` +
        `"task" / true / false were removed in v4.5.0 — see CHANGELOG)`,
    );
  }
  throw new Error(
    `unknown autoUpdate value type: ${typeof val} ` +
      `(v4.5.0 no longer accepts boolean; use "off" or "notify" instead)`,
  );
}
