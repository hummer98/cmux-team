/**
 * `.team/config.json` の読み込みと派生値解決（T247 で main.ts から抽出）。
 *
 * main.ts / dashboard.tsx の両方から参照する必要があるため、module として独立させる。
 * `TeamConfig` / `loadConfig` / `resolveLayout` / `resolveAutoUpdateMode` を提供する。
 * `normalizeAutoUpdate` は schema.ts にある（config 生値の正規化は schema 側の責務）。
 */

import { join } from "path";
import { readFile } from "fs/promises";
import { homedir } from "os";
import type { LayoutMode, AutoUpdateMode } from "./schema";
import { normalizeAutoUpdate } from "./schema";

export interface TeamConfig {
  models?: {
    master?: string;
    conductor?: string;
    agent?: string;
  };
  envrcHookPromptSkipped?: boolean;
  layout?: LayoutMode;
  /**
   * 使用する AI runtime backend（デフォルト: "claude-code"）。Issue #30 M5
   * - "claude-code": Claude Code CLI + cmux（既存動作）
   * - "opencode": opencode REST API / SSE
   */
  runtime?: "claude-code" | "opencode";
  /** opencode backend の設定。Issue #30 M5 / #37 */
  opencode?: {
    /** opencode server の URL（デフォルト: "http://localhost:54321"） */
    serverUrl?: string;
    /**
     * Agent ロールに opencode を使うかどうか（デフォルト: false）。Issue #37
     * true のとき spawn-agent / await-agent / kill-agent が opencode 経路を使う。
     * Conductor は常に Claude Code のまま。
     */
    agentEnabled?: boolean;
    /**
     * opencode Agent で使うモデル名（デフォルト: "claude-sonnet-4-5"）。Issue #37
     * opencode provider layer に渡す。例: "kiwi-2.6", "claude-haiku-4-5"
     */
    agentModel?: string;
  };
  /** false にすると caffeinate によるスリープ抑止を無効化する（デフォルト: true） */
  sleepPrevention?: boolean;
  /**
   * auto-update のモード（デフォルト: "off"）。env CMUX_TEAM_AUTO_UPDATE が優先。
   * - "off": 更新チェックしない
   * - "notify": 更新を検出して TUI バナーに表示（install は行わない）
   *
   * T294 (v4.5.0): `"task"` モードと boolean 後方互換（true/false）は削除された。
   * 旧値が残っている場合は resolveAutoUpdateMode が throw する（exit 1）。
   */
  autoUpdate?: AutoUpdateMode;
  /**
   * プロジェクトの主開発ブランチ。未設定時は cmux-team start 起動時に
   * `git symbolic-ref refs/remotes/origin/HEAD` で自動検出して書き込まれる。T213 で追加。
   */
  mainBranch?: string;
  /**
   * token pool の有効/無効。T322 で追加。未指定時は global config / default(false) にフォールバック。
   * env CMUX_TEAM_TOKEN_POOL が最優先。詳細は resolveTokenPoolEnabled を参照。
   */
  tokenPool?: { enabled?: boolean };
}

/**
 * `~/.cmux-team/config.yaml` のスキーマ。T322 で追加。
 * yaml 慣習に従い snake_case (`token_pool`) で受け、内部表現は camelCase (`tokenPool`) に正規化する。
 */
export interface GlobalConfig {
  tokenPool?: { enabled?: boolean };
}

/**
 * `.team/config.json` を読み込む。存在しない / 壊れている時は空オブジェクトを返す。
 */
export async function loadConfig(projectRoot: string): Promise<TeamConfig> {
  const configPath = join(projectRoot, ".team/config.json");
  try {
    return JSON.parse(await readFile(configPath, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * レイアウトモードを解決する。
 * 優先順位: CLI フラグ (--layout) > config.json の layout > "wide"
 * 不正値は Error を throw する（呼び出し元で process.exit する想定）。
 */
export function resolveLayout(
  config: Pick<TeamConfig, "layout">,
  cliLayout: string | undefined,
): LayoutMode {
  const raw = cliLayout ?? config.layout ?? "wide";
  if (raw !== "wide" && raw !== "16x9") {
    throw new Error(`Unknown layout: ${raw} (expected "wide" or "16x9")`);
  }
  return raw;
}

/**
 * auto-update のモードを解決する。
 * 優先順位: env CMUX_TEAM_AUTO_UPDATE > config.autoUpdate > "off"
 *
 * env 値の解釈（T294 v4.5.0 で縮約）:
 * - 未定義 / 空文字 → config にフォールバック
 * - "0" / "false" / "off" → off (source=env)
 * - "notify" → notify (source=env)
 * - それ以外（"1"/"true"/"task" を含む）→ throw
 *
 * T294: `"task"` モード（自動 update タスク起票）と boolean 後方互換を削除した。
 * 旧値（`task` / `1` / `true` / `true|false` config）は起動時に reject し、
 * cmdStart の try/catch が process.exit(1) + 移行メッセージを表示する。
 *
 * config 値の解釈: normalizeAutoUpdate に委譲（"off" / "notify" のみ受理）
 */
export function resolveAutoUpdateMode(
  config: Pick<TeamConfig, "autoUpdate">,
  env: NodeJS.ProcessEnv = process.env,
): { mode: AutoUpdateMode; source: "env" | "config" | "default" } {
  const raw = env.CMUX_TEAM_AUTO_UPDATE;
  if (raw !== undefined && raw !== "") {
    const v = raw.trim().toLowerCase();
    if (v === "0" || v === "false" || v === "off") return { mode: "off", source: "env" };
    if (v === "notify") return { mode: "notify", source: "env" };
    throw new Error(
      `unknown CMUX_TEAM_AUTO_UPDATE=${JSON.stringify(raw)} (expected 0|false|off|notify; ` +
        `"1" / "true" / "task" were removed in v4.5.0 — use "notify" or unset to migrate)`,
    );
  }
  if (config.autoUpdate !== undefined) {
    return { mode: normalizeAutoUpdate(config.autoUpdate), source: "config" };
  }
  return { mode: "off", source: "default" };
}

/**
 * worktree 作成前の `git fetch` を行うかどうかを解決する（T283）。
 *
 * 優先順位: env CMUX_TEAM_FETCH_BEFORE_WORKTREE > default (true)
 *
 * env 値の解釈:
 * - 未定義 / 空文字 → { enabled: true, source: "default" }
 * - "1" / "true" / "on" → { enabled: true, source: "env" }
 * - "0" / "false" / "off" → { enabled: false, source: "env" }
 * - それ以外 → throw
 *
 * T283 で従来の「デフォルト OFF」を「デフォルト ON」に反転した。offline 環境・
 * rate limit 対策で OFF にしたい場合は `CMUX_TEAM_FETCH_BEFORE_WORKTREE=0` を
 * 設定する。起動ログに `fetch_before_worktree enabled=<on|off> source=<env|default>`
 * を 1 回 emit する（cmdStart）。
 */
export function resolveFetchBeforeWorktree(
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; source: "env" | "default" } {
  const raw = env.CMUX_TEAM_FETCH_BEFORE_WORKTREE;
  if (raw === undefined || raw === "") {
    return { enabled: true, source: "default" };
  }
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on") return { enabled: true, source: "env" };
  if (v === "0" || v === "false" || v === "off") return { enabled: false, source: "env" };
  throw new Error(
    `unknown CMUX_TEAM_FETCH_BEFORE_WORKTREE=${JSON.stringify(raw)} (expected 0|1|true|false|on|off)`,
  );
}

/**
 * token pool の有効/無効を 3 階層で解決する純粋関数。T322 で追加。
 *
 * 優先順位: env > project > global > default(false / opt-in)
 *
 * env `CMUX_TEAM_TOKEN_POOL` の解釈:
 * - "0" / "false" / "off" → false (source=env)
 * - "1" / "true" / "on"   → true  (source=env)
 * - 未定義 / 空文字       → 次の層にフォールバック
 * - それ以外              → throw（既存 resolveAutoUpdateMode 等と同じ fail-fast 流儀）
 *
 * project / global の解釈:
 * - フィールド未指定 / undefined / null → 次の層にフォールバック
 * - boolean 以外（string / number 等）  → 型違反として未指定扱い（zod 未導入なので runtime check は最小限）
 */
export function resolveTokenPoolEnabled(
  projectConfig: Pick<TeamConfig, "tokenPool">,
  globalConfig: Pick<GlobalConfig, "tokenPool"> | null,
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; source: "env" | "project" | "global" | "default" } {
  const raw = env.CMUX_TEAM_TOKEN_POOL;
  if (raw !== undefined && raw !== "") {
    const v = raw.trim().toLowerCase();
    if (v === "0" || v === "false" || v === "off") return { enabled: false, source: "env" };
    if (v === "1" || v === "true" || v === "on") return { enabled: true, source: "env" };
    throw new Error(
      `unknown CMUX_TEAM_TOKEN_POOL=${JSON.stringify(raw)} (expected 0|1|true|false|on|off)`,
    );
  }
  const projectVal = projectConfig.tokenPool?.enabled;
  if (typeof projectVal === "boolean") {
    return { enabled: projectVal, source: "project" };
  }
  const globalVal = globalConfig?.tokenPool?.enabled;
  if (typeof globalVal === "boolean") {
    return { enabled: globalVal, source: "global" };
  }
  return { enabled: false, source: "default" };
}

/**
 * `~/.cmux-team/config.yaml` を読み込んで GlobalConfig に正規化する。T322 で追加。
 *
 * - ファイル不在 → null（next-layer フォールバック扱い）
 * - parse 失敗 → console.warn のみ出して null を返す（best-effort、daemon は停止しない）
 * - yaml 慣習の `token_pool.enabled` を camelCase の `tokenPool.enabled` に詰め替える
 *
 * yaml ライブラリは `yaml` (eemeli/yaml)。bun runtime で動作確認済み。
 */
export async function loadGlobalConfig(): Promise<GlobalConfig | null> {
  // Bun の os.homedir() は HOME 環境変数を尊重しない実装のため、env を優先する。
  // env 未設定時のみ homedir() に fallback する（token-store と同じ流儀）。
  const home = process.env.HOME ?? homedir();
  const path = join(home, ".cmux-team/config.yaml");
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  try {
    const yaml = await import("yaml");
    const parsed = yaml.parse(text);
    if (parsed === null || typeof parsed !== "object") return {};
    const tp = (parsed as Record<string, unknown>).token_pool;
    if (tp && typeof tp === "object") {
      const enabled = (tp as Record<string, unknown>).enabled;
      if (typeof enabled === "boolean") {
        return { tokenPool: { enabled } };
      }
      return { tokenPool: {} };
    }
    return {};
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`cmux-team: failed to parse ~/.cmux-team/config.yaml: ${msg}`);
    return null;
  }
}

/**
 * project / global / env の 3 階層を読み込んで boolean に解決する高レベル wrapper。T322 で追加。
 * cmdSpawnAgent / cmdStart はこれを呼ぶだけで運用ログ用の source も取れる。
 */
export async function isTokenPoolEnabled(
  projectRoot: string,
): Promise<{ enabled: boolean; source: "env" | "project" | "global" | "default" }> {
  const [projectConfig, globalConfig] = await Promise.all([
    loadConfig(projectRoot),
    loadGlobalConfig(),
  ]);
  return resolveTokenPoolEnabled(projectConfig, globalConfig);
}
