# T415 検品結果

## 判定: GO

## 検品サマリ

T415 の仕様（TUI Metrics タブ縮小・Web URL 行追加・`O` キー cross-platform browser open・i18n 整理・docs §9 確定実装化）はすべて実装に反映されており、削除した要素の残骸も無い。per-file テスト（dashboard-metrics 52 / browser-open 6 / dashboard-server 23 / dashboard-issues 11 / dashboard-conductor 15 / dashboard-journal 23 / dashboard-master 6 / dashboard-pool 2）はすべて pass、`bunx tsc --noEmit` も clean (exit 0)。critical な指摘は無し。

## 観点別評価

### 1. タスク要件の達成度

- [✓] 表示要素 (4 ブロック) — Latest activity caption / Web URL 行 / Rate Limit Projection (pool 無効時) / Pool Tokens (pool 有効時) を `buildMetricsRows` (dashboard-metrics.ts:358) で順序固定（caption → URL → projection → pool）。`buildWebUrlRow` は dashboard-metrics.ts:341 に追加済みで pool 有無 / proxy idle と独立に常に 1 行出力されることを test (URL 行は Pool Tokens / Rate Limit Projection より前 / proxy 未稼働でも常時表示) で確認。
- [✓] `O` キー動作 — dashboard.tsx:1955–1979 で `activeTab === "issues"` / `"metrics"` を early-return パターンで分岐拡張。Metrics タブでは `openDashboardUrlInBrowser(url)` を呼び、`{ ok:false, reason }` のとき `metrics_url_not_running`（`no_url`）または `open failed: <reason>` を `metricsStatusMessage` に書き込み + `manager.log` へ `metrics_open_browser_failed` を出す。
- [✓] i18n ja/en — `metrics_url_label` / `metrics_url_not_running` / `metrics_open_browser_hint` の 3 キーが i18n.ts の en (1022-1024) と ja (2017-2019) の双方に追加済み。footer ヘルプ（dashboard.tsx:1782）は `t("metrics_open_browser_hint")` 経由で参照。
- [✓] docs/spec/12-web-dashboard.md §9 更新 — §9.1 縮小後表示要素 / §9.2 `O` キー仕様 / §9.3 URL 取得経路の 3 副節に展開済み。「後続 T-2」表記は削除され、§10 関連ファイルリストにも `browser-open.ts` / `browser-open.test.ts` および `dashboard-metrics.ts` (T415 で role/task セクション削除) が追記済み。

### 2. コード品質

- `browser-open.ts` は DI（`spawn` / `platform`）で test 容易性を確保し、本体は 56 行と過剰に肥大化していない。エラー時も `command` を返すことで呼び出し側 log に活用可能。
- `dashboard-metrics.ts` は `roleRows` / `taskRows` 関連のセクション・import を完全に削除。`buildMetricsRows` の第 3 引数 `statusMessage` を後方互換のためデフォルト `null` にしてあり、`error ?? statusMessage` で error 優先のロジックも素直。
- `dashboard.tsx` の `O` キー handler は issues / metrics の双方を early-return で分岐し、リスク R1（issues タブ動作が壊れる）を回避。`activeTab !== "issues"` での fall-through が `activeTab === "metrics"` 分岐に移ったが、return が確実に入っており他タブで spawn が走る経路は無い。
- 過剰なフォールバック・後方互換コードは無し。CLAUDE.md ルールに沿っている。

### 3. テスト

per-file 再実行結果（`bun test --timeout 30000 <f>`）:

| ファイル | 結果 |
|---|---|
| `dashboard-metrics.test.tsx` | 52 pass / 0 fail |
| `browser-open.test.ts` | 6 pass / 0 fail |
| `dashboard-server.test.ts` | 23 pass / 0 fail |
| `dashboard-issues.test.tsx` | 11 pass / 0 fail |
| `dashboard-conductor.test.tsx` | 15 pass / 0 fail |
| `dashboard-journal.test.tsx` | 23 pass / 0 fail |
| `dashboard-master.test.tsx` | 6 pass / 0 fail |
| `dashboard-pool.test.tsx` | 2 pass / 0 fail |

新規テストケース充足度（plan §5.2）:

- ✓ URL 行表示 — "dashboardServerUrl 設定あり → 'Open dashboard' と URL が含まれる"
- ✓ URL 未設定 — "dashboardServerUrl=null → 'not running' / '未起動' 表示"
- ✓ 行順序 (Pool 前) — "URL 行は Pool Tokens セクションより前に出る"
- ✓ 行順序 (Projection 前) — "URL 行は Rate Limit Projection セクションより前に出る"
- ✓ proxy 未稼働でも URL 行は常に出る — "proxy 未稼働 (latestRowTimestampMs=null) でも常に表示"
- ✓ "By role" / "By task" 不在 — describe `T415 (Web 移管後)` に集約
- ✓ status message 単独表示 — "statusMessage 単独でも末尾に表示される"
- ✓ error 優先 — "error と statusMessage の双方が指定されたら error を優先"
- ✓ data=null + statusMessage — "data=null + statusMessage のみでも末尾に表示"
- ✓ browser-open helper: null → no_url / 空文字 → no_url / darwin → open / linux → xdg-open / win32 fallback / spawn 例外（6 ケース）

### 4. TypeScript

`bunx tsc --noEmit` を `skills/cmux-team/manager/` で実行 → 出力なし、exit 0。Implementer が touch したファイル（`dashboard-metrics.ts` / `dashboard-metrics.test.tsx` / `dashboard.tsx` / `dashboard-issues.test.tsx` / `i18n.ts` / `browser-open.ts` / `browser-open.test.ts`）由来の新規型エラーは無し。

### 5. i18n / MetricsData クリーンアップ

削除対象キー 9 件（`metrics_section_role` / `metrics_section_task` / `metrics_empty_role` / `metrics_empty_task` / `metrics_header_role` / `metrics_header_task` / `metrics_header_requests` / `metrics_header_input` / `metrics_header_output` / `metrics_header_cache`）を `skills` / `commands` / `bin` / `docs` 全域で grep → 参照ゼロ。i18n.ts 自体からも削除済み。

`MetricsData.roleRows` / `taskRows` の grep:
- `dashboard.tsx:1550` / `1622` は **Tasks タブ用の独立変数** で `MetricsData` とは無関係（task list 表示のローカル変数）。
- `agent-strategy.ts:67-116` の `taskRows` は SQL 結果セット用の局所変数で `MetricsData` とは無関係。
- `aggregateApiUsageByRole` / `aggregateApiUsageByTask` は `dashboard.tsx` から完全に消え、`dashboard-server.ts` / `metrics-aggregate.ts` / `trace-store.ts` / `trace-store-*.test.ts` のみが参照（仕様通り）。

### 6. ドキュメント

- `docs/spec/12-web-dashboard.md` §9 は「後続 T-2」表記が消え、§9.1 (5 ブロック) / §9.2 (`O` キー: cross-platform 仕様 + status message + log key) / §9.3 (URL 取得経路 3 つ) に展開済み。
- §10 関連実装に `dashboard-metrics.ts` (T415 で role/task セクション削除、URL 行追加) と `browser-open.ts` (T415 ブラウザ起動 helper) を追記、テスト欄にも `dashboard-metrics.test.tsx` (URL 行 / status message / role/task 削除を追加) と `browser-open.test.ts` (DI ベース、6 ケース) を追記済み。

## Critical findings

無し。

## Minor findings

- **Issues タブ `B` キーの cross-platform 化はスコープ外** — `dashboard.tsx:1950` に `Bun.spawn(["open", item.issue.html_url])` の直書きが残存。Linux 環境では動かないが、plan §5b で「本タスクのスコープ外。helper だけ用意し、Issues 側の差し替えは別タスクで提案する形」と明記されており、docs/spec §9.2 にも「本タスクではスコープ外」と記載。後続タスク (例: T416 candidate) で `browser-open.ts` 経由に差し替えると一律 cross-platform 化できる。
- **`metricsStatusMessage` の自動クリア** — `loadMetricsData` 成功 / fallback (traceDb=null) で `null` に倒すため、`O` キー押下後の status は次の tick (通常 1〜5s 間隔) で消える。長文 reason を読む前にクリアされる可能性は残るが、plan D6 の通り簡素化を優先。明示 dismiss が要るほどの UX 問題が出てきたら別タスクで再考。
- **summary.md のテスト件数** — Implementer 報告の「674 pass / 0 fail」は手元再実行範囲（8 ファイル）と合算した値。本検品では指示された 8 ファイルのみ再実行したが、すべて pass。
