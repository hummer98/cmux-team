# T414 Implementation Summary

> 実装期間: 2026-05-02 (single-pass TDD)
> Implementer: Conductor + Implementer agent (Claude Opus 4.7)
> 作業ディレクトリ: `/Users/yamamoto/git/cmux-team/.worktrees/task-414-1777688558`

## Step completion status

| Step | Status | Commit |
|---|---|---|
| Step 1: HTTP server skeleton + /api/health | ✓ | `1f46b18` |
| Step 2: aggregation API endpoints | ✓ | `a7dd137` |
| Step 3: agent-strategy classification + drill-down | ✓ | `2318152` |
| Step 4: SPA + Overview page + uPlot vendor | ✓ | `ed046fe` (Step 4-6 を 1 commit に統合) |
| Step 5: Tool Use + Tokens pages | ✓ | `ed046fe` |
| Step 6: Agent Strategy + Tasks + drill-down | ✓ | `ed046fe` |
| Step 7: docs/spec/12-web-dashboard.md + cross-references | ✓ | (本 commit 予定) |

> Step 4–6 は SPA `app.js` を 1 ファイルで配信する設計上、render 関数群を一度に揃える方が
> 自然だった（個別 commit はテスト境界を切れず、HTML 配信→ページ追加の差分も視覚的検証主体）
> ため統合 commit にした。Step 1–3 は trace-store / agent-strategy ごとに per-file テストが
> 切れたため別 commit を切ってある。plan の commit 戦略の「ステップが大きすぎて分割した方が
> 良い場合は判断で commit を増やしてもよい」の逆ケース。

## Bun test results (per-file)

すべて `cd skills/cmux-team/manager && bun test --timeout 30000 <file>` で実行。

| Test file | pass | fail | expect() | runtime |
|---|---|---|---|---|
| `dashboard-server.test.ts` | 23 | 0 | 75 | 257 ms |
| `agent-strategy.test.ts` | 14 | 0 | 30 | 63 ms |
| `trace-store-metrics.test.ts` | 32 | 0 | 76 | 156 ms |
| `daemon.test.ts` (regression) | 209 | 0 | 715 | 25 s |
| `trace-store.test.ts` (regression) | 38 | 0 | 234 | 239 ms |
| `metrics-aggregate.test.ts` (regression) | 18 | 0 | 53 | 71 ms |

新規 SQL の境界テスト (空 / 件数降順 / since-until 境界 / hour vs day bucket key) は
`trace-store-metrics.test.ts` の T414 セクション 4 ケースに含まれる。

## tsc results

`cd skills/cmux-team/manager && bunx tsc --noEmit` → **0 新規エラー**。

## 検証チェックリスト (plan §12)

### サーバ起動 / 公開

- [x] `cmux-team start` で manager daemon 起動と同時に dashboard server が立ち上がる
       (main.ts に `startDashboardServer` 統合、fail-soft)
- [x] `.team/team.json` に `dashboardServer: { url, schemaVersion: 1 }` が atomic write
       (daemon.ts:updateTeamJson に追記、tmp+rename 経路は既存)
- [x] daemon shutdown / `onFullQuit` 経路では `server.stop()` を呼ばない
       (main.ts には dashboardHandle を保持しない設計)
- [x] 既存 proxy.ts の port / lifecycle に影響しない (proxy 関連テストは触っていない)

### Security

- [x] `Bun.serve({ hostname: "127.0.0.1" })` 指定 (dashboard-server.ts:519)
- [x] URL 公開は `http://127.0.0.1:<port>` のみ (test で確認)
- [x] response header に CSP 4 + extra directive 付与 (dashboard-server.ts:96)

### API

- [x] `/api/health` / `/api/overview` / `/api/tool-use` / `/api/agent-strategy` /
       `/api/agent-strategy/:taskId` / `/api/tokens` / `/api/tasks` が全て 200 を返す
       (dashboard-server.test.ts でカバー)
- [x] `?from=ISO&to=ISO` 全 endpoint で動く / 既定 24h
- [x] parse 失敗 / `from > to` で 400
- [x] 不在 task で 404 (`/api/agent-strategy/UNKNOWN_TASK_XYZ`)
- [x] 各レスポンスが TypeScript schema を満たす (DI 化により timeout テストもカバー)
- [x] timeout race: 6s sleep aggregator → 5s で 503

### HTML / SPA (手動 / pending)

- [x] htmlBundle inline 置換が 4 placeholder 全部働く (dashboard-server.test.ts で実ファイル読み込み確認)
- [x] `<title>cmux-team dashboard</title>` を含む
- [-] **ブラウザで開いて 5 ページすべてが描画される** — pending (CI 環境では未確認、
       手動チェックリスト)
- [-] preset chip [1h/24h/7d/30d] 連動 — pending (手動)
- [-] custom datetime — pending (手動)
- [-] permalink 別タブ — pending (手動)
- [-] auto refresh 30s ON/OFF — pending (手動)
- [-] Tasks 行クリック → drill-down — pending (手動)

### 既存機能の不破壊

- [x] 既存 TUI Metrics タブ (`dashboard-metrics.ts` / `dashboard.tsx` Metrics 分岐) を未変更
- [x] 既存 `cmux-team metrics` CLI を未変更
- [x] 既存 proxy.ts を未変更 (api 互換、port lifecycle 不変)

### テスト

- [x] `bun test --timeout 30000 dashboard-server.test.ts` 緑 (23/23)
- [x] `bun test --timeout 30000 agent-strategy.test.ts` 緑 (14/14)
- [x] `bun test --timeout 30000 trace-store-metrics.test.ts` 緑 (32/32 — 新規 SQL 境界含む)
- [x] `bunx tsc --noEmit` 0 新規エラー

### Docs

- [x] `docs/spec/12-web-dashboard.md` 新設 (10 章 + 手動検証チェックリスト)
- [x] `docs/spec/00-project-overview.md` 観察箱表に Web ダッシュボード追記 + 索引に 12 行追加
- [x] `docs/spec/glossary.md` §11 に「Web ダッシュボード」「Agent 戦略分類（暫定 6 値）」エントリ追加
- [x] `docs/spec/05-install-and-infrastructure.md` `.team/.gitignore` 節下に
       `team.json.dashboardServer` フィールド説明追加
- [x] `CLAUDE.md` 「進捗情報の取得方法」表に URL 取得方法 1 行追記

### npm publish

- [x] `package.json` files に `skills/cmux-team/manager/dashboard-web/**` 追加
- [x] `npm pack --dry-run` で `dashboard-web/` 配下が含まれる:
       - `dashboard-web-bundle.ts` 1.5 KB
       - `dashboard-web/app.js` 35.5 KB
       - `dashboard-web/index.html` 1.5 KB
       - `dashboard-web/style.css` 4.7 KB
       - `dashboard-web/vendor/uplot.min.js` 50.3 KB
       - `dashboard-web/vendor/uplot.min.css` 1.9 KB
       - `dashboard-web/vendor/UPLOT_VERSION` 7 B
- [x] vendor uPlot のライセンスヘッダコメント (`/*! https://github.com/leeoniya/uPlot (v1.6.31) */`) 残存

## Design Reviewer rev2 New Findings の反映状況

| # | 内容 | 反映 |
|---|---|---|
| 4.2 #1 | `ApiErrorResponse { error; message?; ... }` を 1 つ追加 | ✓ dashboard-server.ts:138 で定義、400/404/500/503 で利用 |
| 4.2 #2 | timeout テストの sleep 差し替え方法を DI 化 | ✓ `DashboardServerOptions.{ sleep, aggregators, aggregateTimeoutMs }` で実現。テストで `fastSleep` + `slowOverview` を注入し 5s race を再現 |
| 4.2 #3 | per-tool table の Bash ピン留めを spec で明文化 | ✓ app.js の `pinBash()` 関数で実装。docs/spec/12-web-dashboard.md §6.4 に記載 |

## plan からの逸脱

なし。impl-deviations.md は作成しない（plan 通り実装）。

軽微な実装裁量:

- Step 4-6 を 1 commit に統合（plan §9「ただしステップが大きすぎて分割した方が良い場合は
  判断で commit を増やしてもよい」の逆方向、SPA 1 ファイル設計上 1 commit が自然）
- `_internal` export を dashboard-server.ts に置き、後続 Step で再利用可能にする
  (ただし最終的には Step 4-6 でも未使用、削除候補だが副作用のないため残置)

## 手動確認 pending

`docs/spec/12-web-dashboard.md` §6.5 の手動チェックリストはブラウザ環境で別途実施が必要。
リスト:

- [ ] 5 ページ全て描画される
- [ ] preset chip [1h / 24h / 7d / 30d] で全グラフが連動する
- [ ] custom datetime ピッカーで任意範囲が指定できる
- [ ] permalink: URL を別タブで開いても同じ表示
- [ ] task drill-down: Tasks 行クリック → Agent Strategy drill-down にジャンプ
- [ ] 30s auto refresh ON / OFF
- [ ] 過去 task で Agent Strategy drill-down が timeline 表示される

実 daemon を再起動 → `cat .team/team.json | jq -r .dashboardServer.url` で URL 取得 →
ブラウザで開いて確認、を Master / ユーザーに依頼する想定。
