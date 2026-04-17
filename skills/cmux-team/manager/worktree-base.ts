import { execFile } from "child_process";
import { promisify } from "util";
import { log } from "./logger";
import type { WorktreeBaseResolution } from "./schema";

const execFileAsync = promisify(execFile);

/**
 * `resolveWorktreeBase` のオプション。
 * - `baseBranch`: task.md frontmatter の `base_branch:`（最優先。非空なら他を一切見ない）
 * - `mainBranch`: `.team/config.json` の `mainBranch`（T213 で正規化済み）
 * - `git`: テスト時に git コマンドをスタブするための注入ポイント。
 *   引数は `git` のサブコマンド配列、戻り値は stdout.trim() 相当。
 *   例外 throw でそのステップ失敗 → 次段にフォールバック。
 * - `doFetch`: true のとき `git fetch --quiet origin <mainBranch>` を先行実行。
 *   失敗はログのみで継続（ベストエフォート）。デフォルト false。
 */
export interface ResolveWorktreeBaseOptions {
  baseBranch?: string;
  mainBranch?: string;
  git?: (args: string[]) => Promise<string>;
  doFetch?: boolean;
}

/**
 * git worktree add の start-point を以下の優先順位で解決する:
 *
 * 1. `baseBranch`（trim 後に非空）→ explicit
 * 2. `mainBranch`（trim 後に非空）かつ `origin/<mainBranch>` 存在 → config-origin
 *    （`doFetch=true` なら事前に `git fetch --quiet origin <mainBranch>` を打つ）
 * 3. `mainBranch` 存在 かつ local `<mainBranch>` 存在 → config-local
 * 4. それ以外 → head-fallback（startPoint=null、`git worktree add -b <new>` のみ発行）
 */
export async function resolveWorktreeBase(
  projectRoot: string,
  opts: ResolveWorktreeBaseOptions = {},
): Promise<WorktreeBaseResolution> {
  const explicit = opts.baseBranch?.trim();
  if (explicit) {
    return {
      startPoint: explicit,
      source: "explicit",
      baseLabel: explicit,
    };
  }

  const main = opts.mainBranch?.trim();
  if (!main) {
    return { startPoint: null, source: "head-fallback", baseLabel: "HEAD" };
  }

  const git =
    opts.git ??
    (async (args: string[]) => {
      const { stdout } = await execFileAsync("git", args, {
        cwd: projectRoot,
        timeout: 30000,
      });
      return stdout.trim();
    });

  if (opts.doFetch) {
    try {
      await git(["fetch", "--quiet", "origin", main]);
    } catch (e: any) {
      await log(
        "worktree_base_fetch_failed",
        `main=${main} stderr=${(e?.stderr ?? "").toString().trim()}`,
      );
    }
  }

  try {
    await git([
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${main}^{commit}`,
    ]);
    return {
      startPoint: `origin/${main}`,
      source: "config-origin",
      baseLabel: `origin/${main}`,
    };
  } catch {
    // origin に存在しない → local へ
  }

  try {
    await git([
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${main}^{commit}`,
    ]);
    return {
      startPoint: main,
      source: "config-local",
      baseLabel: main,
    };
  } catch {
    // local にも存在しない → HEAD fallback
  }

  await log(
    "worktree_base_fallback",
    `main=${main} reason=origin_and_local_missing`,
  );
  return { startPoint: null, source: "head-fallback", baseLabel: "HEAD" };
}
