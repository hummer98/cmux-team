## Verdict: Approved

## Summary

T354 の plan.md は 9 個の要件すべてを 15 個のサブタスク (S1〜S15) に分解しており、構造的解決（時系列を別テーブル `rate_limit_snapshots` に持ち、projection を trace-store の純粋関数で分離）と既存パターンとの整合性（`api_usage` 同 DB / `mapRiskToColor` / `buildUtilizationBar` 再利用）を両立できている。Decision Log で代替案の検討と却下理由が明示されており、CRITICAL チェック項目もすべてパス。実装フェーズで致命的に詰まる箇所はないと判断する。Minor な漏れが数点あるため Recommendations に整理した。

## Findings

1. **[minor] caption 部 (`metrics_caption_from`) の role 正規化がサブタスクに落ちていない**
   セクション 5-1 リスク欄および Decision Log D11 で「`master, x-cmux-surface: surface:300 (5s ago)` のような表示崩れを防ぐため、JS 側で軽く preprocess する」と明記されているが、対応する作業が S7〜S9 のいずれの完了条件にも入っていない。`aggregateApiUsageByRole` の SQL 正規化 (S4) は `roleRows` だけに効き、`getLatestApiUsageRow` で取った `latestRowRole` には効かない。実装フェーズで「集計テーブルの桁は揃ったが caption はガタガタ」が残る可能性がある。

2. **[minor] `getMetricsVisibleLines()` の pure 関数化が S11 の完了条件に明記されていない**
   テスト戦略 (5-3) では「`computeMetricsVisibleLines(stdoutRows, envOverride)` として分離してテスト」と書かれているが、S11 の完了条件は「`getMetricsVisibleLines()` を導入」しか書かれておらず、`process.stdout.rows` を引数化した純粋関数として export することは要求されていない。S11 の完了条件に「`computeMetricsVisibleLines(stdoutRows: number, envOverride: string | undefined): number` を export する」を加えると、5-3 の方針と整合する。

3. **[minor] Pool Tokens の並び順 (D9: util_5h DESC → handle ASC) のテストが S14 の完了条件に明記されていない**
   2-5 と Decision Log D9 で並び順は確定しているが、S14 のテスト追加項目には「Pool Tokens テスト追加」としか書かれておらず、ソート順アサーションを明示する記述がない。conductor-prompt.md 動作確認 #4 の桁揃え確認だけでは並び順までは検証されない。

4. **[minor] 動作確認チェックリスト #13 / #14 をカバーする S15 完了条件が薄い**
   conductor-prompt.md には 14 個の動作確認項目があるが、S15 の完了条件は「typecheck / bun test 個別 / Metrics タブで Projection・Pool Tokens 表示」の 3 点のみで、特に以下が明示されていない:
   - #13: `.team/config.json` に `metricsRefreshIntervalMs: 5000` を書いて Manager 再起動 → 更新間隔が 5s に変わる
   - #14: `sqlite3 .team/traces/traces.db "SELECT COUNT(*) FROM rate_limit_snapshots"` で行が増えていく
   - #11: 汚染 role が `master` に集約され surface 別で分散しない
   #13 / #14 / #11 は S15 の完了条件に追記したい。

5. **[minor] proxy 側の重複 INSERT 防止の確認が S2 の完了条件に書かれていない**
   `proxy.ts` の streaming 経路では `extractRateLimit` が `:656` と `:671` の 2 箇所で呼ばれている (`grep -n` 確認済み)。Plan 5-1 では「streaming 経路は upstream response 受信直後に 1 回だけ」と方針があるが、S2 の完了条件は「`:656`、非 streaming `:728` で 2 箇所以上」と書かれており、`:671` で再度呼ばれた際に再度 INSERT してしまうコードを書く余地がある。S2 の完了条件に「streaming 経路では 1 リクエストにつき 1 回のみ INSERT」を明記したい。

6. **[minor] 1-6 の focusedArea 復帰問題の根拠が現状コードと食い違っている可能性**
   Plan は「ESC 経由で `focusedArea: "global"` に戻った後、`M` / `6` で再来したケースで focus 復帰が ESC 経由のときに失われる経路が観察されている」と書いているが、現状コードを確認すると `M` (`dashboard.tsx:1789`) も `6` (`:1777`) も `switchTab("metrics")` 経由で `focusedArea: "metrics"` に確実に設定される。スクロールできない真因は (a) `METRICS_VISIBLE_LINES = 30` 固定、(b) `Down` キーの上限欠如、(c) スライス計算 のいずれかに集約される可能性が高く、Plan の S11 はこれらを修正できる構成になっているため実害はない。ただし「focusedArea 復帰の修正」を完了条件に入れている S11 は、現状コードでは既に動いているため実装が混乱する余地がある。

## Recommendations

各 finding に対する対処案:

### F1: caption 正規化を S7 または S9 のサブタスクに追加

S9 の完了条件に以下を追記:
> - `dashboard-metrics.ts` の caption 構築直前で `latestRowRole` に対して JS 側で正規化を適用する。共通ヘルパ `normalizeRole(raw: string | null): "master" | "conductor" | "agent" | "unknown"` を export し、SQL 側 (S4) と同じ正規化規則を JS でも実装する（DRY を守るため、SQL の CASE と JS のヘルパが一致していることをテストで担保）。

### F2: pure 関数 `computeMetricsVisibleLines` の export を S11 の完了条件に明記

S11 の完了条件に追記:
> - `computeMetricsVisibleLines(stdoutRows: number | undefined, envOverride: string | undefined): number` を export し、`getMetricsVisibleLines()` は `computeMetricsVisibleLines(process.stdout.rows, process.env.CMUX_TEAM_METRICS_VISIBLE_LINES)` を呼ぶだけにする。
> - `RESERVED_LINES` を const として export し、テストから参照可能にする。

### F3: Pool Tokens 並び順テストを S14 に明記

S14 の完了条件 `dashboard-metrics.test.tsx` に追記:
> - Pool Tokens テストに「util_5h: 78%, 32%, 100% の 3 件 + handle 違い」のフィクスチャを与え、表示順が `100% / 78% / 32%` (util_5h DESC) になることを assertion。同 util の場合は handle 昇順になることも別ケースで確認。

### F4: 動作確認 #11 / #13 / #14 を S15 に明記

S15 の完了条件に追記:
> - **role 集約確認**: 旧汚染 role (`master, x-cmux-surface: surface:123`) が含まれる `api_usage` データを使い、`master` 行に集約されることを TUI と SQL クエリの両方で確認 (#11)
> - **config 反映確認**: `.team/config.json` に `metricsRefreshIntervalMs: 5000` を書いて Manager を再起動し、ログ / Settings タブの値が 5000 になり、実際の poll 周期が 5s になっていることを確認 (#13)
> - **snapshot 蓄積確認**: `sqlite3 .team/traces/traces.db "SELECT COUNT(*) FROM rate_limit_snapshots"` で行数が単調増加することを 1 分以上の窓で確認 (#14)

### F5: proxy 重複 INSERT 防止を S2 の完了条件に明記

S2 の完了条件を以下に書き換え:
> - streaming 経路の `:656` で取得した `rl` を **そのまま使い回す** 形で `insertRateLimitSnapshot` を呼ぶ（`:671` の `extractRateLimit` 再呼び出し箇所では INSERT しない。コメントで「INSERT は :656 で 1 回のみ」を明記）
> - 非 streaming 経路 `:728` で 1 回 INSERT
> - 5h / 7d util がいずれも null のレスポンスは INSERT しない
> - `opts.db` が undefined のときは skip
> - **検証**: 新規テスト `proxy-rate-limit-snapshot.test.ts` で「streaming レスポンス 1 件 → INSERT 1 行」を assertion

### F6: 1-6 の問題分析を実装着手前に再検証

実装担当者向けの注記として S11 に追記:
> - 着手時に `dashboard.tsx:1772-1789` の `M` / `6` キーがいずれも `switchTab("metrics")` 経由で `focusedArea: "metrics"` を設定していることを確認する。設定されているなら focusedArea 復帰は既に効いており、スクロール不能の真因は (a) `METRICS_VISIBLE_LINES = 30` 固定 + (b) `Down` キーの上限欠如 + (c) スライス計算の不整合 に絞られる。M キー / 6 キー側の修正は不要と判断してよい。
