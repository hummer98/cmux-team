# Summary: T363 — TUI ヘッダー右の 5h/7d を pool capacity に置換、専用ボックスは削除

## 完了したサブタスク (plan.md ベース)

- [x] Subtask 1: `pool-header-display.test.ts` 新規作成（12 cases）
- [x] Subtask 2: `pool-header-display.ts` 新規実装（`buildPoolHeaderDisplay` 純粋関数）
- [x] Subtask 3: `dashboard.tsx` ヘッダー右側を三項演算子分岐に差し替え + `buildPoolHeader(daemon.pool)` 呼び出し削除 + import 追加
- [x] Subtask 4: `buildPoolHeader` (dashboard.tsx) の JSDoc に T363 保留コメント追加（export / signature / 関数本体は不変）
- [x] Subtask 5: `dashboard-pool.test.tsx` は方針 A で既存テストを維持
- [x] Subtask 6: 関連テスト個別実行で regression なし
- [x] Subtask 7: `bunx tsc --noEmit` で本タスク編集ファイル群に新規エラーなし

## 変更ファイル

- `skills/cmux-team/manager/pool-header-display.ts` (新規, 69 行)
- `skills/cmux-team/manager/pool-header-display.test.ts` (新規, 138 行)
- `skills/cmux-team/manager/dashboard.tsx` (修正)
  - L52: `buildPoolHeaderDisplay` import 追加
  - L460-462: `buildPoolHeader` JSDoc に T363 保留コメント
  - L1434-1436: ヘッダー右側を `daemon.pool != null ? buildPoolHeaderDisplay(daemon.pool) : buildRateLimitDisplay(daemon.rateLimit)` に変更
  - L1474 周辺: `...buildPoolHeader(daemon.pool),` 行と `// T351:` コメントを削除

## テスト結果

| ファイル | 結果 |
|---------|------|
| `pool-header-display.test.ts` | 12 pass / 0 fail |
| `dashboard-pool.test.tsx` | 17 pass / 0 fail |
| `pool-status-header.test.ts` | 7 pass / 0 fail |
| `rate-limit-display.test.ts` | 13 pass / 0 fail |
| `bunx tsc --noEmit` (manager 配下) | エラーなし |

## 受け入れ条件

- [x] TUI ヘッダー右に `pool capacity: NN%` が表示される（pool ON 時）
- [x] ヘッダー直下の `┌─ token pool ─┐` ボックスが出ない（dashboard 経路から削除）
- [x] pool OFF / 取得失敗時はフォールバックで 5h/7d が出る（`daemon.pool == null` で `buildRateLimitDisplay`）
- [x] 5h ≥ 95% スロットリング時の `headerSubtitle` 赤 blink 挙動は維持（`isThrottled` は `daemon.rateLimit` ベース）
- [x] `pool-header-display.test.ts` を追加（純粋関数の 12 cases）
- [x] `bun test` は skills/cmux-team/manager 内で個別実行（CLAUDE.md 禁忌遵守）

## 設計判断（plan.md Decision Log より抜粋）

- **D1**: 新 helper は `pool-header-display.ts` に新規作成（既存 `pool-status-header.ts` は CLI 用 `string[]` API、新関数は TUI 用 `RateLimitPart[]` API で責務が異なる）
- **D2**: `dashboard.tsx::buildPoolHeader` は export 維持（CLI 側 `buildPoolHeaderLines` との整合再評価まで判断遅延）
- **D3**: throttling 中の右側 parts は pool capacity を出す（throttle 視認性は左側 `⏸ THROTTLED` 赤 blink で確保）
- **D5**: `formatRelativeDuration` は `pool-header-display.ts` 内に等価実装。共通化は YAGNI として後続タスクに延期

## 残課題（後続検討）

- CLI (`cmux-team status`) 側にはまだ `┌─ token pool ─┐` ボックスがある（`main.ts` L1449 の `buildPoolHeaderLines` 呼び出し）。本タスクは TUI のみ。CLI も同様に置換するか別タスクで議論する
- `dashboard.tsx::buildPoolHeader` は dead code 化したが当面残す。CLI 整合性の判断とまとめて再評価
- `formatRelativeDuration` の重複（pool-status-header.ts と pool-header-display.ts）は将来的に `format-duration.ts` 切り出しで共通化可能

## マージコミット

main にローカル ff-only マージ: `3b0b22760c3f9e1d418c56f5984c86fe09d10f73`
