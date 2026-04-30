/**
 * T381: alarm 閾値の SSOT。
 *
 * direction map と閾値を一箇所で定義し、`metrics-compare.ts` の `evaluateAlarms` から
 * import する。spec (`docs/spec/11-metrics.md`) の閾値表はこの値の参照（注釈）であり、
 * 値は **コードが SSOT**（finding 6）。
 *
 * direction:
 *  - `lower_is_worse`  : 値が下がると悪化（completion_rate）
 *  - `higher_is_worse` : 値が上がると悪化（forced_close_rate / duration_ms_mean / tool_failure_rate）
 *
 * unit:
 *  - `pp`  : percentage point（0..1 スケール、比率系の絶対差）
 *  - `pct` : 相対変化率（baseline 比、連続値系）
 */

export type AlarmDirection = "higher_is_worse" | "lower_is_worse";
export type AlarmUnit = "pp" | "pct";

export interface AlarmThreshold {
  direction: AlarmDirection;
  /** pp: 絶対差（0..1）、pct: 相対変化率（0..1） */
  delta: number;
  unit: AlarmUnit;
}

export type AlarmThresholds = Record<string, AlarmThreshold>;

export const DEFAULT_ALARM_THRESHOLDS: AlarmThresholds = {
  completion_rate:    { direction: "lower_is_worse",  delta: 0.10, unit: "pp"  },
  forced_close_rate:  { direction: "higher_is_worse", delta: 0.05, unit: "pp"  },
  duration_ms_mean:   { direction: "higher_is_worse", delta: 0.30, unit: "pct" },
  tool_failure_rate:  { direction: "higher_is_worse", delta: 0.05, unit: "pp"  },
};
