# T310 Metrics タブ スクロール対応 実装計画

## 1. 目的と要件

Metrics タブで画面下部（特に `metrics_section_task` のタスク別ランキング）が見切れる問題を、
↑/↓・g/G によるスクロール機構を追加して解決する。

### 受け入れ条件（タスク本文より）
- Metrics タブで ↑/↓ でスクロールできる
- g で先頭、G で末尾にジャンプできる
- 画面下端にあっても role/task 別ランキングが全件見られる
- footer のキーヒントに scroll 操作が表示される
- `bun test` / typecheck 通過

## 2. 設計方針

Metrics は journal/log と違って **逆順表示ではなく固定レイアウト**（caption → rate limit → unified
→ role → task）なので、offset の意味も異なる：

| area | offset = 0 の意味 | 新データ到着時 |
|------|-------------------|----------------|
| journal / log | 最新（逆順の先頭） | autoScroll で 0 維持または offset 加算で位置保持 |
| **metrics** | **画面トップ（caption 行）** | offset を維持（1s polling で rebuild されても位置変化なし） |

したがって：
- `autoScroll` フラグは不要
- 定期更新（`loadMetricsData`）で offset を加算する必要はない（rows は差分追記ではなく毎回全体 rebuild）
- ただし行数減少で offset が範囲外になるケースを `Math.min(offset, max(0, total - VISIBLE))` で clamp する

## 3. 現状コードの確認（行番号は `skills/cmux-team/manager/dashboard.tsx` の最新版）

参考になる既存実装：

| 役割 | 行番号 |
|------|--------|
| `LOG_VISIBLE_LINES` / `JOURNAL_VISIBLE_LINES` 等の定数定義 | 52–57 |
| `AppState` の `logScrollOffset` / `journalScrollOffset` / `focusedArea` | 412–417 |
| `AppState` の `metricsData` / `metricsError` / `metricsLastLoadedMs` | 427–430 |
| state 初期値（`logScrollOffset: 0` 付近） | 1192–1197 |
| state 初期値（`metricsData: null` 付近） | 1206–1208 |
| メインビュー分岐（`state.activeTab === "metrics"` の `buildMetricsRows(...)` 直渡し） | 1384–1385 |
| journal の offset slice（参考実装） | 1368–1377 |
| log の offset slice（参考実装） | 1386–1393 |
| footer の `focusedArea === "metrics"` 分岐（キーヒント） | 1458–1465 |
| `app.keys({ Up: ... })` の switch 文 | 1518–1548 |
| `app.keys({ Down: ... })` の switch 文 | 1549–1580 |
| `g:` ハンドラ（top） | 1687–1696 |
| `G:` ハンドラ（bottom） | 1697–1708 |

## 4. 変更内容（step-by-step）

### Step 1: `METRICS_VISIBLE_LINES` 定数追加

**場所**: `dashboard.tsx` L52–57 の定数ブロック（`LOG_VISIBLE_LINES` の隣）

```ts
const LOG_VISIBLE_LINES = 30;
const TASK_VISIBLE_LINES = 5;
const JOURNAL_VISIBLE_LINES = 30;
const ARTIFACT_VISIBLE_LINES = 12;
const ISSUE_VISIBLE_LINES = 20;
const SETTINGS_PREVIEW_LINES = 20;
const METRICS_VISIBLE_LINES = 30; // ← 追加（T310）
```

**値の根拠**: `LOG_VISIBLE_LINES` / `JOURNAL_VISIBLE_LINES` と揃えて `30`。
`buildMetricsRows` の最大行数は caption(1) + blank(1) + rate limit 見出し(1) + tokens/requests/burn(3)
+ blank(1) + unified 見出し(1) + unified 行(1) + blank(1) + role 見出し(1) + role ヘッダ(1)
+ roleRows(≒ 5–10) + blank(1) + task 見出し(1) + task ヘッダ(1) + taskRows(TASK_TOP_LIMIT)
≒ 25–35 行程度。30 行なら role まで画面に入り、↓ で task の末尾まで到達可能。

### Step 2: `AppState` に `metricsScrollOffset` フィールド追加

**場所**: `dashboard.tsx` L427–430 の Metrics タブセクション内（`metricsData` の隣）

```ts
  // ── Metrics タブ (T307) ──────────────────────────────────────────
  metricsData: MetricsData | null;
  metricsError: string | null;
  metricsLastLoadedMs: number;
  metricsScrollOffset: number;  // ← 追加（T310）
```

**初期値**: `dashboard.tsx` L1206–1208（`metricsLastLoadedMs: 0,` の直後）

```ts
      metricsData: null,
      metricsError: null,
      metricsLastLoadedMs: 0,
      metricsScrollOffset: 0,  // ← 追加
```

### Step 3: `buildMetricsRows` の戻り値を slice する

**場所**: `dashboard.tsx` L1384–1385

**Before**:
```ts
            : state.activeTab === "metrics"
            ? buildMetricsRows(state.metricsData, state.metricsError)
```

**After**:
```ts
            : state.activeTab === "metrics"
            ? (() => {
                const rows = buildMetricsRows(state.metricsData, state.metricsError);
                const total = rows.length;
                // 行数減少で offset が範囲外になるケースを clamp
                const startIdx = Math.min(
                  state.metricsScrollOffset,
                  Math.max(0, total - METRICS_VISIBLE_LINES),
                );
                const endIdx = Math.min(startIdx + METRICS_VISIBLE_LINES, total);
                return rows.slice(startIdx, endIdx);
              })()
```

> 注: journal/log は逆順表示（`[...arr].reverse()`）するが、Metrics は固定順のため reverse しない。

### Step 4: ↑/↓ キーハンドラ追加

**場所**: `dashboard.tsx` L1518–1580 の `Up` / `Down` switch 文

**Up**（L1532 の `case "log"` ブロック直後、`case "artifacts"` の前に挿入）:
```ts
        case "log": {
          // Down = 古い方へ（offset 増加）※既存
          const newOffset = Math.max(s.logScrollOffset - 1, 0);
          return { ...s, logScrollOffset: newOffset, logAutoScroll: newOffset === 0 };
        }
        case "metrics": {
          // Up = 上方向（offset 減少）
          return { ...s, metricsScrollOffset: Math.max(s.metricsScrollOffset - 1, 0) };
        }
        case "artifacts": {
```

**Down**（L1562 の `case "log"` ブロック直後、`case "artifacts"` の前に挿入）:
```ts
        case "log": {
          // Down = 古い方へ（offset 増加）※既存
          const maxOffset = Math.max(0, s.logLines.length - LOG_VISIBLE_LINES);
          return { ...s, logScrollOffset: Math.min(s.logScrollOffset + 1, maxOffset), logAutoScroll: false };
        }
        case "metrics": {
          // Down = 下方向（offset 増加）
          // rows 総数は buildMetricsRows 実行時にしか判明しないため
          // offset は上限なしで加算し、描画時に clamp（Step 3 の Math.min で安全）
          return { ...s, metricsScrollOffset: s.metricsScrollOffset + 1 };
        }
        case "artifacts": {
```

**設計メモ**: `Down` の max offset 算出には rows 総数が必要だが、それは
`buildMetricsRows(state.metricsData, state.metricsError)` を呼ばないと分からない。
以下 2 案のうち (A) を採用：

- **(A) 採用**: state update 時は clamp せず単純加算。描画側 (Step 3) で `Math.min` により clamp。
  offset が範囲外でも画面は末尾に貼り付くだけで UX 上の問題なし。state に残る overshoot 値も、
  次に ↑ を押した瞬間に 1 ずつ減るだけなので実害なし。
- **(B) 不採用**: key handler で再度 `buildMetricsRows` を呼んで総数を求める。
  毎キー押下で rebuild コスト発生、かつ `G` ハンドラ（Step 5）で総数が必要なのは同じ。

### Step 5: g / G ハンドラ追加

**場所**: `dashboard.tsx` L1687–1708

**g**（L1695 `return s;` の直前に分岐追加）:
```ts
    g: () => app.update((s) => {
      if (s.focusedArea === "journal") {
        return { ...s, journalScrollOffset: 0, journalAutoScroll: true };
      }
      if (s.focusedArea === "log") {
        return { ...s, logScrollOffset: 0, logAutoScroll: true };
      }
      if (s.focusedArea === "metrics") {
        return { ...s, metricsScrollOffset: 0 };
      }
      return s;
    }),
```

**G**（L1707 `return s;` の直前に分岐追加）:
```ts
    G: () => app.update((s) => {
      if (s.focusedArea === "journal") {
        const maxOffset = Math.max(0, s.journalEntries.length - JOURNAL_VISIBLE_LINES);
        return { ...s, journalScrollOffset: maxOffset, journalAutoScroll: false };
      }
      if (s.focusedArea === "log") {
        const maxOffset = Math.max(0, s.logLines.length - LOG_VISIBLE_LINES);
        return { ...s, logScrollOffset: maxOffset, logAutoScroll: false };
      }
      if (s.focusedArea === "metrics") {
        const rows = buildMetricsRows(s.metricsData, s.metricsError);
        const maxOffset = Math.max(0, rows.length - METRICS_VISIBLE_LINES);
        return { ...s, metricsScrollOffset: maxOffset };
      }
      return s;
    }),
```

> 注: `G` ハンドラでのみ `buildMetricsRows` を呼び出して総行数を取得する。
> 通常の ↓ 連打では呼ばない（Step 4 (A) 案により overshoot 許容）。

### Step 6: footer キーヒントに scroll 操作を追加

**場所**: `dashboard.tsx` L1458–1465 の `focusedArea === "metrics"` 分岐

**Before**:
```ts
          : state.focusedArea === "metrics"
          ? [
              ui.kbd("J"), ui.text("journal"),
              ui.kbd("A"), ui.text("artifacts"),
              ui.kbd("L"), ui.text("log"),
              ui.kbd("I"), ui.text("issues"),
              ui.kbd("ESC"), ui.text("back"),
            ]
```

**After**:
```ts
          : state.focusedArea === "metrics"
          ? [
              ui.kbd("↑/↓"), ui.text("scroll"),
              ui.kbd("g/G"), ui.text("top/bottom"),
              ui.kbd("J"), ui.text("journal"),
              ui.kbd("A"), ui.text("artifacts"),
              ui.kbd("L"), ui.text("log"),
              ui.kbd("I"), ui.text("issues"),
              ui.kbd("ESC"), ui.text("back"),
            ]
```

### Step 7: 定期更新（`loadMetricsData`）では offset をリセットしない

タスク本文の「metrics 定期更新（1s polling）で scroll offset を維持（auto-scroll 不要）」要件。

- L2008–2038 の `app.update((s) => ...)` ブロック（`journalScrollOffset` / `logScrollOffset` を書き換えるコード）
  は **metrics には触れない**（`loadMetricsData` は別パスで `metricsData` を更新するだけで、
  ここで `metricsScrollOffset` に手を入れる必要はない）。
- `loadMetricsData`（L1812 付近）の実装も `metricsScrollOffset` には触らない。

→ **既存コードの変更不要**。ただし Step 3 の描画時 clamp によって、
データ更新で総行数が減った場合でも自動的に末尾に貼り付く（offset はそのまま state に残る）。

## 5. テスト方針

### 既存テスト状況
- `skills/cmux-team/manager/dashboard.tsx` に対する unit test は現状**存在しない**
  （`dashboard-metrics.test.tsx` は `dashboard-metrics.ts` の pure function のみテスト）。
- `dashboard-issues.test.tsx` も同様に `dashboard` 本体の state 遷移はテストしていない。

### 本タスクで追加するテスト
dashboard.tsx 側に state/UI テスト枠組みが無いため、**新規 unit test は追加不要**とする。
代わりに以下で品質担保：

1. **typecheck**: `bun run typecheck` （`AppState` に `metricsScrollOffset` を追加したことで全参照が整合しているか）
2. **既存テスト**: `bun test`（`dashboard-metrics.test.tsx` が通ることを確認。`buildMetricsRows` の
   戻り値形式は変えないため影響なし）
3. **手動確認**:
   - `cmux-team start` 後、Metrics タブで ↑/↓ でスクロールできる
   - g で先頭（caption 行）、G で末尾（task ランキング末尾）に飛ぶ
   - footer に `↑/↓ scroll  g/G top/bottom` が表示される
   - 1s 定期更新後も scroll 位置が維持される
   - role/task ランキングの末尾行までが画面内に表示可能

## 6. 注意点・落とし穴（再掲）

1. **Metrics は全体 rebuild なので `autoFollow` フラグは不要**
   `journalAutoScroll` / `logAutoScroll` の類似フラグは追加しない。
2. **offset は 1s polling の update で reset しない**
   → 既存の `app.update` ブロック（L2008–2038）に `metricsScrollOffset` リセット処理を**入れない**。
3. **`startIdx = Math.min(offset, max(0, total - VISIBLE))` で clamp**
   → 行数減少で offset が範囲外になるケース対策。Step 3 で必須。
4. **Down ハンドラで overshoot を許容**
   → `buildMetricsRows` を keybind 側で毎回呼ばないため、state の `metricsScrollOffset` は
   `rows.length` を超えることがある。描画時の `Math.min` で救済されるので問題なし。
5. **`G` ハンドラは `buildMetricsRows` を呼ぶ必要がある**
   → 正確な末尾に飛ぶため。↓ 連打とは別扱い。
6. **journal/log とキー操作の意味がズレないように**
   ↑ = 上（若い index）、↓ = 下（大きい index）、g = top(0)、G = bottom(maxOffset)。
   journal/log は逆順表示なので「最新＝ offset 0 ＝ 先頭」だが、Metrics は順序表示なので
   「caption（先頭）＝ offset 0」。どちらも g で 0 にジャンプするので UX は一貫。

## 7. 変更ファイルまとめ

| ファイル | 変更内容 |
|----------|----------|
| `skills/cmux-team/manager/dashboard.tsx` | 定数追加（1 行）、`AppState` フィールド追加（1 行）、state 初期値（1 行）、view slice 置換、↑/↓/g/G ハンドラ追加、footer ヒント追加 |

他ファイルへの変更は不要（`dashboard-metrics.ts` は純関数なので触らない）。

## 8. 実装順序（Implementer 向け）

1. Step 1（定数）→ Step 2（型 + 初期値）→ `bun run typecheck` で型ホールを潰す
2. Step 3（slice 描画）→ この時点で画面上は scroll 無効だが見切れは発生しなくなる（offset=0 固定）
3. Step 4（↑/↓）→ 手動で ↑/↓ がきくか確認
4. Step 5（g/G）→ 同上
5. Step 6（footer）
6. `bun test` 全件通過
7. `cmux-team start` で Metrics タブ手動確認 → 受け入れ条件 5 項目すべて満たすか確認
