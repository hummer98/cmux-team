/**
 * gh-cache: GitHub トークン解決。
 *
 * 優先順位（plan §4）:
 *   1. host=api.github.com: GITHUB_TOKEN → GH_TOKEN → `gh auth token --hostname github.com`
 *   2. host=GHE: GH_ENTERPRISE_TOKEN → GITHUB_ENTERPRISE_TOKEN → `gh auth token --hostname <host>`
 *
 * 失敗時は kind="none" を返す（crash しない）。
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { createHash } from "crypto";
import type { AuthResolution } from "./gh-cache-types";

const execFileAsync = promisify(execFile);

/**
 * トークンハッシュ（32 hex = sha256 先頭 32 文字）。
 * 監査ログで識別しやすい長さかつ衝突確率は実用十分。
 */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/**
 * env 優先順のトークン候補リスト（host 依存）。
 */
function envCandidates(host: string): Array<{ name: string; value: string | undefined }> {
  const isGheHost = !host.startsWith("api.github.com");
  if (isGheHost) {
    return [
      { name: "GH_ENTERPRISE_TOKEN", value: process.env.GH_ENTERPRISE_TOKEN },
      { name: "GITHUB_ENTERPRISE_TOKEN", value: process.env.GITHUB_ENTERPRISE_TOKEN },
    ];
  }
  return [
    { name: "GITHUB_TOKEN", value: process.env.GITHUB_TOKEN },
    { name: "GH_TOKEN", value: process.env.GH_TOKEN },
  ];
}

/**
 * host から `gh auth token --hostname <X>` の X 部分を決める。
 * "api.github.com" → "github.com"
 * "ghe.example.com/api/v3" → "ghe.example.com"
 */
export function ghCliHostname(host: string): string {
  if (host === "api.github.com") return "github.com";
  const slash = host.indexOf("/");
  return slash > 0 ? host.slice(0, slash) : host;
}

/**
 * gh CLI からトークン取得。存在しない / 失敗時は undefined。
 * テスト差し替えのため関数参照を export する。
 */
export async function ghCliToken(hostname: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("gh", [
      "auth",
      "token",
      "--hostname",
      hostname,
    ]);
    const token = stdout.trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * トークン解決。env → gh CLI の順で試し、見つかったら即返す。
 * plan §4 の優先順位に従う。
 */
export async function resolveGithubToken(
  host: string,
  opts: {
    /** テスト用: gh CLI 呼び出しを差し替える */
    ghCliTokenFn?: (hostname: string) => Promise<string | undefined>;
  } = {},
): Promise<AuthResolution> {
  const checked: string[] = [];
  const candidates = envCandidates(host);

  for (const { name, value } of candidates) {
    checked.push(name);
    if (value && value.trim().length > 0) {
      return { kind: "env", token: value.trim(), host, checked };
    }
  }

  const cliHost = ghCliHostname(host);
  checked.push(`gh auth token --hostname ${cliHost}`);
  const fn = opts.ghCliTokenFn ?? ghCliToken;
  const token = await fn(cliHost);
  if (token) {
    return { kind: "gh-cli", token, host, checked };
  }

  return { kind: "none", host, checked };
}
