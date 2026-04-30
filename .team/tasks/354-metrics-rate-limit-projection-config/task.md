---
id: 354
title: Metrics タブを Rate Limit Projection に作り直し + 更新間隔を config 化
priority: high
created_by: surface:123
created_at: 2026-04-26T21:40:35.591Z
---

## 背景

Metrics タブの `── Rate Limit ──` セクション（`dashboard-metrics.ts:211-311`）は分単位 TPM/RPM ヘッダー (`anthropic-ratelimit-tokens-*` / `requests-*`) のみを参照しているが、Claude Code の OAuth トークン経由ではこれらヘッダーが返らないため **常に no_data でグレー表示** になり、実用上機能していない。

burn rate も「直近 60 秒の input+output 平均」という瞬間値で、リミッター（5h / 7d ウィンドウ）のリセット時刻からの累積消費を反映しないため、ユーザー価値が薄い。

ヘッダー右端には既に `unified-5h-utilization` / `unified-7d-utilization` を使った表示が動いているので、Metrics タブには **「現在の消費ペースだとリセット前にリミットを使い切るか？」** という独自の予測情報を出したい。さらに token pool 有効時は **そのプロジェクトから selectable な各キーの残量とリセット時刻** も並べて見たい。

加えて Metrics タブはスクロールが事実上機能していない（コードはあるが画面に出ない）ので、Pool Tokens 追加で行数が伸びることもあり、スクロール挙動も合わせて修正する。

最後に、ロール別集計の表示が崩れている。`api_usage.role` 列に `master, x-cmux-surface: surface:123` のような長い文字列が保存されているため `padEnd(10)` を溢れて列がずれている（`main.ts:1997 / :2154` の `ANTHROPIC_CUSTOM_HEADERS` 指定が `x-cmux-role` の値に surface 情報まで連結する形になっており、proxy がそのまま 1 文字列として保存している）。表示側で正規化 + 並び順 + 桁揃えを入れる。

## やってほしいこと（要件）

### 1. Rate Limit Projection セクションへの差し替え

既存の `── Rate Limit ──` セクション（tokens / requests / burn rate / projected / RISK の各行）を **丸ごと削除** し、以下の Projection 表示に差し替える:

```
── Rate Limit Projection ──
5h:  util 32%  reset 3h45m
     long-term : exhaust in 9h    ✓
     recent 15m: exhaust in 1h20m ⚠ before reset
7d:  util 12%  reset 5d8h
     long-term : ∞                ✓
     recent 15m: exhaust in 8h30m ⚠ before reset
```

- **long-term（過去ベース）**: `utilization / ウィンドウ開始からの経過時間` で 1 秒あたりの利用率増加を計算 → 残キャパ ÷ レートで枯渇までの秒数
- **recent 15m（近過去ベース）**: 直近 15 分の utilization 増分から同様に計算
- 色分けは既存の `computeRiskLevel` を流用 (red / yellow / green / gray)
- 5h / 7d それぞれで表示
- utilization が取得できていない（proxy 未稼働 / 接続前 / OAuth 未対応など）の場合は no_data 表示

### 2. utilization 時系列の保存

短期ペース計算には utilization のスナップショット時系列が必要。現状 `rate-limit-persistence.ts` は最新 1 件しか持たない。

trace DB (`.team/traces/traces.db`) に新テーブルを追加:

```sql
CREATE TABLE rate_limit_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  unified_5h_utilization REAL,
  unified_5h_reset TEXT,
  unified_7d_utilization REAL,
  unified_7d_reset TEXT
);
CREATE INDEX idx_rate_limit_snapshots_ts ON rate_limit_snapshots(timestamp);
```

- proxy のレスポンス処理 (`proxy.ts` の `extractRateLimit` 周辺) で 1 行 INSERT する
- 既存の `RateLimitInfo` 抽出と整合させる（重複処理にしない）
- 既存スナップショット (`.team/rate-limit.json`) は **存続させる**（ヘッダー表示が依存しているため触らない）
- GC は今回スコープ外（既知の注意点に追記するだけで OK）

### 3. 集計関数

`trace-store.ts` に projection 用の純粋関数を追加（テスト容易性のため Database 引数）:

- `getProjection5h(db, now)`: 上記 long-term + recent 15m を計算して返す
- `getProjection7d(db, now)`: 同上 7d 版
- 戻り値の型は `MetricsData` から参照しやすい形（`utilization`, `resetIso`, `longTermProjectedSec`, `recentProjectedSec` など）

### 4. Metrics タブの更新間隔を 10 秒固定 + config 化

- 現状 `METRICS_POLL_INTERVAL_MS = 1000` (`dashboard.tsx:1863`) を **10000 (10s)** に変更
- config 経由で変更可能にする:
  - `.team/config.json` に新フィールド `metricsRefreshIntervalMs?: number`
  - 未設定時のデフォルト = 10000
  - `config.ts` に getter (`resolveMetricsRefreshIntervalMs(config)` 等) を追加
  - `dashboard.tsx` の `startMetricsTimer` がこの値を読む（毎回のタブ切り替え時に再読み込みでよい）
- Settings タブ (`loadSettingsItems` / `buildSettingsRows`) に現在値を 1 行表示する read-only エントリを追加（編集 UI は今回スコープ外）

### 5. Token pool 有効時: selectable キー毎の rate limit 表示

`isTokenPoolEnabled(projectRoot)` が true の場合のみ、Projection セクションの下に追加表示する:

```
── Pool Tokens (selectable: N) ──
@kddi    5h: 32% ██████░░░░ 3h45m   7d: 12% ██░░░░░░░░ 5d8h
@y       5h: 78% █████████░ 1h12m   7d:  8% █░░░░░░░░░ 4d20h
@auto1   5h:100% ██████████ 0m      7d: 95% █████████▓ 6d2h  ⚠
```

- **フォーマットは非プールキーモード時の TUI ヘッダー右端と同じ**（`rate-limit-display.ts` の `buildUtilizationBar` を export 化して流用するのが筋）
- 各 selectable キー 1 行、5h と 7d を並べる
- **桁揃え必須**: handle / 残り時間も列ごとに `padEnd` / `padStart` して見出し列が揃うこと
- 表示対象:
  - `tokens.db` の `selectable = 1`
  - かつそのプロジェクトの `resolveProjectTokenPool(...)` で除外されない（include/exclude/tags 適用後）
- データソース: `getLatestUsageSnapshot(db, token_id)` の最新 snapshot
- snapshot が無いキーは `no data` 表示
- token pool 無効時はこのセクション自体を表示しない（条件分岐で section ごと省略）
- 並び順は既存 pool-surface-row やトークン CLI の表示順に倣う（util_5h 高い順 等）。揃わない場合は handle 昇順でも可

### 6. ヘッダー側の % パディング修正

`rate-limit-display.ts` の `buildUtilizationBar` (`:104` 付近) のフォーマット:

```ts
// Before
{ text: `${label}: ${pct}% ${bar}`, color, group: true }

// After
{ text: `${label}:${pct.toString().padStart(3)}% ${bar}`, color, group: true }
```

期待出力:

```
5h:  1% ██░░░░░░░░ ...
5h: 14% ████░░░░░░ ...
5h:100% ██████████ ...
```

- ":" の直後で `%` 数字を **3 桁右寄せ**（100% はスペース 0 個、それ未満はスペースで詰める）
- 100% は滅多にないがそこに合わせて 3 桁固定
- bar / 残り時間 / `(stale)` などは既存通り（パディング追加しない）
- 既存テスト（`rate-limit-display.test.ts`）の期待文字列を新フォーマットに合わせて更新する必要あり

この変更はヘッダー / Pool Tokens 両方で共通の `buildUtilizationBar` を使うことで自動的に効く。

### 7. Metrics タブのスクロール修正

現状 `dashboard.tsx` には Up/Down/g/G の `metricsScrollOffset` 操作 (`:1587, :1622, :1743, :1758`) と `METRICS_VISIBLE_LINES = 30` 固定 (`:57`) でのスライス (`:1419-1424`) が実装されているが、**実際にはスクロールできない**（ユーザー観測）。

調査と修正の要点:

- **画面高さの動的取得**: `METRICS_VISIBLE_LINES = 30` の固定値が原因の可能性。ターミナルの縦幅が 30 行未満だと表示が切れる + scrollOffset が画面下まで届かない。可能なら ink / rezi の動的サイズ API で実画面高さに追従するか、せめて値を妥当な小さい既定（例: 20）+ 環境変数で上書き可能にする
- **focusedArea が "global" のままだと Up/Down が no-op** (`:1590` の default 経路)。タブ切り替え直後は `switchTab` で `focusedArea: "metrics"` になるが、ESC を踏んだ後など global 状態のときに M キー / 6 キーで戻ってきたケースでは `focusedArea` も復帰させる
- Pool Tokens を追加すると行数がさらに伸びる前提で、長尺表示でも先頭〜末尾までスクロール可能にすること
- `g` で先頭、`G` で末尾、Up/Down で 1 行ずつ — journal / log と同じ操作感に揃える
- footer のキーヒントは既に `↑/↓ scroll  g/G top/bottom` と出ているのでそのままでよい

### 8. ロール別集計の表示調整

現状の問題（`dashboard-metrics.ts:313-342`）:

- `api_usage.role` 列が `master, x-cmux-surface: surface:123` のように **汚染された文字列で保存されている**（ANTHROPIC_CUSTOM_HEADERS の指定形式が原因。proxy 入力の改修は本タスクのスコープ外）
- そのため `r.role.padEnd(10)` で溢れて列が押し出されガタガタに見える

修正内容:

#### 8-1. role の正規化

集計レイヤーで role を **`master` / `conductor` / `agent` / `unknown` の 4 値に正規化** する:

- `aggregateApiUsageByRole` の SQL（`trace-store.ts:785-806`）で `CASE` を使って `role LIKE 'master%'` → `'master'` 等に正規化、`COALESCE(role, 'unknown')` も維持
- 同じ正規化済み role で GROUP BY → SUM が合算される（surface 別で分かれない）
- もしくは集計後に dashboard-metrics.ts 側で reduce する。SQL 側の方が筋がよいので推奨

#### 8-2. 並び順

固定順:

```
1. master
2. conductor
3. agent
4. その他 (unknown など)
```

ORDER BY を独自の CASE で組むか、JS 側で並び替える。同 role 内では現状の (input + output) DESC を維持。

#### 8-3. 桁揃え

- role 列: 10 文字 padEnd（正規化後は最長 9 文字 = "conductor" なので 10 文字に収まる）
- requests 列: 見出し `metrics_header_requests` と値の幅を **完全一致** させる。現状は見出し `padStart(6)` / 値 `padStart(6)` だが、`r.requests.toLocaleString("en-US")` がカンマ込み 7 文字超になる場合あり → **見出し・値とも `padStart(8)` 等に拡張** （実データの最大桁を見て決める）
- input / output / cache 列: 同様に見出しと値で同じ幅。カンマ込みで 9-10 文字になる想定なら `padStart(12)` などに広げる
- ガタガタの根本は (a) role 文字列の汚染と (b) カンマ入り数値の桁が見出しを超えている のいずれか or 両方。両方とも対応すること
- 列間の `gap: 2` は維持

#### 8-4. タスク別集計（下段）も同じ桁揃えを適用

`dashboard-metrics.ts:344-375` の task 別セクションも同じ桁揃えロジックを適用する（task_id 列はパディング不要だが、数値列は role 別と同じ幅に揃える）。

### 9. テスト更新

- `dashboard-metrics.test.tsx`: 旧 Rate Limit セクションのアサーションを Projection に書き換え、Pool Tokens セクションのテストケース追加（pool enabled / disabled の両系統、桁揃えのアサーションを含む）
- ロール別集計のテスト追加: 並び順 (master → conductor → agent → unknown)、正規化（汚染 role が master に集約される）、桁揃え（カンマ入り数値で列がズレない）
- `trace-store.ts` の新関数に対するユニットテストを `trace-store-metrics.test.ts` または新ファイルで追加
- proxy が `rate_limit_snapshots` に INSERT することの確認テスト
- `rate-limit-display.test.ts`: 新フォーマット (`5h:  1%` / `5h:100%`) への期待値更新
- スクロール修正のテスト: 長尺の `MetricsData` を構築し、scrollOffset と画面サイズの組み合わせで先頭〜末尾までカバーされること

## やってほしくないこと

- `.team/rate-limit.json` / `persistRateLimit` / `loadRateLimit` のスキーマ変更はしない
- Settings タブの編集 UI は作らない（read-only サマリで OK）
- Pool Tokens セクションでキーの操作（selectable トグル等）は付けない（read-only 表示のみ）
- 旧 `tokensRemaining` / `tokensLimit` / `requestsRemaining` 系列のフィールドを `MetricsData` から削除して回るかは判断に任せる（互換は不要、消してよい）
- `(stale)` サフィックスやアイコン位置の挙動には触らない（要件 6 の % パディングのみ）
- journal / log タブのスクロール仕様は変えない（Metrics に揃える方向で揃えるなら共通化は OK）
- **`main.ts:1997 / :2154` の `ANTHROPIC_CUSTOM_HEADERS` 指定形式の改修は本タスクのスコープ外**（root cause 修正は別タスク。本タスクは集計側の正規化で対処する）
- 既に保存されている汚染データ（`master, x-cmux-surface: ...`）の物理 migration はしない（正規化で読めれば十分）

## 動作確認

1. `cmux-team start` で Manager を起動し Metrics タブを開く
2. `── Rate Limit Projection ──` セクションが 5h / 7d それぞれ表示されること
3. 数十秒〜数分待ち、`recent 15m` が動的に変化することを確認
4. token pool 有効プロジェクト（このリポジトリは `tokenPool.enabled=true`）で `── Pool Tokens (selectable: N) ──` が表示され、ヘッダーと同じバー形式で各キーの 5h/7d が並び、% の桁数が違っても列が揃って見えること
5. token pool 無効プロジェクトでは Pool Tokens セクションが出ないこと
6. ヘッダー右端の `5h:  1%` / `5h: 14%` / `5h:100%` が % 桁数によらず同じ幅で表示されること
7. **Metrics タブで Up/Down キーで 1 行ずつ、g/G で先頭/末尾までスクロールできること**（特に Pool Tokens 追加後の長尺表示で末尾まで到達できる）
8. **ターミナル高さを縮めて起動した場合でも、画面下が切れずスクロールで全行確認できること**
9. **ロール別集計が `master` → `conductor` → `agent` → その他 の固定順で並ぶこと**
10. **ロール別集計で各列の見出しと数値の桁が完全に揃って見えること**（カンマ入り 7 桁数字でもズレない）
11. **汚染 role (`master, x-cmux-surface: ...`) が `master` に集約され、surface 別で分散しないこと**
12. Settings タブで `metricsRefreshIntervalMs` の現在値が表示されること
13. `.team/config.json` に `\"metricsRefreshIntervalMs\": 5000` を書いて Manager を再起動 → 更新間隔が 5 秒に変わること
14. `sqlite3 .team/traces/traces.db \"SELECT COUNT(*) FROM rate_limit_snapshots\"` で行が増え続けていること

## 関連

- 削除される旧コード: `dashboard-metrics.ts:211-311` (Rate Limit セクション), 関連テスト
- 既存ヘッダー表示: `rate-limit-display.ts`（`buildUtilizationBar` を再利用 + % パディング修正）
- proxy ヘッダー抽出: `proxy.ts:258-291` (`extractRateLimit`)
- token store: `token-store.ts` の `Token` / `UsageSnapshot` / `getLatestUsageSnapshot` / `listTokens`
- token pool config 解決: `config.ts` の `resolveProjectTokenPool` / `isTokenPoolEnabled`
- スクロール関連: `dashboard.tsx:57`(VISIBLE_LINES), `:1419-1424`(slice), `:1587/:1622/:1743/:1758`(キー処理)
- ロール別集計: `dashboard-metrics.ts:313-342` (UI), `trace-store.ts:785-806` (`aggregateApiUsageByRole` SQL)
- 汚染 role の発生源（参考、本タスクでは触らない）: `main.ts:1997 / :2154` の `ANTHROPIC_CUSTOM_HEADERS`
- 過去の Metrics 系タスク: `.team/tasks/307-dashboard-metrics/`, `.team/tasks/309-metrics-5h-7d/`, `.team/tasks/310-metrics/`, `.team/tasks/323-tui-pool-capacity-cmux-team-pool-status/` を ready 化前に一読推奨
