---
id: 351
title: ライブ TUI dashboard に pool capacity ヘッダー + per-surface handle/util 表示を実装
priority: medium
created_by: surface:123
created_at: 2026-04-26T21:16:28.016Z
---

## タスク
# 背景

T323 で `cmux-team status` CLI 出力には `pool capacity: NN%` ヘッダーと per-surface の handle/util_5h/util_7d 表示が実装されたが、Manager 常駐の **ライブ TUI dashboard (`dashboard.tsx`)** には **pool 関連の表示が一切組み込まれていない**（grep 確認済み: `dashboard.tsx` 内に `pool` / `capacity` / `tokenHandle` / `util_5h` への参照ゼロ）。

ユーザーは Manager ペイン（dashboard）を常時見ているため、pool 残量・各 surface に bind されている handle が見えないと「TUI 上で何も変化がない」と感じる。T323 のタスクタイトルは「TUI: pool capacity 指標表示」だったが、実装上は CLI の方だけが対応された状態。

# 確認済み事実

- `~/.cmux-team/tokens.db` にデータは入っている（@kddi / @tayo / @kami の usage_snapshots あり）
- `.team/config.json` で `tokenPool.enabled=true` のプロジェクトでも dashboard 表示は変わらない
- pool capacity 計算ロジックは `pool-status-header.ts` の `buildPoolHeaderLines` と `pool-next-reset.ts` の `computeNextReset`、token 取得は `token-store.ts` の `listTokens` / `getLatestUsageSnapshot` / `computePoolCapacity`
- per-surface handle 解決は `main.ts:1409-1540` 周辺の `lookupPool` 関数が参考になる
- `daemon.ts:1509` で `AGENT_TOKEN_BOUND` を受信して `agent.tokenHandle` を更新している
- `daemon.ts:3616-3654` で snapshot に `tokenHandle` が含まれている（dashboard 側がまだ読んでいない可能性）

# やること

`dashboard.tsx` に以下を追加する。実装方針は調査して判断してよい。

## 1. ヘッダー表示

pool 有効時のみ、`Conductors` セクションの上 or `Tasks` の下に pool capacity 行を出す。CLI の出力例:

```
─ token pool ─────────────────────────────────────
 pool capacity: 173%
 next reset: @kddi 5h in 30m (+20 pts)
─────────────────────────────────────────────────
```

レイアウト・色分けは既存の Conductors / Tasks セクションと統一感を持たせる。色分け閾値は `docs/spec/09-token-pool.md` を参照（100%+ 通常 / 40〜100% 手加減 / <40% 待機推奨）。

## 2. per-surface 表示

Master / Conductor / Agent の行に handle と utilization を併記する（CLI と同じ情報）。狭幅でも壊れないように省略形を考える（例: `@kddi 5h:2% 7d:33%` など）。

## 3. データ取得

dashboard は Ink コンポーネントで描画される。pool データは:
- `team.json` の snapshot から `tokenHandle` を読む（既に daemon が書いている）
- `tokens.db` を dashboard プロセスが直接 open するか、daemon 経由で snapshot に capacity 情報も載せるかは設計判断

**設計判断ポイント:** dashboard は Manager daemon の子プロセスなので、daemon → dashboard へ pool 情報を流す経路（既存の team.json snapshot か別チャネル）を選ぶ。tokens.db の頻繁な open は避けたい。

## 4. ロジックの再利用

CLI 側 (`main.ts:1409-1540`) と同じ計算ロジックを共有モジュールに切り出して、CLI と dashboard 双方が呼べるようにする。重複実装は避けること。

# 完了条件

- `.team/config.json` で `tokenPool.enabled=true` のプロジェクトで Manager dashboard を起動すると pool capacity ヘッダーが表示される
- pool 無効プロジェクトでは何も表示されない（既存レイアウトを壊さない）
- 各 Conductor / Agent 行に handle が表示される（bind されていない場合は空欄でよい）
- 既存の dashboard test (`dashboard-conductor.test.tsx` / `dashboard-issues.test.tsx` / `dashboard-metrics.test.tsx`) が pass
- 新規追加分のテスト（pool 有効時のレンダリング・無効時の非表示・per-surface handle 表示）が pass
- `bunx tsc --noEmit` 0 errors
- 個別 file 単位での `bun test` が pass（CLAUDE.md の `bun test` 全体実行禁忌に従う）

# 関連

- T323 (TUI pool capacity — CLI のみ実装で TUI 未対応だった元タスク)
- `docs/spec/09-token-pool.md` (pool 仕様)
- `.team/artifacts/A019-token-pool-design.md` (設計方針)
