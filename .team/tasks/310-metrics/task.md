---
id: 310
title: Metrics タブにスクロール機構を追加（下段が見えない問題）
priority: high
created_by: surface:969
created_at: 2026-04-24T08:18:24.145Z
---

## タスク
## 症状

dashboard の Metrics タブで画面下部が見切れる。タスク別ランキング（`metrics_section_task`）が特に影響を受ける。

## 原因

Metrics タブに scroll 機構が無い。`dashboard.tsx:1384-1385` で `buildMetricsRows(...)` の結果をそのまま渡しているだけで、journal/log のような scroll offset + slice 処理が無い。↑/↓ キーハンドラも未登録。

## 参考実装（journal / log）

- State: `journalScrollOffset` / `logScrollOffset`（`dashboard.tsx:412, 416`）+ 初期値 0（L1192, 1196）
- 描画: `reversed.slice(startIdx, endIdx)` で可視範囲のみ（L1370-1392）
- キーバインド: ↑/↓ で offset 増減（L1525-1531, 1556-1561）+ g/G で top/bottom（L1690-1705）
- 自動追従: `journalAutoScroll` / `logAutoScroll` で最新更新時に追従（L2033-2034）

## 変更方針

Metrics は逆順表示ではなく**固定レイアウト（caption → rate limit → unified → role → task）**なので、journal/log とは scroll 方向の意味が異なる。単純な top からの offset でよい:

1. **`AppState` に `metricsScrollOffset: number` を追加**（dashboard.tsx:427 付近、MetricsData の隣）
2. **`buildMetricsRows` の戻り値を slice**: `dashboard.tsx:1384-1385` を
   ```ts
   : state.activeTab === "metrics"
   ? (() => {
       const all = buildMetricsRows(state.metricsData, state.metricsError);
       const VISIBLE = METRICS_VISIBLE_LINES; // 既存の LOG_VISIBLE_LINES と同様の定数を新設
       const total = all.length;
       const startIdx = Math.min(state.metricsScrollOffset, Math.max(0, total - VISIBLE));
       return all.slice(startIdx, startIdx + VISIBLE);
     })()
   ```
3. **↑/↓ ハンドラ**: `focusedArea === "metrics"` で offset 増減（既存の journal/log 分岐に追加）
4. **g/G**: top = 0 / bottom = `max(0, total - VISIBLE)` に（journal/log と同じパターン）
5. **footer**: `focusedArea === "metrics"` の分岐（`dashboard.tsx:1458-1465`）に `ui.kbd("↑/↓") ui.text("scroll") ui.kbd("g/G") ui.text("top/bottom")` を追加
6. **metrics 定期更新（1s polling）で scroll offset を維持**: journal/log と違って Metrics は全体 rebuild なので、offset は維持するだけで追従不要（auto-scroll フラグは不要）

## 補足

- `METRICS_VISIBLE_LINES` の値はターミナル高さから動的算出するのが理想だが、既存 journal/log が定数で運用しているので同じ方針で定数でよい（適切な値を既存 2 者から見て決める）
- T309（統合セクション削除）が先に入ると行数が数行減るが、このタスクとは独立に進めてよい（競合しない）
- 統合セクションも scroll 対象に含まれるので merge 順は問わない

## 受け入れ条件

- Metrics タブで ↑/↓ でスクロールできる
- g で先頭、G で末尾にジャンプできる
- 画面下端にあっても role/task 別ランキングが全件見られる
- footer のキーヒントに scroll 操作が表示される
- `bun test` / typecheck 通過
