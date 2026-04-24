/**
 * T307: dashboard Metrics タブの純粋 build / 集計関数群。
 *
 * 責務分担:
 * - trace-store.ts: SQL 集計（aggregateApiUsageByRole / aggregateApiUsageByTask /
 *   getLatestApiUsageRow / getBurnRateWindow）
 * - dashboard-metrics.ts: UI 行ビルド + 数値変換（本モジュール）
 * - dashboard.tsx: AppState 管理 + interval + keybind + rendering 分岐
 *
 * `buildMetricsRows` は AppState/daemon への参照を持たず、`MetricsData` を
 * 受け取って `any[]`（Rezi UI 行オブジェクト配列）を返す純粋関数。
 * ユニットテストは `dashboard-metrics.test.tsx` で JSON stringify → toContain
 * パターンで検証する。
 */
import { ui, rgb } from "@rezi-ui/core";
import type {
  AggregatedRoleRow,
  AggregatedTaskRow,
} from "./trace-store";
import { t } from "./i18n";

const GREEN = rgb(0, 160, 0);
const YELLOW = rgb(200, 160, 0);
const RED = rgb(180, 40, 40);
const GRAY = rgb(130, 130, 130);

/** Metrics タブで描画する全データ。loadMetricsData が 1 tick 分を構築する。 */
export interface MetricsData {
  /** この MetricsData 構築時刻（ms）。proxy idle 判定や "Ns ago" 表示に使う */
  nowMs: number;
  /** 分単位 tokens remaining（getLatestApiUsageRow 由来、ヘッダー未取得なら null） */
  tokensRemaining: number | null;
  /** 分単位 tokens limit */
  tokensLimit: number | null;
  /** 分単位 tokens reset（ISO 8601 文字列、未取得なら null） */
  tokensResetIso: string | null;
  /** 分単位 requests remaining */
  requestsRemaining: number | null;
  /** 分単位 requests limit */
  requestsLimit: number | null;
  /** 分単位 requests reset */
  requestsResetIso: string | null;
  /** 直近 60s の tok/s */
  burnTokPerSec: number;
  /** ロール別集計（直近 1h、input+output 降順） */
  roleRows: AggregatedRoleRow[];
  /** タスク別集計（直近 1h、input+output 降順で limit 件） */
  taskRows: AggregatedTaskRow[];
  /** Rec #5: 最新 api_usage 行の role（rate limit ヘッダーの取得元） */
  latestRowRole: string | null;
  /** Rec #5: 最新 api_usage 行の surface */
  latestRowSurface: string | null;
  /** Rec #6: 最新 api_usage 行の timestamp（ms、proxy idle 判定用）。
   *   row 自体が存在しない（proxy 未稼働）場合は null */
  latestRowTimestampMs: number | null;
}

/** タスク別ランキングの表示件数（D4 の責務分離と合わせて UI 定数） */
const TASK_TOP_LIMIT = 5;
/** Rec #6: proxy idle 判定の閾値（秒） */
const PROXY_IDLE_THRESHOLD_SEC = 60;

/**
 * ASCII プログレスバー生成。
 * `█`（filled）と `░`（dim）の組み合わせで残量表示。
 * `limit = 0` のとき 0 除算を回避して全 dim を返す。
 */
export function buildProgressBar(
  consumed: number,
  limit: number,
  width: number = 16,
): string {
  if (limit <= 0 || !Number.isFinite(limit)) {
    return "░".repeat(width);
  }
  const ratio = Math.max(0, Math.min(1, consumed / limit));
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** burn rate を `1,240 tok/s` 形式に整形する。 */
export function formatBurnRate(tokPerSec: number): string {
  const n = Math.round(tokPerSec);
  return `${n.toLocaleString("en-US")} tok/s`;
}

/**
 * remaining / burn から「上限到達までの予測秒数」を計算する。
 * - remaining が null（ヘッダー未取得）→ null
 * - burn が 0 以下（idle / 異常値）→ null（上限到達しないので意味なし）
 */
export function computeProjectedToLimit(
  remaining: number | null,
  burnTokPerSec: number,
): number | null {
  if (remaining === null) return null;
  if (burnTokPerSec <= 0 || !Number.isFinite(burnTokPerSec)) return null;
  return remaining / burnTokPerSec;
}

/**
 * `projected`（上限到達秒数）と `resetRemaining`（リセットまでの秒数）から
 * リスクレベルを決定する。
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

/**
 * `utilization`（0-1）からパーセンテージ文字列とリスクカラーを返す。
 * 使用率の色分け: < 70% green / 70-89% yellow / >= 90% red。
 */
function utilizationColor(util: number | null): {
  text: string;
  color: ReturnType<typeof rgb> | undefined;
} {
  if (util === null) {
    return { text: t("metrics_label_no_data"), color: GRAY };
  }
  const pct = Math.round(util * 100);
  const color = pct >= 90 ? RED : pct >= 70 ? YELLOW : GREEN;
  return { text: `${pct}%`, color };
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
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec - h * 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
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

  // ── Rec #5 / Rec #6: 取得元 caption + proxy idle fallback ────────────────
  const latestAgeSec =
    data.latestRowTimestampMs !== null
      ? Math.max(0, Math.floor((data.nowMs - data.latestRowTimestampMs) / 1000))
      : null;
  const proxyIdle =
    latestAgeSec !== null && latestAgeSec > PROXY_IDLE_THRESHOLD_SEC;

  if (data.latestRowTimestampMs === null) {
    // proxy 未稼働 / 接続前
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
          role: data.latestRowRole ?? "unknown",
          surface: data.latestRowSurface ?? "-",
          age: String(latestAgeSec ?? 0),
        }),
        { dim: true },
      ),
    );
  }

  // ── 上段: 分単位 rate limit (tokens / requests / burn rate) ──────────────
  rows.push(ui.text(""));
  rows.push(
    ui.text(`── ${t("metrics_section_rate_limit")} ──`, { dim: true }),
  );

  // tokens 行: [███░░░░░░░] 70%  800,000 / 1,000,000  reset in 45s
  {
    const consumed =
      data.tokensLimit !== null && data.tokensRemaining !== null
        ? data.tokensLimit - data.tokensRemaining
        : 0;
    const limit = data.tokensLimit ?? 0;
    const bar = buildProgressBar(consumed, limit, 16);
    const util = limit > 0 ? consumed / limit : null;
    const colored = utilizationColor(util);
    const resetSec =
      data.tokensResetIso !== null
        ? (Date.parse(data.tokensResetIso) - data.nowMs) / 1000
        : null;
    const resetStr = formatDurationShort(resetSec);
    const remainingStr =
      data.tokensRemaining !== null && data.tokensLimit !== null
        ? `${data.tokensRemaining.toLocaleString("en-US")} / ${data.tokensLimit.toLocaleString("en-US")}`
        : t("metrics_label_no_data");
    rows.push(
      ui.row({ gap: 1 }, [
        ui.text(t("metrics_label_tokens"), { dim: true }),
        ui.text(bar, { style: { fg: colored.color } }),
        ui.text(colored.text, { style: { fg: colored.color } }),
        ui.text(remainingStr, { dim: true }),
        ui.text(`${t("metrics_label_reset_in")} ${resetStr}`, { dim: true }),
      ]),
    );
  }

  // requests 行
  {
    const consumed =
      data.requestsLimit !== null && data.requestsRemaining !== null
        ? data.requestsLimit - data.requestsRemaining
        : 0;
    const limit = data.requestsLimit ?? 0;
    const bar = buildProgressBar(consumed, limit, 16);
    const util = limit > 0 ? consumed / limit : null;
    const colored = utilizationColor(util);
    const resetSec =
      data.requestsResetIso !== null
        ? (Date.parse(data.requestsResetIso) - data.nowMs) / 1000
        : null;
    const resetStr = formatDurationShort(resetSec);
    const remainingStr =
      data.requestsRemaining !== null && data.requestsLimit !== null
        ? `${data.requestsRemaining.toLocaleString("en-US")} / ${data.requestsLimit.toLocaleString("en-US")}`
        : t("metrics_label_no_data");
    rows.push(
      ui.row({ gap: 1 }, [
        ui.text(t("metrics_label_requests"), { dim: true }),
        ui.text(bar, { style: { fg: colored.color } }),
        ui.text(colored.text, { style: { fg: colored.color } }),
        ui.text(remainingStr, { dim: true }),
        ui.text(`${t("metrics_label_reset_in")} ${resetStr}`, { dim: true }),
      ]),
    );
  }

  // burn rate 行 + projected + RISK ラベル
  {
    const burnStr = formatBurnRate(data.burnTokPerSec);
    const resetSec =
      data.tokensResetIso !== null
        ? (Date.parse(data.tokensResetIso) - data.nowMs) / 1000
        : null;
    const projectedSec = computeProjectedToLimit(
      data.tokensRemaining,
      data.burnTokPerSec,
    );
    const risk = computeRiskLevel(projectedSec, resetSec);
    const color = mapRiskToColor(risk);
    const projectedStr =
      projectedSec === null
        ? t("metrics_label_idle")
        : formatDurationShort(projectedSec);
    const riskLabel = risk === "red"
      ? `⚠ ${t("metrics_label_risk")}`
      : risk === "yellow"
      ? t("metrics_label_risk")
      : "";
    const parts: any[] = [
      ui.text(t("metrics_label_burn_rate"), { dim: true }),
      ui.text(burnStr, { style: { fg: color } }),
      ui.text(
        `${t("metrics_label_projected")}: ${projectedStr}`,
        { dim: true },
      ),
    ];
    if (riskLabel) {
      parts.push(ui.text(riskLabel, { style: { fg: color, bold: true } }));
    }
    rows.push(ui.row({ gap: 1 }, parts));
  }

  // ── 中段: ロール別集計 ─────────────────────────────────────────────────
  rows.push(ui.text(""));
  rows.push(
    ui.text(`── ${t("metrics_section_role")} ──`, { dim: true }),
  );
  if (data.roleRows.length === 0) {
    rows.push(ui.text(t("metrics_empty_role"), { dim: true }));
  } else {
    // ヘッダ行
    rows.push(
      ui.row({ gap: 2 }, [
        ui.text(t("metrics_header_role").padEnd(10), { dim: true }),
        ui.text(t("metrics_header_requests").padStart(6), { dim: true }),
        ui.text(t("metrics_header_input").padStart(10), { dim: true }),
        ui.text(t("metrics_header_output").padStart(10), { dim: true }),
        ui.text(t("metrics_header_cache").padStart(10), { dim: true }),
      ]),
    );
    for (const r of data.roleRows) {
      rows.push(
        ui.row({ gap: 2 }, [
          ui.text(r.role.padEnd(10)),
          ui.text(r.requests.toLocaleString("en-US").padStart(6), { dim: true }),
          ui.text(r.input.toLocaleString("en-US").padStart(10)),
          ui.text(r.output.toLocaleString("en-US").padStart(10)),
          ui.text(r.cache.toLocaleString("en-US").padStart(10), { dim: true }),
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
        ui.text(t("metrics_header_requests").padStart(6), { dim: true }),
        ui.text(t("metrics_header_input").padStart(10), { dim: true }),
        ui.text(t("metrics_header_output").padStart(10), { dim: true }),
        ui.text(t("metrics_header_cache").padStart(10), { dim: true }),
      ]),
    );
    for (const r of data.taskRows) {
      rows.push(
        ui.row({ gap: 2 }, [
          ui.text(r.task_id.padEnd(10)),
          ui.text(r.requests.toLocaleString("en-US").padStart(6), { dim: true }),
          ui.text(r.input.toLocaleString("en-US").padStart(10)),
          ui.text(r.output.toLocaleString("en-US").padStart(10)),
          ui.text(r.cache.toLocaleString("en-US").padStart(10), { dim: true }),
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
