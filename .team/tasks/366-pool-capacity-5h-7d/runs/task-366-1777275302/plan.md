# T366 実装計画: pool capacity を 5h / 7d 別合計に変更

## 概要

現状の token pool capacity 表示は **トークンごとに `min(flow_5h, flow_7d)` を取り、それを合算した単一値** を `pool capacity: NN%` として TUI / CLI に出している。これでは「5h ウィンドウが律速か / 7d ウィンドウが律速か」がユーザーに見えない。

本タスクでは:

- `computePoolCapacity` が **5h 側合計** と **7d 側合計** を別々に返すように変更する
- TUI ヘッダー / CLI status 出力を `pool capacity: 5h 120% / 7d 80%` の二値表示に変更する
- 色分けは **`min(5h, 7d)`** をベースに既存閾値（>=100% GREEN / 40-100% YELLOW / <40% RED）を維持する
- 後方互換のための旧 `capacity_pct` / `capacityPct` フィールドは残さない（CLAUDE.md「後方互換性コードは不要」方針）

## 現状把握

### `computePoolCapacity` (token-store.ts:734-769)

```ts
export interface PoolCapacityResult {
  capacity_pct: number;
  per_token: Array<{ handle: string; cap_pct: number }>;
}

export function computePoolCapacity(
  tokens: TokenForCapacity[],
  nowIso: string = new Date().toISOString(),
): PoolCapacityResult {
  // ...
  for (const t of tokens) {
    if (t.plan_ratio == null) continue;
    // remaining_5h / remaining_7d / hoursUntil(reset_*) から flow_5h / flow_7d を計算
    const candidates: number[] = [];
    if (t5hH != null) candidates.push((remaining5h * t.plan_ratio) / t5hH);
    if (t7dH != null) candidates.push((remaining7d * t.plan_ratio) / t7dH);
    if (candidates.length === 0) {
      candidates.push((1.0 * t.plan_ratio) / FULL_WEEK_HOURS);
    }
    const flow = Math.min(...candidates);          // ← トークンごとに min を取って単一値化
    const cap_pct = (flow / REFERENCE_FLOW) * 100;
    perToken.push({ handle: t.handle, cap_pct });
    totalCap += cap_pct;
  }
  return { capacity_pct: totalCap, per_token: perToken };
}
```

ここで「`min(flow_5h, flow_7d)`」を取って合算しているため、2 ウィンドウのうち遅い方の情報が失われる。

### `PoolHeaderInput` (pool-status-header.ts:17-20)

```ts
export interface PoolHeaderInput {
  capacityPct: number;
  nextReset: PoolHeaderNextReset | null;
}
```

`buildPoolHeaderLines` は `pool capacity: ${Math.round(input.capacityPct)}%` を 1 行で出している (line 29)。

### 呼び出し関係

```
computePoolCapacity (token-store.ts:734)
  ├── pool-summary.ts:67           buildPoolSummary (header.capacityPct = cap.capacity_pct)
  ├── pool-cli.ts:57               cmdPoolStatus (cap.capacity_pct を最後に表示)
  ├── pool-next-reset.ts:94, 103   computeNextReset (baseCap / afterCap で deltaPct 算出)
  └── token-cli.ts:325             token list (per_token のみ参照、capacity_pct 不参照)

PoolHeaderInput (pool-status-header.ts:17)
  ├── pool-status-header.ts        buildPoolHeaderLines（CLI 用文字列ボックス）
  ├── pool-summary.ts:35           PoolSummary.header の型
  ├── pool-header-display.ts:27    buildPoolHeaderDisplay（TUI 用 RateLimitPart[]）
  ├── dashboard.tsx:534            buildPoolHeader（旧 TUI 経路、現在は dashboard 描画から外れているが export 残置）
  └── main.ts:1448-1453            CLI status 出力で buildPoolHeaderLines に渡す
```

その他に `dashboard-pool.test.tsx` / `pool-summary.test.ts` / `pool-status-header.test.ts` / `pool-header-display.test.ts` が `capacityPct` を直接参照する。

## 新しい型定義

### `PoolCapacityResult`（token-store.ts）

```ts
export interface PoolCapacityResult {
  /** 全 token の 5h flow 合計 を REFERENCE_FLOW で正規化したパーセント */
  capacity_5h_pct: number;
  /** 全 token の 7d flow 合計 を REFERENCE_FLOW で正規化したパーセント */
  capacity_7d_pct: number;
  /**
   * 各 token の per-token cap。`cap_pct` は従来通り `min(flow_5h, flow_7d)` ベース
   * （per-token 表示は引き続きボトルネック側を出すのが自然なので維持）。
   */
  per_token: Array<{ handle: string; cap_pct: number }>;
}
```

### `computePoolCapacity` のロジック

トークンごとに 5h / 7d の `flow` を別々に集計する:

```ts
let total5h = 0;
let total7d = 0;
for (const t of tokens) {
  if (t.plan_ratio == null) continue;
  // ...（remaining_*, t5hH, t7dH の算出は既存通り）

  // 5h 側
  if (t5hH != null) {
    total5h += ((remaining5h * t.plan_ratio) / t5hH / REFERENCE_FLOW) * 100;
  } else {
    // reset_5h_at が null の場合は 7d 相当として 7d 側に倒すか、フル想定にするか
    // → 既存ロジックは「両 window null ならフル 7d 相当」だったので、5h 側は 0 寄与にする
  }

  // 7d 側
  if (t7dH != null) {
    total7d += ((remaining7d * t.plan_ratio) / t7dH / REFERENCE_FLOW) * 100;
  } else {
    // 同上 → 7d 側もフォールバック必要なら FULL_WEEK_HOURS 相当に
  }

  // per_token は従来通り min ベース
  const candidates: number[] = [];
  if (t5hH != null) candidates.push((remaining5h * t.plan_ratio) / t5hH);
  if (t7dH != null) candidates.push((remaining7d * t.plan_ratio) / t7dH);
  if (candidates.length === 0) {
    candidates.push((1.0 * t.plan_ratio) / FULL_WEEK_HOURS);
  }
  const flow = Math.min(...candidates);
  perToken.push({ handle: t.handle, cap_pct: (flow / REFERENCE_FLOW) * 100 });
}
```

**両 window とも null の token の扱い**: 既存実装は「フル 7d 相当」として単一値に寄与していた。新実装では:

- 5h / 7d どちらも null → `capacity_5h_pct` は変化なし（5h 側は寄与 0）、`capacity_7d_pct` は `(plan_ratio / FULL_WEEK_HOURS / REFERENCE_FLOW) * 100` を加算
- これで「reset 情報が来ていない token は 7d 側のフル容量とみなす」既存挙動を 7d 側で温存できる
- `per_token` は従来通り `min` ベース

### `PoolHeaderInput`（pool-status-header.ts）

```ts
export interface PoolHeaderInput {
  capacity5hPct: number;
  capacity7dPct: number;
  nextReset: PoolHeaderNextReset | null;
}
```

旧 `capacityPct` は削除。

### `buildPoolHeaderLines` の出力

```
┌─ token pool ──────────────────────────────────────────────┐
│ pool capacity: 5h 120% / 7d 80%                            │
│ next reset: @kddi 5h in 30m  (+20 pts)                     │
└────────────────────────────────────────────────────────────┘
```

行内の値は `Math.round(input.capacity5hPct)` / `Math.round(input.capacity7dPct)`。

### `buildPoolHeaderDisplay`（pool-header-display.ts）の RateLimitPart[]

色分けは `min(capacity5hPct, capacity7dPct)` ベース:

```ts
const minPct = Math.min(summary.header.capacity5hPct, summary.header.capacity7dPct);
const capColor: RateLimitPart["color"] =
  minPct >= 100 ? "green" : minPct >= 40 ? "yellow" : "red";

const parts: RateLimitPart[] = [
  {
    text: `pool capacity: 5h ${Math.round(summary.header.capacity5hPct)}% / 7d ${Math.round(summary.header.capacity7dPct)}%`,
    color: capColor,
    group: true,
  },
];
```

`buildPoolHeader`（dashboard.tsx）も同じく `min` ベースで色決定する。

### `pool-next-reset.ts` の `deltaPct`

`computeNextReset` は `baseCap` / `afterCap` の差分で `deltaPct` を算出している。新しい型では `capacity_pct` が消えるため、**`min(capacity_5h_pct, capacity_7d_pct)` ベースで delta** を取る方針にする（ユーザー視点では「ボトルネック側がどう動くか」が読みたい情報なので min が自然）。

```ts
const baseResult = computePoolCapacity(baseTokens, nowIso);
const baseCap = Math.min(baseResult.capacity_5h_pct, baseResult.capacity_7d_pct);
const afterResult = computePoolCapacity(afterTokens, nowIso);
const afterCap = Math.min(afterResult.capacity_5h_pct, afterResult.capacity_7d_pct);
return { ..., deltaPct: Math.round(afterCap - baseCap) };
```

### CLI 末尾（pool-cli.ts:108）

```ts
console.log(`pool capacity: 5h ${Math.round(cap.capacity_5h_pct)}% / 7d ${Math.round(cap.capacity_7d_pct)}%`);
```

## 変更計画（ファイル別）

### 1. `skills/cmux-team/manager/token-store.ts`

- `PoolCapacityResult` を新型に置換（`capacity_5h_pct` / `capacity_7d_pct` / `per_token` の 3 フィールド、`capacity_pct` を削除）
- `computePoolCapacity` 本体を書き換え。5h / 7d の合計を別々に算出し、`per_token` は従来通り `min` ベースを維持
- 既存ヘルパー `hoursUntil` / 定数 `REFERENCE_FLOW` / `FULL_WEEK_HOURS` / `MIN_HOURS` はそのまま流用

### 2. `skills/cmux-team/manager/pool-status-header.ts`

- `PoolHeaderInput` を新型に置換（`capacity5hPct` / `capacity7dPct` / `nextReset`）
- `buildPoolHeaderLines` の capacity 行構築を `pool capacity: 5h NN% / 7d NN%` に変更
- 罫線幅 60 文字制約（D10）はそのまま — `padEnd` / `truncate` のロジックを再確認

### 3. `skills/cmux-team/manager/pool-summary.ts`

- `buildPoolSummary` の `header` 構築を新型に変更:
  ```ts
  header: {
    capacity5hPct: cap.capacity_5h_pct,
    capacity7dPct: cap.capacity_7d_pct,
    nextReset,
  }
  ```
- `perHandle` 側は `cap.per_token` を引き続き使う（per-token cap は min ベース維持）

### 4. `skills/cmux-team/manager/pool-header-display.ts`

- `buildPoolHeaderDisplay` の参照を `summary.header.capacity5hPct` / `capacity7dPct` に変更
- 色分け: `Math.min(capacity5hPct, capacity7dPct)` を閾値判定に使う
- `parts[0].text` を `pool capacity: 5h NN% / 7d NN%` に変更

### 5. `skills/cmux-team/manager/dashboard.tsx`

- `buildPoolHeader`（line 529-547）の `summary.header.capacityPct` 参照を新型に変更
- 色決定も `min(5h, 7d)` ベース
- `buildPoolHeaderLines` 経由で「pool capacity:」行を見つけて再色付けしている既存ロジックは流用可能（line 内の `pool capacity:` を探して色を当てているだけなので、新フォーマットでも問題なし）

### 6. `skills/cmux-team/manager/pool-next-reset.ts`

- `baseCap` / `afterCap` の取得を `Math.min(result.capacity_5h_pct, result.capacity_7d_pct)` に変更（`capacity_pct` は型から消える）

### 7. `skills/cmux-team/manager/pool-cli.ts`

- 末尾出力（line 108）を新フォーマット `pool capacity: 5h NN% / 7d NN%` に変更
- `capByHandle` は `cap.per_token` を使い続ける（変更不要）

### 8. `skills/cmux-team/manager/token-cli.ts`

- line 325 の `computePoolCapacity` 呼び出しは `per_token` のみ参照しており、戻り値の型変更（`capacity_pct` → `capacity_5h_pct`/`capacity_7d_pct`）の影響を受けるが、実体としては `per_token[0]?.cap_pct` だけ見ているので **型エラーは出ない**（destructuring `{ per_token }` のみ）。確認のみ

### 9. テスト

#### `pool-status-header.test.ts`

- 全 6 ケースの `PoolHeaderInput` リテラルから `capacityPct` を `capacity5hPct` / `capacity7dPct` に書き換え
- `expect(lines[1]).toContain("pool capacity: 173%")` → `expect(lines[1]).toContain("pool capacity: 5h 173% / 7d 173%")` へ（または `expect(lines[1]).toContain("5h 173%")` のように 1 セグメントごとに分けて assert）
- 罫線幅 60 文字テストは `pool capacity: 5h 100% / 7d 100%` で 60 字内に収まる前提で確認

#### `pool-header-display.test.ts`

- `makeSummary` ヘルパーの引数を `capacity5h: number, capacity7d?: number` に拡張（`capacity7d` 省略時は同値で代入）
- case 2-7 の色閾値ケースは `min(5h, 7d)` で判定する仕様を反映:
  - 例: `capacity5h=173, capacity7d=80` → `min=80` → `yellow`
  - 単一値ケース（5h=7d）はそのまま読み替えで動く
- case 8-10（next reset の整形）はテキスト確認なので `capacity5h=80, capacity7d=80` 等で渡す
- 新規ケース追加（任意）: `capacity5h=120, capacity7d=80` → text に `5h 120%` `7d 80%` が含まれる、色は yellow

#### `dashboard-pool.test.tsx`

- `makeSummary(capacityPct, perHandle?)` のシグネチャを `makeSummary(capacity5h, capacity7d?, perHandle?)` に拡張
- case 3 (`173%` GREEN) → `capacity5h=173, capacity7d=173`
- case 4 (`30%` RED) → `capacity5h=30, capacity7d=30`
- case 5 (`60%` YELLOW) → `capacity5h=60, capacity7d=60`
- 新規ケース追加（任意）: `capacity5h=173, capacity7d=30` → text に「5h 173% / 7d 30%」、色は RED（min ベース）

#### `pool-summary.test.ts`

- 全 case で `summary.header.capacityPct` を `summary.header.capacity5hPct` / `capacity7dPct` に書き換え
- case A（plan_ratio=20, util=0.5, 5h まで 5h, 7d まで 168h）:
  - `flow_5h = 0.5 * 20 / 5 = 2.0`、`cap5h = 2.0 / (20/168) * 100 = 1680%`
  - `flow_7d = 0.5 * 20 / 168 ≒ 0.0595`、`cap7d ≒ 50%`
  - 既存の `capacityPct ≒ 50%` assertion は、新実装では `capacity_7d_pct ≒ 50%` に対応する。`capacity_5h_pct ≒ 1680%` の assertion を追加
- case B（2 token 同条件）: `capacity_5h_pct ≒ 3360%`、`capacity_7d_pct ≒ 100%`
- case C（plan_ratio=null）: 両方とも `0`
- case D（selectable=0 を含む）: `capacity_5h_pct` / `capacity_7d_pct` の両方を assert
- case E（mixed plan_ratio）: per_token cap は従来通り、5h / 7d 別々の合計を確認

#### 必要に応じて追加するテスト

- `token-store` 内の `computePoolCapacity` を直接呼ぶ unit test がない場合、以下の最小ケースで追加:
  - 5h reset がすぐ来る token（5h 律速ではない）→ `capacity_5h_pct >> capacity_7d_pct`
  - 5h util ≒ 1.0（5h 残量ゼロ）→ `capacity_5h_pct ≒ 0`、`capacity_7d_pct` は通常値
  - 既存テストファイルを確認: `token-store.test.ts` などに `computePoolCapacity` の単体テストがあれば併せて更新

## TDD 順序

```
[1] テスト書き換え（RED）
    1-1. pool-status-header.test.ts
    1-2. pool-header-display.test.ts
    1-3. pool-summary.test.ts
    1-4. dashboard-pool.test.tsx
    （token-store.test.ts に computePoolCapacity の direct test があれば 1-5 として書き換え）
    → bun test を回して全ケース RED を確認

[2] 型変更（型エラー誘発で受け皿を可視化）
    2-1. token-store.ts:62-65 の PoolCapacityResult 改訂
    2-2. pool-status-header.ts:17-20 の PoolHeaderInput 改訂
    → tsc --noEmit を回して全エラー箇所を列挙

[3] 実装（GREEN へ）
    3-1. computePoolCapacity 本体（5h/7d 合計の別々算出）
    3-2. buildPoolHeaderLines（5h/7d 二値表示）
    3-3. buildPoolSummary（header フィールド変更）
    3-4. buildPoolHeaderDisplay（min ベース色分け、5h/7d テキスト）
    3-5. dashboard.tsx::buildPoolHeader（min ベース色分け）
    3-6. pool-next-reset.ts（min ベース deltaPct）
    3-7. pool-cli.ts（末尾出力フォーマット）
    → 段階的に bun test で GREEN になっていくのを確認

[4] 周辺テスト確認
    4-1. token-cli.ts は per_token 参照のみなので型エラーが出ないか tsc 確認
    4-2. main.ts:1448 の buildPoolHeaderLines 呼び出し箇所も型整合のみ確認

[5] 手動検証（任意）
    5-1. cmux-team status を実行して新フォーマット表示を確認
    5-2. dashboard 起動（cmux-team start でなく既存 daemon 経由）して TUI ヘッダーを目視確認
```

## 検証手順

### 自動テスト

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-366-1777275302/skills/cmux-team/manager

# 個別ファイル実行（CLAUDE.md ガイドライン: bun test 全体禁忌）
bun test --timeout 30000 pool-status-header.test.ts
bun test --timeout 30000 pool-header-display.test.ts
bun test --timeout 30000 pool-summary.test.ts
bun test --timeout 30000 dashboard-pool.test.tsx
# computePoolCapacity の direct test がある場合
bun test --timeout 30000 token-store.test.ts

# 型チェック
bun run tsc --noEmit
# あるいは package.json scripts 経由（要確認）
```

### 手動検証（CLI）

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-366-1777275302
bun skills/cmux-team/manager/main.ts status
# → ヘッダーの token pool ボックスに `pool capacity: 5h NN% / 7d NN%` が出ることを確認

bun skills/cmux-team/manager/main.ts pool status
# → 末尾に新フォーマットが出ることを確認
```

## リスク・注意点

### 1. 後方互換削除の影響

`PoolCapacityResult.capacity_pct` / `PoolHeaderInput.capacityPct` の削除は破壊的変更だが、利用箇所はリポジトリ内 7 ファイル（grep 確認済み）に閉じている:

- `token-store.ts` / `pool-summary.ts` / `pool-status-header.ts` / `pool-header-display.ts` / `dashboard.tsx` / `pool-next-reset.ts` / `pool-cli.ts`
- テスト 4 ファイル: `pool-status-header.test.ts` / `pool-header-display.test.ts` / `pool-summary.test.ts` / `dashboard-pool.test.tsx`

外部公開 API（npm package として exposed）ではなく、すべて `skills/cmux-team/manager/` 内部の TS 型なので、本タスク範囲ですべて書き換えれば足りる。CLAUDE.md の「後方互換性コードは不要」方針に従う。

### 2. 罫線幅 60 文字制約

`buildPoolHeaderLines` は固定幅 60 文字。新フォーマット `pool capacity: 5h NN% / 7d NN%` は最長 `pool capacity: 5h 9999% / 7d 9999%` で 33 文字。`buildContentLine` の inner 幅は 58 文字なので余裕で収まる。罫線は変更不要。

### 3. dashboard.tsx::buildPoolHeader の色付け方式

dashboard.tsx は `buildPoolHeaderLines` の出力した「`pool capacity:` を含む行」全体を `ui.text(line, { style: { fg: capColor } })` で色付けしている。新フォーマットでは行に「5h NN% / 7d NN%」が含まれるので、行全体が `min` ベースの色で塗られる。これは要件「`min(5h, 7d)` をベースに色分け」と一致するので問題なし。

ただし、`buildPoolHeader` は dashboard.tsx:516 の comment にあるように現在 dashboard 描画経路から外れており、export 残置のみ。**TUI の実描画経路は `buildPoolHeaderDisplay`（pool-header-display.ts → dashboard.tsx:1494）** なのでそちらを優先して直すこと。

### 4. `pool-next-reset.ts` の deltaPct 解釈

`deltaPct` は「次に reset したらキャパがどれだけ増えるか」を示す。新実装で `min(5h, 7d)` ベースに変えると:

- 5h 側がボトルネック中で 5h reset が来る → `min` が大幅増 → `deltaPct` が +大きい値
- 7d 側がボトルネックで 5h reset が来る → `min` は不変 → `deltaPct ≒ 0`

これは「ユーザーが期待する『次に何が起きるか』」と整合する。既存テストで delta の絶対値を検証している箇所があれば、新ロジックの数値に合わせて再計算する必要あり（`pool-next-reset.test.ts` 等の確認は実装時に grep で）。

### 5. `computePoolCapacity` のエッジケース

- **両 window null**: 既存は「フル 7d 相当を 1 候補として min」だった。新実装では「5h 側 0 寄与、7d 側に `(plan_ratio / FULL_WEEK_HOURS)` を加算」とする方針。これにより `capacity_5h_pct` が「reset 情報未取得トークンを除外した値」になり、`capacity_7d_pct` が「全トークン込みの値」になる。
- これが要件と合うか実装時に再確認。違和感があれば「両 window null は両方ともフル 7d 相当として均等に寄与」など別案に切り替える。テスト case で明示する。

### 6. テストフィクスチャの数値変動

`pool-summary.test.ts` の case A は「`capacityPct ≒ 50%`」を assert している。これは旧実装の min 後合算値。新実装では:

- `capacity_5h_pct ≒ 1680%`（5h reset まで 5h、残量 50% → 律速ではない）
- `capacity_7d_pct ≒ 50%`（7d reset まで 168h、残量 50% → 律速）

旧 assertion は「7d 律速」のケースだったので `capacity_7d_pct ≒ 50%` にスライドできる。case B / D も同様の解釈で書き換え可能。

### 7. CLI 互換性（外部スクリプトに与える影響）

`cmux-team pool status` / `cmux-team status` の出力は人間向け表示のみで、機械可読出力（JSON）は今回触らない。仮に外部スクリプトが `pool capacity: NN%` を grep していた場合は新フォーマットで壊れるが、リポジトリ内では確認できる範囲ではそのような利用は無し（ドキュメント上も grep 用途は明示されていない）。

リスクとして低く、要件にも「TUI ヘッダー / CLI status 同じ形式」と明示されているため許容範囲。
