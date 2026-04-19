/**
 * gh-cache: git remote から {host, owner, repo} を解決する。
 *
 * - `git@github.com:o/r.git` → host=api.github.com
 * - `https://github.com/o/r(.git)` → host=api.github.com
 * - `git@ghe.example.com:o/r.git` → host=ghe.example.com/api/v3
 * - `https://ghe.example.com/o/r(.git)` → host=ghe.example.com/api/v3
 * - GitLab / bitbucket / 非 GitHub → null
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { join } from "path";
import type { RepoInfo } from "./gh-cache-types";

const execFileAsync = promisify(execFile);

/** `cwd` が git repo 内かどうかの判定（.git ディレクトリ or ファイル、worktree 対応） */
export function isGitRepo(cwd: string): boolean {
  let dir = cwd;
  for (let i = 0; i < 32; i++) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = join(dir, "..");
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

/**
 * `git remote get-url origin` の出力から RepoInfo を組み立てる。
 *
 * 純粋関数。テスト用に URL 直渡しで呼べるようにしておく。
 */
export function parseRemoteUrl(url: string): RepoInfo | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // SSH: git@host:owner/repo(.git)
  const sshMatch = trimmed.match(/^[\w.-]+@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch && sshMatch[1] && sshMatch[2] && sshMatch[3]) {
    return buildRepoInfo(sshMatch[1], sshMatch[2], sshMatch[3]);
  }

  // HTTPS: https://host/owner/repo(.git) or http://
  const httpsMatch = trimmed.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (httpsMatch && httpsMatch[1] && httpsMatch[2] && httpsMatch[3]) {
    return buildRepoInfo(httpsMatch[1], httpsMatch[2], httpsMatch[3]);
  }

  // git:// や ssh:// 形式（まれ）
  const sshUrlMatch = trimmed.match(/^(?:ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (sshUrlMatch && sshUrlMatch[1] && sshUrlMatch[2] && sshUrlMatch[3]) {
    return buildRepoInfo(sshUrlMatch[1], sshUrlMatch[2], sshUrlMatch[3]);
  }

  return null;
}

function buildRepoInfo(hostRaw: string, owner: string, repo: string): RepoInfo | null {
  const host = hostRaw.toLowerCase();
  if (host === "github.com" || host === "www.github.com") {
    return { host: "api.github.com", owner, repo };
  }
  // GHE と仮定: gitlab.com / bitbucket.org / その他は除外
  if (host === "gitlab.com" || host === "www.gitlab.com") return null;
  if (host === "bitbucket.org" || host === "www.bitbucket.org") return null;
  if (host === "codeberg.org") return null;
  if (host === "git.sr.ht" || host === "sr.ht") return null;
  // GHE 扱い: ホスト名に "github" が含まれる / それ以外は GHE と仮定
  // 実運用上は「GitHub でない remote は非 GitHub」だが、企業 GHE はホスト名が
  // 任意なので「除外 list 方式」で判定する（plan §4 の host 判定方針）。
  return { host: `${host}/api/v3`, owner, repo };
}

/**
 * `git remote get-url origin` を実行して解決する。
 * 非 git / origin 未設定 / 非 GitHub の場合は null を返す。
 */
export async function resolveOriginRepo(cwd: string): Promise<RepoInfo | null> {
  if (!isGitRepo(cwd)) return null;
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd });
    return parseRemoteUrl(stdout);
  } catch {
    return null;
  }
}

/**
 * REST API の base URL を返す（末尾スラッシュなし）。
 * - "api.github.com" → "https://api.github.com"
 * - "ghe.example.com/api/v3" → "https://ghe.example.com/api/v3"
 */
export function apiBaseUrl(host: string): string {
  return `https://${host}`;
}
