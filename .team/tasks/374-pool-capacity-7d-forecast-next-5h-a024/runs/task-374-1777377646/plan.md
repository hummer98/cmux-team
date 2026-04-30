# T374 実装計画 — pool capacity を 7d forecast ゲージ + next 候補 5h に再設計（A024）

> **ソース**: A024 (`.team/artifacts/A024-pool-capacity-7d-forecast-gauge.md`) を確定仕様とする。
> 計算式・閾値・表示文言は A024 と一致させる。本計画書で独自最適化や近似は導入しない。
>
> **改訂版（design-review.md 反映後）**:
> - R1: Phase 順序を「拡張 → 切替 → 削除」に再配列し、各 Phase 末で `bunx tsc --noEmit` が pass する構造に
> - R2: A024 の "非 stale" 文言を本タスクで update（選択肢 A 採用 / §8.4・§10.2 参照）
> - R3: `buildBinRanges` を `(nowIso, timezone)` を引数で受ける純関数化（代替案 b）
> - R4: `PeekedToken` に `util_7d` を追加
> - R5: スパークライン境界値 / forecast 境界 reset の test.each を明示
> - R6: §10.3 に tsconfig 補足、§6.1 に `pool-cli.ts` 事前 grep を追記

---

## スコープ概要

| ID | ファイル | 変更種別 | 行数目安 |
|---|---|---|---|
| F1 | `skills/cmux-team/manager/forecast.ts` | **新規** | ~140 |
| F1t | `skills/cmux-team/manager/forecast.test.ts` | **新規** | ~220 |
| F2 | `skills/cmux-team/manager/token-store.ts` | 拡張（`peekNextToken` 追加・`admitCandidates` の戻り値拡張） | +40 |
| F2t | `skills/cmux-team/manager/token-store.test.ts` 等 | テスト追加（既存に追記） | +60 |
| F3 | `skills/cmux-team/manager/pool-summary.ts` | 型拡張・呼び出し追加（Phase 3 で header と forecast 並存 / Phase 5.5 で header 削除） | ±40 |
| F3t | `skills/cmux-team/manager/pool-summary.test.ts` | 既存ケース更新 + forecast / next ケース追加 | +60 |
| F4 | `skills/cmux-team/manager/pool-status-header.ts` | 全面書き換え | -40 +80 |
| F4t | `skills/cmux-team/manager/pool-status-header.test.ts` | 既存全置換 | ~ |
| F5 | `skills/cmux-team/manager/pool-header-display.ts` | 全面書き換え | -30 +70 |
| F5t | `skills/cmux-team/manager/pool-header-display.test.ts` | 既存全置換 | ~ |
| F6 | `skills/cmux-team/manager/pool-surface-row.ts` 周辺 | per-surface decoration 削除 | -100 |
| F6t | `skills/cmux-team/manager/pool-surface-row.test.ts` / `dashboard-*.test.tsx` | 削除/更新 | -150 |
| F7 | `docs/spec/09-token-pool.md` | §pool_capacity 指標を §forecast に書き換え | ~ |
| F8 | `.team/artifacts/A024-pool-capacity-7d-forecast-gauge.md` | §next 候補の選定 の「非 stale」に脚注追加（R2） | +5 |
| F9 | `README.md` / `README.ja.md` / `CHANGELOG.md` | スクリーンショット・例示更新 | ~ |

**前提**: 既存 `computePoolCapacity` の per_token 内部利用（`pool-cli.ts: cmux-team pool status`）は当面温存。`capacity_5h_pct` / `capacity_7d_pct` 集計値はヘッダー表示から完全撤去（Phase 5.5 で `PoolSummary.header` 自体を撤去）。

---

## 1. 新規 `forecast.ts` の設計

### 1.1 公開 API

```ts
// skills/cmux-team/manager/forecast.ts

export const FORECAST_DAYS = 7 as const;
export const FULL_WEEK_HOURS = 168 as const;

/** Day 0..6 の bar 高さ（0..∞、% 単位の生数値）。100 で sustainable pace 同等、>100 は cap 表現で頭打ちに使う。 */
export interface Pool7dForecast {
  bars: number[];          // 長さ 7（FORECAST_DAYS）。NaN や負値は出さない
  /** 計算に有効寄与した token 数（plan_ratio!=null かつ selectable=true）。0 なら全 cell が NaN ではなく 0 を入れる */
  contributingTokens: number;
}

export interface ForecastTokenInput {
  handle: string;
  plan_ratio: number | null;
  util_7d: number | null;
  reset_7d_at: string | null;
  /** A024 §エッジケース「selectable=false は denom にも入れない」のため policy 適用後の token を入力する */
  selectable: boolean;
}

export function computePool7dForecast(
  tokens: ForecastTokenInput[],
  nowIso: string,
  /** R3: 代替案 b — TZ を引数で受け取る純関数。省略時は process でランタイム TZ を取得 */
  timezone?: string,
): Pool7dForecast;
```

**型方針**:

- 既存 `TokenForCapacity` (token-store.ts:53) は **5h 軸も含む型**。本関数は 7d 軸のみ使う + `selectable` を必要とするため、別途 `ForecastTokenInput` を定義（7d 専用 / selectable を明示）。
- `pool-summary.ts` 側で `TokenForCapacity` から `ForecastTokenInput` へマップする（`util_5h` / `reset_5h_at` を捨てて `selectable` を足す）。
- `Pool7dForecast.bars` は `number[]` で固定長 7（A024 §確定事項）。配列リテラルの長さは runtime 検証ではなく実装で保証（test で長さ 7 を assert）。

### 1.2 内部分解（R3 反映: timezone 引数を全段に伝搬）

```ts
// rate 関数（per-hour rate）。t は now からの経過時間 [h]
function rateAt(token, t_h, hoursToReset_h): number {
  // t < hoursToReset → (1 - util_7d) / hoursToReset
  // t >= hoursToReset → 1/168
}

// bin 内積分（A024 §計算式 alloc_i）
function integrateBin(token, binStart_h, binEnd_h, hoursToReset_h): number {
  // case 1: binEnd <= reset → (binEnd - binStart) * rate_pre
  // case 2: binStart >= reset → (binEnd - binStart) / 168
  // case 3: straddle → (reset - binStart) * rate_pre + (binEnd - reset) / 168
}

/**
 * R3: 代替案 b — `nowIso` と `timezone` を受ける純関数。
 * 本番呼び出し側（pool-summary.ts）が `Intl.DateTimeFormat().resolvedOptions().timeZone` で
 * ランタイム TZ を取得して渡し、test 側は `"UTC"` / `"America/New_York"` 等を直接注入する。
 */
function buildBinRanges(nowIso: string, timezone: string): Array<{ startH: number; endH: number }>; // length 7

// メイン
function computePool7dForecast(tokens, nowIso, timezone?) {
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const elig = tokens.filter(t => isEligible(t));   // A024 §エッジケース参照
  if (elig.length === 0) return { bars: [0,0,0,0,0,0,0], contributingTokens: 0 };

  const bins = buildBinRanges(nowIso, tz);
  const sumPlanRatio = elig.reduce((acc, t) => acc + t.plan_ratio!, 0);

  const bars = bins.map(bin => {
    const binHours = bin.endH - bin.startH;
    let pool = 0;
    for (const t of elig) {
      const reset_h = hoursToReset(t.reset_7d_at, nowIso); // ← null 不可（isEligible で弾かれる）
      const alloc = integrateBin(t, bin.startH, bin.endH, reset_h);
      pool += alloc * t.plan_ratio!;
    }
    const denom = (binHours / FULL_WEEK_HOURS) * sumPlanRatio;
    return (pool / denom) * 100;   // % スケール
  });

  return { bars, contributingTokens: elig.length };
}
```

### 1.3 エッジケース処理（A024 §エッジケース と一致）

| ケース | `isEligible` 結果 | 備考 |
|---|---|---|
| `plan_ratio == null` | 除外 | denom にも入れない |
| `selectable === false` | 除外 | 〃 |
| `util_7d == null` または `reset_7d_at == null` | 除外 | A024「片方 null は完全除外」 |
| `reset_7d_at` の epoch_ms が解釈不能（`parseResetEpochMs` が NaN） | 除外 | 安全側 |
| `reset_7d_at` が **過去** | **除外しない**。`hoursToReset = 0` として扱い、全 bin で `rate = 1/168` を使う | A024 §エッジケース「reset がすでに過去 → now 起点で post-reset rate を使う」 |
| `reset_7d_at` が **>7d 先** | 除外しない。全 bin が pre-reset rate になる（実装上は自動） | A024 §エッジケース 4 |
| 対象 token 0 件（全除外） | `bars = [0,0,0,0,0,0,0]` を返す | UI 側で「forecast 出さず next: のみ」分岐するシグナル |

### 1.4 Day 0 = 残時間のみ の bin 計算（R3: TZ 注入版）

A024 §Day 0 の bin: `[now, 今日 24:00 (local)]`。**指定 timezone** で 24:00（=翌日 00:00）に向かう経過時間を使う。

```ts
function buildBinRanges(nowIso: string, timezone: string) {
  const now = new Date(nowIso);
  // 指定 TZ における now の time-of-day を Intl.DateTimeFormat で取り出す
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(now);
  const hh = Number(parts.find(p => p.type === "hour")!.value);
  const mm = Number(parts.find(p => p.type === "minute")!.value);
  const ss = Number(parts.find(p => p.type === "second")!.value);
  // 当該 TZ で 00:00 までの残り秒数（小数 ms 切り捨ては許容、A024 ±1% 許容内）
  const secsSinceMidnight = hh * 3600 + mm * 60 + ss;
  const day0Hours = (86_400 - secsSinceMidnight) / 3600;

  const bins: Array<{ startH: number; endH: number }> = [{ startH: 0, endH: day0Hours }];
  for (let d = 1; d < FORECAST_DAYS; d++) {
    bins.push({ startH: day0Hours + 24 * (d - 1), endH: day0Hours + 24 * d });
  }
  return bins;
}
```

**注意**:

- `setHours(24, 0, 0, 0)` は使わない（プロセス TZ に依存するため test で固定しづらく、R3 M3 のリスク）。代わりに `Intl.DateTimeFormat` で指定 TZ の time-of-day を読み出して残り秒数を計算する。
- DST 切替日は当該 TZ で 23h or 25h day になりうるが、本実装は「24:00 までの残り時間」のみ Day 0 に入れ Day 1..6 は固定 24h で進めるため、A024 §確定事項「Day 0 は残り時間のみ（可変幅）」とは整合する。Day 1..6 が DST 跨ぎで物理的に 23h or 25h になる場合の bin 端ズレは A024 §エッジケース対象外（許容誤差 ±1% に収まる）。
- 本番呼び出し側（pool-summary.ts）は `Intl.DateTimeFormat().resolvedOptions().timeZone` でランタイム TZ を解決して渡す。test 側は `timezone="UTC"` を直接注入。

### 1.5 hoursToReset の解釈

`token-store.ts: parseResetEpochMs` を流用（既に export 済み・T372 で同種の経路に統合）。`(parseResetEpochMs(reset_7d_at) - nowMs) / 3_600_000`。

`isEligible` で NaN を弾く。reset が過去なら正規化して 0 を入れて積分式の `case 2` にフォールスルー。

---

## 2. 新規 API: `peekNextToken` の設計

### 2.1 シグネチャ（R4 反映: util_7d 追加）

```ts
// token-store.ts に追加

export interface PeekedToken {
  handle: string;
  util_5h: number | null;     // 候補抽出時の "effUtil_5h"（stale 救済反映後）。snapshot 不在時 null
  util_7d: number | null;     // R4: admitCandidates が effUtil7d を持つので extra cost ゼロで揃える
}

export function peekNextToken(
  db: Database,
  policy: SelectTokenPolicy | string[],
  nowIso: string = new Date().toISOString(),
): PeekedToken | null;
```

### 2.2 既存 `selectToken` からの抜き出し（行番号レベル指示）

`token-store.ts:1019-1041` の `selectToken` をテンプレートに、`acquireLease` を呼ばない peek 版を作る。

```ts
export function peekNextToken(db, policy, nowIso = new Date().toISOString()): PeekedToken | null {
  const p = normalizePolicy(policy);
  expireLeases(db, nowIso);                  // 既存と同じ副作用（pool DB 一貫性維持）
  const candidates = admitCandidates(db, p, nowIso);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0]!;
  return { handle: best.token.handle, util_5h: best.effUtil5h, util_7d: best.effUtil7d };
}
```

### 2.3 admitCandidates 戻り値の拡張

`token-store.ts:887-970` の `admitCandidates` を **副作用なし・公開シグネチャ非変更** で内部だけ拡張:

```ts
function admitCandidates(db, policy, nowIso): Array<{
  token: Token;
  score: number;
  effUtil5h: number;   // 追加（peekNextToken 用）
  effUtil7d: number;   // 追加（PeekedToken / debug 用）
}> {
  // ... 既存ロジック ...
  candidates.push({ token: tok, score, effUtil5h, effUtil7d });
}
```

`selectToken` (1019-1041) と `canSelectAnyToken` (984-993) は既存 `score`/`length` しか参照しないため互換維持。

### 2.4 lease を取らない以外の差分の確認（R2 反映）

A024 §next 候補の選定:

- `project_tags` でフィルタ → 既存 `policy.projectTags` でカバー
- `selectable=1` / blocker（util_5h ≤ 95% / 非 stale / 非 lease） → 既存 `admitCandidates` でカバー
  - **stale 非除外**: T373 で `selectToken` admit は「stale 救済」に方針変更済み。A024 §next 候補 の旧文言「非 stale」は T373 以前の写しであり、本タスクでは **A024 アーティファクトに脚注追加（R2 / §8.4）** + **`peekNextToken` は spawn-agent と同じ admit 経路を共有** という対応で整合させる。
  - 理由: `peekNextToken` は「spawn-agent が次に選ぶ token を peek」する責務であり、admit ロジックが乖離すると「peek で出した候補が実際の spawn で選ばれない」UX 不整合が生じる。
- `score = w_5h × util_5h + w_7d × util_7d` 最小 → 既存と同じ（係数も同じ）

### 2.5 配置場所

**`token-store.ts` に追加**（別ファイル化しない）:

- `selectToken` / `canSelectAnyToken` と同じ admit ロジックを共有するため、`admitCandidates` という private 関数を import するわけにはいかない（同一モジュール内クロージャ）
- `pool-throttle.ts` のように policy 解釈を別ファイルに切り出すと admit の二重実装リスクが復活する（T367 の構造的整合性原則に反する）

---

## 3. `pool-summary.ts` 拡張（Phase 3 と Phase 5.5 で 2 段階）

### 3.1 Phase 3 時点の型（header 残す）

R1 反映: Phase 3 では `header` を残し `forecast7d` / `nextCandidate` を **追加**。これにより既存の `pool-status-header.ts` / `pool-header-display.ts` / `dashboard.tsx (legacy buildPoolHeader)` の型不整合を Phase 4-5 まで起こさない。

```ts
// pool-summary.ts (Phase 3 時点)

import { computePool7dForecast, type Pool7dForecast } from "./forecast";
import { peekNextToken, type PeekedToken } from "./token-store";

export interface PoolSummary {
  /** 旧仕様。Phase 5.5 で削除 */
  header: PoolHeaderInput;
  /** A024 §TUI 表示の forecast ゲージ用。bars.length === 7 */
  forecast7d: Pool7dForecast;
  /** A024 §TUI 表示の next 候補。null = 候補なし（全 blocked / tags 不適合） */
  nextCandidate: PeekedToken | null;
  /** handle ごとの per-surface 表示用 lookup */
  perHandle: Map<string, PerHandleSummary>;
}
```

### 3.2 Phase 5.5 時点の型（header 削除）

```ts
// pool-summary.ts (Phase 5.5 以降)

export interface PoolSummary {
  forecast7d: Pool7dForecast;
  nextCandidate: PeekedToken | null;
  perHandle: Map<string, PerHandleSummary>;
}
```

旧 `header.capacity5hPct` / `header.capacity7dPct` を直接読んでいた箇所は Phase 4-5 で書き換え済みのため、Phase 5.5 で `header` フィールドを削除しても type-safe。

`PerHandleSummary.capPct` (token-store の `per_token.cap_pct`) は当面維持（`pool-cli.ts: cmux-team pool status` がまだ使う）。

### 3.3 `buildPoolSummary` の呼び出し順序（Phase 3）

```ts
export function buildPoolSummary(
  db: Database,
  nowIso: string = new Date().toISOString(),
  policy: SelectTokenPolicy | null = null,    // ← R1 反映で Phase 3 から追加
): PoolSummary {
  const tokens = listTokens(db);
  const snapshots = new Map(tokens.map(t => [t.id, getLatestUsageSnapshot(db, t.id)]));

  // 1) forecast7d（純関数、A024 §計算式）
  const forecastTokens: ForecastTokenInput[] = tokens.map(t => {
    const snap = snapshots.get(t.id) ?? null;
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

  // 2) nextCandidate (peek。policy が渡されたときのみ)
  const nextCandidate: PeekedToken | null =
    policy != null ? peekNextToken(db, policy, nowIso) : null;

  // 3) perHandle + (Phase 3 限定) header（既存ロジック踏襲）
  const cap = computePoolCapacity(forCap, nowIso); // 既存維持
  const capByHandle = new Map(cap.per_token.map(p => [p.handle, p.cap_pct]));
  const perHandle = new Map<string, PerHandleSummary>();
  for (const t of tokens) {
    const snap = snapshots.get(t.id) ?? null;
    perHandle.set(t.handle, {
      util5h: snap?.util_5h ?? null,
      util7d: snap?.util_7d ?? null,
      capPct: capByHandle.get(t.handle) ?? null,
      selectable: t.selectable,
    });
  }

  // Phase 3: 旧 header をそのまま埋める。Phase 5.5 で本ブロック削除
  const header: PoolHeaderInput = buildLegacyPoolHeaderInput(cap, /* ... */);

  return { header, forecast7d, nextCandidate, perHandle };
}
```

### 3.4 policy 注入経路

`peekNextToken` は `SelectTokenPolicy` を要求する。`buildPoolSummary` は policy を持たないので **オプショナル引数**で受ける:

```ts
export function buildPoolSummary(
  db: Database,
  nowIso: string = new Date().toISOString(),
  policy: SelectTokenPolicy | null = null,    // Phase 3 から追加
): PoolSummary;
```

- `policy=null` のときは `nextCandidate=null`（CLI 側 `loadPoolSummary` の最低限フォールバック）
- `loadPoolSummary` 側で `buildSelectTokenPolicy(projectRoot)` を呼んで policy を解決し、`buildPoolSummary(db, nowIso, policy)` に渡す
- `daemon` 側は `state.poolPolicy` を起動時 1 回キャッシュしている（`docs/spec/09-token-pool.md` §policy 構築の一元化）。これを `buildPoolSummary` に渡す

### 3.5 `loadPoolSummary` の更新

```ts
export async function loadPoolSummary(projectRoot, nowIso?): Promise<PoolSummary | null> {
  const decision = await isTokenPoolEnabled(projectRoot);
  if (!decision.enabled) return null;
  const db = initTokenDB();
  const policy = await buildSelectTokenPolicy(projectRoot);    // ← 追加
  return buildPoolSummary(db, nowIso, policy);
}
```

### 3.6 daemon 側 (`daemon.ts`) からの呼び出し

`buildPoolSummary(state.tokenDb, nowIso, state.poolPolicy)` に変更。state.poolPolicy が空の場合は null を渡す。`daemon.ts:41` の import に変更なし。

### 3.7 エッジケース時のデフォルト値（A024 §エッジケース表 と整合）

| 状況 | `forecast7d.bars` | `nextCandidate` | UI 動作 |
|---|---|---|---|
| 候補アカウントなし（全 blocked） | 計算結果 or 全 0 | `null` | UI: `next: ⚠ no eligible account` |
| pool 機能 OFF / token 未登録 | — | — | `loadPoolSummary` が null を返す → ヘッダー行非表示 |
| 候補は居るが `util_5h == null` | 計算結果 | `{ handle, util_5h: null, util_7d: ... }` | UI: `next: @kddi 5h:—` |
| 全 token の reset_7d_at が null | `[0,0,0,0,0,0,0]` (contributingTokens=0) | あり / なし | UI: スパークラインを出さず next: のみ |

---

## 4. `pool-status-header.ts` 書き換え

### 4.1 新インターフェース

```ts
// pool-status-header.ts

export type SparklineCell = " " | "▁" | "▂" | "▃" | "▄" | "▅" | "▆" | "▇" | "█";

export interface PoolHeaderInput {
  forecast7d: Pool7dForecast;
  nextCandidate: PeekedToken | null;
}

export function buildPoolHeaderLines(input: PoolHeaderInput | null): string[];
export function mapBarToSparkline(barPct: number): SparklineCell;          // export（test 用）
export function pickSparklineColor(bars: number[]): "green" | "yellow" | "red";
```

注: 新 `PoolHeaderInput` は **新仕様の型**（`forecast7d` / `nextCandidate`）。旧 `PoolSummary.header` の型と同名だが内容は別物。Phase 4 着手時に旧 `pool-status-header.ts` の `PoolHeaderInput` を新定義で完全置換する。

### 4.2 スパークライン文字マッピング（A024 §TUI 表示 8 段マッピング）

```ts
const SPARK_CHARS: SparklineCell[] = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇"];

export function mapBarToSparkline(barPct: number): SparklineCell {
  if (barPct >= 100) return "█";    // cap
  if (barPct < 0) return " ";        // 異常値防御
  // 0..100 を 8 段に区切る。境界値（12.5, 25, ...）は上位 cell に倒す（A024 §TUI 表示）
  if (barPct < 12.5) return " ";
  if (barPct < 25) return "▁";
  if (barPct < 37.5) return "▂";
  if (barPct < 50) return "▃";
  if (barPct < 62.5) return "▄";
  if (barPct < 75) return "▅";
  if (barPct < 87.5) return "▆";
  return "▇";   // [87.5, 100)
}
```

実装は **lookup table ではなく `if` チェイン**を採用（境界値判定が明示的・lookup table だと off-by-one を見逃しやすい）。

### 4.3 色閾値（A024 §TUI 表示）

`min(bar(d) for d=0..6)` ベース、全 cell 一括色:

```ts
export function pickSparklineColor(bars: number[]): "green" | "yellow" | "red" {
  if (bars.length === 0) return "red";
  const m = Math.min(...bars);
  if (m >= 100) return "green";
  if (m >= 70) return "yellow";
  return "red";
}
```

### 4.4 next 候補フォーマット

```ts
function formatNext(next: PeekedToken | null): string {
  if (next == null) return "next: ⚠ no eligible account";
  if (next.util_5h == null) return `next: ${next.handle} 5h:—`;
  return `next: ${next.handle} 5h:${Math.round(next.util_5h * 100)}%`;
}
```

5h util の色（A024 §5h util の色）:

- `> 95%`: red
- `> 70%`: yellow
- それ以下: green / gray

`pool-status-header.ts` は ANSI 色を直接書かない（rate-limit-display.ts と同じ哲学）。`PoolHeaderInput` を string 化する **CLI 用は plain string** で出力。色は呼び出し側の `dashboard.tsx` が `pool-header-display.ts` 経由で適用する。

CLI 出力は色なしでよい（`cmux-team status` 既存も色を出していない / pool-status-header.ts は plain string）。

### 4.5 ヘッダー行のレイアウト

A024 §TUI 表示:

```
pool 7d  ██▇▅▅▆█   next: @kddi 5h:65%
```

- 罫線ボックスは **撤去**（旧 `┌─ token pool ─...┐` の固定幅 60 文字 box）
- 1 行のみ。CLI 用 `buildPoolHeaderLines` は string[] を返す（既存シグネチャ維持）が、要素数は基本 1
- `forecast7d.contributingTokens === 0` のとき: A024 §エッジケース「全アカウントの reset_7d_at が null → 7d スパークラインは出さず `next:` だけ表示」に従い、**`pool 7d` ラベル + spark を共に省略**し `next: @kddi 5h:65%` のみ出す。

### 4.6 エッジケース表示（A024 §エッジケース表）

| 状況 | `buildPoolHeaderLines` 戻り値 |
|---|---|
| `input == null`（pool OFF / 失敗） | `[]` |
| `nextCandidate == null` （候補なし） + forecast 有 | `["pool 7d ██▇▅▅▆█  next: ⚠ no eligible account"]` |
| 候補有 + `util_5h == null` | `["pool 7d ██▇▅▅▆█  next: @kddi 5h:—"]` |
| `forecast7d.contributingTokens == 0` + 候補有 | `["next: @kddi 5h:65%"]`（spark 省略） |
| 全アカウント reset_7d_at null + 候補なし | `["next: ⚠ no eligible account"]`（理論上 next も無いはずだが防御） |

---

## 5. `pool-header-display.ts` 書き換え

### 5.1 構造

```ts
import type { RateLimitPart } from "./rate-limit-display";
import type { PoolSummary } from "./pool-summary";
import { mapBarToSparkline, pickSparklineColor } from "./pool-status-header";

export interface PoolHeaderDisplay {
  parts: RateLimitPart[];
}

export function buildPoolHeaderDisplay(summary: PoolSummary | null): PoolHeaderDisplay {
  if (summary == null) return { parts: [] };

  const parts: RateLimitPart[] = [];
  const f = summary.forecast7d;

  // 1) "pool 7d" ラベル + spark (contributingTokens > 0 のみ)
  if (f.contributingTokens > 0) {
    const spark = f.bars.map(mapBarToSparkline).join("");
    const color = pickSparklineColor(f.bars);
    parts.push({ text: `pool 7d  ${spark}`, color, group: true });
  }

  // 2) next: @handle 5h:NN%
  parts.push(buildNextPart(summary.nextCandidate));

  return { parts };
}

function buildNextPart(next: PeekedToken | null): RateLimitPart {
  if (next == null) {
    return { text: "next: ⚠ no eligible account", color: "yellow", group: true };
  }
  if (next.util_5h == null) {
    return { text: `next: ${next.handle} 5h:—`, color: "gray", group: true };
  }
  const pct = Math.round(next.util_5h * 100);
  const color = pct > 95 ? "red" : pct > 70 ? "yellow" : "green";
  return { text: `next: ${next.handle} 5h:${pct}%`, color, group: true };
}
```

### 5.2 `pool-status-header.ts` との表示一致

両者は同じ summary を見て同じ文言・同じ色（CLI 側は色なし）を出す。`mapBarToSparkline` / `pickSparklineColor` を `pool-status-header.ts` から re-export して `pool-header-display.ts` がそれを使う。

cross-validate test (`pool-header-display.test.ts`) で「同じ input から両者の text が一致する」ケースを 1 つ追加する。

### 5.3 Ink Text の Box 配置

`buildPoolHeaderDisplay` の戻り値は `RateLimitPart[]`。これは `dashboard.tsx:1502` の既存ループ:

```tsx
const rl = daemon.pool != null
  ? buildPoolHeaderDisplay(daemon.pool)
  : buildRateLimitDisplay(daemon.rateLimit);
const rightText = rl.parts.map((p, i) => (i > 0 ? (p.group ? "  " : " ") : "") + p.text).join("");
```

に直接乗せられる。Box 配置の追加コードは不要（既存 helper がそのまま使える）。

dashboard 旧経路 `buildPoolHeader` (dashboard.tsx:530) は **削除**（NOTE T363 で「描画経路から外した」と明記済み・new code は使っていない）。

---

## 6. 既存実装の整理

### 6.1 `computePoolCapacity` の去就 + 事前 grep 確認（R6 反映）

| 用途 | 扱い |
|---|---|
| `capacity_5h_pct` / `capacity_7d_pct` フィールド | **値は計算結果として残すが、UI から完全撤去**。`pool-summary.ts: PoolSummary.header` を Phase 5.5 で削除した時点でヘッダー経由の表示は消える |
| `per_token: { handle, cap_pct }` | 残す。`pool-cli.ts: cmux-team pool status` (pool-cli.ts:57) と `token-cli.ts: token list` (token-cli.ts:325) が引き続き利用 |
| 関数本体 | 残す。`PoolCapacityResult` 型も残す |

→ **`computePoolCapacity` 自体は本タスクで触らない**。値の使用箇所だけ整理する。

**実装着手時の事前 grep（R6）**: 以下を最初の grep で確認し、もし `pool-cli.ts` / `token-cli.ts` が `header.capacity*Pct` を直接読んでいたら本タスクのスコープに含める:

```bash
grep -rn "header\.\(capacity5hPct\|capacity7dPct\)\|summary\.header" \
  skills/cmux-team/manager/pool-cli.ts \
  skills/cmux-team/manager/token-cli.ts
```

予測: ヒットしない（`pool-cli.ts` は `computePoolCapacity` を直接呼んで `result.per_token` だけ読んでいる）。ヒットした場合は §6.1 表に追記し、`pool-cli.ts` 更新を Phase 6 と同タイミングで実施。

### 6.2 per-surface decoration の削除（A024 §per-handle 行は出さない）

**削除対象**:

- `pool-surface-row.ts` 全体（`formatSurfaceRow` / `buildSurfaceRowSuffix`）
- 呼び出し側:
  - `main.ts:1486-1494, 1512-1520, 1527-1535`（CLI `cmux-team status`）
  - `dashboard.tsx:618-635 buildPoolSuffixForSurface` および各 buildXxxRow 呼び出し
- テスト:
  - `pool-surface-row.test.ts` 削除
  - `dashboard-pool.test.tsx` の case 11 ほか per-handle suffix 検査ケースを削除/書き換え

**残すもの**:

- `PerHandleSummary` 型（`PoolSummary.perHandle` が引き続きこの型を出す。ただし dashboard / CLI は読まない）
- `pool-throttle.ts` の `hasPoolHeadroomFromSummary` 等で `perHandle.selectable` を見ている部分は維持（throttle 判定で使う）

**判断**: `pool-surface-row.ts` の **削除を本タスクに含める**。A024 §per-handle 行は出さない が確定事項であり、温存すると dead code になる。`buildPoolSuffixForSurface` 経路も同時に消す。`dashboard.tsx` の build*Row* 系も signature を縮小（`perHandle` 引数を削る）してよい。

### 6.3 `pool-next-reset.ts` の去就

A024 §既存実装との関係: 「forecast から自然に読み取れるので削除候補（残す場合は補足表示）」 / task.md：「最初は残して別タスクで判断」

→ **本タスクでは残す**。`computeNextReset` を呼んでいた `pool-summary.ts` の `header.nextReset` 経由の流入箇所が Phase 5.5 で消えるが、`pool-next-reset.ts` ファイル自体は触らない。tsconfig 補足は §10.3 参照（`noUnusedLocals=false` のため警告は出ない）。

---

## 7. テスト戦略

### 7.1 `forecast.test.ts`（新規 / R3 + R5 反映）

A024 §検証ケース 1 / 2 を回帰テストに落とす + 境界値テーブル + DST safety:

```ts
describe("computePool7dForecast", () => {
  describe("Case 1: 単純例（now = 00:00 UTC、Day 0 = 24h フル）", () => {
    const NOW_ISO = "2026-04-28T00:00:00.000Z";
    const TZ = "UTC";
    const tokens: ForecastTokenInput[] = [
      // A: util=0.5, hours_to_reset=48h → reset = NOW + 48h（境界 reset 値: Day 1 binEnd と一致）
      { handle: "@a", plan_ratio: 1, util_7d: 0.5, reset_7d_at: "2026-04-30T00:00:00.000Z", selectable: true },
      // B: util=0.7, hours_to_reset=120h
      { handle: "@b", plan_ratio: 1, util_7d: 0.7, reset_7d_at: "2026-05-03T00:00:00.000Z", selectable: true },
    ];
    const expected = [108, 108, 71, 71, 71, 100, 100];

    it("returns 7-element bars within ±1% of expected", () => {
      const f = computePool7dForecast(tokens, NOW_ISO, TZ);
      expect(f.bars).toHaveLength(7);
      for (let i = 0; i < 7; i++) {
        expect(Math.abs(f.bars[i] - expected[i])).toBeLessThanOrEqual(1);
      }
      expect(f.contributingTokens).toBe(2);
    });

    it("境界 reset (reset_7d_at が Day 1 binEnd=48h と一致) で off-by-one が起きない", () => {
      // R5 / m6: token A は reset がちょうど bin 境界に一致するケース
      // integrateBin の case 1 (binEnd <= reset) と case 2 (binStart >= reset) の等号包含を検証
      const f = computePool7dForecast(tokens, NOW_ISO, TZ);
      expect(f.bars[1]).toBeCloseTo(108, 0);   // Day 1: pre-reset 全幅
      expect(f.bars[2]).toBeCloseTo(71, 0);    // Day 2: post-reset 全幅
    });
  });

  describe("Case 2: bin straddle（now = 18:00 UTC、Day 0 = 6h）", () => {
    const NOW_ISO = "2026-04-28T18:00:00.000Z";
    const TZ = "UTC";
    const tokens: ForecastTokenInput[] = [
      // A: util=0.5, hours_to_reset=40h → reset = NOW + 40h
      { handle: "@a", plan_ratio: 1, util_7d: 0.5, reset_7d_at: "2026-04-30T10:00:00.000Z", selectable: true },
      // B: util=0.7, hours_to_reset=120h
      { handle: "@b", plan_ratio: 1, util_7d: 0.7, reset_7d_at: "2026-05-03T18:00:00.000Z", selectable: true },
    ];
    const expected = [126, 126, 94, 71, 71, 78, 100];
    it("returns 7-element bars within ±1% of expected", () => {
      const f = computePool7dForecast(tokens, NOW_ISO, TZ);
      for (let i = 0; i < 7; i++) {
        expect(Math.abs(f.bars[i] - expected[i])).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("エッジケース", () => {
    it("util_7d == null は除外（denom にも入らない）", () => { /* ... */ });
    it("reset_7d_at == null は除外", () => { /* ... */ });
    it("selectable=false は除外", () => { /* ... */ });
    it("reset が過去なら post-reset rate (1/168) を全 bin に適用", () => { /* ... */ });
    it("reset が >7d 先なら全 bin が pre-reset rate", () => { /* ... */ });
    it("token 0 件 → bars=[0,0,0,0,0,0,0], contributingTokens=0", () => { /* ... */ });
    it("plan_ratio == null は除外", () => { /* ... */ });
    it("bars 全要素が >100 でも数値超過を維持（UI 側で cap 表示）", () => { /* ... */ });
  });

  describe("DST safety (R3)", () => {
    it("America/New_York の DST 春シフト相当日でも bars.length === 7", () => {
      // 2026-03-08 02:00 EST → 03:00 EDT に飛ぶ日。Day 0 はその日の残り時間
      const f = computePool7dForecast(
        [{ handle: "@a", plan_ratio: 1, util_7d: 0.5, reset_7d_at: "2026-03-15T00:00:00.000Z", selectable: true }],
        "2026-03-08T05:00:00.000Z",  // local = 00:00 EST、DST 切替前
        "America/New_York",
      );
      expect(f.bars).toHaveLength(7);
      expect(f.bars.every(b => Number.isFinite(b))).toBe(true);
    });
  });
});
```

**TZ 注入方針 (R3)**: `computePool7dForecast` の第 3 引数で TZ を直接受け取るため、test では `process.env.TZ` をいじる必要がない。本番は `pool-summary.ts` で `Intl.DateTimeFormat().resolvedOptions().timeZone` を解決して渡す。

### 7.2 `peekNextToken` のテスト追加

`token-store.test.ts`（既存）に case 追加:

- pool に token A (util_5h=0.1) / B (util_5h=0.5) → score 最小 = A → `peekNextToken` が A を返す
- `peekNextToken` 後に `selectToken` を呼ぶと **同じ A** が選ばれる（lease なし → race なし）
- 2 連続 `peekNextToken` で同じ結果（副作用なし確認 / `expireLeases` の DB write は許容）
- 全 blocked → `null`
- `util_5h == null` の token が選ばれた場合 `{ handle, util_5h: null, util_7d: ... }` を返す（R4: util_7d も assert）
- stale 救済の挙動（T373 と整合）: stale + reset 過去 → `effUtil5h=0` で選ばれる

### 7.3 `pool-summary.test.ts` の更新（Phase 3 と Phase 5.5 で 2 段階）

| 既存ケース | Phase 3 の対応 | Phase 5.5 の対応 |
|---|---|---|
| case A-E（旧 `header.capacity*Pct` を assert） | そのまま pass（header 残るため） | `forecast7d` / `nextCandidate` を assert する形に書き換え |
| case F (`loadPoolSummary` の OFF 時 null) | そのまま | そのまま |

新規ケース（Phase 3 で追加）:

- `forecast7d.contributingTokens === 2`、`bars.length === 7` の構造 assert
- `nextCandidate` が peek 結果と一致（policy を渡したケース / 渡さなかったケースで null）
- pool OFF → `loadPoolSummary` が null を返す

### 7.4 `pool-status-header.test.ts` 全置換（R5 反映）

`buildPoolHeaderLines` の旧 box 形式テストを全削除し、新仕様の 1 行表示テストに置き換え:

- `null` 入力 → `[]`
- 有効入力（spark + next） → `["pool 7d  ██▇▅▅▆█  next: @kddi 5h:65%"]`
- next 候補なし → `["pool 7d  ...  next: ⚠ no eligible account"]`
- util_5h null → `["pool 7d  ...  next: @kddi 5h:—"]`
- contributingTokens=0 → spark 省略
- **`mapBarToSparkline` 境界値テーブル (R5)**:

```ts
test.each([
  [0,       " "],
  [12.4999, " "],
  [12.5,    "▁"],
  [25,      "▂"],
  [37.5,    "▃"],
  [50,      "▄"],
  [62.5,    "▅"],
  [75,      "▆"],
  [87.5,    "▆"],   // [87.5, 100) は ▇ ではなく ▆？ → 確認: A024 ▇=[87.5,100) なので ▇ が正
  [99.9999, "▇"],
  [100,     "█"],
  [150,     "█"],
])("mapBarToSparkline(%f) === %p", (input, expected) => {
  expect(mapBarToSparkline(input)).toBe(expected);
});
```
（実装時は §4.2 の `if` チェインの境界と一致させる。87.5 → ▇ が A024 §TUI 表示「[87.5, 100): ▇」と整合）

- `pickSparklineColor` の min ベース閾値テスト (≥100=green / 70≤<100=yellow / <70=red)

### 7.5 `pool-header-display.test.ts` 全置換

`buildPoolHeaderDisplay` の `parts` 配列を assert:

- pool OFF (`summary=null`) → `parts=[]`
- 有効入力 → 第 1 要素 `text: "pool 7d  ..."` / 第 2 要素 `text: "next: ..."`
- 色閾値テスト（spark 全て >= 100 で green / 70-100 で yellow / <70 で red）
- next 5h の色（>95% red / >70% yellow / それ以下 green）
- cross-validate: `buildPoolHeaderLines` と `buildPoolHeaderDisplay(...).parts.map(p => p.text).join` が同じ文字列を返す

### 7.6 既存テストの削除/更新

| ファイル | 対応 |
|---|---|
| `pool-surface-row.test.ts` | 削除（pool-surface-row.ts 削除に伴い） |
| `dashboard-pool.test.tsx` の per-handle suffix ケース | 削除/書き換え |
| `pool-next-reset.test.ts` | **触らない**（§6.3 方針） |

### 7.7 統合テスト（任意）

`main.ts: cmux-team status` の出力スナップショット test を追加できるなら追加（既存の e2e tests/cmux-team-status.test.ts のような枠組みがあれば）。なければ手動確認: `bun run skills/cmux-team/manager/main.ts status` で fixture DB から forecast 行が出ること。

---

## 8. ドキュメント更新

### 8.1 `docs/spec/09-token-pool.md`

| 既存セクション | 対応 |
|---|---|
| §pool_capacity 指標（line 368-391） | **全面書き換え**: タイトル `7d Forecast ゲージ`、A024 の計算式・bin 切り出し・正規化・色閾値を転記 |
| §TUI 表示（暗黙、各箇所） | A024 §TUI 表示を転記し、`pool 7d <spark>  next: @handle 5h:NN%` 例を追記 |
| §関連ファイル（line 459-471） | `forecast.ts` を追加、`pool-surface-row.ts` を削除 |
| `pool_capacity_pct` の文言 | 廃止と forecast への移行を明記。`per_token.cap_pct` は `cmux-team pool status` 内部利用として残ることを併記 |

### 8.2 README

- `README.md` / `README.ja.md` にスクリーンショット or text mock があれば「pool 7d ██▇▅▅▆█  next: @kddi 5h:65%」形式に差し替え
- per-surface decoration（`<5h:X%/7d:Y%> cap:Z%`）の例示を削除
- 該当箇所を grep して特定: `grep -rn "pool capacity\|cap:.*%\|<5h:" README.md README.ja.md`

### 8.3 CHANGELOG.md

`## [Unreleased]` セクションに追加:

```markdown
### Changed

- **pool capacity 表示を「7d 日次 forecast ゲージ + next 候補 5h」に再設計（T374 / A024）**。
  従来の `pool capacity: 5h NN% / 7d NN%` 二値表示を廃止し、ヘッダーを 1 行に集約: `pool 7d ██▇▅▅▆█  next: @kddi 5h:65%`。
  7d は今後 7 日（Day 0..6）の日次割当 forecast を 8 段スパークラインで可視化（100% = sustainable pace）、
  next は spawn-agent が次に割り当てる候補アカウントの util_5h を peek（lease は取らない）。
  per-surface decoration `<5h:X%/7d:Y%> cap:Z%` は削除（詳細は `cmux-team pool status` で確認）。

### Removed

- `pool-surface-row.ts` および per-surface pool decoration（A024 §per-handle 行は出さない）
```

### 8.4 `.team/artifacts/A024-pool-capacity-7d-forecast-gauge.md`（R2: 選択肢 A）

A024 §next 候補の選定 の「**非 stale**」記述に脚注を追加:

```markdown
※ T373 以降、現行 `selectToken` admit は stale 救済方針に変更されている。
T374 で実装する `peekNextToken` は spawn-agent との整合のため admit 経路に追従し、
stale でも reset 通過済み軸の effUtil_*=0 救済込みで peek する。
本ヘッダーの「next 候補」表示はこの admit 経路と一致するため、
A024 執筆時点の「非 stale」blocker 文言は当時の admit 仕様の写しとして読み替える。
```

artifact を update する理由: CLAUDE.md「state を外部化する」原則に従い、本計画書 §10.2 注釈だけでは不十分（artifact 側で確認可能でなければならない）。選択肢 B（新 artifact A025 起票）と比較して、artifact 1 個に集約する方が後の retro / docs-sync で読みやすい。

---

## 9. 実装順序（依存関係 / R1 反映で再配列）

純関数 → 内部 API → UI → 削除 → ドキュメント の順で進める。**各 Phase 末で `bunx tsc --noEmit` が pass することを保証** する構造（R1）。

### Phase 0: 既存テストの全 baseline 取得

```bash
cd skills/cmux-team/manager
for f in pool-summary.test.ts pool-status-header.test.ts pool-header-display.test.ts pool-next-reset.test.ts pool-surface-row.test.ts token-store.test.ts; do
  bun test --timeout 30000 "$f"
done
```

baseline を pass 状態で確認（変更前の green ベースを保証）。
**事前 grep（R6）**: `pool-cli.ts` / `token-cli.ts` が `header.capacity*Pct` / `summary.header` を読んでいないことを確認。読んでいたら §6.1 のスコープに追記。

### Phase 1: forecast.ts（純関数 / R3: TZ 引数）

1. `forecast.ts` を新規作成（`computePool7dForecast(tokens, nowIso, timezone?)` シグネチャ）
2. `forecast.test.ts` を作成して A024 §検証ケース 1 / 2 + エッジケース + 境界値 + DST safety を通す
3. **テスト**: `bun test --timeout 30000 forecast.test.ts` が green
4. **tsc**: `bunx tsc --noEmit` が pass

### Phase 2: peekNextToken / admitCandidates 戻り値拡張

1. `token-store.ts: admitCandidates` の戻り値に `effUtil5h` / `effUtil7d` を追加
2. `selectToken` / `canSelectAnyToken` の互換確認（既存 test pass）
3. `peekNextToken` を新規追加（`PeekedToken: { handle, util_5h, util_7d }` を返す / R4）
4. `token-store.test.ts` に peek ケースを追加
5. **テスト**: `bun test --timeout 30000 token-store.test.ts` が green
6. **tsc**: `bunx tsc --noEmit` が pass

### Phase 3: pool-summary.ts 拡張（**header を残す / R1**）

1. `PoolSummary` 型に `forecast7d` / `nextCandidate` を **追加**（`header` は残す）
2. `buildPoolSummary` 実装更新（policy 引数追加 / forecast 計算 / peekNextToken 呼び出し / 旧 header も従来通り埋める）
3. `loadPoolSummary` で `buildSelectTokenPolicy` を呼び policy を渡す
4. `daemon.ts` から `state.poolPolicy` を渡す
5. `pool-summary.test.ts` に新ケース追加（既存 case A-E はそのまま pass）
6. **テスト**: `bun test --timeout 30000 pool-summary.test.ts` が green
7. **tsc**: `bunx tsc --noEmit` が pass（旧 header 経路もまだ動くため OK）

### Phase 4: pool-status-header.ts 書き換え

1. `pool-status-header.ts` を新仕様で全面書き換え（forecast7d / nextCandidate を読む）
2. `mapBarToSparkline` / `pickSparklineColor` を export
3. `pool-status-header.test.ts` 全置換（境界値 test.each / R5 含む）
4. **テスト**: `bun test --timeout 30000 pool-status-header.test.ts` が green
5. **tsc**: `bunx tsc --noEmit` が pass（pool-summary.ts は header 残しているので OK / 新 header 経路は forecast/nextCandidate を読む）

### Phase 5: pool-header-display.ts 書き換え

1. `pool-header-display.ts` を全面書き換え（`pool-status-header` から helper を import）
2. `dashboard.tsx` 旧 `buildPoolHeader` (legacy) の参照を削除（NOTE T363 で描画経路から外し済みなので削除のみ）
3. `pool-header-display.test.ts` 全置換
4. **テスト**: `bun test --timeout 30000 pool-header-display.test.ts` が green
5. **tsc**: `bunx tsc --noEmit` が pass

### Phase 5.5: pool-summary.ts から header 削除（**R1 新設**）

1. `PoolSummary` 型から `header` フィールドを削除
2. `buildPoolSummary` から `buildLegacyPoolHeaderInput` 呼び出しを削除
3. `pool-next-reset` の import を削除（§6.3 / §10.3 方針）
4. `pool-summary.test.ts` の case A-E を `forecast7d` / `nextCandidate` 検証に書き換え
5. **テスト**: `bun test --timeout 30000 pool-summary.test.ts` が green
6. **tsc**: `bunx tsc --noEmit` が pass（Phase 4-5 で UI が新仕様化済みのため、`header` への参照は dashboard / CLI 含めもう存在しないはず。grep で `summary.header` / `\.header\.capacity` がヒットしないことを確認）

### Phase 6: per-surface decoration 削除

1. `pool-surface-row.ts` 削除
2. `main.ts` の `formatSurfaceRow` 呼び出し 3 箇所削除
3. `dashboard.tsx` の `buildPoolSuffixForSurface` / `buildSurfaceRowSuffix` 呼び出し削除
4. `dashboard.tsx` の `buildConductorRowWithPool` の `perHandle` 引数を削除（または通過のみで dead）
5. `pool-surface-row.test.ts` 削除
6. `dashboard-pool.test.tsx` から per-handle ケース削除
7. **テスト**: `bun test --timeout 30000 dashboard-*.test.tsx`（影響範囲）が green
8. **手動確認**: `bun run skills/cmux-team/manager/main.ts status` の Master / Conductor / Agent 行が縮退表示

### Phase 7: tsc / build 健全性確認

```bash
cd skills/cmux-team/manager
bunx tsc --noEmit -p tsconfig.json
```

unused import / 型不一致がないことを確認。`pool-next-reset.ts` の dead code 警告は **`tsconfig.json: noUnusedLocals=false / noUnusedParameters=false` のため出ない**（§10.3）。

### Phase 8: 統合テスト

```bash
cd skills/cmux-team/manager
for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do
  bun test --timeout 30000 "$f"
done
```

`bun test` 全体実行は禁忌（CLAUDE.md ガード）。上記 for ループで個別実行。

### Phase 9: ドキュメント更新

1. `docs/spec/09-token-pool.md` 更新
2. `.team/artifacts/A024-pool-capacity-7d-forecast-gauge.md` の §next 候補の選定 に脚注追加（R2 / §8.4）
3. `README.md` / `README.ja.md` 更新
4. `CHANGELOG.md` に `[Unreleased]` 追加

### Phase 10: 受け入れ基準確認

task.md の受け入れ基準を 1 つずつ check:

- [ ] A024 §検証ケース 1 / 2 のテストが通る（Phase 1）
- [ ] `cmux-team status` ヘッダーに `pool 7d <spark>   next: @handle 5h:NN%` が出る（Phase 4 + 手動確認）
- [ ] pool 機能 OFF / 全 blocked / 候補なし / snapshot 待ちの 4 エッジケースが A024 通り表示される（Phase 4 / 5 のテスト）
- [ ] 既存の pool 関連テスト（pool-summary / pool-status-header / pool-header-display / pool-next-reset）を更新済み（Phase 3-5.5）
- [ ] A024 artifact が新 admit 方針と整合（Phase 9 / R2）

---

## 10. 非スコープ確認・既知の留意点

### 10.1 非スコープ（task.md §非スコープ と一致）

- per-handle decoration の代替表示（`cmux-team pool status` 拡張） — 別タスク
- 5h forecast 化 — A024 §背景で 5h は forecast 化しない方針
- ETA 予測 — A019 で明示的に避けた方針を継続

### 10.2 A024 文言の update（R2 反映: 本タスクに含める）

A024 §next 候補の選定 が「**非 stale**」を blocker と書いているが、現行 `selectToken` admit は T373 で「stale 救済」に方針変更済み。本タスクでは:

1. **`peekNextToken` は spawn-agent と同じ admit 経路を共有** する（実装方針 / §2.4）
2. **A024 artifact に脚注を追加** して非 stale 文言を T373 後の admit に従うと明記（R2 選択肢 A 採用 / §8.4）

これにより:

- artifact / 実装 / 計画の 3 者間で stale 救済方針が一貫する
- 将来の retro / docs-sync で「A024 と実装が乖離している」と再発見されない
- 新 artifact 起票せず A024 1 個に集約することで、後続タスクで参照しやすい

### 10.3 dead code 警告のリスク（R6 反映）

`pool-next-reset.ts` を本タスクで残す方針（task.md 明示）。`pool-summary.ts` から import が消えるが:

- **`skills/cmux-team/manager/tsconfig.json` は `noUnusedLocals: false` / `noUnusedParameters: false`**（実機で確認可）
- したがって `pool-next-reset.ts` の dead 化は tsc 警告にならない
- ファイル自体の dead code（テストはまだ pass する）は別タスクで「pool-next-reset.ts を削除 or 補足表示として残す」を判断する

### 10.4 DST 安全性（R3 反映）

`forecast.ts` の `buildBinRanges` は `(nowIso, timezone)` を引数で受ける純関数。`Intl.DateTimeFormat` で指定 TZ における time-of-day を取り出して残り秒数を計算するため、process TZ や JS Date のローカル変換に依存しない。

DST 切替日には Day 0 が物理的に 23h or 25h になるが、A024 §確定事項「Day 0 の bin: `[now, 今日 24:00 (local)]`（残り時間のみ。可変幅）」と整合する。test で `timezone="America/New_York"` 3/13 春 DST 相当を 1 ケース足して `bars.length === 7` と全 cell 有限を保証する（§7.1 DST safety）。

### 10.5 既存 throttle / dashboard テストへの波及

- `pool-throttle.ts` は `PerHandleSummary.selectable` のみ参照しており影響なし
- `dashboard-conductor.test.tsx` / `dashboard-pool.test.tsx` の per-handle suffix ケースのみ要更新（Phase 6）
- daemon-side state.pool / `notifyStateChanged` への影響なし（型シグネチャの import 互換）

---

## 11. 受け入れ後の事前 lint / テストチェックリスト

実装完了時に Conductor が確認すべき項目:

| 項目 | コマンド |
|---|---|
| TypeScript 型チェック | `cd skills/cmux-team/manager && bunx tsc --noEmit` |
| forecast 単体テスト | `bun test --timeout 30000 forecast.test.ts` |
| 影響範囲 unit test | for f in pool-summary pool-status-header pool-header-display token-store dashboard-pool ... |
| 手動確認: `cmux-team status` | spark + next が 1 行で出る・ボックス罫線が消えている |
| 手動確認: dashboard | 同上 |
| A024 artifact 整合 | §next 候補の選定 に脚注追加済み（R2） |
| Markdown lint（必要なら） | `mdformat` などプロジェクト方針に合わせる |

---

## 付録 A: A024 検証ケース 1 のテスト用 ISO 計算

`timezone = "UTC"` で `now = 2026-04-28T00:00:00.000Z`（UTC 0:00）とする:

- A: hours_to_reset = 48h → reset_7d_at = `2026-04-30T00:00:00.000Z`（境界 reset = Day 1 binEnd と一致）
- B: hours_to_reset = 120h → reset_7d_at = `2026-05-03T00:00:00.000Z`

期待 bars: `[108, 108, 71, 71, 71, 100, 100]`（許容誤差 ±1）。

## 付録 B: A024 検証ケース 2 のテスト用 ISO 計算

`timezone = "UTC"` で `now = 2026-04-28T18:00:00.000Z`（UTC 18:00 → Day 0 残 6h）:

- A: hours_to_reset = 40h → reset_7d_at = `2026-04-30T10:00:00.000Z`
- B: hours_to_reset = 120h → reset_7d_at = `2026-05-03T18:00:00.000Z`

期待 bars: `[126, 126, 94, 71, 71, 78, 100]`（許容誤差 ±1）。

## 付録 C: design-review.md 反映チェックリスト

| ID | 反映内容 | 反映箇所 |
|---|---|---|
| R1 | Phase 順序を「拡張 → 切替 → 削除」に再配列 | §3.1-3.2 / §9 Phase 3 / Phase 5.5 新設 |
| R2 | A024 §next 候補の選定 に脚注追加（選択肢 A） | §8.4 / §10.2 / §11 |
| R3 | `buildBinRanges` を `(nowIso, timezone)` 引数の純関数化（代替案 b） | §1.1 / §1.2 / §1.4 / §7.1 / §10.4 |
| R4 | `PeekedToken` に `util_7d` 追加 | §2.1 / §2.2 / §3.7 / §7.2 |
| R5 | スパークライン境界値 / forecast 境界 reset の test.each 明示 | §7.1 (Case 1 境界 reset) / §7.4 (mapBarToSparkline テーブル) |
| R6 | tsconfig 補足 / `pool-cli.ts` 事前 grep | §6.1 (事前 grep) / §10.3 (tsconfig 補足) / §9 Phase 0 |
| m5 (参考) | `peekNextToken` 連続呼び出し副作用なしテスト | §7.2（実装余裕時） |
| m6 (参考) | 検証ケース 1 の境界 reset 明示 | §7.1 Case 1 内に追加 |
