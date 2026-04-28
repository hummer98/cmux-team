/**
 * statusline フォーマッタ (T211)
 *
 * `skills/cmux-team/manager/statusline.sh` (旧 bash 版) の描画ロジックを
 * TypeScript に移植した純関数群。proxy.ts の POST /statusline ハンドラから
 * 呼び出され、DaemonState + surface ヘッダーから 1 行の statusline 文字列を生成する。
 *
 * 現行 bash 版の出力とバイト単位で一致させる方針（末尾改行のみ proxy 側で省略）。
 */
import { execFileSync } from "child_process";

/** Claude Code が stdin で渡す JSON の関心部分を抽出した型 */
export interface StatuslineInput {
  model?: string | { id?: string } | undefined;
  context_window?: { used_percentage?: number };
  context?: { used_percentage?: number };
  workspace?: { current_dir?: string };
  cwd?: string;
  working_dir?: string;
}

/** 描画に必要な DaemonState の最小サブセット */
export interface StatuslineState {
  running?: boolean;
  bootPhase?: "infra" | "conductors" | "master" | "ready";
  /** T229: 複数 Master をサポート。proxy.ts が Map→Array で渡す */
  masters?: Array<{
    surface: string;
    status?: "idle" | "running" | "disconnected";
    pid?: number;
  }>;
  conductors: Map<string, StatuslineConductor>;
  taskList?: Array<{ id: string; status: string; title: string }>;
}

export interface StatuslineConductor {
  surface: string;
  taskId?: string;
  taskTitle?: string;
  status?: "starting" | "assigning" | "idle" | "running" | "asking" | "disconnected";
  agents?: Array<{
    surface: string;
    role?: string;
    taskTitle?: string;
    /** T375: token pool 有効時に agent が掴んでいる handle（`@xxx`）。未設定なら表示しない */
    tokenHandle?: string;
  }>;
}

/** リクエスト毎の描画オプション（ヘッダー由来） */
export interface StatuslineOptions {
  /** X-Cmux-Surface ヘッダー必須 */
  surface: string;
  /** X-Cmux-Nerd-Font (default true) */
  nerdFont: boolean;
  /** X-Cmux-Statusline-Color (default false) */
  color: boolean;
  /** git branch 解決用 cwd (未指定なら input から解決) */
  workdir?: string;
}

/** role 判定結果 (surface からの逆引き) */
export type StatuslineRole =
  | { kind: "master" }
  | { kind: "conductor"; conductor: StatuslineConductor }
  | {
      kind: "agent";
      conductorSurface: string;
      agent: {
        surface: string;
        role?: string;
        taskTitle?: string;
        tokenHandle?: string;
      };
    }
  | { kind: "unknown" };

// --- 色コード・アイコン定義 ---

const ANSI = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
} as const;

/**
 * Nerd Font / fallback アイコン。
 * 現行 bash 版 (`statusline.sh`) の `nf "$nerd" "$fallback"` 呼び出しと
 * 1 バイト単位で一致させる必要がある。
 *
 * 現行 bash 版は NF 有効時の glyph を殆ど空文字にしており (TASK_ICON のみ `󰝖`)、
 * NF 無効時は ♦ / ▸ / ctx / T などの ASCII fallback を用いる。
 */
const ICONS = {
  master: {
    on: { icon: "", m: "", ctx: "", task: "󰝖", br: "" },
    off: { icon: "♦", m: "", ctx: "ctx", task: "T", br: "" },
  },
  conductor: {
    on: { icon: "", ctx: "", m: "" },
    off: { icon: "♦", ctx: "ctx", m: "" },
  },
  agent: {
    on: { icon: "", ctx: "" },
    off: { icon: "▸", ctx: "ctx" },
  },
} as const;

// --- 純関数（テストしやすく分離） ---

/** `claude-opus-4-20250514 → opus-4`, `claude-opus-4-6 → opus-4-6` と同等の短縮 */
export function shortModel(raw: string | undefined | null): string {
  if (!raw) return "";
  let s = String(raw);
  if (s.startsWith("claude-")) s = s.slice("claude-".length);
  s = s.replace(/-\d{8}$/, "");
  return s;
}

/** input から model を文字列化（`model.id` オブジェクト形にも対応） */
export function extractModel(input: StatuslineInput): string {
  const m = input.model;
  if (typeof m === "string") return m;
  if (m && typeof m === "object" && typeof m.id === "string") return m.id;
  return "";
}

/** `.context_window.used_percentage` 優先、`.context.used_percentage` fallback、0 default */
export function ctxPct(input: StatuslineInput): number {
  const raw =
    input.context_window?.used_percentage ??
    input.context?.used_percentage ??
    0;
  if (typeof raw !== "number" || isNaN(raw)) return 0;
  return Math.round(raw);
}

/** pct (0-100) → 色エスケープ文字列。Color 無効時は空文字 */
export function ctxColor(pct: number, color: boolean): string {
  if (!color) return "";
  if (pct >= 80) return ANSI.red;
  if (pct >= 60) return ANSI.yellow;
  return ANSI.green;
}

/** input から working dir を解決 (`workspace.current_dir` > `cwd` > `working_dir`) */
export function workdirFromInput(input: StatuslineInput): string {
  return (
    input.workspace?.current_dir ||
    input.cwd ||
    input.working_dir ||
    ""
  );
}

/** `git -C <dir> rev-parse --abbrev-ref HEAD`、失敗時は空文字 */
export function gitBranch(cwd: string): string {
  const dir = cwd || ".";
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    return out.trim();
  } catch {
    return "";
  }
}

/** `taskList` から status が ready / assigned のものを数える */
export function openTaskCount(state: StatuslineState): number {
  const list = state.taskList ?? [];
  let n = 0;
  for (const t of list) {
    if (t.status === "ready" || t.status === "assigned") n++;
  }
  return n;
}

/** surface → master / conductor / agent / unknown のロール判定 */
export function resolveRole(surface: string, state: StatuslineState): StatuslineRole {
  if ((state.masters ?? []).some((m) => m.surface === surface)) {
    return { kind: "master" };
  }
  const cond = state.conductors.get(surface);
  if (cond) {
    return { kind: "conductor", conductor: cond };
  }
  // Agent: 全 conductor の agents を線形探索
  for (const [condSurface, c] of state.conductors) {
    const agents = c.agents ?? [];
    for (const a of agents) {
      if (a.surface === surface) {
        return { kind: "agent", conductorSurface: condSurface, agent: a };
      }
    }
  }
  return { kind: "unknown" };
}

/** タスクタイトルを 20 codepoint で切り詰め、超過時は `…` を付加 */
export function truncateTitle(title: string): string {
  if (!title) return "";
  const chars = Array.from(title);
  if (chars.length <= 20) return title;
  return chars.slice(0, 20).join("") + "…";
}

// --- 各ロール別レンダラ ---

interface RenderCtx {
  modelShort: string;
  pct: number;
  branch: string;
  color: boolean;
  nerdFont: boolean;
  ctxColorCode: string;
}

function makeCtx(
  input: StatuslineInput,
  opts: StatuslineOptions,
): RenderCtx {
  const modelShort = shortModel(extractModel(input));
  const pct = ctxPct(input);
  const cwd = opts.workdir || workdirFromInput(input);
  const branch = gitBranch(cwd);
  return {
    modelShort,
    pct,
    branch,
    color: opts.color,
    nerdFont: opts.nerdFont,
    ctxColorCode: ctxColor(pct, opts.color),
  };
}

function col(name: keyof typeof ANSI, color: boolean): string {
  return color ? ANSI[name] : "";
}

function renderMaster(state: StatuslineState, ctx: RenderCtx): string {
  const i = ctx.nerdFont ? ICONS.master.on : ICONS.master.off;
  const cyan = col("cyan", ctx.color);
  const reset = col("reset", ctx.color);
  const dim = col("dim", ctx.color);
  const green = col("green", ctx.color);
  const ctxColorCode = ctx.ctxColorCode;
  const openTasks = openTaskCount(state);
  // printf: `${C_CYAN}%s Master${C_RESET} ${C_DIM}|${C_RESET} %s %s ${C_DIM}|${C_RESET}
  //          ${CTX_COLOR}%s %s%%${C_RESET} ${C_DIM}|${C_RESET} ${C_GREEN}%s:%s${C_RESET}
  //          ${C_DIM}|${C_RESET} %s %s`
  // args: (ICON, M_ICON, MODEL_SHORT, CTX_ICON, CTX_PCT, TASK_ICON, OPEN_TASKS, BR_ICON, BRANCH)
  return (
    `${cyan}${i.icon} Master${reset} ${dim}|${reset} ` +
    `${i.m} ${ctx.modelShort} ${dim}|${reset} ` +
    `${ctxColorCode}${i.ctx} ${ctx.pct}%${reset} ${dim}|${reset} ` +
    `${green}${i.task}:${openTasks}${reset} ${dim}|${reset} ` +
    `${i.br} ${ctx.branch}`
  );
}

function renderConductor(
  cond: StatuslineConductor,
  ctx: RenderCtx,
): string {
  const i = ctx.nerdFont ? ICONS.conductor.on : ICONS.conductor.off;
  const cyan = col("cyan", ctx.color);
  const reset = col("reset", ctx.color);
  const dim = col("dim", ctx.color);
  const ctxColorCode = ctx.ctxColorCode;

  const taskId = cond.taskId ?? "";
  if (taskId) {
    const title = truncateTitle(cond.taskTitle ?? "");
    const label = `T${taskId} ${title}`;
    // printf: `${C_CYAN}%s %s${C_RESET} ${C_DIM}|${C_RESET} %s ${C_DIM}|${C_RESET}
    //          ${CTX_COLOR}%s %s%%${C_RESET} ${C_DIM}|${C_RESET} %s %s`
    // args: (ICON, TASK_LABEL, BRANCH, CTX_ICON, CTX_PCT, M_ICON, MODEL_SHORT)
    return (
      `${cyan}${i.icon} ${label}${reset} ${dim}|${reset} ` +
      `${ctx.branch} ${dim}|${reset} ` +
      `${ctxColorCode}${i.ctx} ${ctx.pct}%${reset} ${dim}|${reset} ` +
      `${i.m} ${ctx.modelShort}`
    );
  }
  // idle: branch 表示なし、全体を dim
  // printf: `${C_DIM}%s %s${C_RESET} ${C_DIM}|${C_RESET} ${CTX_COLOR}%s %s%%${C_RESET}
  //          ${C_DIM}|${C_RESET} %s %s`
  // args: (ICON, TASK_LABEL, CTX_ICON, CTX_PCT, M_ICON, MODEL_SHORT)
  return (
    `${dim}${i.icon} idle${reset} ${dim}|${reset} ` +
    `${ctxColorCode}${i.ctx} ${ctx.pct}%${reset} ${dim}|${reset} ` +
    `${i.m} ${ctx.modelShort}`
  );
}

function renderAgent(
  agent: { surface: string; role?: string; taskTitle?: string; tokenHandle?: string },
  conductor: StatuslineConductor,
  ctx: RenderCtx,
): string {
  const i = ctx.nerdFont ? ICONS.agent.on : ICONS.agent.off;
  const yellow = col("yellow", ctx.color);
  const reset = col("reset", ctx.color);
  const dim = col("dim", ctx.color);
  const ctxColorCode = ctx.ctxColorCode;
  const roleName = agent.role ?? "agent";
  // Conductor がタスクを持っていればそれを Agent の task id として使う
  const taskId = conductor.taskId ?? "";
  // T375: token pool 有効時のみ末尾に `@<handle>` セグメントを足す。
  //       未設定なら既存出力と完全一致させる。
  const handleSeg = agent.tokenHandle
    ? ` ${dim}|${reset} @${agent.tokenHandle}`
    : "";

  if (taskId) {
    // printf: `${C_YELLOW}%s %s${C_RESET} ${C_DIM}| T%s |${C_RESET} ${CTX_COLOR}%s %s%%${C_RESET}`
    // args: (ICON, ROLE_NAME, TASK_ID, CTX_ICON, CTX_PCT)
    return (
      `${yellow}${i.icon} ${roleName}${reset} ${dim}| T${taskId} |${reset} ` +
      `${ctxColorCode}${i.ctx} ${ctx.pct}%${reset}` +
      handleSeg
    );
  }
  // printf: `${C_YELLOW}%s %s${C_RESET} ${C_DIM}|${C_RESET} ${CTX_COLOR}%s %s%%${C_RESET}`
  // args: (ICON, ROLE_NAME, CTX_ICON, CTX_PCT)
  return (
    `${yellow}${i.icon} ${roleName}${reset} ${dim}|${reset} ` +
    `${ctxColorCode}${i.ctx} ${ctx.pct}%${reset}` +
    handleSeg
  );
}

/**
 * メインエントリ。surface からロールを判定し、ロール別レンダラで 1 行文字列を組み立てる。
 * unknown surface は空文字を返す（現行 bash 版の `exit 0` と同等）。
 */
export function formatStatusline(
  input: StatuslineInput,
  state: StatuslineState,
  opts: StatuslineOptions,
): string {
  const role = resolveRole(opts.surface, state);
  if (role.kind === "unknown") return "";
  const ctx = makeCtx(input, opts);
  switch (role.kind) {
    case "master":
      return renderMaster(state, ctx);
    case "conductor":
      return renderConductor(role.conductor, ctx);
    case "agent": {
      const parent =
        state.conductors.get(role.conductorSurface) ??
        ({ surface: role.conductorSurface } as StatuslineConductor);
      return renderAgent(role.agent, parent, ctx);
    }
  }
}
