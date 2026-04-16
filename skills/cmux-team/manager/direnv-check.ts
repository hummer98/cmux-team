/**
 * `.envrc` が direnv allow されているかを fail-fast で検証する。
 *
 * cmux-team start / spawn-agent の起動直後に呼び、allow されていなければ
 * 即 exit することで CLAUDE_CODE_OAUTH_TOKEN 等の未ロード状態で Conductor /
 * Agent が意図しない認証経路で起動するのを防ぐ。
 *
 * `envrc-prompt.ts` は対話で .envrc に行を追記するモジュール、
 * 本モジュールは「allow 済みであることを非対話で確認する」モジュールで役割が異なる。
 *
 * === direnv status の出力値 ===
 *
 * `direnv status` は stdout に複数行を出力し、.envrc の allow 状態は
 * 以下の行で判定する:
 *
 *   Found RC allowed <N>
 *
 *   N = 0 → allowed (direnv allow 済み)
 *   N = 1 → not allowed (未 allow の初期状態)
 *   N = 2 → denied (direnv deny 済み)
 *
 * 実測（2026-04-17, direnv v2.x on macOS）:
 *   - `direnv allow` 実行後: Found RC allowed 0
 *   - 新規 .envrc（未操作）: Found RC allowed 1
 *   - `direnv deny` 実行後:  Found RC allowed 2
 *
 * 注意: `Loaded RC allowed` は direnv hook が現シェルに入っていないと常に 0
 * を返すため信頼できない。必ず `Found RC allowed` を使う。
 *
 * === fail-closed 方針 ===
 *
 * allow=0 のみを "ok" とし、それ以外（1/2/不明値/行不在/execFile 失敗）は
 * すべて "not_allowed" に倒す。誤検知で起動が止まっても実害は小さいが、
 * 誤って通すと認証経路が乱れるため安全側に寄せる。
 */
import { existsSync } from "fs";
import { join } from "path";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { log } from "./logger";
import { formatExecError } from "./exec-error";

const execFile = promisify(execFileCb);

export type DirenvAllowStatus = "ok" | "not_allowed" | "no_envrc" | "no_direnv";

export interface CheckDirenvOptions {
  /** テスト用に Bun.which を差し替える */
  which?: (bin: string) => string | null;
  /** テスト用に direnv status の実行を差し替える */
  runDirenvStatus?: (cwd: string) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * stdout から `Found RC allowed <N>` を探して N を返す。
 * 行が見つからなければ null。
 */
function parseFoundRcAllowed(stdout: string): number | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^Found RC allowed\s+(-?\d+)\s*$/.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

export async function checkDirenvAllowed(
  projectRoot: string,
  options: CheckDirenvOptions = {},
): Promise<DirenvAllowStatus> {
  const envrcPath = join(projectRoot, ".envrc");
  if (!existsSync(envrcPath)) {
    return "no_envrc";
  }

  const which = options.which ?? ((b: string) => Bun.which(b));
  if (!which("direnv")) {
    return "no_direnv";
  }

  const runDirenvStatus =
    options.runDirenvStatus ??
    (async (cwd: string) => {
      const { stdout, stderr } = await execFile("direnv", ["status"], { cwd });
      return { stdout: String(stdout), stderr: String(stderr) };
    });

  let stdout: string;
  try {
    const result = await runDirenvStatus(projectRoot);
    stdout = result.stdout;
  } catch (e) {
    await log("direnv_status_failed", formatExecError(e));
    return "not_allowed";
  }

  const allowed = parseFoundRcAllowed(stdout);
  if (allowed === 0) return "ok";
  return "not_allowed";
}

/**
 * `not_allowed` 時に stderr へ出力するメッセージを生成する。
 *
 * cmux-team start / cmux-team spawn-agent から共通で使うため、
 * 冒頭行にコマンド名は入れない（plan §5.3 案 B）。
 */
export function formatDirenvNotAllowedMessage(projectRoot: string): string {
  const envrcPath = join(projectRoot, ".envrc");
  return [
    "❌ cmux-team: .envrc が direnv allow されていません",
    "",
    `  .envrc: ${envrcPath}`,
    "",
    "  .envrc に設定された CLAUDE_CODE_OAUTH_TOKEN / CMUX_CLAUDE_HOOKS_DISABLED",
    "  等の環境変数が現在のセッションにロードされていません。このまま起動すると",
    "  Conductor / Agent が意図しない認証経路で起動する恐れがあります。",
    "",
    "  解決方法:",
    `    1. cd ${projectRoot}`,
    "    2. direnv allow",
    "    3. cmux-team start を再実行",
  ].join("\n");
}
