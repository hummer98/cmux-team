/**
 * pool-summary.ts (T351 / T374)
 *
 * `cmux-team status` CLI と Manager dashboard の双方が呼べる pool snapshot 純関数。
 *
 * - `buildPoolSummary(db, nowIso?, policy?)`: Database を引数で受ける純関数。daemon は state.tokenDb を渡す。
 *   T374 で旧 `header` (capacity_5h/7d_pct + nextReset) を撤去し、`forecast7d` (A024 §計算式) と
 *   `nextCandidate` (peekNextToken) に置き換えた。
 * - `loadPoolSummary(projectRoot, nowIso?)`: CLI 用 1-shot wrapper。`isTokenPoolEnabled` で gate し、
 *   ON なら `initTokenDB()` で都度 open + `buildSelectTokenPolicy` で policy を解決して
 *   `buildPoolSummary` に委譲、OFF / 失敗なら null を返す。
 *
 * daemon は long-running なので毎 tick で `initTokenDB` を呼ぶと file handle が累積するため、
 * 起動時 1 度だけ open したハンドルを保持し `buildPoolSummary` を直接呼ぶ。
 *
 * `computePoolCapacity` の per_token cap_pct は `pool-cli.ts: cmux-team pool status` /
 * `token-cli.ts: token list` で引き続き利用するため、`perHandle.capPct` 経由で温存する。
 */
import type { Database } from "bun:sqlite";
import {
  initTokenDB,
  listTokens,
  getLatestUsageSnapshot,
  computePoolCapacity,
  peekNextToken,
  type TokenForCapacity,
  type SelectTokenPolicy,
  type PeekedToken,
} from "./token-store";
import {
  computePool7dForecast,
  type Pool7dForecast,
  type ForecastTokenInput,
} from "./forecast";
import { isTokenPoolEnabled, buildSelectTokenPolicy } from "./config";

export interface PerHandleSummary {
  util5h: number | null;
  util7d: number | null;
  capPct: number | null;
  /**
   * tokens.selectable=1 か否か（T367）。
   * `hasPoolHeadroomFromSummary` が default 昇格を考慮しない近似で
   * Ink dashboard の throttle 表示に使う。daemon 側 (scanTasks /
   * computeSidebarStatus) は SQLite を直接見るため正確な判定。
   */
  selectable: boolean;
}

export interface PoolSummary {
  /** A024 §TUI 表示の forecast ゲージ用。bars.length === 7 */
  forecast7d: Pool7dForecast;
  /** A024 §TUI 表示の next 候補。null = 候補なし（全 blocked / tags 不適合 / policy=null） */
  nextCandidate: PeekedToken | null;
  /** handle ごとの per-surface 表示用 lookup */
  perHandle: Map<string, PerHandleSummary>;
}

/**
 * tokens.db を引数で受ける純粋関数。`db` は呼び出し側で open / close する。
 *
 * 動作仕様（T374、A024 §計算式 と一致）:
 * - `listTokens(db)` で全 token を列挙
 * - `computePool7dForecast(forecastTokens, nowIso, tz)` で 7 日分 bar 配列を算出（A024 §計算式）
 * - `peekNextToken(db, policy, nowIso)` で spawn-agent と同じ admit 経路の peek 実行
 *   （policy が null のとき nextCandidate=null）
 * - `perHandle` は **listTokens 全 token** を含み、capPct は `computePoolCapacity` から拾う
 */
export function buildPoolSummary(
  db: Database,
  nowIso: string = new Date().toISOString(),
  policy: SelectTokenPolicy | null = null,
): PoolSummary {
  const tokens = listTokens(db);

  // forecast7d: A024 §計算式（T374）
  const forecastTokens: ForecastTokenInput[] = tokens.map((t) => {
    const snap = getLatestUsageSnapshot(db, t.id);
    return {
      handle: t.handle,
      plan_ratio: t.plan_ratio,
      util_7d: snap?.util_7d ?? null,
      reset_7d_at: snap?.reset_7d_at ?? null,
      selectable: t.selectable,
    };
  });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const forecast7d = computePool7dForecast(forecastTokens, nowIso, tz);

  // nextCandidate: spawn-agent と同じ admit 経路を共有（T374）
  const nextCandidate: PeekedToken | null =
    policy != null ? peekNextToken(db, policy, nowIso) : null;

  // per_token cap_pct は pool-cli / token-cli の per-token 表示用に維持（capacity_5h/7d 集計値は廃止）
  const forCap: TokenForCapacity[] = tokens.map((t) => {
    const snap = getLatestUsageSnapshot(db, t.id);
    return {
      handle: t.handle,
      plan_ratio: t.plan_ratio,
      util_5h: snap?.util_5h ?? null,
      util_7d: snap?.util_7d ?? null,
      reset_5h_at: snap?.reset_5h_at ?? null,
      reset_7d_at: snap?.reset_7d_at ?? null,
    };
  });
  const cap = computePoolCapacity(forCap, nowIso);
  const capByHandle = new Map(cap.per_token.map((p) => [p.handle, p.cap_pct]));

  const perHandle = new Map<string, PerHandleSummary>();
  for (const t of tokens) {
    const snap = getLatestUsageSnapshot(db, t.id);
    perHandle.set(t.handle, {
      util5h: snap?.util_5h ?? null,
      util7d: snap?.util_7d ?? null,
      capPct: capByHandle.get(t.handle) ?? null,
      selectable: t.selectable,
    });
  }

  return {
    forecast7d,
    nextCandidate,
    perHandle,
  };
}

/**
 * CLI 専用の 1-shot wrapper。
 *
 * - `isTokenPoolEnabled` で 3 階層解決（env / project / global / default）
 * - ON なら `initTokenDB()` で都度 open + `buildSelectTokenPolicy(projectRoot)` で policy 解決
 *   → `buildPoolSummary(db, nowIso, policy)` に委譲
 * - OFF なら null を返す
 * - DB open / read / policy 解決で例外が出たら null を返す
 *
 * daemon は long-running なので state.tokenDb / state.poolPolicy を保持し
 * `buildPoolSummary` を直接呼ぶ（このラッパーは使わない）。
 */
export async function loadPoolSummary(
  projectRoot: string,
  nowIso?: string,
): Promise<PoolSummary | null> {
  let enabled = false;
  try {
    const decision = await isTokenPoolEnabled(projectRoot);
    enabled = decision.enabled;
  } catch {
    enabled = false;
  }
  if (!enabled) return null;

  try {
    const db = initTokenDB();
    const policy = await buildSelectTokenPolicy(projectRoot);
    return buildPoolSummary(db, nowIso, policy);
  } catch {
    return null;
  }
}
