/**
 * `.team/config.json` の読み込みと派生値解決（T247 で main.ts から抽出）。
 *
 * main.ts / dashboard.tsx の両方から参照する必要があるため、module として独立させる。
 * `TeamConfig` / `loadConfig` / `resolveLayout` / `resolveAutoUpdateMode` を提供する。
 * `normalizeAutoUpdate` は schema.ts にある（config 生値の正規化は schema 側の責務）。
 */

import { join } from "path";
import { readFile } from "fs/promises";
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
  /** false にすると caffeinate によるスリープ抑止を無効化する（デフォルト: true） */
  sleepPrevention?: boolean;
  /**
   * auto-update のモード（デフォルト: "off"）。env CMUX_TEAM_AUTO_UPDATE が優先。
   * - "off": 更新チェックしない
   * - "notify": 更新を検出して TUI バナーに表示（install は行わない）
   * - "task": 更新を検出して update タスクを --run-after-all で自動起票
   * 後方互換: true→"task", false→"off"
   */
  autoUpdate?: boolean | AutoUpdateMode;
  /**
   * プロジェクトの主開発ブランチ。未設定時は cmux-team start 起動時に
   * `git symbolic-ref refs/remotes/origin/HEAD` で自動検出して書き込まれる。T213 で追加。
   */
  mainBranch?: string;
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
 * env 値の解釈:
 * - 未定義 / 空文字 → config にフォールバック
 * - "0" / "false" / "off" → off (source=env)
 * - "1" / "true" / "task" → task (source=env)
 * - "notify" → notify (source=env)
 * - それ以外 → throw
 *
 * config 値の解釈: normalizeAutoUpdate に委譲（true→task, false→off, 文字列はそのまま）
 */
export function resolveAutoUpdateMode(
  config: Pick<TeamConfig, "autoUpdate">,
  env: NodeJS.ProcessEnv = process.env,
): { mode: AutoUpdateMode; source: "env" | "config" | "default" } {
  const raw = env.CMUX_TEAM_AUTO_UPDATE;
  if (raw !== undefined && raw !== "") {
    const v = raw.trim().toLowerCase();
    if (v === "0" || v === "false" || v === "off") return { mode: "off", source: "env" };
    if (v === "1" || v === "true" || v === "task") return { mode: "task", source: "env" };
    if (v === "notify") return { mode: "notify", source: "env" };
    throw new Error(`unknown CMUX_TEAM_AUTO_UPDATE=${JSON.stringify(raw)} (expected 0|1|true|false|off|notify|task)`);
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
