/**
 * project_tags resolver (T321)
 *
 * cmux-team spawn-agent 経路で `selectToken(tokDb, surface, projectTags)` の
 * 第 3 引数を解決する。git remote / `.team/config.json` から推定し、
 * 失敗時は `["any"]` にフォールバックする。
 *
 * - `parseRemoteOriginToTags`: 純粋関数。url 文字列 → tags 配列
 * - `resolveProjectTags`: projectRoot から非同期解決（CLI から呼ぶ entry point）
 *
 * 規約 (task.md / docs/spec):
 *  - host が github.com / www.github.com → ["any"]
 *  - host が gitlab.com / bitbucket.org / codeberg.org / sr.ht 系 → ["any"]
 *  - host が github.<org>.com（GHE）→ ["org:<org>"]
 *  - その他 host → ["org:<最初のラベル>"]
 *  - 解析不能 / remote 取得失敗 → ["any"]
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { join } from "path";

const execFileAsync = promisify(execFile);

export const FALLBACK_TAGS: readonly string[] = ["any"];

const PUBLIC_OSS_HOSTS = new Set([
  "gitlab.com",
  "www.gitlab.com",
  "bitbucket.org",
  "www.bitbucket.org",
  "codeberg.org",
  "git.sr.ht",
  "sr.ht",
]);

/**
 * git remote origin の URL から tags 配列を導出する純粋関数。
 *
 * `gh-cache-repo.ts:parseRemoteUrl` の regex 形と互換だが、
 * 「raw host を保持する」点が異なる（API host 正規化を行わない）。
 */
export function parseRemoteOriginToTags(url: string): string[] {
  const host = extractHost(url);
  if (!host) return [...FALLBACK_TAGS];

  // public GitHub
  if (host === "github.com" || host === "www.github.com") {
    return [...FALLBACK_TAGS];
  }

  // GitLab / Bitbucket / Codeberg / sr.ht 等の有名 OSS host
  if (PUBLIC_OSS_HOSTS.has(host)) {
    return [...FALLBACK_TAGS];
  }

  const labels = host.split(".");
  // GHE: github.<org>.com 形式 → org:<org>
  if (labels.length >= 3 && labels[0] === "github") {
    const org = labels[1];
    if (org) return [`org:${org}`];
  }

  // その他カスタム host → 最初のラベル
  const first = labels[0];
  if (first) return [`org:${first}`];

  return [...FALLBACK_TAGS];
}

/**
 * git remote origin の URL から tags + isOss を導出する純粋関数（T335）。
 *
 * - `tags`: `parseRemoteOriginToTags` と同じ
 * - `isOss`:
 *   - `primaryOrgs` が空 → 常に false（旧動作維持。plan §4 Open Questions）
 *   - host が public GitHub / 公開 OSS host → true（個人 OSS 開発を OSS 扱い）
 *   - host が `github.<org>.com` で `<org>` ∈ primaryOrgs → false（自社 GHE）
 *   - host がカスタムで先頭ラベルが ∈ primaryOrgs → false
 *   - その他（host 解析不能 / org 一致なし）→ true
 *
 * 戻り値の形は `{ tags: string[]; isOss: boolean }`。
 */
export function parseRemoteOriginToContext(
  url: string,
  primaryOrgs: string[],
): { tags: string[]; isOss: boolean } {
  const tags = parseRemoteOriginToTags(url);
  if (primaryOrgs.length === 0) {
    return { tags, isOss: false };
  }
  const host = extractHost(url);
  if (!host) {
    // host 不明 → org と照合できない → 安全側として OSS 扱い
    return { tags, isOss: true };
  }
  // public GitHub / 公開 OSS host は無条件で OSS
  if (host === "github.com" || host === "www.github.com") {
    return { tags, isOss: true };
  }
  if (PUBLIC_OSS_HOSTS.has(host)) {
    return { tags, isOss: true };
  }
  // GHE / カスタムは tags の先頭が "org:<X>" かつ X ∈ primaryOrgs ならば自社
  const first = tags[0];
  if (first && first.startsWith("org:")) {
    const org = first.slice("org:".length);
    if (primaryOrgs.includes(org)) {
      return { tags, isOss: false };
    }
  }
  return { tags, isOss: true };
}

/**
 * url 文字列から raw host (lowercase) を抽出する。失敗時は null。
 *
 * 形式: SSH (`git@host:o/r(.git)`) / HTTPS (`https://host/o/r(.git)`) /
 *       ssh:// or git:// (`ssh://git@host:22/o/r(.git)`)
 */
function extractHost(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // SSH: git@host:owner/repo(.git)
  const sshMatch = trimmed.match(/^[\w.-]+@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch && sshMatch[1]) {
    return sshMatch[1].toLowerCase();
  }

  // HTTPS: https://host/owner/repo(.git)
  const httpsMatch = trimmed.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (httpsMatch && httpsMatch[1]) {
    return httpsMatch[1].toLowerCase();
  }

  // ssh:// or git:// 形式
  const sshUrlMatch = trimmed.match(/^(?:ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (sshUrlMatch && sshUrlMatch[1]) {
    return sshUrlMatch[1].toLowerCase();
  }

  return null;
}

/**
 * `git remote get-url origin` を実行して URL を返す。
 * 非 git / origin 未設定 / timeout / git 未インストール → 空文字。
 */
async function readGitOriginUrl(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd,
      timeout: 2000,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * projectRoot から project_tags + isOss を総合解決する（T335）。
 *
 * 優先順位（projectTags 解決）:
 *  1. `.team/config.json` の `project_tags` (string[]) が非空 → そのまま使う
 *  2. git remote origin URL から推定（`parseRemoteOriginToTags`）
 *  3. fail-safe: ["any"]
 *
 * isOss 判定:
 *  - `primaryOrgs` が空 → 常に `isOss=false`（旧動作維持）
 *  - `.team/config.json` の `project_tags` 明示があれば、tags の先頭が
 *    `org:<X>` で X ∈ primaryOrgs → false / それ以外 → true
 *  - git remote 経由の場合は `parseRemoteOriginToContext` の結果に従う
 *  - 全部失敗 → false（旧動作維持）
 *
 * resolver 自身は throw しない。呼び出し側は二重防護として
 * try/catch + `project_tags_resolve_failed` ログを出すこと。
 */
export interface ProjectContext {
  projectTags: string[];
  isOss: boolean;
}

export async function resolveProjectContext(
  projectRoot: string,
  primaryOrgs: string[],
): Promise<ProjectContext> {
  // 1. .team/config.json の project_tags 明示優先
  try {
    const raw = await readFile(join(projectRoot, ".team/config.json"), "utf-8");
    let cfg: unknown;
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      console.error(`project_tags_config_parse_failed: ${(e as Error).message}`);
      cfg = null;
    }
    if (cfg && typeof cfg === "object") {
      const candidate = (cfg as { project_tags?: unknown }).project_tags;
      if (
        Array.isArray(candidate) &&
        candidate.length > 0 &&
        candidate.every((t) => typeof t === "string")
      ) {
        const tags = candidate as string[];
        const isOss = isOssFromExplicitTags(tags, primaryOrgs);
        return { projectTags: tags, isOss };
      }
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(`project_tags_config_read_failed: ${(e as Error).message}`);
    }
    // ENOENT は通常パス（config.json なし）
  }

  // 2. git remote origin から推定
  const url = await readGitOriginUrl(projectRoot);
  if (url) {
    const ctx = parseRemoteOriginToContext(url, primaryOrgs);
    return { projectTags: ctx.tags, isOss: ctx.isOss };
  }

  // 3. fail-safe（旧動作: isOss=false）
  return { projectTags: [...FALLBACK_TAGS], isOss: false };
}

/**
 * `.team/config.json` の `project_tags` 明示値から isOss を判定する純粋関数。
 *
 * - `primaryOrgs` が空 → false（旧動作維持）
 * - tags のいずれかが `org:X` で X ∈ primaryOrgs → false（自社）
 * - それ以外（"any" のみ / 他社 org / org でない tag）→ true
 */
function isOssFromExplicitTags(tags: string[], primaryOrgs: string[]): boolean {
  if (primaryOrgs.length === 0) return false;
  for (const t of tags) {
    if (t.startsWith("org:")) {
      const org = t.slice("org:".length);
      if (primaryOrgs.includes(org)) return false;
    }
  }
  return true;
}

/**
 * `resolveProjectContext` の wrapper（後方互換）。projectTags のみ返す。
 *
 * 旧 T321 シグネチャを維持。OSS 判定が必要な呼び出し側は
 * `resolveProjectContext(projectRoot, primaryOrgs)` を使うこと。
 */
export async function resolveProjectTags(projectRoot: string): Promise<string[]> {
  const ctx = await resolveProjectContext(projectRoot, []);
  return ctx.projectTags;
}
