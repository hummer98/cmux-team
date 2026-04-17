# Summary: T180 — Manager の cmux tree タイムアウトを crash 判定から除外

## 結果: ✅ 完了（main にマージ済み）

- マージコミット: `2279a05` (Fast-forward)
- ブランチ: `task-180-1776102379/task` → `main`

## 完了したサブタスク

| Phase | Agent | 出力 |
|-------|-------|------|
| 1. Plan | planner (surface:608) | `plan.md` (16KB) |
| 2. Design Review | design-reviewer (surface:615) | `design-review.md` — Approved with Recommendations (R1-R6) |
| 3. Implementation | implementer (surface:616) | `impl-notes.md` + コード変更 |
| 4. Inspection | inspector (surface:618) | `inspection.md` — **GO** |

## 変更ファイル一覧

| ファイル | 変更 |
|---------|------|
| `skills/cmux-team/manager/exec-error.ts` | `isExecTimeout()` 追加（killed && SIGTERM/SIGKILL、cause 辿り） |
| `skills/cmux-team/manager/cmux.ts` | runCmux で killed/signal/code 転写、`validateSurfaceDetailed` (3 値) 追加、`treeImpl` 差し替えフック、formatExecError 統一 |
| `skills/cmux-team/manager/daemon.ts` | monitorConductors の 3 値分岐、`kind=cmux_unresponsive` 状態、節目ログ |
| `skills/cmux-team/manager/schema.ts` | `treeFailureCount?` / `treeFailureFirstAt?` (optional) |
| `skills/cmux-team/manager/exec-error.test.ts` | 新規 14 ケース |
| `skills/cmux-team/manager/cmux.test.ts` | `validateSurfaceDetailed` 6 ケース追加 |

合計: 6 files changed, +341 / -20 lines

## テスト結果

- `bun test`: **165 pass / 0 fail / 349 expect** (+20 new tests)
- 型エラー: 新規発生なし（main の既存 NonSharedBuffer エラーのみ残存）

## 受け入れ基準

- ✅ cmux tree 一時タイムアウトで稼働中 task が aborted にならない
- ✅ `monitor_tree_failed` 等のログに stderr が（存在すれば）含まれる
- ✅ 既存 crash 検出（surface 不在 → `kind=crashed`）は壊れていない
- ✅ CLAUDE.md「ロギングポリシー」準拠

## 環境変数（追加）

- `CMUX_TEAM_UNRESPONSIVE_MAX_TICKS` (default `6`)
- `CMUX_TEAM_UNRESPONSIVE_MAX_SEC` (default `120`)

デフォルト設定では `60s 連続 unresponsive + 120s 経過` で disconnected 昇格、さらに 300s 後に task abort（合計 ~7 分）。

## TODO（本タスクスコープ外）

`kind=cmux_unresponsive` で disconnected 化したケースの復帰パスは未実装。
cmux daemon が復旧しても現状は `DISCONNECT_TIMEOUT_SEC=300` で abort される。
将来的に `forceCloseDisconnectedConductor` 直前で tree 再試行 → 復旧時に `disconnected → running` 復帰を追加する案あり。
詳細は `impl-notes.md` の「R2 TODO」節を参照。

## 設計判断・試行錯誤メモ

- 中規模 vs 大規模の判定: 複数ファイル変更 + 設計判断（タイムアウト判別方式）あり → 大規模、4 フェーズ全実行
- spawn-agent が複数回タイムアウトした（皮肉にも今直そうとしている問題と同じ症状）→ リトライで対処
- ポーリング判定パターンを 3 回改善: `Bunning…` → `unning…` → `(ctrl+o)` 誤検出修正 → inspection.md 存在チェック追加
- Inspector 1 回目が出力前に異常終了 → 再 spawn して GO 取得
