# T401 Summary: Metrics pool token に computeEffUtil を適用して CLI と一致させる

## 概要

Manager dashboard の Metrics ページで Pool Tokens セクションの 5h/7d 列が、CLI (`cmux-team token list`) と異なり生 snapshot を直読みしていたため、stale + reset 通過済み軸の判定が抜けていた。`buildPoolTokenRows` を `computeEffUtil` 経由に揃え、純粋ヘルパー `buildPoolTokenRowFromSnapshot` を抽出して CLI 等価性を fixture テストで担保した。

## 完了したサブタスク

- **S1**: i18n キー `metrics_pool_marker_legend` を en/ja に追加（CLI と完全一致の文言）
- **S2**: `PoolTokenRow` に `reset5hPassed: boolean` / `reset7dPassed: boolean` を追加
- **S3**: 純粋ヘルパー `buildPoolTokenRowFromSnapshot(handle, snap, nowMs)` を `dashboard-metrics.ts` に export
- **S4**: `dashboard.tsx::buildPoolTokenRows` を `buildPoolTokenRowFromSnapshot` 経由に置換（旧 `snap?.util_5h ?? null` 直読みを消滅）
- **S5**: `buildPoolTokensSection` に `*` マーカー列とフッタ凡例を追加
- **S6**: 既存テストフィクスチャ全 15 箇所を更新、新規 7 テスト追加（CLI 等価性 + marker 描画）
- **S7**: 関連 6 ファイルの個別テストでリグレッションなしを確認
- **S8**: 受け入れ条件（@kddi 例 = util_7d=0.97 + reset_7d 通過 → 0% + `*` + 凡例）を fixture テストでカバー

## 変更ファイル

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/i18n.ts` | en/ja に `metrics_pool_marker_legend` を追加 |
| `skills/cmux-team/manager/dashboard-metrics.ts` | `PoolTokenRow` に reset*Passed 追加、`buildPoolTokenRowFromSnapshot` を export、`buildPoolTokensSection` で `*` マーカー + 凡例描画 |
| `skills/cmux-team/manager/dashboard.tsx` | `buildPoolTokenRows` 内で `buildPoolTokenRowFromSnapshot` を呼ぶよう置換、`Date.now()` をループ前 1 回取得 |
| `skills/cmux-team/manager/dashboard-metrics.test.tsx` | 既存フィクスチャ 15 箇所に reset*Passed: false 追加、新規 7 テスト追加 |

## テスト結果

| ファイル | 結果 |
|---|---|
| `dashboard-metrics.test.tsx` | 37 pass / 0 fail / 79 expect |
| `dashboard-issues.test.tsx` | 11 pass / 0 fail |
| `token-format.test.ts` | 20 pass / 0 fail |
| `token-store.test.ts` | 154 pass / 1 skip / 0 fail |
| `token-cli.test.ts` | 39 pass / 9 skip / 0 fail |
| `pool-cli.test.ts` | 4 pass / 0 fail |
| `bunx tsc --noEmit` | exit 0（プロジェクト全体エラーなし） |

## レビュー履歴

- **Design Review**: Approved（minor 4 件、すべて Implementer に伝達して反映済み）
- **Inspection**: GO（Critical 0 / Major 0 / Minor 3。Minor は package-lock 無関係差分注意・テスト表現スタイル・スコープ外 follow-up 認識）

## 設計判断のハイライト

- **`computeEffUtil` の 4 箇所目の consumer に整列**: T390 で確立した「admit / throttle / 表示の唯一の実装」原則を Metrics に拡張。これにより同種のバグ（個別 consumer が独自に snapshot 解釈する）が構造的に再発しない
- **純粋ヘルパー化**: `buildPoolTokenRowFromSnapshot` を `dashboard-metrics.ts` に置くことで、`daemon.tokenDb` 非依存の単体テストが可能になり、CLI (`formatPerHandleUtilCell`) との等価性を fixture 共有で証明

## 残課題（follow-up）

- **`util_5h=null` 時の CLI/Metrics 表示乖離（Decision Log D3）**: CLI は `formatUtil(0)` で "0%" 化するが Metrics は null 維持で bar 非描画。本タスクの受け入れ条件（reset 通過ケースの一致）の範囲外と判断。完了処理直後に follow-up タスクを起票する

## マージ情報

- ブランチ: `task-401-1777557565/task`
- merge commit: `30945b73ddd7ccf3313c1fffb1e6ebd75c61f3e2`
- マージ先: `main`（ff-only）
- 納品方式: ローカルマージ
