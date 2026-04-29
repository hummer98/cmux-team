/**
 * pool-throttle.ts (T367 / T382)
 *
 * pool-aware THROTTLE 判定の単一エントリ helper。
 * proxy `/rate-limit` / scanTasks / computeSidebarStatus / dashboard の 4 箇所がこの 1 関数を呼ぶ。
 *
 * - **pool 有効経路** (`db !== null`): `canSelectAnyToken` を `selectToken` と共有することで
 *   admit 判定が spawn-agent 側と構造的に一致する（design-review-r2 Major #3 / N1 対応）。
 *   閾値は `selectToken` 側の `> BLOCKER_5H` / `> BLOCKER_7D`（T382）を唯一の真理として扱い、
 *   `THROTTLE_5H_THRESHOLD (=0.90)` は pool 無効経路でのみ参照する。
 * - **pool 無効経路** (`db === null`): 従来挙動（`unified5hUtilization >= THROTTLE_5H_THRESHOLD`）を完全保持。
 * - **boot/running ガード**: `running=false` または `bootReady=false` のとき常に false を返す
 *   （起動中・停止後の throttle 判定を回避）。
 *
 * Ink dashboard 側からは SQLite に依存しない `hasPoolHeadroomFromSummary` を呼ぶ。
 * dashboard は Ink 再描画時に SQLite を叩かない設計（pure variant 経由）。
 * daemon の SQLite 直見との微小乖離は dashboard-pool.test.tsx の B6 で許容を明示する。
 */
import type { Database } from "bun:sqlite";
import {
  canSelectAnyToken,
  listTokens,
  getLatestUsageSnapshot,
  parseResetEpochMs,
  BLOCKER_5H,
  BLOCKER_7D,
  type SelectTokenPolicy,
} from "./token-store";
import { isStale5h } from "./rate-limit-persistence";
import { THROTTLE_5H_THRESHOLD, type RateLimitInfo } from "./schema";
import type { PerHandleSummary } from "./pool-summary";

const DEFAULT_POLICY: SelectTokenPolicy = {
  projectTags: ["any"],
  projectDefault: null,
  include: [],
  exclude: [],
  isOss: false,
  ossDefault: null,
};

const STALE_THRESHOLD_MS = 30 * 60 * 1000;

export interface ThrottleOpts {
  /** daemon が running 状態か */
  running: boolean;
  /** bootPhase === "ready" か */
  bootReady: boolean;
  /** pool 有効時のみ参照（buildSelectTokenPolicy 由来）。未指定なら DEFAULT_POLICY */
  policy?: SelectTokenPolicy;
  /** canSelectAnyToken に渡す。throttle 判定では lease を取らないので "throttle-probe" 固定でよい */
  holder?: string;
}

/**
 * pool 有効/無効を切り替えながら throttle 判定する単一エントリ。
 *
 * @param db pool 有効なら token DB ハンドル、無効なら null
 * @param rl 直近観測の rate-limit info（pool 無効経路でのみ参照）
 * @param opts running / bootReady / policy / holder
 * @param nowIso 現在時刻 ISO（テスト注入可、デフォルトは Date.now）
 */
export function isThrottled5h(
  db: Database | null,
  rl: RateLimitInfo | null,
  opts: ThrottleOpts,
  nowIso: string = new Date().toISOString(),
): boolean {
  // boot / running ガード（design-review Major #5）
  if (!opts.running || !opts.bootReady) return false;

  // pool 有効経路
  if (db !== null) {
    return !canSelectAnyToken(db, opts.holder ?? "throttle-probe", opts.policy ?? DEFAULT_POLICY, nowIso);
  }

  // pool 無効経路（従来ロジック完全保持）
  if (isStale5h(rl)) return false;
  return (rl?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD;
}

export interface PoolTokenCount {
  /** 常に true（呼び出されたなら pool 有効） */
  enabled: boolean;
  /** listTokens(selectableOnly: false) の総数 */
  total: number;
  /** listTokens(selectableOnly: true) の総数 */
  selectable: number;
  /** policy 適用後に admit 通った（候補化された）数 */
  available: number;
  /** snapshot が stale (30 分以上前) と判定された token 数 */
  stale: number;
}

/**
 * pool の token 集計（/rate-limit / scanTasks throttled ログ用）。
 *
 * - `selectable` は DB 上の selectable 列の合計。default 昇格分は含まない
 * - `available` は admit 候補の数（candidate 配列の length）。default 昇格を考慮した「実選択可能数」
 * - `stale` は recorded_at が現在から 30 分以上前の token 数。lease 中・blocker 等は無関係
 */
export function countPoolTokens(
  db: Database,
  policy: SelectTokenPolicy = DEFAULT_POLICY,
  nowIso: string = new Date().toISOString(),
): PoolTokenCount {
  const allTokens = listTokens(db, { selectableOnly: false });
  const selectableTokens = listTokens(db, { selectableOnly: true });

  const nowMs = new Date(nowIso).getTime();
  let stale = 0;
  for (const t of allTokens) {
    const snap = getLatestUsageSnapshot(db, t.id);
    if (snap) {
      const recAt = new Date(snap.recorded_at).getTime();
      if (nowMs - recAt > STALE_THRESHOLD_MS) stale++;
    }
  }

  // available は admit 候補数。canSelectAnyToken と同じ閾値で数える。
  // canSelectAnyToken は length>0 だけ返すため、ここでは admitCandidates 相当を再現する。
  // selectToken の admit と同一に揃える（B1: default 昇格、B2: exclude、B3: lease、B4: BLOCKER_5H/7D 以下、stale 救済 5h/7d）。
  const effectiveDefault: string | null =
    policy.projectDefault !== null ? policy.projectDefault : policy.isOss ? policy.ossDefault : null;
  const projectTagSet = new Set(policy.projectTags);
  const includeSet = new Set(policy.include);
  const excludeSet = new Set(policy.exclude);
  const activeLeases = new Set(
    (db.prepare("SELECT token_id FROM leases WHERE expires_at >= ?").all(nowIso) as Array<{ token_id: number }>).map(
      (r) => r.token_id,
    ),
  );

  let available = 0;
  for (const tok of allTokens) {
    if (excludeSet.has(tok.handle)) continue;
    if (!tok.selectable && tok.handle !== effectiveDefault) continue;
    if (activeLeases.has(tok.id)) continue;
    const snap = getLatestUsageSnapshot(db, tok.id);
    // T373 / T382: stale でも除外しない。reset_*_at が過去なら effUtil*=0 で評価。
    let effUtil5h = snap?.util_5h ?? 0;
    let effUtil7d = snap?.util_7d ?? 0;
    if (snap) {
      const recAt = new Date(snap.recorded_at).getTime();
      const isStale = nowMs - recAt > STALE_THRESHOLD_MS;
      if (isStale) {
        if (snap.reset_5h_at != null && parseResetEpochMs(snap.reset_5h_at) <= nowMs) {
          effUtil5h = 0;
        }
        if (snap.reset_7d_at != null && parseResetEpochMs(snap.reset_7d_at) <= nowMs) {
          effUtil7d = 0;
        }
      }
    }
    if (effUtil5h > BLOCKER_5H) continue;
    if (effUtil7d > BLOCKER_7D) continue;
    let admitted = false;
    if (tok.handle === effectiveDefault) {
      admitted = true;
    } else if (includeSet.has(tok.handle)) {
      admitted = true;
    } else if (policy.isOss) {
      admitted = true;
    } else {
      const tokenTags = tok.tags;
      const tagsMatch =
        tokenTags.includes("any") ||
        projectTagSet.has("any") ||
        tokenTags.some((t) => projectTagSet.has(t));
      if (tagsMatch) admitted = true;
    }
    if (admitted) available++;
  }

  return {
    enabled: true,
    total: allTokens.length,
    selectable: selectableTokens.length,
    available,
    stale,
  };
}

/**
 * Ink dashboard / pool-header-display 用の純粋関数（T367 Minor #6 / T382）。
 *
 * SQLite を触らず、`PerHandleSummary` 配列だけで pool に余裕があるかを判定する。
 * 判定基準は `selectToken` の blocker 閾値（`BLOCKER_5H` / `BLOCKER_7D`、T382 で 7d 軸を追加）と一致させる。
 *
 * **util7d=null の扱い**: snapshot 受信前の起動直後は util_7d 不明なので、5h のみで判定する
 * （誤った throttle 表示を避けるため）。両方 null なら headroom あり扱い（既存挙動）。
 *
 * **近似**: selectable=0 の default 昇格は考慮しない（dashboard は cosmetic な ⏸ 表示のため）。
 * 厳密判定が必要な daemon 側 (scanTasks / computeSidebarStatus) は SQLite を直接見るので
 * 微小に乖離する。`dashboard-pool.test.tsx` の B6 でこの境界を明示テストする。
 */
export function hasPoolHeadroomFromSummary(perHandle: PerHandleSummary[]): boolean {
  for (const ph of perHandle) {
    if (!ph.selectable) continue;
    const u5 = ph.util5h;
    const u7 = ph.util7d;
    const blocked5h = u5 != null && u5 > BLOCKER_5H;
    const blocked7d = u7 != null && u7 > BLOCKER_7D;
    if (blocked5h || blocked7d) continue;
    return true;
  }
  return false;
}
