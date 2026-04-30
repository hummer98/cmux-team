# T310 Metrics タブ scroll 機構追加 — Summary

## 完了フェーズ

- Phase 1 (Planner): plan.md 作成（journal/log を参考に具体的な行番号付き計画）
- Phase 3 (Implementer): dashboard.tsx への scroll 機構実装、typecheck + 1215 件テスト通過
- Phase 4 (Inspector): GO 判定（受け入れ条件 5/5 達成）

## 変更ファイル

| ファイル | 変更 |
|----------|------|
| `skills/cmux-team/manager/dashboard.tsx` | +29 / -1（定数・AppState・描画 slice・↑/↓/g/G handler・footer） |
| `skills/cmux-team/manager/dashboard-issues.test.tsx` | +1（`metricsScrollOffset: 0` を makeState に追加、型整合のため） |
| `package-lock.json` | npm install 由来（4.5.1 → 4.6.0） |

## 実装の要点

1. `METRICS_VISIBLE_LINES = 30`（journal/log と同値）
2. `AppState.metricsScrollOffset: number`（初期値 0）
3. 描画時 `Math.min(offset, max(0, total - VISIBLE))` で clamp（行数減少時の overshoot 対策）
4. Down は単純加算・描画側 clamp に委ねる（keybind で `buildMetricsRows` を再実行しないため）
5. G ハンドラのみ `buildMetricsRows` を呼んで `maxOffset` を算出して末尾へ飛ぶ
6. footer の metrics 分岐先頭に `↑/↓ scroll` / `g/G top/bottom` を追加
7. 1s polling の `loadMetricsData` は `metricsScrollOffset` を触らない（scroll 位置維持要件）

## テスト結果

- `bunx tsc --noEmit`: 新規エラー 0 件（pre-existing 3 件は別スコープ）
- `bun test`: 1215 pass / 0 fail / 40 files

## 受け入れ条件達成状況

1. ✓ Metrics タブで ↑/↓ でスクロール
2. ✓ g で先頭、G で末尾にジャンプ
3. ✓ role/task ランキング全件閲覧可能
4. ✓ footer にキーヒント表示
5. ✓ `bun test` / typecheck 通過

## マージ情報

- Base: local `main` (rebase target)
- Pre-rebase HEAD: `68a71b1`
- Post-rebase commit: `8da2a35`
- Merge strategy: `ff-only` into main
- Merge SHA: `8da2a35715b83bc1f633a32c392fc550adff3e2e`
- Rebase conflict: なし（T309 と独立）
