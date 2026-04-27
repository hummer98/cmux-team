/**
 * T307 / T354: dashboard Metrics タブの純粋 build / 集計関数群。
 *
 * 責務分担:
 * - trace-store.ts: SQL 集計（aggregateApiUsageByRole / aggregateApiUsageByTask /
 *   getLatestApiUsageRow / getProjection5h / getProjection7d）
 * - dashboard-metrics.ts: UI 行ビルド + 数値変換（本モジュール）
 * - dashboard.tsx: AppState 管理 + interval + keybind + rendering 分岐
 *
 * `buildMetricsRows` は AppState/daemon への参照を持たず、`MetricsData` を
 * 受け取って `any[]`（Rezi UI 行オブジェクト配列）を返す純粋関数。
 *
 * T354 で Rate Limit セクションを「分単位 TPM/RPM」から「unified 5h/7d projection」へ
 * 書き換え、Pool Tokens セクションを新設した。F1 の caption role 正規化も本モジュールで行う。
 */
import { ui, rgb } from "@rezi-ui/core";
import type {
  AggregatedRoleRow,
  AggregatedTaskRow,
  ProjectionResult,
} from "./trace-store";
import { normalizeRole } from "./trace-store";
import { buildUtilizationBar } from "./rate-limit-display";
import { t } from "./i18n";

const GREEN = rgb(0, 160, 0);
const YELLOW = rgb(200, 160, 0);
const RED = rgb(180, 40, 40);
const GRAY = rgb(130, 130, 130);

/** Pool Tokens セクション 1 行分。daemon の token-store から組み立てる。 */
export interface PoolTokenRow {
  handle: string;
  util5h: number | null;
  reset5hIso: string | null;
  util7d: number | null;
  reset7dIso: string | null;
  /** snapshot 列が 1 つでも non-null なら true（"no data" 表示の判定） */
  hasSnapshot: boolean;
}

/** Metrics タブで描画する全データ。loadMetricsData が 1 tick 分を構築する。 */
export interface MetricsData {
  /** この MetricsData 構築時刻（ms）。proxy idle 判定や "Ns ago" 表示に使う */
  nowMs: number;
  /** unified 5h projection。snapshot 不足で計算不能なら null */
  projection5h: ProjectionResult | null;
  /** unified 7d projection。snapshot 不足で計算不能なら null */
  projection7d: ProjectionResult | null;
  /** token pool が enabled の場合 selectable token の rate limit 一覧。null = pool 無効 */
  poolTokens: PoolTokenRow[] | null;
  /** ロール別集計（直近 1h、SQL 側で master / conductor / agent / unknown に正規化済み） */
  roleRows: AggregatedRoleRow[];
  /** タスク別集計（直近 1h、input+output 降順で limit 件） */
  taskRows: AggregatedTaskRow[];
  /** 最新 api_usage 行の role（caption 表示用、生値） */
  latestRowRole: string | null;
  /** 最新 api_usage 行の surface */
  latestRowSurface: string | null;
  /** 最新 api_usage 行の timestamp（ms、proxy idle 判定用）。
   *  row 自体が存在しない（proxy 未稼働）場合は null */
  latestRowTimestampMs: number | null;
}

/** タスク別ランキングの表示件数（D4 の責務分離と合わせて UI 定数） */
const TASK_TOP_LIMIT = 5;
/** Rec #6: proxy idle 判定の閾値（秒） */
const PROXY_IDLE_THRESHOLD_SEC = 60;

/**
 * `projected`（上限到達秒数）と `resetRemaining`（リセットまでの秒数）から
 * リスクレベルを決定する（T307 から継承）。
 * - いずれかが null → "gray"
 * - projected < resetRemaining → "red" （リセット前にリミット到達）
 * - projected < 2 × resetRemaining → "yellow" （margin 薄い）
 * - それ以上 → "green"
 */
export function computeRiskLevel(
  projectedSec: number | null,
  resetRemainingSec: number | null,
): "green" | "yellow" | "red" | "gray" {
  if (projectedSec === null || resetRemainingSec === null) return "gray";
  if (resetRemainingSec <= 0) return "gray";
  if (projectedSec < resetRemainingSec) return "red";
  if (projectedSec < 2 * resetRemainingSec) return "yellow";
  return "green";
}

function mapRiskToColor(risk: "green" | "yellow" | "red" | "gray"): ReturnType<typeof rgb> | undefined {
  switch (risk) {
    case "red": return RED;
    case "yellow": return YELLOW;
    case "green": return GREEN;
    case "gray": return GRAY;
  }
}

/** 秒数を人間可読な短い文字列にする（60s / 1m30s / 1h5m）。 */
function formatDurationShort(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "—";
  if (sec < 0) return "0s";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec - m * 60);
    return s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec - h * 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(sec / 86400);
  const h = Math.round((sec - d * 86400) / 3600);
  return h > 0 ? `${d}d${h}h` : `${d}d`;
}

/** reset 列の値（ISO 8601 文字列または epoch 秒文字列）を ms に正規化する。 */
function parseResetMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const asNum = Number(raw);
  if (!isNaN(asNum) && asNum > 1e9) return Math.floor(asNum * 1000);
  const ms = new Date(raw).getTime();
  return isNaN(ms) ? null : ms;
}

/** rate-limit-display.RateLimitPart[] を `ui.text` 配列に変換する。 */
function partsToUiText(parts: { text: string; color: "green" | "yellow" | "red" | "gray" }[]): any[] {
  return parts.map((p) =>
    ui.text(p.text, { style: { fg: mapRiskToColor(p.color) } }),
  );
}

/**
 * T354: 5h / 7d の Projection 1 軸分を 3 行で組み立てる。
 *
 * 1 行目: util% bar + reset 残時間
 * 2 行目: long-term: <projection>
 * 3 行目: recent 15m: <projection>
 *
 * projection が null なら "—"、0 なら "exhausted" 相当の 0s 表示。
 */
function buildProjectionRows(
  label: string,
  proj: ProjectionResult | null,
  nowMs: number,
): any[] {
  const rows: any[] = [];
  if (proj === null) {
    rows.push(
      ui.row({ gap: 1 }, [
        ui.text(label, { dim: true }),
        ui.text(t("metrics_label_no_data"), { style: { fg: GRAY } }),
      ]),
    );
    return rows;
  }
  const resetMs = parseResetMs(proj.resetIso);
  const resetRemainingSec =
    resetMs !== null ? Math.max(0, (resetMs - nowMs) / 1000) : null;

  // 1 行目: bar + reset 残時間（buildUtilizationBar を再利用）
  const bar = buildUtilizationBar(label, proj.utilization, proj.resetIso, nowMs);
  rows.push(ui.row({ gap: 1 }, partsToUiText(bar.parts)));

  // 2 行目: long-term
  {
    const risk = computeRiskLevel(proj.longTermProjectedSec, resetRemainingSec);
    const color = mapRiskToColor(risk);
    const projStr = formatDurationShort(proj.longTermProjectedSec);
    rows.push(
      ui.row({ gap: 1 }, [
        ui.text(`  ${t("metrics_long_term")}:`, { dim: true }),
        ui.text(projStr, { style: { fg: color } }),
        ui.text(t("metrics_before_reset"), { dim: true }),
      ]),
    );
  }

  // 3 行目: recent 15m
  {
    const risk = computeRiskLevel(proj.recentProjectedSec, resetRemainingSec);
    const color = mapRiskToColor(risk);
    const projStr = formatDurationShort(proj.recentProjectedSec);
    rows.push(
      ui.row({ gap: 1 }, [
        ui.text(`  ${t("metrics_recent_15m")}:`, { dim: true }),
        ui.text(projStr, { style: { fg: color } }),
        ui.text(t("metrics_before_reset"), { dim: true }),
      ]),
    );
  }

  return rows;
}

/**
 * T354 S8: Pool Tokens セクションを組み立てる。
 *
 * - poolTokens === null → 何も出さない（pool 無効）
 * - 空配列 → "(no selectable tokens)" 1 行
 * - 非空 → handle padEnd + 5h/7d util bar
 */
function buildPoolTokensSection(
  poolTokens: PoolTokenRow[] | null,
  nowMs: number,
): any[] {
  if (poolTokens === null) return [];
  const rows: any[] = [];
  rows.push(ui.text(""));
  rows.push(
    ui.text(
      `── ${t("metrics_section_pool_tokens", { count: String(poolTokens.length) })} ──`,
      { dim: true },
    ),
  );
  if (poolTokens.length === 0) {
    rows.push(ui.text(t("metrics_pool_no_selectable"), { dim: true }));
    return rows;
  }
  const maxHandleLen = poolTokens.reduce(
    (m, r) => Math.max(m, r.handle.length),
    0,
  );
  for (const r of poolTokens) {
    if (!r.hasSnapshot) {
      rows.push(
        ui.row({ gap: 1 }, [
          ui.text(r.handle.padEnd(maxHandleLen)),
          ui.text(t("metrics_pool_no_data"), { style: { fg: GRAY } }),
        ]),
      );
      continue;
    }
    const cells: any[] = [ui.text(r.handle.padEnd(maxHandleLen))];
    if (r.util5h !== null) {
      const bar5h = buildUtilizationBar("5h", r.util5h, r.reset5hIso, nowMs);
      cells.push(...partsToUiText(bar5h.parts));
    }
    if (r.util7d !== null) {
      const bar7d = buildUtilizationBar("7d", r.util7d, r.reset7dIso, nowMs);
      cells.push(...partsToUiText(bar7d.parts));
    }
    rows.push(ui.row({ gap: 1 }, cells));
  }
  return rows;
}

/**
 * Metrics タブの行配列を構築する純粋関数。
 *
 * @param data - 1 tick 分のスナップショット。null なら loading 表示
 * @param error - 直近の loadMetricsData エラー（stale-while-error 用）。末尾に表示
 */
export function buildMetricsRows(
  data: MetricsData | null,
  error: string | null,
): any[] {
  const rows: any[] = [];

  if (data === null) {
    rows.push(ui.text(t("metrics_loading"), { dim: true }));
    if (error) {
      rows.push(ui.text(""));
      rows.push(ui.text(error, { style: { fg: RED } }));
    }
    return rows;
  }

  // ── 取得元 caption + proxy idle fallback ──────────────────────────────
  // F1: latestRowRole が "master, x-cmux-surface: ..." のような汚染値でも
  //     SQL の CASE と同じルールで master に丸める（DRY のため normalizeRole を共有）。
  const latestAgeSec =
    data.latestRowTimestampMs !== null
      ? Math.max(0, Math.floor((data.nowMs - data.latestRowTimestampMs) / 1000))
      : null;
  const proxyIdle =
    latestAgeSec !== null && latestAgeSec > PROXY_IDLE_THRESHOLD_SEC;

  if (data.latestRowTimestampMs === null) {
    rows.push(ui.text(t("metrics_label_no_data"), { style: { fg: GRAY } }));
  } else if (proxyIdle) {
    rows.push(
      ui.text(t("metrics_proxy_idle", { age: String(latestAgeSec) }), {
        style: { fg: YELLOW },
      }),
    );
  } else {
    rows.push(
      ui.text(
        t("metrics_caption_from", {
          role: normalizeRole(data.latestRowRole),
          surface: data.latestRowSurface ?? "-",
          age: String(latestAgeSec ?? 0),
        }),
        { dim: true },
      ),
    );
  }

  // ── 上段: Rate Limit Projection (5h / 7d) ────────────────────────────
  rows.push(ui.text(""));
  rows.push(
    ui.text(`── ${t("metrics_section_rate_limit_projection")} ──`, {
      dim: true,
    }),
  );
  rows.push(...buildProjectionRows("5h", data.projection5h, data.nowMs));
  rows.push(...buildProjectionRows("7d", data.projection7d, data.nowMs));

  // ── Pool Tokens（pool 有効時のみ）──────────────────────────────────────
  rows.push(...buildPoolTokensSection(data.poolTokens, data.nowMs));

  // ── 中段: ロール別集計 ─────────────────────────────────────────────────
  rows.push(ui.text(""));
  rows.push(
    ui.text(`── ${t("metrics_section_role")} ──`, { dim: true }),
  );
  if (data.roleRows.length === 0) {
    rows.push(ui.text(t("metrics_empty_role"), { dim: true }));
  } else {
    rows.push(
      ui.row({ gap: 2 }, [
        ui.text(t("metrics_header_role").padEnd(10), { dim: true }),
        ui.text(t("metrics_header_requests").padStart(12), { dim: true }),
        ui.text(t("metrics_header_input").padStart(12), { dim: true }),
        ui.text(t("metrics_header_output").padStart(12), { dim: true }),
        ui.text(t("metrics_header_cache").padStart(12), { dim: true }),
      ]),
    );
    for (const r of data.roleRows) {
      rows.push(
        ui.row({ gap: 2 }, [
          ui.text(r.role.padEnd(10)),
          ui.text(r.requests.toLocaleString("en-US").padStart(12), { dim: true }),
          ui.text(r.input.toLocaleString("en-US").padStart(12)),
          ui.text(r.output.toLocaleString("en-US").padStart(12)),
          ui.text(r.cache.toLocaleString("en-US").padStart(12), { dim: true }),
        ]),
      );
    }
  }

  // ── 下段: タスク別集計 ───────────────────────────────────────────────────
  rows.push(ui.text(""));
  rows.push(
    ui.text(
      `── ${t("metrics_section_task", { limit: String(TASK_TOP_LIMIT) })} ──`,
      { dim: true },
    ),
  );
  if (data.taskRows.length === 0) {
    rows.push(ui.text(t("metrics_empty_task"), { dim: true }));
  } else {
    rows.push(
      ui.row({ gap: 2 }, [
        ui.text(t("metrics_header_task").padEnd(10), { dim: true }),
        ui.text(t("metrics_header_requests").padStart(12), { dim: true }),
        ui.text(t("metrics_header_input").padStart(12), { dim: true }),
        ui.text(t("metrics_header_output").padStart(12), { dim: true }),
        ui.text(t("metrics_header_cache").padStart(12), { dim: true }),
      ]),
    );
    for (const r of data.taskRows) {
      rows.push(
        ui.row({ gap: 2 }, [
          ui.text(r.task_id.padEnd(10)),
          ui.text(r.requests.toLocaleString("en-US").padStart(12), { dim: true }),
          ui.text(r.input.toLocaleString("en-US").padStart(12)),
          ui.text(r.output.toLocaleString("en-US").padStart(12)),
          ui.text(r.cache.toLocaleString("en-US").padStart(12), { dim: true }),
        ]),
      );
    }
  }

  // ── エラー表示（stale-while-error） ────────────────────────────────────
  if (error) {
    rows.push(ui.text(""));
    rows.push(ui.text(error, { style: { fg: RED } }));
  }

  return rows;
}
