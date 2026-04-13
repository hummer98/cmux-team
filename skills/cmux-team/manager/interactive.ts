/**
 * 対話プロンプトユーティリティ
 *
 * cmux-team CLI の対話式入力を提供する。
 * envrc-prompt.ts と同じパターン（readline/promises, TTY ゲーティング）に従う。
 *
 * ゲーティング条件（対話を出さない）:
 *   - CMUX_TEAM_NO_PROMPT が truthy
 *   - stdin が TTY ではない
 */

import * as readline from "readline/promises";

/** 対話プロンプトを表示すべきかどうか */
export function isInteractive(): boolean {
  if (process.env.CMUX_TEAM_NO_PROMPT) return false;
  return Boolean(process.stdin.isTTY);
}

export interface AskChoiceOptions {
  /** テスト用に readline を差し替える */
  ask?: (prompt: string) => Promise<string>;
}

/**
 * 番号付きメニューを表示し、ユーザーに選択させる。
 *
 * 表示例:
 *   エージェントを選んでください:
 *     1) claude (デフォルト)
 *     2) gemini
 *     3) codex
 *   選択 [1]:
 *
 * Enter で defaultIndex の値を返す。無効な入力は再プロンプト。
 */
export async function askChoice(
  prompt: string,
  options: string[],
  defaultIndex = 0,
  opts: AskChoiceOptions = {},
): Promise<string> {
  const lines: string[] = [`\n${prompt}`];
  for (let i = 0; i < options.length; i++) {
    const suffix = i === defaultIndex ? " (デフォルト)" : "";
    lines.push(`  ${i + 1}) ${options[i]}${suffix}`);
  }
  const menuText = lines.join("\n") + `\n選択 [${defaultIndex + 1}]: `;

  const askFn = opts.ask ?? createReadlineAsk();

  // 無効入力時はリトライ（最大 5 回）
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await askFn(menuText);
    const trimmed = raw.trim();

    // Enter のみ → デフォルト
    if (trimmed === "") return options[defaultIndex];

    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= options.length) {
      return options[num - 1];
    }

    // 名前で直接入力された場合
    if (options.includes(trimmed)) return trimmed;

    console.log(`  ※ 1〜${options.length} の数字を入力してください`);
  }

  // リトライ上限 → デフォルト
  return options[defaultIndex];
}

/**
 * Yes/No プロンプト。
 *
 * defaultYes=true の場合: [Y/n]、Enter で true
 * defaultYes=false の場合: [y/N]、Enter で false
 */
export async function askYesNo(
  prompt: string,
  defaultYes = false,
  opts: AskChoiceOptions = {},
): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const askFn = opts.ask ?? createReadlineAsk();

  const raw = await askFn(`${prompt} ${hint}: `);
  const trimmed = raw.trim().toLowerCase();

  if (trimmed === "") return defaultYes;
  return trimmed.startsWith("y");
}

/**
 * 自由入力プロンプト。Enter のみで defaultValue を返す。
 */
export async function askFreeform(
  prompt: string,
  defaultValue = "",
  opts: AskChoiceOptions = {},
): Promise<string> {
  const askFn = opts.ask ?? createReadlineAsk();
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const raw = await askFn(`${prompt}${suffix}: `);
  const trimmed = raw.trim();
  return trimmed || defaultValue;
}

/** readline ベースの ask 関数を生成 */
function createReadlineAsk(): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  };
}
