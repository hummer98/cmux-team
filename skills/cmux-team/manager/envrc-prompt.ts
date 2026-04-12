/**
 * .envrc に CMUX_CLAUDE_HOOKS_DISABLED=1 を追記するかをユーザーに対話確認する。
 *
 * cmux-team start の起動時、TUI（Ink）を起動する前に呼ぶこと。
 * Ink が stdin/stdout を奪うため、それより手前で readline プロンプトを表示する必要がある。
 *
 * gating（対話を出さない条件）:
 *   - CMUX_TEAM_NO_PROMPT が truthy
 *   - stdin が TTY ではない
 *   - .envrc が存在しない
 *   - .envrc に既に CMUX_CLAUDE_HOOKS_DISABLED が含まれる
 *   - .team/config.json の envrcHookPromptSkipped が true
 */
import { existsSync } from "fs";
import { readFile, writeFile, appendFile } from "fs/promises";
import { join } from "path";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import * as readline from "readline/promises";
import { log } from "./logger";

const execFile = promisify(execFileCb);

export type EnvrcAction =
  | "added"
  | "skipped_once"
  | "silenced"
  | "noop_no_envrc"
  | "noop_already_set"
  | "noop_env_silenced"
  | "noop_user_silenced"
  | "noop_no_tty";

export interface EnvrcCheckResult {
  action: EnvrcAction;
  warnings: string[];
}

export type Answer = "Y" | "n" | "N";

/** 対話プロンプト（テストでモック差し替え可能） */
export async function askYNQuestion(prompt: string): Promise<Answer> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const raw = await rl.question(prompt);
    const trimmed = raw.trim();
    if (trimmed === "") return "Y";
    const first = trimmed[0];
    if (first === "n") return "n";
    if (first === "N") return "N";
    return "Y";
  } finally {
    rl.close();
  }
}

/** .envrc の末尾改行を保証して export 行を append する */
export async function appendExportLine(envrcPath: string): Promise<void> {
  const current = existsSync(envrcPath) ? await readFile(envrcPath, "utf-8") : "";
  let toWrite = "";
  if (current.length > 0 && !current.endsWith("\n")) {
    toWrite += "\n";
  }
  toWrite += "export CMUX_CLAUDE_HOOKS_DISABLED=1\n";
  await appendFile(envrcPath, toWrite);
}

/** config.json に envrcHookPromptSkipped: true を merge */
async function silenceInConfig(projectRoot: string): Promise<void> {
  const configPath = join(projectRoot, ".team/config.json");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const txt = await readFile(configPath, "utf-8");
      const parsed = JSON.parse(txt);
      if (parsed && typeof parsed === "object") {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      config = {};
    }
  }
  config.envrcHookPromptSkipped = true;
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** config.envrcHookPromptSkipped を読む */
async function isUserSilenced(projectRoot: string): Promise<boolean> {
  const configPath = join(projectRoot, ".team/config.json");
  if (!existsSync(configPath)) return false;
  try {
    const txt = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === "object") {
      return (parsed as Record<string, unknown>).envrcHookPromptSkipped === true;
    }
  } catch {
    return false;
  }
  return false;
}

const PROMPT_TEXT =
  "\n" +
  "プロジェクトルートで `claude` を直接起動すると cmux claude-hook の通知が cmux-team の通知と重複します。\n" +
  ".envrc に `export CMUX_CLAUDE_HOOKS_DISABLED=1` を追記しますか？\n" +
  "  [Y] 追記する (デフォルト)  [n] スキップ (今回のみ)  [N] 今後聞かない\n" +
  "選択 [Y/n/N]: ";

const POST_ADD_REMINDER =
  ".envrc に CMUX_CLAUDE_HOOKS_DISABLED=1 を追記しました。\n" +
  "反映には以下の手順が必要です:\n" +
  "\n" +
  "  1. 現在のセッションを exit\n" +
  "  2. シェルで: direnv allow\n" +
  "  3. cmux-team start を再実行\n" +
  "\n" +
  "（direnv が未導入の場合は手動で source .envrc または環境変数設定が必要です）";

export interface EnsureOptions {
  /** テスト用に askYNQuestion を差し替える */
  ask?: (prompt: string) => Promise<Answer>;
  /** テスト用に process.env / process.stdin の状態を差し替える */
  envOverride?: { CMUX_TEAM_NO_PROMPT?: string };
  /** テスト用に stdin TTY 判定を差し替える */
  isTTY?: boolean;
  /** テスト用に direnv の検出結果を差し替える */
  direnvPath?: string | null;
  /** テスト用に direnv allow の実行関数を差し替える */
  runDirenvAllow?: (cwd: string) => Promise<void>;
}

export async function ensureEnvrcHookPrompt(
  projectRoot: string,
  options: EnsureOptions = {}
): Promise<EnvrcCheckResult> {
  const warnings: string[] = [];

  // --- gating ---
  const noPromptEnv = options.envOverride?.CMUX_TEAM_NO_PROMPT ?? process.env.CMUX_TEAM_NO_PROMPT;
  if (noPromptEnv) {
    await log("envrc_check_skipped", "reason=env CMUX_TEAM_NO_PROMPT");
    return { action: "noop_env_silenced", warnings };
  }

  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  if (!isTTY) {
    await log("envrc_check_skipped", "reason=no_tty");
    return { action: "noop_no_tty", warnings };
  }

  const envrcPath = join(projectRoot, ".envrc");
  if (!existsSync(envrcPath)) {
    await log("envrc_check_skipped", "reason=no_envrc");
    return { action: "noop_no_envrc", warnings };
  }

  let envrcContent = "";
  try {
    envrcContent = await readFile(envrcPath, "utf-8");
  } catch (e: any) {
    await log("error", `envrc read failed: ${e.message}`);
    return { action: "noop_no_envrc", warnings };
  }
  if (envrcContent.includes("CMUX_CLAUDE_HOOKS_DISABLED")) {
    await log("envrc_check_skipped", "reason=already_set");
    return { action: "noop_already_set", warnings };
  }

  if (await isUserSilenced(projectRoot)) {
    await log("envrc_check_skipped", "reason=user_silenced");
    return { action: "noop_user_silenced", warnings };
  }

  // --- 対話 ---
  await log("envrc_hook_prompt_shown");
  const ask = options.ask ?? askYNQuestion;
  let answer: Answer;
  try {
    answer = await ask(PROMPT_TEXT);
  } catch (e: any) {
    await log("error", `envrc prompt aborted: ${e.message}`);
    return { action: "noop_no_tty", warnings };
  }

  if (answer === "n") {
    await log("envrc_hook_prompt_declined", "reason=once");
    return { action: "skipped_once", warnings };
  }

  if (answer === "N") {
    try {
      await silenceInConfig(projectRoot);
      await log("envrc_hook_prompt_silenced");
      return { action: "silenced", warnings };
    } catch (e: any) {
      await log("error", `config silence write failed: ${e.message}`);
      return { action: "skipped_once", warnings };
    }
  }

  // --- 追記処理 (Y) ---
  try {
    await appendExportLine(envrcPath);
  } catch (e: any) {
    await log("envrc_hook_disabled_add_failed", e.message);
    console.error(`[cmux-team] .envrc への追記に失敗しました: ${e.message}`);
    return { action: "skipped_once", warnings };
  }

  // direnv 検出
  const direnvPath = options.direnvPath !== undefined ? options.direnvPath : Bun.which("direnv");
  let direnvAvailable = false;
  if (direnvPath) {
    direnvAvailable = true;
    try {
      if (options.runDirenvAllow) {
        await options.runDirenvAllow(projectRoot);
      } else {
        await execFile("direnv", ["allow", projectRoot], { cwd: projectRoot });
      }
    } catch (e: any) {
      await log("direnv_allow_failed", e.message);
      warnings.push(`direnv allow に失敗しました: ${e.message}`);
    }
  } else {
    await log("direnv_not_found");
    warnings.push("direnv が見つかりません — シェルを再起動するまで反映されません");
  }

  console.log(POST_ADD_REMINDER);
  await log("envrc_hook_disabled_added", `direnv=${direnvAvailable}`);
  return { action: "added", warnings };
}
