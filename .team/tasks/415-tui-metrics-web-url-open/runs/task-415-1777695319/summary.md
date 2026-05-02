# T415 実装結果

## 完了したサブタスク

- [x] Step 1: i18n キー 3 件追加（`metrics_url_label` / `metrics_url_not_running` / `metrics_open_browser_hint`）+ 旧キー 9 件削除（`metrics_section_role` / `metrics_section_task` / `metrics_empty_role` / `metrics_empty_task` / `metrics_header_role` / `metrics_header_task` / `metrics_header_requests` / `metrics_header_input` / `metrics_header_output` / `metrics_header_cache`）
- [x] Step 2: `dashboard-metrics.test.tsx` を T415 仕様に先行更新（roleRows/taskRows fixture 削除、URL 行 / 順序 / status message テスト追加）→ red 確認
- [x] Step 3: `dashboard-metrics.ts` 実装（`MetricsData` 型から `roleRows`/`taskRows` 削除、`dashboardServerUrl` 追加、`buildWebUrlRow` 純粋関数追加、role/task セクション削除、`buildMetricsRows` 第 3 引数 `statusMessage` 追加）→ green 確認
- [x] Step 4: `dashboard.tsx` の `loadMetricsData` 更新（`aggregateApiUsageByRole/Task` import 削除、`dashboardServerUrl` を daemon から populate、`METRICS_TASK_TOP_N` / `METRICS_WINDOW_MS` 削除、AppState に `metricsStatusMessage` 追加、buildMetricsRows 呼び出し 3 箇所を 3 引数化、footer ヘルプに `O open browser` 追加）
- [x] Step 5: `browser-open.ts` 新設（DI 可能な `openDashboardUrlInBrowser` helper）+ `dashboard.tsx` の `O` キー handler を `activeTab` で issues / metrics 分岐拡張 + `browser-open.test.ts` 6 ケース追加
- [x] Step 6: `docs/spec/12-web-dashboard.md` §9 を後続 T-2 → 確定実装に書き換え（縮小後表示要素 5 ブロック + `O` キー仕様 + URL 取得経路 3 つ）+ §10 関連実装/テストリストに追記
- [x] Step 7: 全 per-file テスト + `bunx tsc --noEmit` + summary.md 出力

## 変更ファイル

- `skills/cmux-team/manager/i18n.ts` — T415 用 i18n キー 3 件追加 / 旧キー 9 件削除（en + ja 両方）
- `skills/cmux-team/manager/dashboard-metrics.ts` — `MetricsData` 型変更（roleRows/taskRows 削除、dashboardServerUrl 追加）、`buildWebUrlRow` 追加、`buildMetricsRows` から role/task セクション削除し URL 行を caption 直後に追加、第 3 引数 `statusMessage` を導入し error 優先で末尾表示
- `skills/cmux-team/manager/dashboard-metrics.test.tsx` — fixture 更新、`describe("buildMetricsRows: role / task aggregations")` 削除、URL 行 / 順序 / proxy 未稼働下の常時表示 / status message 単独表示 / error 優先の 8 ケース追加
- `skills/cmux-team/manager/dashboard.tsx` — import 整理（`aggregateApiUsageByRole/Task` 削除、`openDashboardUrlInBrowser` 追加）、`AppState.metricsStatusMessage` 追加 + 初期値、`loadMetricsData` を `dashboardServerUrl` populate に変更、`buildMetricsRows` 呼び出し 3 箇所を `state.metricsStatusMessage` 渡し、footer の metrics 分岐に `O` キーヘルプ追加、`O` キー handler を `activeTab` で issues / metrics 分岐
- `skills/cmux-team/manager/browser-open.ts` — 新規 cross-platform helper（macOS=`open`、その他=`xdg-open`、DI で `spawn`/`platform` 差し替え可能）
- `skills/cmux-team/manager/browser-open.test.ts` — 新規 6 ケース（null / 空文字 / darwin / linux / win32 fallback / spawn 例外）
- `skills/cmux-team/manager/dashboard-issues.test.tsx` — fixture に `metricsStatusMessage: null` 追加（AppState 型整合）
- `docs/spec/12-web-dashboard.md` — §9 を確定実装に書き換え（9.1 縮小後表示要素 / 9.2 `O` キー / 9.3 URL 取得経路）、§10 に `dashboard-metrics.ts` / `browser-open.ts` / `dashboard-metrics.test.tsx` / `browser-open.test.ts` を追記

## テスト結果

per-file テストはすべて pass（CLAUDE.md の「`bun test` 全体実行禁止」ルールに従う）:

| テストファイル | pass | fail |
|---|---|---|
| `dashboard-metrics.test.tsx` | 52 | 0 |
| `browser-open.test.ts` | 6 | 0 |
| `dashboard-server.test.ts` | 23 | 0 |
| `trace-store-metrics.test.ts` | 32 | 0 |
| `trace-store-projection.test.ts` | 13 | 0 |
| `dashboard-conductor.test.tsx` | 15 | 0 |
| `dashboard-console-redirect.test.ts` | 3 | 0 |
| `dashboard-issues.test.tsx` | 11 | 0 |
| `dashboard-journal.test.tsx` | 23 | 0 |
| `dashboard-master.test.tsx` | 6 | 0 |
| `dashboard-pool.test.tsx` | 2 | 0 |
| `dashboard-scroll.test.ts` | 8 | 0 |
| `metrics-cli.test.ts` + `metrics-aggregate.test.ts` | 36 | 0 |
| `daemon.test.ts` + `main.test.ts` | 444 | 0 |

合計 674 pass / 0 fail。

## tsc 検証

`bunx tsc --noEmit` を `skills/cmux-team/manager/` で実行 → 出力なし（clean）。

タッチしたファイル群（`dashboard-metrics.ts` / `dashboard-metrics.test.tsx` / `dashboard.tsx` / `dashboard-issues.test.tsx` / `i18n.ts` / `browser-open.ts` / `browser-open.test.ts`）に新規型エラーは増えていない。

## 設計判断・差分

plan.md の 6 設計判断（D1〜D6）はそのまま採用。乖離は以下の 1 点のみ:

### plan.md からの差分

- **D3 / Step 5b**: helper の配置先は `browser-open.ts` を採用（`dashboard.tsx` から `openDashboardUrlInBrowser` を export することは行わなかった）。R2 のリスク回避のため、`spawn` / `platform` を DI 引数として公開し、test では `Bun.spawn` を mock せず DI 経由で argv を検証する方針を採った。win32 等の未定義 platform は `xdg-open` フォールバック扱いとして DI test に明記した（仕様明記なし → linux と同経路で安全側）。
- **D6 / Step 5**: `metricsStatusMessage` の自動クリアは `loadMetricsData` 成功時 + traceDb 未接続 fallback 時の双方で `metricsStatusMessage: null` に倒す（loadMetricsData 失敗時は触らないので、status と error が同 tick で起きてもクリアされない）。これは plan.md の「次の loadMetricsData で自動クリア」を素直に実装したもので、UX 観点の差はない。

### 仕様の正確性確認

- `MetricsData.roleRows` / `taskRows` の参照箇所を `grep -rn "roleRows\|taskRows\|MetricsData"` で再確認 → `dashboard-server.ts` 経由は `aggregateApiUsageByRole/Task` の独立呼び出しで済んでおり、TUI 側削除の影響はない（plan.md D1 の前提通り）
- `metrics_section_role` 等 9 件の削除前 grep を `skills commands bin docs` 範囲で実施 → 参照は `dashboard-metrics.ts` のみで安全に削除可能と確認
- `dashboardServerUrl` の populate 経路は `daemon.ts` の `state.dashboardServerUrl`（main.ts の `startDashboardServer` で書き込み）から取得、`team.json.dashboardServer.url` への書き出しと同一情報源（SSOT 維持）

## 残課題・懸念

- **R3 / R4 follow-up**: 削除した i18n キー 9 件は `skills commands bin docs` 範囲では参照ゼロを確認済み。仮に Web ダッシュボード側が今後 i18n を共有する設計に倒した場合は再追加検討。
- **Issues タブ `B` キーの cross-platform 化**: plan.md Step 5b の通りスコープ外（既存の `Bun.spawn(["open", url])` は darwin 前提のまま放置）。`browser-open.ts` 経由に差し替えれば一律になるが、別タスクで提案する形にとどめる。
- **status message の表示時間**: `metricsStatusMessage` は次の `loadMetricsData` (設定により 1〜5 秒間隔) で自動クリアする。長時間表示が必要なら明示 dismiss 機構が要るが、本タスクでは plan.md D6 の通りシンプルさを優先。
- **手動検証は未実施**: Implementer は code change のみで完了とする運用のため、daemon 起動 → TUI で `O` 押下 → ブラウザ起動 / 未起動時の status 表示の手動確認は Conductor / Master 側に委ねる。
