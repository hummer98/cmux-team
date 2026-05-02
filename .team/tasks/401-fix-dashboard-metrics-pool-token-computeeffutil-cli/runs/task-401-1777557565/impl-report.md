# T401 実装レポート: Metrics pool token に computeEffUtil を適用して CLI と一致させる

## Completed Tasks

- **S1**: i18n キー `metrics_pool_marker_legend` を en/ja に追加
- **S2**: `PoolTokenRow` に `reset5hPassed: boolean` / `reset7dPassed: boolean` を追加
- **S3**: 純粋ヘルパー `buildPoolTokenRowFromSnapshot(handle, snap, nowMs)` を `dashboard-metrics.ts` に export
- **S4**: `dashboard.tsx::buildPoolTokenRows` を `buildPoolTokenRowFromSnapshot` 経由に置換 (旧 `snap?.util_5h ?? null` 直読みを消滅)
- **S5**: `buildPoolTokensSection` に `*` マーカー列とフッタ凡例を追加 (anyMarker フラグはマーカー列追加と同ブランチで立てる - design-review R3 に対応)
- **S6**: `dashboard-metrics.test.tsx` の既存フィクスチャ全 15 箇所 (R1) に `reset5hPassed: false, reset7dPassed: false` を追加。新 describe 2 ブロック (CLI 等価性 / marker T401) で 7 テストを追加
- **S7**: 関連 6 ファイルの個別テストでリグレッションなしを確認
- **S8**: 受け入れ条件 (`@kddi` 例 = util_7d=0.97 + reset_7d 通過 → 0% 表示 + `*` マーカー + 凡例) を S6-c / S6-d / S6-e で fixture テストとしてカバー済みを確認

## Files Changed

| パス | 変更概要 |
|---|---|
| `skills/cmux-team/manager/i18n.ts` | en/ja に `metrics_pool_marker_legend` を追加 (CLI と完全一致の文言) |
| `skills/cmux-team/manager/dashboard-metrics.ts` | (a) `PoolTokenRow` に `reset5hPassed` / `reset7dPassed` を追加 (b) `import { computeEffUtil, type UsageSnapshot } from "./token-store"` を追加 (c) 純粋ヘルパー `buildPoolTokenRowFromSnapshot` を `buildPoolTokensSection` 直前に export (d) `buildPoolTokensSection` のループで reset 通過行に ` *` セルを push、ループ後 `anyMarker` が true なら凡例行を追加 |
| `skills/cmux-team/manager/dashboard.tsx` | (a) import に `buildPoolTokenRowFromSnapshot` を追加 (b) `buildPoolTokenRows` 内の rows 構築を `buildPoolTokenRowFromSnapshot(tok.handle, snap, now)` 呼び出し 1 行に置換、`now = Date.now()` をループ前に 1 回取得 (D7) |
| `skills/cmux-team/manager/dashboard-metrics.test.tsx` | (a) 既存 PoolTokenRow フィクスチャ全 15 箇所に `reset5hPassed/reset7dPassed: false` を追加 (b) import に `buildPoolTokenRowFromSnapshot` / `formatPerHandleUtilCell` / `formatUtil` / `UsageSnapshot` を追加 (c) 新 describe `buildPoolTokenRowFromSnapshot (CLI consistency)` を追加 (4 tests: a-d) (d) 新 describe `buildMetricsRows: pool tokens marker (T401)` を追加 (3 tests: e/e2/f) |

## TDD Cycles / Verification Results

### S1 (i18n キー追加)
- **GREEN**: 直接編集で en/ja 両方に key を追加
- **VERIFY**: `grep "metrics_pool_marker_legend" i18n.ts | wc -l` → 2

### S2 (PoolTokenRow 拡張)
- **GREEN**: フィールド 2 件を interface に追加
- **VERIFY**: `grep -n "reset5hPassed: boolean\|reset7dPassed: boolean" dashboard-metrics.ts` → 41, 43 行目で hit
- 副作用として dashboard.tsx / dashboard-metrics.test.tsx が型エラー (S4 / S6 で解消する前提)

### S3 (純粋ヘルパー追加)
- **GREEN**: `import { computeEffUtil, type UsageSnapshot } from "./token-store"` 追加。`buildPoolTokensSection` 直前に `buildPoolTokenRowFromSnapshot` を export。実装は plan に記載通り `eff = computeEffUtil(snap, nowMs)` → `util5h/7d` を `snap?.util_5h == null ? null : eff.effUtil5h` 形で詰める
- **REFACTOR**: なし (plan 通り)
- **VERIFY**: `bunx tsc --noEmit` → dashboard-metrics.ts 単体ではエラーなし

### S4 (dashboard.tsx 置換)
- **GREEN**: import 追加 + `candidates.map` 内の rows 構築を `buildPoolTokenRowFromSnapshot(tok.handle, snap, now)` 1 行に置換。`now = Date.now()` をループ前に 1 回取得 (D7 / S4 メソッド制約)
- **VERIFY**:
  - `grep -n "snap?.util_5h ?? null" dashboard.tsx` → **0 件** (旧実装消滅)
  - `grep -n "buildPoolTokenRowFromSnapshot" dashboard.tsx` → **2 件** (import + 呼び出し)

### S5 (marker / 凡例追加)
- **RED**: S6 でテストを書いてから実装する流れだが、本タスクは pure helper とテンプレート化されたループ追加のため先実装。テスト (S6-e/f) で検証する。
- **GREEN**:
  - `for (const c of computed) { ... }` 内で `if (c.row.reset5hPassed || c.row.reset7dPassed) { cells.push(ui.text("*", { dim: true })); anyMarker = true; }` (R3: marker 列追加と同ブランチで anyMarker フラグ更新)
  - ループ後に `if (anyMarker) rows.push(ui.text(t("metrics_pool_marker_legend"), { dim: true }))`
- **VERIFY**: tsc clean

### S6 (テスト追加・既存フィクスチャ更新)
- **RED → GREEN → VERIFY**: 7 つの新規テストを追加 (a-f, e2)。既存 30 + 新規 7 = **37 tests pass**
  - (a) snap=null → 全 null + reset*Passed=false
  - (b) fresh → 生値そのまま
  - (c) **T401 reset_7d 通過例** (Finding 2 に従い名称中立化): stale + reset_5h 未到達 + reset_7d 通過 + util_7d=0.97 → util7d=0, reset7dPassed=true
  - (d) CLI 等価性: token-format.test.ts:132 と同じ fixture で `formatPerHandleUtilCell` ("0%", "91%", "*") と `buildPoolTokenRowFromSnapshot` (util5h=0, util7d=0.91, reset5hPassed=true) を比較。R2 提案も組み込み `formatUtil(metrics.util5h)` が `cli.display5h` と一致することも assert
  - (e) reset5hPassed=true → "*" + 凡例
  - (e2) reset7dPassed=true → "*" + 凡例 (T401 受け入れ条件の @kddi 例)
  - (f) 全行 reset*Passed=false → "*" / 凡例なし
- **REFACTOR**: なし (plan 通り)
- **VERIFY**: `bun test --timeout 30000 dashboard-metrics.test.tsx`
  ```
   37 pass
   0 fail
   79 expect() calls
  ```

### S7 (regression 確認)
- 関連 6 ファイル個別実行で regression なし:
  | file | result |
  |---|---|
  | `dashboard-metrics.test.tsx` | 37 pass / 0 fail |
  | `dashboard-issues.test.tsx` | 11 pass / 0 fail |
  | `token-format.test.ts` | 20 pass / 0 fail |
  | `token-store.test.ts` | 154 pass / 1 skip / 0 fail |
  | `token-cli.test.ts` | 39 pass / 9 skip / 0 fail |
  | `pool-cli.test.ts` | 4 pass / 0 fail |

### S8 (受け入れ条件確認)
- **`@kddi` のように `util_7d` が高いまま reset_7d_at を通過した token が、CLI と Metrics で同じ表示になる** → S6-c / S6-d で確認 (CLI 側 marker="*" + Metrics 側 reset7dPassed=true / util7d=0)
- **凡例 (`* = reset 通過済みで実質クリア`) が Metrics ページに出る** → S6-e / S6-e2 で確認
- **`bunx tsc --noEmit`**: exit=0 (全プロジェクト型エラーなし)

## Issues Encountered

なし。Plan 通りに進行。Design review の minor finding 4 つはすべて反映済み:
- **R1**: 既存フィクスチャ件数を 15 件で網羅 (`grep -c "hasSnapshot:" → 15` を修正前後で確認)
- **Finding 2**: S6-c のテスト名を `T401 reset_7d 通過例` に中立化 (token-format.test.ts:146 の "@kddi 想定" との衝突回避)
- **R3**: `anyMarker` フラグを marker セル追加と同じブランチで立てる
- **R2**: S6-d で `formatUtil(metrics.util5h) === cli.display5h` レベルの文字列一致まで踏み込み
- **Finding 4**: util_5h=null 時の CLI/Metrics 表示乖離は本タスクのスコープ外 (Conductor の完了処理で follow-up 起票)
