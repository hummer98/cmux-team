# T401 実装計画書: Metrics pool token に computeEffUtil を適用して CLI と一致させる

## 1. 課題分析

### 現状の問題点

`cmux-team token list` (CLI) と Manager dashboard の Metrics ページの Pool Tokens セクションで、同一の usage snapshot に対する解釈が乖離している。

| 経路 | 経由関数 | stale + reset 通過軸の挙動 |
|------|---------|---------------------------|
| CLI (`token list` / `pool status`) | `formatPerHandleUtilCell` → `computeEffUtil` | 0% に上書き、行末に `*` マーカー |
| Metrics ページ | `buildPoolTokenRows` → 生 `snap.util_5h/7d` | 生値のまま (例: `@kddi` の `util_7d=0.97` がそのまま表示) |

### 根本原因

`skills/cmux-team/manager/dashboard.tsx:2079-2091` の `buildPoolTokenRows` が `snap?.util_5h ?? null` / `snap?.util_7d ?? null` をそのまま `PoolTokenRow.util5h/util7d` に詰めており、`computeEffUtil` を経由していない。

これは **「`computeEffUtil` が admit / throttle / 表示の 3 箇所共有の唯一の実装」という設計原則 (T390) に反して、Metrics ページが 4 つ目の独自実装 (生 snapshot 直読み) になっていた** ことを意味する。

### 影響範囲

- **可視範囲**: Manager dashboard の `Metrics` タブ → Pool Tokens セクションの 5h / 7d 列。
- **動作影響**: 表示のみ。admit / throttle / spawn-agent の判定は影響を受けない (それらは既に `computeEffUtil` 経由)。
- **ユーザー体験**: 「reset 過ぎているのに高 util のまま」という直感に反する表示によりユーザーが混乱する (今回のバグ報告そのもの)。
- **テスト**: `dashboard-metrics.test.tsx` の Pool Tokens セクションのテストフィクスチャに reset-passed フラグの観点が欠落している。

## 2. 技術アプローチ

### 採用するアプローチ

1. `dashboard.tsx::buildPoolTokenRows` で `computeEffUtil(snap, now)` を呼び、その結果から `PoolTokenRow` を構築する。
2. `PoolTokenRow` インターフェース (`dashboard-metrics.ts`) に `reset5hPassed: boolean` / `reset7dPassed: boolean` を追加し、UI 側でマーカー判断材料を確実に渡す。
3. `dashboard-metrics.ts::buildPoolTokensSection` で「いずれかの軸で reset 通過」行に CLI と同じ `*` マーカーを付け、1 つでも `*` があれば末尾に凡例 `(* = reset 通過済みで実質クリア)` を出す。i18n キーは `metrics_pool_marker` / `metrics_pool_marker_legend` を新設する。
4. 純粋ヘルパー `buildPoolTokenRowFromSnapshot(handle, snap, nowMs)` を `dashboard-metrics.ts` に export する。これにより daemon state に依存しない単体テストが書け、CLI (`formatPerHandleUtilCell`) との等価性を検証できる。

### 採用理由

- **構造的正しさを優先**: `computeEffUtil` は spec line 274 で「3 箇所共有の唯一の実装」と明記されている。Metrics を 4 つ目の consumer に整列させることで、今後同様のバグが構造的に発生し得なくなる。
- **テスタビリティ向上**: `buildPoolTokenRows` 自体は `daemon.tokenDb` を要求するため単体テストが書きにくいが、純粋ヘルパー化することで `formatPerHandleUtilCell` と同じ fixture (token-format.test.ts のパターン) で等価性を検証できる。
- **CLI との合意**: token-format.ts:46-67 のコメント (`pool status と spawn-agent で選ばれる値の乖離が構造的に発生しない`) と同じ性質が Metrics にも拡張される。

### 代替案と却下理由

| 案 | 概要 | 却下理由 |
|---|---|---|
| 案 A | `formatPerHandleUtilCell` を Metrics でもそのまま呼び、文字列 (`"0%"` / `"91%"`) を `PoolTokenRow.display5h/7d` に持つ | UI 側の `buildUtilizationBar` は数値 (`util5h: number`) を要求するため、文字列化済みの値ではバー描画ができない。表示 (`X%`) と bar (`█████`) を独立に作るのは責務の二重化 |
| 案 B | `buildPoolTokenRows` を `dashboard.tsx` に残したまま現場修正のみ (ヘルパー抽出なし) | 単体テストで `daemon.tokenDb` を mock する必要があり、テスト追加コストが高い。pure 関数として切り出した方が `formatPerHandleUtilCell` との等価性を fixture 共有で証明できる |
| 案 C | `computeEffUtil` を Metrics 用に拡張 (signature 変更) | 既に admit / throttle / 表示で安定使用されている関数。signature 変更は他経路にリスクを波及させる |

### 既存パターンとの整合性

- token-format.ts:55-67 (`formatPerHandleUtilCell`) と同じ呼び出しパターン (`computeEffUtil(snap, nowMs)` → effUtil + reset*Passed) を採用。
- pool-cli.ts:75-122 / token-cli.ts:466-519 の `anyMarker` ループパターンを `buildPoolTokensSection` にも適用 (ただし dashboard-metrics 側は配列を一巡してマーカー有無を判定するシンプル化された形)。
- i18n キーの命名は既存の `metrics_pool_no_selectable` / `metrics_pool_no_data` と同じ prefix で揃える。

## 3. 変更対象

### 変更ファイル

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/dashboard-metrics.ts` | (a) `PoolTokenRow` に `reset5hPassed: boolean` / `reset7dPassed: boolean` を追加。 (b) 純粋ヘルパー `buildPoolTokenRowFromSnapshot(handle, snap, nowMs)` を export。 (c) `buildPoolTokensSection` で 1 つでも reset 通過軸があれば `*` マーカー列とフッタ凡例を追加 |
| `skills/cmux-team/manager/dashboard.tsx` | `buildPoolTokenRows` 内で `computeEffUtil` 経由に切り替え。実装は `buildPoolTokenRowFromSnapshot` を呼ぶだけになる |
| `skills/cmux-team/manager/i18n.ts` | `metrics_pool_marker_legend` キーを en/ja の両方に追加 (内容は CLI と完全一致: `(* = reset passed, effectively cleared)` / `(* = reset 通過済みで実質クリア)`) |
| `skills/cmux-team/manager/dashboard-metrics.test.tsx` | (a) 既存の `PoolTokenRow` フィクスチャに `reset5hPassed: false, reset7dPassed: false` を追加。 (b) 新 describe ブロックで marker / legend / `buildPoolTokenRowFromSnapshot` の単体テストを追加 (CLI 等価性 1 ケース含む) |

### 新規作成ファイル

なし (既存ファイルへの追記・修正のみ)。

### 削除ファイル

なし。

## 4. サブタスク分割

> **制約**: 旧実装と新実装を並行させない (S3 完了時点で `snap?.util_5h ?? null` の直読みは消滅していること)。リファクタで不要になるコードがあれば削除タスクを明示する (本タスクでは S3 内で直読み block が消える)。

### S1: i18n キー追加

- **対象ファイル**: `skills/cmux-team/manager/i18n.ts`
- **内容**:
  - `en`: `metrics_pool_marker_legend: "(* = reset passed, effectively cleared)"` (line 824 付近、既存 `metrics_pool_no_data` の直後)
  - `ja`: `metrics_pool_marker_legend: "(* = reset 通過済みで実質クリア)"` (line 1637 付近、既存 `metrics_pool_no_data` の直後)
- **完了条件**: `bunx tsc --noEmit skills/cmux-team/manager/i18n.ts` がエラーなし。`grep "metrics_pool_marker_legend" skills/cmux-team/manager/i18n.ts | wc -l` が 2。

### S2: PoolTokenRow に reset 通過フラグを追加

- **対象ファイル**: `skills/cmux-team/manager/dashboard-metrics.ts`
- **内容**: `PoolTokenRow` インターフェース定義 (line 32-40) に以下を追加:
  ```ts
  /** stale + reset_5h_at 通過済みで effUtil5h が 0 に上書きされた場合 true。CLI の MARK 列と同じ判定 */
  reset5hPassed: boolean;
  /** stale + reset_7d_at 通過済みで effUtil7d が 0 に上書きされた場合 true */
  reset7dPassed: boolean;
  ```
- **メソッド制約**: 既存の `hasSnapshot` フィールドは現状維持 (削除しない / 意味を変えない)。
- **完了条件**: `grep "reset5hPassed\|reset7dPassed" skills/cmux-team/manager/dashboard-metrics.ts` が両方ヒット。
- **検証コマンド**: `grep -n "reset5hPassed: boolean\|reset7dPassed: boolean" skills/cmux-team/manager/dashboard-metrics.ts`

### S3: 純粋ヘルパー buildPoolTokenRowFromSnapshot を追加

- **対象ファイル**: `skills/cmux-team/manager/dashboard-metrics.ts`
- **内容**: 既存 `buildPoolTokensSection` の直前に以下を追加 (computeEffUtil import を含む):
  ```ts
  import { computeEffUtil, type UsageSnapshot } from "./token-store";

  /**
   * T401: token snapshot から 1 行分の PoolTokenRow を組み立てる pure 関数。
   *
   * - `computeEffUtil` の effUtil5h/7d をそのまま `util5h/7d` に詰める (stale + reset 通過軸は 0)。
   * - `snap.util_5h === null` 等の null 値は null のまま保持 (UI で bar 非描画)。
   *   `effUtil*` は 0 になるが `util5h: null` を返すことで bar 描画を skip する従来挙動と整合。
   * - admit / throttle / CLI 表示と同一の `computeEffUtil` を経由するため、Metrics と
   *   `cmux-team token list` で同一値が表示される (T390 の "3 箇所共有" 原則を 4 箇所に拡張)。
   */
  export function buildPoolTokenRowFromSnapshot(
    handle: string,
    snap: UsageSnapshot | null,
    nowMs: number,
  ): PoolTokenRow {
    const eff = computeEffUtil(snap, nowMs);
    const util5h = snap?.util_5h == null ? null : eff.effUtil5h;
    const util7d = snap?.util_7d == null ? null : eff.effUtil7d;
    return {
      handle,
      util5h,
      reset5hIso: snap?.reset_5h_at ?? null,
      util7d,
      reset7dIso: snap?.reset_7d_at ?? null,
      hasSnapshot: snap !== null && (util5h !== null || util7d !== null),
      reset5hPassed: eff.reset5hPassed,
      reset7dPassed: eff.reset7dPassed,
    };
  }
  ```
- **メソッド制約**: 必ず `computeEffUtil` 経由。`snap.util_5h * 1.0` 等の生値直接演算は禁止。
- **完了条件**: 関数が export されている。`bunx tsc --noEmit` がエラーなし。
- **検証コマンド**: `grep -n "export function buildPoolTokenRowFromSnapshot" skills/cmux-team/manager/dashboard-metrics.ts`

### S4: dashboard.tsx::buildPoolTokenRows をヘルパー呼び出しに置き換え

- **対象ファイル**: `skills/cmux-team/manager/dashboard.tsx`
- **内容**:
  - line 56-60 の import に `buildPoolTokenRowFromSnapshot` を追加。
  - line 2079-2091 の `candidates.map((tok) => { ... })` 内の rows 構築を以下に置き換え:
    ```ts
    const now = Date.now();
    const rows: PoolTokenRow[] = candidates.map((tok) => {
      const snap = getLatestUsageSnapshot(daemon.tokenDb!, tok.id);
      return buildPoolTokenRowFromSnapshot(tok.handle, snap, now);
    });
    ```
- **メソッド制約**: ループ内で毎回 `Date.now()` を呼ばず、ループ前に 1 回取得して `nowMs` を使い回す (パディング計算と整合させるため。`buildPoolTokensSection` も `data.nowMs` を受け取る同パターン)。
- **完了条件**:
  - `grep -n "snap?.util_5h ?? null" skills/cmux-team/manager/dashboard.tsx` で 0 件 (旧実装が消滅)。
  - `grep -n "buildPoolTokenRowFromSnapshot" skills/cmux-team/manager/dashboard.tsx` で 2 件 (import + 呼び出し)。
- **検証コマンド**: `grep -n "snap?.util_5h\|buildPoolTokenRowFromSnapshot" skills/cmux-team/manager/dashboard.tsx`

### S5: buildPoolTokensSection に marker 列とフッタ凡例を追加

- **対象ファイル**: `skills/cmux-team/manager/dashboard-metrics.ts`
- **内容**:
  - `buildPoolTokensSection` (line 204-259) のループで、各行末尾に reset*Passed のいずれかが true なら ` *` を追加 (handle padEnd 後の cells 末尾に push)。
  - ループ後、`anyMarker` フラグが true なら `rows.push(ui.text(t("metrics_pool_marker_legend"), { dim: true }))` でフッタ凡例を追加。
  - hasSnapshot=false 行は marker 判定の対象外 (CLI 同等)。
- **メソッド制約**: マーカー文字は CLI と完全一致 (`*`)。色指定は dim or なし (CLI は plain text)。
- **完了条件**: `bunx tsc --noEmit` エラーなし。S6 のテスト ("reset 通過済み行に * マーカーが付く") が pass。
- **検証コマンド**: `grep -n "metrics_pool_marker_legend" skills/cmux-team/manager/dashboard-metrics.ts`

### S6: dashboard-metrics.test.tsx に新規テストを追加

- **対象ファイル**: `skills/cmux-team/manager/dashboard-metrics.test.tsx`
- **内容**:
  1. **既存フィクスチャの修正**: line 210-403 の `PoolTokenRow` フィクスチャ全件 (8 箇所) に `reset5hPassed: false, reset7dPassed: false` を追加。これは S2 で追加した必須フィールド分。
  2. **新 describe `buildPoolTokenRowFromSnapshot (CLI consistency)`** を追加し、以下のテストを書く:
     - **(a) snap=null** → `util5h=null, util7d=null, hasSnapshot=false, reset5hPassed=false, reset7dPassed=false`
     - **(b) fresh snap** (recorded_at が現在、reset_*_at が未来) → `util5h=eff.effUtil5h=snap.util_5h`、 reset 通過フラグ false
     - **(c) @kddi 想定**: stale (recorded_at が 35 分前) + reset_5h_at 未到達 + reset_7d_at 通過 + util_5h=0.02, util_7d=0.97 → `util5h=0.02, util7d=0, reset5hPassed=false, reset7dPassed=true`
     - **(d) CLI 等価性**: token-format.test.ts:132 の同じ snap fixture で `formatPerHandleUtilCell` (`"0%", "91%", "*"`) と `buildPoolTokenRowFromSnapshot` (util5h=0, util7d=0.91, reset5hPassed=true, reset7dPassed=false) が同じ判断を共有していることを確認 (両者の数値が `formatUtil` 経由で一致することの確認)
  3. **新 describe `buildMetricsRows: pool tokens marker (T401)`** を追加し、以下のテストを書く:
     - **(e)** 1 つ以上の row が `reset5hPassed=true` の場合、出力文字列に `"*"` マーカーが含まれ、フッタに `"reset 通過済み"` (ja) または `"reset passed"` (en) を含む凡例が含まれる。
     - **(f)** すべての row が `reset5hPassed=false && reset7dPassed=false` の場合、`"*"` マーカーは含まれず、凡例も含まれない。
- **メソッド制約**: token-format.test.ts:100-200 の `snap()` ヘルパー / `STALE_RECORDED` 定数と同等のフィクスチャパターンを採用 (CLI 等価性を fixture 共有で示すため)。`bun test --timeout 30000 dashboard-metrics.test.tsx` で実行可能。
- **完了条件**:
  - `cd skills/cmux-team/manager && bun test --timeout 30000 dashboard-metrics.test.tsx` が pass。
  - 既存の Pool Tokens 系テスト (現行 18+ ケース) が引き続き pass。
- **検証コマンド**: `cd skills/cmux-team/manager && bun test --timeout 30000 dashboard-metrics.test.tsx 2>&1 | tail -20`

### S7: 既存ユニットテストへの影響確認 (frontend regression check)

- **対象ファイル**: `skills/cmux-team/manager/dashboard-metrics.test.tsx`, `skills/cmux-team/manager/dashboard-issues.test.tsx`, `skills/cmux-team/manager/token-format.test.ts`, `skills/cmux-team/manager/token-store.test.ts`, `skills/cmux-team/manager/token-cli.test.ts`, `skills/cmux-team/manager/pool-cli.test.ts`
- **内容**:
  - すべて pass することを確認。
  - `dashboard-issues.test.tsx:65 (metricsData: null)` は `MetricsData` 型自体は変えていないので影響なし (確認のみ)。
- **完了条件**:
  ```bash
  cd skills/cmux-team/manager && for f in dashboard-metrics.test.tsx dashboard-issues.test.tsx token-format.test.ts token-store.test.ts token-cli.test.ts pool-cli.test.ts; do bun test --timeout 30000 "$f" || exit 1; done
  ```
  全件 pass。
- **メソッド制約**: `bun test` 全体実行は禁忌 (CLAUDE.md 既知の注意点)。個別ファイル実行のみ。

### S8: 受け入れ条件の手動確認

- **対象ファイル**: なし (動作確認)
- **内容**:
  - 受け入れ条件「`@kddi` のように `util_7d` が高いまま reset_7d_at を通過した token が、CLI と Metrics で同じ表示になる」 を fixture テスト (S6-c, S6-d) でカバーしていることを確認。
  - 凡例 (`* = reset 通過済みで実質クリア`) が Metrics ページに出ることを S6-e で確認。
- **完了条件**: S6 の (c), (d), (e) すべて pass。

## 5. リスク

### 既存機能への影響

- **admit / throttle / spawn-agent**: 影響なし (これらは既に `computeEffUtil` 経由)。
- **CLI (`token list` / `pool status`)**: 影響なし (本タスクでは触らない)。
- **dashboard 他タブ**: Pool Tokens セクション以外は変更しないので影響なし。
- **`PoolTokenRow` 型を消費する他箇所**: `grep` 結果上、`buildPoolTokenRows` (dashboard.tsx) と `buildPoolTokensSection` (dashboard-metrics.ts) のみ。両方とも本タスクで更新済みになる。

### エッジケース

| ケース | 挙動 | 対応方針 |
|--------|------|---------|
| snap=null (snapshot 未登録) | `eff.hasSnapshot=false` → 現状の "no data" 行と同じ | 変更なし |
| snap 存在 + util_5h=null + util_7d=null | `util5h=null, util7d=null` → `hasSnapshot = false` (snap 存在でも null only なら no data 扱い) | 既存挙動を保持 |
| snap 存在 + util_5h=null + util_7d=0.5 | `util5h=null, util7d=0.5` → bar5h は描画されず bar7d のみ描画。`hasSnapshot=true` | 既存挙動を保持 |
| stale + reset_5h_at が NaN/不正値 | `parseResetEpochMs` が NaN を返し `<=` 比較が false → reset5hPassed=false | `computeEffUtil` 内で既にハンドル済み (token-store.ts:980-981) |
| reset_5h_at が `null` | computeEffUtil 内で `null != null` → false → reset5hPassed=false | 既存挙動 |
| 全 token reset 通過 | 全 5h が 0 → util5h DESC ソートで全行が同 util。同 util は handle ASC (現状維持) | 動作上問題なし。バグでもない |

### テスト戦略

- **CLI 等価性**: token-format.test.ts と同じ snap fixture を再利用 (snap helper を inline 再現) し、両関数が同じ判断 (effUtil 値・reset 通過フラグ) を返すことを確認 (S6-d)。
- **マーカー描画**: `buildMetricsRows` に reset 通過 row を渡し、出力文字列に `*` と凡例が含まれることを確認 (S6-e/f)。
- **回帰防止**: 既存 18+ ケースが PoolTokenRow 新フィールド追加でも pass し続けることを確認 (S6 の既存フィクスチャ修正)。

## 6. 既存型エラーの先読み

```bash
bunx tsc --noEmit 2>&1 | grep -E "^(skills/cmux-team/manager/dashboard\.tsx|skills/cmux-team/manager/dashboard-metrics\.ts|skills/cmux-team/manager/dashboard-metrics\.test\.tsx|skills/cmux-team/manager/token-format\.ts|skills/cmux-team/manager/token-store\.ts|skills/cmux-team/manager/token-format\.test\.ts|skills/cmux-team/manager/dashboard-issues\.test\.tsx|skills/cmux-team/manager/i18n\.ts)" || echo "(no matching errors)"
```

実行結果: **(no matching errors)**

### 6.1 本タスクのスコープで解消するエラー

該当なし。

### 6.2 後続タスク (cleanup) に分離するエラー

該当なし。

> 注: 本タスクで `PoolTokenRow` に必須フィールドを追加 (S2) するため、フィクスチャ未更新時には新規にコンパイルエラーが発生する可能性がある。S6 の "既存フィクスチャの修正" でこれを解消する設計とした (発生 → 即時解消が同タスク内で完結)。

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | `PoolTokenRow` に reset*Passed を新規フィールドで追加するか、既存 `hasSnapshot` のように bool を増やすか | **新規フィールド追加** | reset*Passed は marker 描画判定に必要な独立情報。`hasSnapshot` (snapshot 存在判定) と意味が直交するため統合不可 |
| D2 | `buildPoolTokenRows` を `dashboard.tsx` から `dashboard-metrics.ts` へ完全移設するか | **しない (純粋部分のみ抽出)** | DB I/O (`getLatestUsageSnapshot` / `listTokens`) を `dashboard-metrics.ts` に持ち込むと dashboard-metrics の純粋性が損なわれる。pure helper のみ切り出してテスト可能性を確保するのが最小変更 |
| D3 | snap の util_5h が null の場合 effUtil の 0 を表示するか、null 維持か | **null 維持** | spec 文言「stale 条件を満たせば 0%、満たさなければ snapshot の生値」の "snapshot の生値" は null を含むと解釈。null → bar 非描画の既存挙動を保持。CLI も formatUtil(0) で "0%" 化するが、これは別問題 (本タスクのスコープ外、cleanup で対処すべき場合は別タスク化) |
| D4 | 凡例 (`* = reset 通過済みで実質クリア`) を Metrics ページに追加するか | **追加** | CLI と同じ凡例を出すことで「マーカーの意味が CLI と Metrics で別」という乖離を防ぐ。i18n 化も既存パターン (`metrics_pool_no_data` 等) に揃える |
| D5 | i18n キー名 | **`metrics_pool_marker_legend`** | 既存 `metrics_pool_no_selectable` / `metrics_pool_no_data` と prefix を揃え、用途 (legend) を suffix に明示 |
| D6 | テストで CLI 等価性をどう示すか | **token-format.test.ts と同じ snap fixture を共有** | 「同じ入力 → 両関数が同じ判断 (effUtil5h, reset5hPassed)」を fixture 共有で示すのが最も明示的。新たな test helper を作るより既存パターン継承が望ましい |
| D7 | dashboard.tsx の `Date.now()` 呼び出し位置 | **ループ前に 1 回** | 既存 `buildPoolTokensSection` も `data.nowMs` を 1 回 propagate する設計。各 row で `Date.now()` を呼ぶとパディング計算と微妙にずれるリスクあり |
| D8 | reset 通過行のソート扱い (effUtil5h=0 で下位に沈む) | **CLI と同じく許容** | CLI も同等のソート挙動。util DESC で並んでいることがユーザー期待 (高 util から見たい)。reset 通過した token は実質 0 なので下位に沈むのは合理的 |
