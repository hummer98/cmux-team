/**
 * pool-summary.ts (T351)
 *
 * `cmux-team status` CLI と Manager dashboard の双方が呼べる pool snapshot 純関数。
 *
 * - `buildPoolSummary(db, nowIso?)`: Database を引数で受ける純関数。daemon は state.tokenDb を渡す。
 *   現行 main.ts:1444-1483 の in-line 実装（listTokens → 各 token に getLatestUsageSnapshot →
 *   computePoolCapacity → computeNextReset → Map 化）と等価。
 * - `loadPoolSummary(projectRoot, nowIso?)`: CLI 用 1-shot wrapper。`isTokenPoolEnabled` で gate し、
 *   ON なら `initTokenDB()` で都度 open → `buildPoolSummary` に委譲、OFF / 失敗なら null を返す。
 *
 * daemon は long-running なので毎 tick で `initTokenDB` を呼ぶと file handle が累積するため、
 * 起動時 1 度だけ open したハンドルを保持し `buildPoolSummary` を直接呼ぶ。
 */
import type { Database } from "bun:sqlite";
import {
  initTokenDB,
  listTokens,
  getLatestUsageSnapshot,
  computePoolCapacity,
  type TokenForCapacity,
} from "./token-store";
import { computeNextReset } from "./pool-next-reset";
import type { PoolHeaderInput } from "./pool-status-header";
import { isTokenPoolEnabled } from "./config";

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
  /** buildPoolHeaderLines にそのまま渡せる入力 */
  header: PoolHeaderInput;
  /** handle ごとの per-surface 表示用 lookup */
  perHandle: Map<string, PerHandleSummary>;
}

/**
 * tokens.db を引数で受ける純粋関数。`db` は呼び出し側で open / close する。
 *
 * 動作仕様（現行 main.ts:1444-1483 in-line 実装と等価）:
 * - `listTokens(db)` で全 token を列挙
 * - 各 token の最新 usage_snapshot を取得して `TokenForCapacity[]` を作る
 * - `computePoolCapacity` で `capacity_5h_pct` / `capacity_7d_pct` / `per_token` を算出（plan_ratio=null は除外）
 * - `perHandle` は **listTokens 全 token** を含み、capPct は per_token Map から拾う（plan_ratio=null は null）
 * - `computeNextReset` には `selectable: t.selectable` を含めて渡す
 */
export function buildPoolSummary(
  db: Database,
  nowIso: string = new Date().toISOString(),
): PoolSummary {
  const tokens = listTokens(db);

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

  const nextReset = computeNextReset({
    nowIso,
    tokens: tokens.map((t) => {
      const snap = getLatestUsageSnapshot(db, t.id);
      return {
        handle: t.handle,
        plan_ratio: t.plan_ratio,
        util_5h: snap?.util_5h ?? null,
        util_7d: snap?.util_7d ?? null,
        reset_5h_at: snap?.reset_5h_at ?? null,
        reset_7d_at: snap?.reset_7d_at ?? null,
        selectable: t.selectable,
      };
    }),
  });

  return {
    header: {
      capacity5hPct: cap.capacity_5h_pct,
      capacity7dPct: cap.capacity_7d_pct,
      nextReset,
    },
    perHandle,
  };
}

/**
 * CLI 専用の 1-shot wrapper。
 *
 * - `isTokenPoolEnabled` で 3 階層解決（env / project / global / default）
 * - ON なら `initTokenDB()` で都度 open → `buildPoolSummary` に委譲
 * - OFF なら null を返す
 * - DB open / read で例外が出たら null を返す（ヘッダー / handle 装飾を skip）
 *
 * daemon は long-running なので state.tokenDb を保持し `buildPoolSummary` を直接呼ぶ（このラッパーは使わない）。
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
    return buildPoolSummary(db, nowIso);
  } catch {
    return null;
  }
}
