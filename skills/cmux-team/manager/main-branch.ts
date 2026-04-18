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
 * main ブランチの自動検出が全て失敗したときに throw される例外（T253）。
 * 診断用に origin/HEAD と HEAD の stderr を保持する。
 */
export class MainBranchResolutionError extends Error {
  readonly originHeadStderr?: string;
  readonly headStderr?: string;
  constructor(detail: { originHeadStderr?: string; headStderr?: string }) {
    super(
      "Failed to detect main branch: both `git symbolic-ref refs/remotes/origin/HEAD` " +
        "and `git symbolic-ref --short HEAD` failed.",
    );
    this.name = "MainBranchResolutionError";
    this.originHeadStderr = detail.originHeadStderr;
    this.headStderr = detail.headStderr;
  }
}

/**
 * プロジェクトの main ブランチを以下の優先順位で解決する:
 *
 * 1. `config.mainBranch`（trim 後に空でない場合のみ採用）
 * 2. `git symbolic-ref refs/remotes/origin/HEAD`（例: `refs/remotes/origin/main` → `main`）
 * 3. `git symbolic-ref --short HEAD`（現在の HEAD 名。detached ならスキップ）
 *
 * 全て失敗した場合は T253 で暗黙 `"main"` フォールバックが削除されたため
 * `MainBranchResolutionError` を throw する。呼び出し元（`cmdStart`）で catch し
 * `.team/config.json` の明示指定 or `CMUX_TEAM_MAIN_BRANCH` env を促す
 * エラーメッセージを出した上で `process.exit(1)` すること。
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

  let originHeadStderr: string | undefined;
  let headStderr: string | undefined;

  try {
    const out = await git(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    const m = out.match(/^refs\/remotes\/origin\/(.+)$/);
    if (m && m[1]) return { branch: m[1], source: "detected" };
  } catch (e: any) {
    originHeadStderr = (e?.stderr ?? "").toString().trim();
    await log(
      "main_branch_detect_failed",
      `step=origin_head stderr=${originHeadStderr}`,
    );
  }

  try {
    const out = await git(["symbolic-ref", "--short", "HEAD"]);
    if (out) return { branch: out, source: "detected" };
  } catch (e: any) {
    headStderr = (e?.stderr ?? "").toString().trim();
    await log(
      "main_branch_detect_failed",
      `step=head stderr=${headStderr}`,
    );
  }

  throw new MainBranchResolutionError({ originHeadStderr, headStderr });
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
