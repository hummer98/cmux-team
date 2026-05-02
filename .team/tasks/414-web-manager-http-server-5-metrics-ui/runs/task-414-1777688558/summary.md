# T414 Summary — 内部 Web ダッシュボード

> Manager 同居 HTTP server + 5 ページ Metrics UI
> 完了日: 2026-05-02
> Conductor: surface:585
> Worktree: `.worktrees/task-414-1777688558`
> Branch: `task-414-1777688558/task`

## 完了したサブタスク

| Phase | Status | 成果物 |
|---|---|---|
| Phase 1: Plan | ✓ | `plan.md` (795 行) |
| Phase 2: Design Review (rev1 + rev2) | ✓ Approved | `design-review.md` / `design-review-rev2.md` — 必須 5 項目すべて反映、後退 0 件 |
| Phase 3: Implementation | ✓ | 6 commits, 21 files changed (+3766/-2) |
| Phase 4: Inspection | ✓ GO | `inspection.md` — Critical/Major 0、Minor 3 のうち touch 範囲 2 を cleanup commit で解消 |

## 変更ファイル一覧

新規:
- `skills/cmux-team/manager/dashboard-server.ts` (+891)
- `skills/cmux-team/manager/dashboard-server.test.ts` (+359)
- `skills/cmux-team/manager/dashboard-web-bundle.ts` (+38)
- `skills/cmux-team/manager/dashboard-web/{index.html, style.css, app.js}` (+1204)
- `skills/cmux-team/manager/dashboard-web/vendor/{uplot.min.js, uplot.min.css, UPLOT_VERSION}` (vendored, MIT)
- `skills/cmux-team/manager/agent-strategy.ts` (+217)
- `skills/cmux-team/manager/agent-strategy.test.ts` (+277)
- `skills/cmux-team/manager/trace-store-metrics.test.ts` (+269)
- `docs/spec/12-web-dashboard.md` (+345)

更新:
- `skills/cmux-team/manager/trace-store.ts` (+120) — 新規 SQL 3 本（`countToolCallsByPeriod` / `failureRateByTool` / `aggregateApiUsageByBucket`）
- `skills/cmux-team/manager/main.ts` (+19) — `startDashboardServer` 統合（fail-soft）
- `skills/cmux-team/manager/daemon.ts` (+14) — `DaemonState.dashboardServerUrl` + `team.json` への atomic write
- `package.json` (+1) — `files` に `skills/cmux-team/manager/dashboard-web/**`
- `CLAUDE.md` / `docs/spec/00-project-overview.md` / `docs/spec/glossary.md` / `docs/spec/05-install-and-infrastructure.md` — 参照リンク追加

完全未変更（非破壊性確認済）:
- `skills/cmux-team/manager/proxy.ts` / `dashboard.tsx` / `dashboard-metrics.ts` / `metrics-aggregate.ts` / `bin/`

## テスト結果

| Test file | pass | fail | runtime |
|---|---|---|---|
| dashboard-server.test.ts | 23 | 0 | 250 ms |
| agent-strategy.test.ts | 14 | 0 | 74 ms |
| trace-store-metrics.test.ts | 32 | 0 | 199 ms |
| daemon.test.ts (regression) | 209 | 0 | 25 s |
| trace-store.test.ts (regression) | 38 | 0 | 242 ms |
| metrics-aggregate.test.ts (regression) | 18 | 0 | 80 ms |

`bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json` → exit 0、新規エラー 0 件。

## 主な設計判断（Plan/Review で確定）

- **traceDb 取得経路**: dashboard-server は **常に自前で `initDB(PROJECT_ROOT)`**（B 案、proxy 再利用パスの `else` ブロック内ローカル変数問題を回避）
- **shutdown 方針**: `dashboardHandle.stop()` を呼ばない（既存 proxy と整合、in-flight fetch 破壊回避、process.exit 任せ）
- **長クエリ対策**: endpoint ハンドラ層で `Promise.race([work, sleep(5000)])` → 503 + `windowSec`
- **CSP**: `script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'`
- **uPlot vendoring**: npm dep に追加せず `dashboard-web/vendor/` に直接配置（bundle 14KB gz、build step 不要）
- **SPA**: vanilla JS（フレームワーク不採用）、URL クエリ + hash で全状態を表現、permalink 可能
- **Bash 強調**: per-tool table で `bash-row` class + 上位ピン留め、horizontal bar / failure timeline で太線描画

## マージ情報

- マージ先ブランチ: `main`
- マージ方式: ローカル ff-only マージ（`Updating 1c1f1f5..43d83ed`、6 commits を main に直結）
- マージ後 HEAD: `43d83ed5c89b13776f74085836af6c3560853e4f`

## 手動確認 pending（後続）

`docs/spec/12-web-dashboard.md` §6.5 のチェックリストはブラウザ実機で別途実施:

- [ ] 5 ページ全て描画される
- [ ] preset chip [1h / 24h / 7d / 30d] で全グラフ連動
- [ ] custom datetime ピッカーで任意範囲指定
- [ ] permalink: URL を別タブで同じ表示
- [ ] task drill-down: Tasks 行クリック → Agent Strategy へジャンプ
- [ ] 30s auto refresh ON/OFF
- [ ] 過去 task で Agent Strategy drill-down が timeline 表示

実 daemon 再起動 → `cat .team/team.json | jq -r .dashboardServer.url` で URL 取得 → ブラウザで確認、を Master/ユーザーに依頼する想定。

## 残課題（後続タスク候補）

Inspector が「Out-of-scope improvements」として挙げた項目:

1. **TUI Metrics タブの縮小 + URL open UX (T-2)** — タスク本文「関連」で予告されている follow-up
2. **`*.test.tsx` の npm publish exclude** — 既存問題（main 時点）。`package.json` の `files` exclude pattern 修正
3. **uPlot security advisory 監視** — `vendor/UPLOT_VERSION` を依存更新タスクで diff 確認する自動化

これらは Master の判断で別タスクとして起票してください（本タスクのスコープ外）。
