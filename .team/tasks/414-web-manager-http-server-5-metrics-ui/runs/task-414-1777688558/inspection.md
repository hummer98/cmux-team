# T414 Inspection — 内部 Web ダッシュボード

> Inspector: Inspector Agent (surface 585)
> 実行日: 2026-05-02
> 対象 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-414-1777688558`
> 対象 commit range: `main..HEAD`（5 commits, 21 files, +3775 / -2 行）

---

## 1. Verdict

**GO**

## 2. Summary

plan §1〜§12 の deliverable はすべて実装され、必須テスト 6 ファイル (dashboard-server / agent-strategy / trace-store-metrics / daemon / trace-store / metrics-aggregate) はいずれも緑。`bunx tsc --noEmit -p tsconfig.json` は新規エラー 0。既存 `proxy.ts` / `dashboard.tsx` / `dashboard-metrics.ts` / `metrics-aggregate.ts` / `bin/` は完全未変更で非破壊性が確認できた。Critical / Major 級の問題は無し（後述 Minor 2 件のみ）。

## 3. Test Results

すべて `cd skills/cmux-team/manager && bun test --timeout 30000 <file>` で実行。

| Test file | pass | fail | expect() | runtime |
|---|---|---|---|---|
| `dashboard-server.test.ts` | 23 | 0 | 75 | 250 ms |
| `agent-strategy.test.ts` | 14 | 0 | 30 | 74 ms |
| `trace-store-metrics.test.ts` | 32 | 0 | 76 | 199 ms |
| `daemon.test.ts` (regression) | 209 | 0 | 715 | 25.0 s |
| `trace-store.test.ts` (regression) | 38 | 0 | 234 | 242 ms |
| `metrics-aggregate.test.ts` (regression) | 18 | 0 | 53 | 80 ms |

Implementer 自己申告と完全一致。境界条件 (empty / from>to / parse 失敗 / taskId 不在 / 503 timeout / default 24h / 127.0.0.1 only / CSP 4 directive / hour vs day bucket) は dashboard-server.test.ts (line 36–353) と trace-store-metrics.test.ts でカバー済み。

## 4. tsc Results

`cd skills/cmux-team/manager && bunx tsc --noEmit -p tsconfig.json` → exit 0。**新規エラー 0 件。**

(初回ルートで `bunx tsc --noEmit` が tsconfig を見つけられず help を出力した。`-p tsconfig.json` 明示で解決。実装の問題ではない。)

## 5. plan 一致性

| 観点 | 判定 | 根拠 |
|---|---|---|
| §9 Step 1〜7 全 deliverable | ✓ | 5 commit (Step 4–6 統合は plan §9 が許容する判断裁量) |
| §4.2 ResponseShape 全 7 種 | ✓ | dashboard-server.ts:201–310 に TS interface で定義、test で shape 検証 |
| §5.1「dashboard-server は常に自前 initDB」 | ✓ | dashboard-server.ts:730 `db = opts.db ?? initDB(projectRoot)`、main.ts は db を渡さない |
| §5.1「shutdown では明示停止しない」 | ✓ | main.ts に dashboardHandle 保持なし、`stop()` 呼び出し無し |
| §6.4 Bash ピン留め | ✓ | app.js:435–462 `pinBash()` 関数、`bash-row` class、`stroke #f59f00 + width 3` |
| §10 Promise.race timeout | ✓ | dashboard-server.ts:188–195 `withTimeout` + 740–768 `runWithTimeout`、503 + `windowSec` 返却 |
| CSP 4 directive (script-src/style-src/connect-src/object-src) | ✓ | dashboard-server.ts:103–110、test:51 で 4 directive すべて確認 |

## 6. 既存コード非破壊性

| ファイル | diff | 判定 |
|---|---|---|
| `skills/cmux-team/manager/proxy.ts` | 0 行 | ✓ 完全未変更 |
| `skills/cmux-team/manager/dashboard.tsx` | 0 行 | ✓ Metrics 分岐含め未変更 |
| `skills/cmux-team/manager/dashboard-metrics.ts` | 0 行 | ✓ 未変更（dashboard-server から read-only で `computeRiskLevel` を import するのみ） |
| `skills/cmux-team/manager/metrics-aggregate.ts` | 0 行 | ✓ 未変更（dashboard-server から `aggregateMetricsByTask` / `readTaskLifecycle` を import するのみ） |
| `skills/cmux-team/manager/trace-store.ts` | +120 / -0 行 | ✓ 末尾追記のみ。`countToolCallsByPeriod` / `failureRateByTool` / `aggregateApiUsageByBucket` の **新規 export 追加のみ**で既存 export の signature は不変 |
| `bin/` 全体 | 0 行 | ✓ CLI 完全未変更（`metrics-cli.ts` 等含む） |
| `skills/cmux-team/manager/main.ts` | +19 / -0 行 | △ start hook の追記のみ。fail-soft で起動失敗しても daemon 続行する safe path |
| `skills/cmux-team/manager/daemon.ts` | +14 / -0 行 | △ `DaemonState.dashboardServerUrl` 追加 + `updateTeamJson` 内で `dashboardServer` フィールド書き出し追加。既存 `updateTeamJson` の他フィールド出力経路は変更なし |

既存 daemon.test.ts (209 tests) が緑なので team.json 互換性も確認済み。

## 7. 個別検品観点の結果

### 観点 3: テスト
- ✓ 4 必須テスト + regression 2 すべて緑（§3）
- ✓ assert は plan §8 と整合（境界条件全カバー）

### 観点 5: コード品質
- ✓ 旧コード参照コメント（"removed" / "used by" / "added for"）は無し
- △ Minor: dashboard-server.ts:894–900 の `_internal` export は impl-summary が自己申告のとおり外部利用なし。副作用はなく Critical/Major にはあたらない（plan §10 の race ヘルパーを後続 step で公開する意図は当初設計に存在し、設計痕跡として正当性はある）
- △ Minor: dashboard-server.ts:709 で `await import("./metrics-aggregate")` の dynamic import は冗長（line 32 で既に静的 import 済み）。`readTaskLifecycle` を line 32 の静的 import に追加すれば動的 import は不要
- ✓ 後方互換性 shim / fallback の混入なし
- ✓ inline emoji / アスキーアート無し

### 観点 6: プロンプト編集ルール
- ✓ `.team/prompts/*.md` への直接編集なし、テンプレート (`skills/cmux-team/templates/*.md`) も触っていない（dashboard 機能はテンプレート系と独立）

### 観点 7: docs/spec / CLAUDE.md / glossary 整合
- ✓ `docs/spec/12-web-dashboard.md` 新設、章構成は plan §11.1 に沿う（plan の 9 章 + §5「SSOT 原則」を 1 章追加した自然な拡張）
- ✓ `docs/spec/00-project-overview.md` の観察箱表に「Web ダッシュボード」追記、章索引にも 1 行追加
- ✓ `docs/spec/glossary.md` §11 Metrics に「Web ダッシュボード」「Agent 戦略分類（暫定 6 値）」エントリ追加
- ✓ `docs/spec/05-install-and-infrastructure.md` `team.json` 主要フィールド節に `dashboardServer` 説明追加
- ✓ `CLAUDE.md` の「進捗情報の取得方法」表に 1 行追記（plan §11.2 と完全一致）

### 観点 8: npm publish
- ✓ `package.json` files 配列に `skills/cmux-team/manager/dashboard-web/**` 追加（既存 `*.test.ts` exclude pattern と非衝突、`*.test.ts` の publish=0）
- ✓ `npm pack --dry-run` で dashboard-web 配下 7 ファイル（app.js / index.html / style.css / vendor/uplot.min.js / vendor/uplot.min.css / vendor/UPLOT_VERSION / dashboard-web-bundle.ts）すべて含有を確認
- ✓ vendor uPlot 冒頭に MIT ライセンスヘッダ `/*! https://github.com/leeoniya/uPlot (v1.6.31) */` 残存、`UPLOT_VERSION` ファイルに `1.6.31` 記載

### 観点 9: 観察箱原則
- ✓ trace DB は `initDB(projectRoot)` で開くが、書き込み API (`record*`) は使っていない。SQL は SELECT のみ。read-only 利用
- ✓ daemon main loop / EventBus を阻害する箇所なし。dashboard-server は別 `Bun.serve` インスタンスで起動し、fail-soft（起動失敗時も daemon 続行）
- ✓ 絶対 path / hostname のハードコードは `127.0.0.1` のみ（plan §3 で意図された値）

### 観点 10: 軽微な NOGO ライン
- ✓ セキュリティ: `Bun.serve({ hostname: "127.0.0.1" })` 明示、`0.0.0.0` listen 無し、CSP 4+3 directive 付与、sensitive log 出力なし
- ✓ データ破壊: 既存 `team.json` フィールドは未変更（`dashboardServer` は **追加のみ**、起動失敗時は `delete teamJson.dashboardServer` で stale 値を残さない）。`task-state.json` は touched せず
- ✓ 既存テスト破壊: regression 2 ファイル (daemon.test.ts 209/209、trace-store.test.ts 38/38、metrics-aggregate.test.ts 18/18) すべて緑
- ✓ npm publish 経路破壊: files 配列 typo 無し、既存ファイル除外なし

## 8. Findings

### Critical

なし。

### Major

なし。

### Minor

1. **dashboard-server.ts:894–900 の `_internal` export が外部未利用 dead code**
   - impl-summary が自己申告通り Step 4-6 でも未使用
   - 副作用は無いが、CLAUDE.md「Don't add features beyond what the task requires」に厳密には反する
   - Critical/Major には該当しない（後続タスクで pin/refactor 時に削除 or 利用可）

2. **dashboard-server.ts:709 の dynamic `import("./metrics-aggregate")` が冗長**
   - 同ファイル line 32 で静的 import 済み。`readTaskLifecycle` を静的 import に追加すれば dynamic import は削除可能
   - 機能・パフォーマンスへの影響は無視できる範囲（cache 後は実質無コスト）

3. **`*.test.tsx` (6 ファイル, 計 ~67 KB) が npm pack に同梱される**（既存挙動）
   - `package.json` files の exclude pattern が `*.test.ts` のみで `*.test.tsx` を除外していない（main 時点からの問題）
   - 本タスクの責務外（インスペクタも検品観点 §8 で要求していない）。後続タスク候補

## 9. Out-of-scope improvements (後続タスク候補)

- **手動検証チェックリスト 7 項目**（impl-summary §「手動確認 pending」）— ブラウザ実機で daemon を再起動 → URL 取得 → SPA 動作確認。Implementer ではなく Master/ユーザー側のタスクとして残置
- **`_internal` export の整理 / dynamic import の解消** — 上記 Minor 1, 2 のクリーンアップ
- **`*.test.tsx` の npm publish exclude** — Minor 3（既存問題）の修正タスク
- **TUI 連携 (T-2)** — TUI Metrics タブから「Open dashboard」コマンドで URL を browser に開く UX。plan §1 非スコープと明示
- **uPlot security advisory 監視** — `vendor/UPLOT_VERSION` を依存更新タスクで diff 確認する自動化

## 10. Fix Required (NOGO の場合)

該当なし（GO 判定）。

---

## 付録: 実行コマンドログ

```
$ git log --oneline main..HEAD
9a679dd docs(spec): docs/spec/12-web-dashboard.md + cross-references (T414)
ed046fe feat(dashboard): single-HTML SPA + 5 pages + uPlot vendor (T414)
2318152 feat(dashboard): agent-strategy classification + drill-down endpoint (T414)
a7dd137 feat(dashboard): aggregation API endpoints — overview/tool-use/tokens/tasks (T414)
1f46b18 feat(dashboard): HTTP server skeleton + /api/health endpoint (T414)

$ git diff --stat main..HEAD
 21 files changed, 3775 insertions(+), 2 deletions(-)

$ git diff main..HEAD -- skills/cmux-team/manager/proxy.ts          → 0 行
$ git diff main..HEAD -- skills/cmux-team/manager/dashboard.tsx     → 0 行
$ git diff main..HEAD -- skills/cmux-team/manager/dashboard-metrics.ts → 0 行
$ git diff main..HEAD -- skills/cmux-team/manager/metrics-aggregate.ts → 0 行
$ git diff main..HEAD -- bin/                                        → 0 行

$ bun test --timeout 30000 dashboard-server.test.ts     → 23 pass / 0 fail (250 ms)
$ bun test --timeout 30000 agent-strategy.test.ts       → 14 pass / 0 fail (74 ms)
$ bun test --timeout 30000 trace-store-metrics.test.ts  → 32 pass / 0 fail (199 ms)
$ bun test --timeout 30000 daemon.test.ts               → 209 pass / 0 fail (25 s)
$ bun test --timeout 30000 trace-store.test.ts          → 38 pass / 0 fail (242 ms)
$ bun test --timeout 30000 metrics-aggregate.test.ts    → 18 pass / 0 fail (80 ms)

$ bunx tsc --noEmit -p tsconfig.json                    → exit 0, errors 0

$ npm pack --dry-run | grep dashboard-web → 7 files included
$ npm pack --dry-run | grep '\.test\.ts$' → 0 files (`*.test.ts` exclude OK)
```
