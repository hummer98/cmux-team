# T307 Design Review — Dashboard に Metrics タブ追加

## Verdict: Approved

## Summary

plan.md は課題分析・代替案却下理由・サブタスク分割・Decision Log まで十分に厚く、CRITICAL チェック項目（サブタスクカバレッジ・統合検証・既存テスト互換・キーバインド重複回避・タブバー rendering）は全てパスしている。SQL 集計の $param バインディング、NULL 値の扱い、taskId=NULL 行の除外、stale-while-error 方針、interval の start/stop ライフサイクルといった構造的正しさに関わる論点もいずれも明示的に決着済み。Critical findings は 0 件なので Approved とし、DB 接続戦略と burn rate 0 除算など major/minor の改善提案を Recommendations に列挙する（実装フェーズで反映を推奨）。

## Findings

### 1. [major] dashboard から traces.db を独立 open する前提が誤り

plan §2 Decision D9 は「DB 接続の寿命 = 1 回の `loadMetricsData` 内で open → close」「daemon 側の DB writer と競合しない」と書いているが、**dashboard は daemon と同一プロセス内で動いている**（`main.ts:706` の `startDashboard(() => state, ...)` が示す通り `state` を直接参照する、`config: { executionMode: "inline" }` 構成）。一方 daemon は `state.traceDb = initDB(root)` （`daemon.ts:636`）で既に writer 接続を抱えている。

`loadIssuesFromCache` は **別 DB（gh_cache.db）** を open しているだけで、traces.db 向けの先例にはならない。毎秒 open/close を繰り返すと SYSCALL（ファイル open、WAL shm 再マッピング）の無駄が連続発生する。

**影響**: 動作はする（WAL + multi-reader）が、plan の根拠（「別プロセス想定」）が事実と食い違っており、実装者が「なぜ open/close なのか」の意図を誤解しやすい。`daemonState.traceDb` を共有 read-handle として reuse する方が既存パターンと整合的（`insertHookSignal(state.traceDb, ...)` / `updateNotificationEnrichment(state.traceDb, ...)` と同じ層）。

### 2. [minor] burn rate 0 除算時の戻り値型が `computeProjectedToLimit` で不明確

plan §2「Burn rate 計算」では `burn=0 は Infinity → "idle"` と文字列 fallback、plan §4 subtask (3) では `computeProjectedToLimit(remaining: number | null, burnTokPerSec: number): number | null` と型宣言されている。`burnTokPerSec === 0` のとき `null` を返すのか、`Infinity` を返すのか、`remaining` が null のとき挙動はどうかが暗黙的。Subtask (4) の test でも `RISK 判定` までしかカバーしておらず、0 除算単体ケースが列挙されていない。

**影響**: `computeRiskLevel(null, ...)` → `"gray"` の扱いと、`burn=0` → `Infinity`/`null` の扱いが実装者の裁量になる。挙動が plan §2 の「color 判定表」と一致するかの保証が弱い。

### 3. [minor] i18n のタブラベル一貫性が片側だけ

plan subtask (10) は `metrics_tab_title` を i18n 化する方針だが、既存のタブボタン（`dashboard.tsx:1308-1344`）は Journal/Artifacts/Log/Settings が **ハードコード英語**、Issues だけ `t("gh_tui_tab_title")`。Metrics を i18n 化しても依然としてハイブリッドのまま残る。

**影響**: 機能面の regression は無い。ただし「どのラベルを i18n 化するか」の方針が暫定のままなので、将来 CLAUDE.md の i18n ポリシーが固まったときに再修正が走る可能性。

### 4. [minor] subtask (8) の検証コマンド `grep -n '"metrics"' ... | wc -l` の期待値が弱い

「少なくとも 4 箇所」とあるが、AppState 型定義・FOCUSED_AREA_FOR_TAB・switchTab・tab rotation 配列・rendering 分岐・focusedArea 分岐・タブボタン id・キーバインド case を合わせると実際は 8 箇所以上になる。期待値を具体化（例: `>= 7`）しないと、マッチ漏れに気付きにくい。

### 5. [minor] Rate limit 表示の「最新 1 行」ポリシーに role 偏り懸念

plan §2「Rate limit 状況の取得方針」は `api_usage` の `id DESC LIMIT 1` を分単位 remaining の情報源とする。Anthropic 側はアカウント単位 window なので概ね妥当だが、**直近 1 行の role が agent / conductor / master どれかによって `ratelimit_*_remaining` の値が微妙に古くなる**ケースがあり得る（リクエストごとに返る remaining はそのリクエスト処理後の残量）。

**影響**: 運用上は問題にならない。ただし「Metrics タブは全体最新」と謳いつつ latest row は特定 role のスナップショットなので、タブに「取得元 role / surface」も小さく表示しておくとデバッグ性が上がる。

### 6. [minor] stale な api_usage レコードによる burn rate の過小評価

`getBurnRateWindow(db, 60)` は `WHERE timestamp >= datetime('now', '-60 seconds')` で集計する。proxy が停止していた空白 60s の直後にタブを開くと 0 tok/s 表示になるが、これが「本当に idle」なのか「proxy 死」なのかが区別できない。

**影響**: 判定精度は低下するが、proxy 死は dashboard 全体で observable なので代替手段はある。`projected_to_limit` が `Infinity`/`idle` 扱いになるエッジケースとして test でカバーしておく価値はある。

## Recommendations

1. **DB 接続戦略を既存コネクション reuse に倒す** — subtask (6) の `loadMetricsData` シグネチャを `loadMetricsData(db: Database)` に変更し、`startDashboard` 側で `daemonState.traceDb` を close せずにそのまま渡す。D9 の判断理由を「同一プロセス内で既存コネクションを reuse、WAL モードで multi-reader OK」に書き換える。`loadIssuesFromCache` との類推は別 DB（gh_cache）向けであって traces.db の先例ではない旨を Decision Log に明記する。
2. **`computeProjectedToLimit` の 0 除算・null 入力ケースをテストで明示** — subtask (4) のテスト数を +2 以上増やし、`burnTokPerSec === 0` / `remaining === null` / `resetRemainingSec === null` の各条件で戻り値が `null` または既定ラベル（`"idle"` / `"no data"`）に fall-through することを assert する。Risk level と projected の組み合わせ表をそのままテストケース化する。
3. **i18n 方針はフォローアップ issue に切り出す** — 今回は Metrics だけ i18n 化する方針で OK だが、「既存タブも i18n 化するか」は別タスク（T307 後続の dockeeper タスクでも可）として GitHub issue を起票するか、Decision Log に "D11: Metrics only for now, other tabs deferred" を追加する。
4. **subtask (8) の grep 期待値を `wc -l` の数値で固定する** — `grep -nE '"metrics"|metricsData|metricsError' ... | wc -l` が **8 以上**、`grep -nE 'switchTab\("metrics"\)' | wc -l` が **少なくとも 3**（"6" / M / Tab rotation 経由）を期待値として記載する。
5. **Rate limit 表示に「取得元」small caption を併記** — plan §2 の Rate limit セクションの最上段に `"from: <role>/<surface> (<age>s ago)"` のような小さなメタ情報を追加する。1 行追加で済み、future デバッグでの混乱を防ぐ。
6. **proxy 死 / 未稼働の明示表示** — `getLatestApiUsageRow` の timestamp が `now - 60s` より古ければ「proxy idle? last seen N s ago」表示にフォールバックする（burn rate 0 と区別）。plan §2「両方 null のケース」とは別に「古すぎるケース」が存在することを D10 の stale-while-error 方針に追記する。

---

**Reviewer**: Design Reviewer Agent (T307 run `task-307-1776976904`)
**Reviewed plan**: `/Users/yamamoto/git/cmux-team/.team/tasks/307-dashboard-metrics/runs/task-307-1776976904/plan.md`
