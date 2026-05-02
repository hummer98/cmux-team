# T415 — TUI Metrics タブ縮小 + Web URL open キーバインド: 実装計画

## 1. 概要

T414 で導入された Web ダッシュボード (`team.json.dashboardServer.url`) に集計表示を寄せ、TUI Metrics タブを「今危険か」を即座に見るための最小構成に縮小する。さらに `O` キーで Web ダッシュボードをブラウザ起動するキーバインドを追加し、TUI ↔ Web の導線を確立する。

縮小後の表示要素は `Pool Tokens` / `Rate Limit projection (5h/7d) risk` / `Latest activity (caption)` / `Web URL 行` の 4 ブロック。`MetricsData.roleRows` / `taskRows` は **Web に完全移管されているため削除**（dashboard-server.ts は独自に `aggregateApiUsageByRole` / `aggregateApiUsageByTask` を呼んでおり、TUI 経由の参照のみが消える）。

---

## 2. 影響を受けるファイル

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/dashboard-metrics.ts` | `MetricsData` から `roleRows` / `taskRows` を削除し `dashboardServerUrl: string \| null` を追加。`buildMetricsRows` の末尾「By role」「By task」セクション削除、Web URL 行を追加 |
| `skills/cmux-team/manager/dashboard-metrics.test.tsx` | `roleRows` / `taskRows` 関連 assertion / fixture 削除、Web URL 行の表示 / no-running 文言 / `dashboardServerUrl=null` を新規 case として追加 |
| `skills/cmux-team/manager/dashboard.tsx` | `loadMetricsData` から `aggregateApiUsageByRole` / `aggregateApiUsageByTask` の呼び出し / import を削除、`MetricsData` 構築時に `daemon.dashboardServerUrl` を詰める。footer の `metrics` focused area ヘルプに `O` キーを追記。既存 `O` キー handler を `activeTab` で分岐拡張し、Metrics タブで `openDashboardUrlInBrowser(state)` を呼ぶ |
| `skills/cmux-team/manager/i18n.ts` | `metrics_open_browser_hint` (= `"open browser"` / `"ブラウザで開く"`)、`metrics_url_label` (= `"Open dashboard"` / `"Web ダッシュボード"`)、`metrics_url_not_running` (= `"Web dashboard: not running"` / `"Web ダッシュボード: 未起動"`) を追加。既存の `metrics_section_role` / `metrics_section_task` / `metrics_empty_role` / `metrics_empty_task` / `metrics_header_role` / `metrics_header_task` / `metrics_header_requests` / `metrics_header_input` / `metrics_header_output` / `metrics_header_cache` は他参照が無ければ削除（grep で確認） |
| `docs/spec/12-web-dashboard.md` | §9「TUI 連携（後続 T-2）」を本タスクの確定実装に書き換え（縮小後表示要素・`O` キー仕様・URL 取得経路） |

---

## 3. 設計判断

### D1: `MetricsData.roleRows` / `taskRows` は削除する

**理由**: 仕様の「Implementer 判断」項目。grep の結果、利用箇所は `dashboard-metrics.ts` (buildMetricsRows での描画) と `dashboard.tsx` (loadMetricsData の populate) と `dashboard-metrics.test.tsx` のみ。Web ダッシュボードは **`dashboard-server.ts` が独自に同じ集計関数を呼んでおり TUI の `MetricsData` 経由ではない**ため、TUI 側のフィールドを残しても誰も使わない。`AggregatedRoleRow` / `AggregatedTaskRow` 型と `aggregateApiUsageByRole` / `aggregateApiUsageByTask` 関数自体は dashboard-server / `cmux-team metrics` CLI で使われ続けるので削らない。

### D2: 大文字 `O` キーをバインド (issues タブの `O` と activeTab で分岐)

**理由**: 既存の Issues タブが `B` (browser) / `O` (view) を大文字で定義しており、「タブ横断の補助キーは大文字」というパターンに揃える。仕様文の表記 `ui.kbd("O") ui.text("open browser")` も大文字を示している。`O` キーは現在 issues タブ専用 handler（`activeTab !== "issues"` で early return）なので、handler を `activeTab === "metrics"` で別動作させる形に拡張すればキー名重複は起きない。

### D3: ブラウザ起動は `process.platform` で `open` / `xdg-open` を分岐 (helper を新設)

**理由**: 仕様の「`open`（macOS）/ `xdg-open`（Linux）で起動」を満たす。Issues タブの `B` キーは macOS 前提で `Bun.spawn(["open", url])` を直書きしているが、Metrics の URL 起動は cross-platform 配慮を仕様で要求している。dashboard.tsx 内に `openDashboardUrlInBrowser(url: string | null): void` を追加 (引数 `null` は no-op + status 文言)。

### D4: URL 行の位置は「Latest activity caption の直後、Pool Tokens の前」

**理由**: 仕様では順序が明示されていないが、危険度を即座に見るための「最小ヘッドライン」として caption (latest activity) と URL を上部に固める方が、Pool Tokens の縦伸びに埋もれない。具体構造:

```
1. caption (from: role/surface (Ns ago))   ← latest activity 兼用
2. Open dashboard: http://127.0.0.1:NNNN   ← 新規（URL 行）
3. ── Rate Limit Projection ──             ← pool 無効時のみ
4. ── Pool Tokens (selectable: N) ──       ← pool 有効時
```

`poolTokens === null` (pool 無効) でも `poolTokens !== null` (pool 有効) でも URL 行は常に出す。proxy idle / no data caption とも独立して常に表示する（仕様: 「URL 行」は固定要素）。

### D5: URL 未取得時の文言

**理由**: 仕様文「`Web dashboard: not running`」（英）。i18n key `metrics_url_not_running` で英 / 日両対応にする。`metrics_url_label`（"Open dashboard"）と切り替える形ではなく、両者で別の 1 行を出す。

```
URL あり → "Open dashboard: http://127.0.0.1:54321"
URL なし → "Web dashboard: not running"
```

### D6: `O` キー押下時のステータス通知

**理由**: 仕様「URL 未取得時は no-op + 1 行 status メッセージ」。既存の `metricsError` 行を再利用して URL 未取得時のヒントを出すと load error と混ざるため、専用フィールド `metricsStatusMessage: string | null` を AppState に追加し、URL 未取得時 / open 失敗時にセットする。`buildMetricsRows` は `error` の代わりに `(error ?? statusMessage)` を末尾に表示する仕様に拡張する。表示後、次の loadMetricsData で自動クリアする（簡素化）。

---

## 4. 実装ステップ（TDD）

### Step 1: i18n キー追加（テスト不要、定数追加のみ）

- `skills/cmux-team/manager/i18n.ts` に英 / 日のキー 3 件を追加:
  - `metrics_open_browser_hint`
  - `metrics_url_label`
  - `metrics_url_not_running`
- 既存 `metrics_section_role` / `metrics_section_task` / `metrics_empty_role` / `metrics_empty_task` / `metrics_header_*` 系の参照を grep。`dashboard-metrics.ts` 以外に参照が無ければ削除する（テスト走らせて型エラー確認）。

### Step 2: `dashboard-metrics.test.tsx` を縮小後仕様に合わせて先行更新（red）

- 既存テスト調整:
  - `describe("buildMetricsRows: role / task aggregations …")` ブロックを削除（Web に移管済み）
  - 既存 `makeData` から `roleRows: []` / `taskRows: []` を取り除き、代わりに `dashboardServerUrl: null` を default に設定
  - `MetricsData` 型 import に `dashboardServerUrl` フィールドが反映されることを TypeScript 経由で検証（型エラーで red）
- 新規テスト追加:
  - `describe("buildMetricsRows: Web URL row (T415)")`:
    - `dashboardServerUrl: "http://127.0.0.1:54321"` → 出力に `"Open dashboard"` と `"http://127.0.0.1:54321"` を含む
    - `dashboardServerUrl: null` → 出力に `"not running"` または `"未起動"` を含む（i18n に依存しない toLowerCase 比較）
    - URL 行は Pool Tokens セクションより前に出る（`indexOf` 比較）
    - URL 行は Rate Limit Projection セクションより前に出る
- bun test per-file で fail を確認（roleRows 削除に伴う型エラー / 新規 case の未実装）

### Step 3: `dashboard-metrics.ts` 実装（green）

- `MetricsData` 型から `roleRows` / `taskRows` 削除、`dashboardServerUrl: string | null` 追加
- 不要になった import 削除: `AggregatedRoleRow` / `AggregatedTaskRow`
- `buildMetricsRows`:
  - 末尾の「By role」「By task」セクションを丸ごと削除
  - caption 行のあと、`buildWebUrlRow(data.dashboardServerUrl)` を呼んで URL 行を追加
  - `buildWebUrlRow` 純粋関数 (private) を追加: URL あり / なしで `t("metrics_url_label")` または `t("metrics_url_not_running")` を返す
- bun test per-file で test green を確認

### Step 4: `dashboard.tsx` の `MetricsData` 構築 / import を更新（既存の TUI が依然動くことを確認）

- import から `aggregateApiUsageByRole` / `aggregateApiUsageByTask` / `AggregatedRoleRow` / `AggregatedTaskRow` を削除
- `loadMetricsData`:
  - `aggregateApiUsageByRole` / `aggregateApiUsageByTask` の SQL コール削除
  - `MetricsData` 構築時に `dashboardServerUrl: daemon.dashboardServerUrl ?? null` を詰める
  - traceDb 不在時の fallback `MetricsData` も同じ shape に揃える
- footer の `state.focusedArea === "metrics"` 分岐に `ui.kbd("O"), ui.text(t("metrics_open_browser_hint"))` を追加
- bun test per-file: dashboard.tsx は直接単体テストが薄いため、`dashboard-metrics.test.tsx` / `dashboard-server.test.ts` / `trace-store-metrics.test.ts` が green であることで stub を確認

### Step 5: `O` キー handler 追加 (red→green、unit test は helper 関数経由)

- AppState に `metricsStatusMessage: string | null` を追加（init `null`）。`buildMetricsRows` の error 行が `metricsError ?? metricsStatusMessage` の OR で表示されるように改修（プロンプト的には `dashboard-metrics.test.tsx` で「`statusMessage` 単独でも末尾に出る」test を 1 件追加）
- `dashboard.tsx` 内に helper 関数:
  ```ts
  function openDashboardUrlInBrowser(url: string | null): { ok: boolean; reason?: string } {
    if (!url) return { ok: false, reason: "no_url" };
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    try {
      Bun.spawn([cmd, url], { stdio: ["ignore", "ignore", "ignore"] });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, reason: e?.message ?? String(e) };
    }
  }
  ```
  これを `dashboard.tsx` の export ではなく、テスト容易性のために `dashboard-browser.ts` を新規作成して切り出すかは一旦保留（Step 5b 参照）。
- 既存 `O: (ctx) => { ... }` を以下に拡張:
  ```ts
  O: (ctx) => {
    if (ctx.state.activeTab === "issues") { /* 既存処理 */ return; }
    if (ctx.state.activeTab === "metrics") {
      const r = openDashboardUrlInBrowser(ctx.state.metricsData?.dashboardServerUrl ?? null);
      if (!r.ok) {
        const msg = r.reason === "no_url"
          ? t("metrics_url_not_running")
          : `open failed: ${r.reason}`;
        app.update((s) => ({ ...s, metricsStatusMessage: msg }));
      }
      return;
    }
  }
  ```
- 単体テスト方針:
  - `dashboard-browser.test.ts` (新規): `openDashboardUrlInBrowser` を `process.platform` を mock せずに pure に検証する
    - `null` → `{ ok: false, reason: "no_url" }`
    - 不正な command path で fail すれば `ok: false`（ただし spawn は非同期に成功した「ように見える」可能性があり、実 spawn では検証が脆い）
  - 代替案として `Bun.spawn` を `bun:test mock` 経由でスタブし、`["open", url]` / `["xdg-open", url]` のいずれかが呼ばれることを確認する。`process.platform` は `Object.defineProperty(process, "platform", ...)` で一時上書き → restore する pattern を採用
- bun test per-file で green を確認

### Step 5b: helper の配置先決定

- `openDashboardUrlInBrowser` を `dashboard.tsx` に置くと、import 都合で test が `dashboard.tsx` 全体を読み込んで重い
- → 軽い別ファイル `skills/cmux-team/manager/browser-open.ts` を新設して export。`dashboard.tsx` と test の双方から import する
- 加えて Issues タブの `B` キー実装 (`Bun.spawn(["open", url], ...)`) も同じ helper に置き換えると platform 互換性が一律になるが、**本タスクのスコープ外（仕様で指示なし）**。helper だけ用意し、Issues 側の差し替えは別タスクで提案する形にとどめる

### Step 6: spec 更新

- `docs/spec/12-web-dashboard.md` §9 を以下に書き換え（「後続 T-2」表記を消す）:
  - 縮小後の TUI Metrics タブ表示要素 (Pool Tokens / Rate Limit projection / Latest activity / Web URL row) の箇条書き
  - `O` キー仕様（macOS=`open`、Linux=`xdg-open`、URL 未取得時 no-op + status）
  - URL 取得経路: `team.json.dashboardServer.url` または TUI で直接 `O`
  - 関連 spec / コードに `dashboard-metrics.ts` / `browser-open.ts` を追記

### Step 7: 全テスト再実行 + 手動検証

- `cd skills/cmux-team/manager && for f in dashboard-metrics.test.tsx dashboard-server.test.ts dashboard-browser.test.ts trace-store-metrics.test.ts; do bun test --timeout 30000 "$f"; done` (per-file ルール遵守)
- 必要に応じ周辺 (i18n.test.ts / state-machine 系) も per-file で実行
- 手動検証は §6 参照

---

## 5. テスト計画

### 5.1 既存テストの更新点

| ファイル | 更新 |
|---|---|
| `dashboard-metrics.test.tsx` | (a) `makeData` から `roleRows: []` / `taskRows: []` を削除し `dashboardServerUrl: null` を追加 (b) `describe("buildMetricsRows: role / task aggregations …")` ブロック全体を削除 (c) `describe("buildMetricsRows: caption …")` 内の no-data caption テストは存続させる |

### 5.2 新規テストケース

| 観点 | テスト名（example） | 検証内容 |
|---|---|---|
| URL 行表示 | `"dashboardServerUrl 設定あり → URL 行が出る"` | `s.includes("Open dashboard")` && `s.includes("http://127.0.0.1:54321")` |
| URL 未設定 | `"dashboardServerUrl=null → not running 表示"` | `s.toLowerCase().includes("not running") \|\| s.includes("未起動")` |
| 行順序 | `"URL 行は Pool Tokens セクションより前"` | `indexOf("Open dashboard") < indexOf("Pool Tokens")` |
| 行順序 | `"URL 行は Rate Limit Projection より前"` | `indexOf("Open dashboard") < indexOf("Rate Limit Projection")` |
| roleRows / taskRows 不在 | `"buildMetricsRows 出力に 'By role' / 'By task' セクションが含まれない"` | `s` が `"By role"` / `"By task"` / `"ロール別"` / `"タスク別"` を含まない |
| status message 表示 | `"metricsStatusMessage 単独でも末尾に表示される"` | `buildMetricsRows(data, null, "open failed: foo")` の末尾に文言が出る（API 拡張に伴う） |
| browser-open helper | `"openDashboardUrlInBrowser(null) → { ok: false, reason: 'no_url' }"` | helper 単体 |
| browser-open helper | `"darwin で 'open <url>' を spawn"` | `Bun.spawn` を mock し引数検証 |
| browser-open helper | `"linux で 'xdg-open <url>' を spawn"` | 同上 |

### 5.3 統合テスト（手動）

1. `bun run skills/cmux-team/manager/main.ts daemon` で daemon 起動 → `cmux-team status` で URL 取得を確認
2. TUI を開いて `M` キーで Metrics タブ → URL 行 / Pool / projection / latest activity を確認
3. `O` キーでブラウザが起動して Web ダッシュボードが開く
4. dashboard-server を意図的に止めて再起動し、URL 取得失敗ケースで `O` 押下 → 「Web dashboard: not running」が status 行に出る

---

## 6. 検証手順

### 6.1 自動検証

```bash
cd skills/cmux-team/manager
# 直接修正したファイルとそれに依存する test
for f in dashboard-metrics.test.tsx dashboard-browser.test.ts dashboard-server.test.ts trace-store-metrics.test.ts trace-store-projection.test.ts; do
  bun test --timeout 30000 "$f"
done
```

### 6.2 手動検証

```bash
# 1. ローカル package を再ビルド + リンク
bun run --cwd skills/cmux-team/manager build  # （該当 script があれば）
# 2. 既存 daemon を停止
cmux-team stop || true
# 3. daemon 再起動 + Manager TUI 起動
cmux-team start
# 4. URL を確認
cat .team/team.json | jq -r .dashboardServer.url
# 5. TUI で M キー → Metrics タブ表示
# 6. O キー → ブラウザで Web ダッシュボードが開くこと
# 7. 確認後、dashboard-server を未起動状態に戻すか、URL を抑止して再表示
```

### 6.3 観察ポイント

- TUI Metrics タブに `By role` / `By task` セクションが**残っていないこと**
- footer ヘルプの metrics 行に `O open browser`（または日本語）が表示されること
- `O` 押下後のブラウザ動作（macOS で `open` プロセスが立ち上がる）
- URL 未取得時に押しても TUI がフリーズしない / 例外で落ちない / status 文言だけ出る
- `cmux-team status` の出力に変化がないこと（dashboardServer.url の表示は維持）

---

## 7. リスク・懸念点

### R1: `O` キー handler 拡張で issues タブ動作が壊れる

`O` の単一 handler を `activeTab` で 2 分岐させる際、issues タブの既存ロジック（`openSelectedIssueInViewer`）を壊さないよう **return を必ず入れる**。テストは issues 側の TUI E2E が無いため、focusedArea === "issues" のときの早期 return を unit ではなく review で確認する。

### R2: `Bun.spawn` の mock テストが脆い

`bun:test` の `mock.module("...")` パターンでも `Bun.spawn` グローバル差し替えがやや不安定。代替として helper 関数の `spawn` 部分を関数引数（DI）にして `openDashboardUrlInBrowser(url, opts: { spawn?: typeof Bun.spawn })` の形にすると、test 容易性が大きく上がる。既存の `dashboard.tsx` のキー handler では未対応の DI パターンだが、新設 helper のスコープ内なら導入コストは小さい。

### R3: `MetricsData.roleRows` / `taskRows` 削除による外部参照の見落とし

grep 範囲は `skills/cmux-team/` に限定した。`commands/` / `bin/` / `docs/spec/` / `tests-of-tests/` の document / script から参照されていないかを念のため `grep -r "MetricsData" skills commands bin docs` で再確認する。テンプレートや md からの type 参照は技術的にはあり得ないが、「インスタンス化サンプル」として記述されている可能性を排除する。

### R4: `metrics_section_role` / `metrics_empty_role` / `metrics_header_*` 系 i18n キーの削除判断

これらは仕様で「Implementer 判断」とされている。**dashboard-metrics.ts 以外で参照されていないことを `grep -rn "metrics_section_role\|metrics_section_task\|metrics_empty_role\|metrics_empty_task\|metrics_header_role\|metrics_header_task\|metrics_header_requests\|metrics_header_input\|metrics_header_output\|metrics_header_cache" skills/`で確認したうえで削除**する。Web ダッシュボード側 (`dashboard-web/app.js`) は独自の文字列定数を持つ（i18n 共有していない）想定だが、要確認。残せば dead code、消せば後方互換性ロス（外部参照無いはずなので問題ないはず）。

### R5: URL 行の i18n 文字列に `:` が含まれることによる既存 caption テストの偽陽性

`metrics_caption_from` は `"from: ..."` を含み、URL 行も `"Open dashboard:"` を含む。test の `s.includes("from:")` 等で他 caption と衝突しないか念のため確認する（実際は接頭辞が異なるため衝突は起こらないはず）。

### R6: `metricsStatusMessage` 自動クリアのタイミング

「次の loadMetricsData で自動クリア」で良いかは UX 観点の判断。1 秒間隔の polling では「`O` 押下→直後に消える」可能性があるが、no-op (URL 未取得) のとき以外は通常クリアされない（push 後にすぐ消える程度の頻度ならユーザーは気付く）。長時間表示が必要なら明示的な dismiss が要るが、本タスクではシンプルさを優先し「次の tick でクリア」を採用する。
