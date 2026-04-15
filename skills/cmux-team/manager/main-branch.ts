import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { log } from "./logger";
import type { MainBranchResolution } from "./schema";

const execFileAsync = promisify(execFile);

/**
 * `resolveMainBranch` のオプション。
 * - `configMainBranch`: `.team/config.json` の `mainBranch` フィールド（string もしくは未定義）。
 * - `git`: テスト時に git コマンドをスタブするための注入ポイント。
 *   引数は `git` のサブコマンド配列、戻り値は `stdout.trim()` 相当の文字列。
 *   例外を throw すると呼び出し側は「そのステップが失敗」とみなして次段に進む。
 */
export interface ResolveMainBranchOptions {
  configMainBranch?: string;
  git?: (args: string[]) => Promise<string>;
}

/**
 * プロジェクトの main ブランチを以下の優先順位で解決する:
 *
 * 1. `config.mainBranch`（trim 後に空でない場合のみ採用）
 * 2. `git symbolic-ref refs/remotes/origin/HEAD`（例: `refs/remotes/origin/main` → `main`）
 * 3. `git symbolic-ref --short HEAD`（現在の HEAD 名。detached ならスキップ）
 * 4. フォールバックで `"main"` を返す
 *
 * 空文字 / 改行のみの `configMainBranch` は無効値として自動検出へフォールスルーする。
 */
export async function resolveMainBranch(
  projectRoot: string,
  opts: ResolveMainBranchOptions = {},
): Promise<MainBranchResolution> {
  const cfg = opts.configMainBranch?.trim();
  if (cfg) {
    return { branch: cfg, source: "config" };
  }
  const git =
    opts.git ??
    (async (args: string[]) => {
      const { stdout } = await execFileAsync("git", args, { cwd: projectRoot });
      return stdout.trim();
    });

  try {
    const out = await git(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    const m = out.match(/^refs\/remotes\/origin\/(.+)$/);
    if (m && m[1]) return { branch: m[1], source: "detected" };
  } catch (e: any) {
    await log(
      "main_branch_detect_failed",
      `step=origin_head stderr=${(e?.stderr ?? "").toString().trim()}`,
    );
  }

  try {
    const out = await git(["symbolic-ref", "--short", "HEAD"]);
    if (out) return { branch: out, source: "detected" };
  } catch (e: any) {
    await log(
      "main_branch_detect_failed",
      `step=head stderr=${(e?.stderr ?? "").toString().trim()}`,
    );
  }

  await log("main_branch_fallback", "reason=git_detect_failed");
  return { branch: "main", source: "fallback" };
}

/**
 * `.team/config.json` の `mainBranch` フィールドを更新する。
 * 既存の他フィールド（`models`, `layout`, `autoUpdate` 等）は保持する。
 * `envrc-prompt.ts:silenceInConfig` と同じ read-merge-write パターン。
 */
export async function persistMainBranch(
  projectRoot: string,
  branch: string,
): Promise<void> {
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
  config.mainBranch = branch;
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}
