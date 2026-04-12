/**
 * Agent CLI アダプタレジストリ
 *
 * 各 AI コーディングエージェント CLI のコマンド生成を抽象化し、
 * cmux-team が Claude 以外のエージェントも起動できるようにする。
 */

export interface AgentCommandOpts {
  prompt?: string;
  promptFile?: string;
  model: string;
  settingsFlag?: string; // Claude 専用（--settings パス）、他は無視
}

export interface AgentAdapter {
  /** 表示名 */
  name: string;
  /** PATH 上のバイナリ名 */
  binary: string;
  /** シェルコマンド文字列を生成 */
  buildCommand(opts: AgentCommandOpts): string;
  /** true の場合 ANTHROPIC_BASE_URL を設定しない */
  skipProxyEnv?: boolean;
}

// ── ヘルパー ────────────────────────────────────────────

/** シングルクォートのエスケープ（シェル安全） */
function sq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** promptFile → インラインプロンプト変換（非 Claude 用） */
function catFile(path: string): string {
  return `"$(cat ${sq(path)})"`;
}

// ── アダプタ定義 ────────────────────────────────────────

const claudeAdapter: AgentAdapter = {
  name: "Claude Code",
  binary: "claude",
  buildCommand({ prompt, promptFile, model, settingsFlag }) {
    const flags = ["--dangerously-skip-permissions"];
    if (settingsFlag) flags.push(settingsFlag);
    flags.push(`--model ${model}`);
    const flagStr = flags.join(" ");
    if (promptFile) {
      return `claude ${flagStr} ${sq(promptFile + " を読んで指示に従ってください。")}`;
    }
    return `claude ${flagStr} ${sq(prompt ?? "")}`;
  },
};

const ftClaudeAdapter: AgentAdapter = {
  name: "FT-Claude",
  binary: "ft-claude",
  buildCommand({ prompt, promptFile, model, settingsFlag }) {
    const flags = ["--dangerously-skip-permissions"];
    if (settingsFlag) flags.push(settingsFlag);
    flags.push(`--model ${model}`);
    const flagStr = flags.join(" ");
    if (promptFile) {
      return `ft-claude ${flagStr} ${sq(promptFile + " を読んで指示に従ってください。")}`;
    }
    return `ft-claude ${flagStr} ${sq(prompt ?? "")}`;
  },
};

const codexAdapter: AgentAdapter = {
  name: "Codex",
  binary: "codex",
  skipProxyEnv: true,
  buildCommand({ prompt, promptFile, model }) {
    const flags = ["--full-auto"];
    if (model) flags.push(`-c model=${sq(model)}`);
    const flagStr = flags.join(" ");
    if (promptFile) {
      return `codex ${flagStr} exec ${catFile(promptFile)}`;
    }
    return `codex ${flagStr} exec ${sq(prompt ?? "")}`;
  },
};

const geminiAdapter: AgentAdapter = {
  name: "Gemini CLI",
  binary: "gemini",
  skipProxyEnv: true,
  buildCommand({ prompt, promptFile, model }) {
    const flags: string[] = [];
    if (model) flags.push(`--model ${model}`);
    const flagStr = flags.length > 0 ? flags.join(" ") + " " : "";
    if (promptFile) {
      return `gemini ${flagStr}${catFile(promptFile)}`;
    }
    return `gemini ${flagStr}${sq(prompt ?? "")}`;
  },
};

const opencodeAdapter: AgentAdapter = {
  name: "OpenCode",
  binary: "opencode",
  skipProxyEnv: true,
  buildCommand({ prompt, promptFile, model }) {
    const flags: string[] = [];
    if (model) flags.push(`--model ${model}`);
    const flagStr = flags.length > 0 ? flags.join(" ") + " " : "";
    if (promptFile) {
      return `opencode run ${flagStr}${catFile(promptFile)}`;
    }
    return `opencode run ${flagStr}${sq(prompt ?? "")}`;
  },
};

// ── レジストリ ──────────────────────────────────────────

const REGISTRY: Record<string, AgentAdapter> = {
  claude: claudeAdapter,
  "ft-claude": ftClaudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  opencode: opencodeAdapter,
};

export const DEFAULT_AGENT_TYPE = "claude";

/**
 * 指定キーのアダプタを返す。未知のキーはエラー。
 */
export function getAdapter(agentType: string): AgentAdapter {
  const adapter = REGISTRY[agentType];
  if (!adapter) {
    const available = Object.keys(REGISTRY).join(", ");
    throw new Error(
      `Unknown agent type: "${agentType}". Available: ${available}`
    );
  }
  return adapter;
}

/**
 * 利用可能なアダプタキーの一覧
 */
export function listAdapters(): string[] {
  return Object.keys(REGISTRY);
}
