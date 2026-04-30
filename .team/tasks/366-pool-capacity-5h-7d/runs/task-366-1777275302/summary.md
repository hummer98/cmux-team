# T366 実装サマリー: pool capacity を 5h / 7d 別合計に変更

## 完了サブタスク

- [1] テスト書き換え（RED）
  - `pool-status-header.test.ts` を `capacity5hPct` / `capacity7dPct` に対応
  - `pool-header-display.test.ts` を min ベース色判定 + 二値表示テストに更新
  - `pool-summary.test.ts` を 5h / 7d 別 assert に更新
  - `dashboard-pool.test.tsx` を 5h / 7d 二値 + min ベース色判定に更新
  - `token-store.test.ts` の `computePoolCapacity` direct test を 5h / 7d 別期待値に更新
- [2] 型変更
  - `token-store.ts::PoolCapacityResult`: `capacity_pct` → `capacity_5h_pct` / `capacity_7d_pct`（per_token は据え置き）
  - `pool-status-header.ts::PoolHeaderInput`: `capacityPct` → `capacity5hPct` / `capacity7dPct`
- [3] 実装（GREEN へ）
  - `computePoolCapacity` を 5h / 7d 別合計に書き換え（per_token は従来通り min ベース）
  - `buildPoolHeaderLines` を `pool capacity: 5h NN% / 7d NN%` の二値表示に変更
  - `buildPoolSummary` の header 構築を新型に変更
  - `buildPoolHeaderDisplay` を min ベース色判定 + 二値表示に変更
  - `dashboard.tsx::buildPoolHeader` を min ベース色判定に変更
  - `pool-next-reset.ts` の deltaPct を min ベースに変更（+ シミュレーションロジック調整、後述）
  - `pool-cli.ts` の末尾出力フォーマットを二値表示に変更

## 変更ファイル一覧

| path | 1 行サマリー |
|------|------|
| `skills/cmux-team/manager/token-store.ts` | `PoolCapacityResult` を 5h / 7d 別合計に変更し `computePoolCapacity` を書き換え |
| `skills/cmux-team/manager/pool-status-header.ts` | `PoolHeaderInput` を 5h / 7d 二値に変更し header 行を `5h NN% / 7d NN%` に |
| `skills/cmux-team/manager/pool-summary.ts` | `header.capacityPct` → `header.capacity5hPct` / `capacity7dPct` |
| `skills/cmux-team/manager/pool-header-display.ts` | min ベース色判定 + 二値表示に変更 |
| `skills/cmux-team/manager/dashboard.tsx` | `buildPoolHeader` を min ベース色判定に変更 |
| `skills/cmux-team/manager/pool-next-reset.ts` | deltaPct を min ベースに変更し reset シミュレーションを修正 |
| `skills/cmux-team/manager/pool-cli.ts` | 末尾の `pool capacity:` 出力を `5h NN% / 7d NN%` 形式に変更 |
| `skills/cmux-team/manager/pool-status-header.test.ts` | 新型に書き換え + 二値表示の assert 追加 |
| `skills/cmux-team/manager/pool-header-display.test.ts` | 新型 + min ベース色閾値 + 5h/7d 二値表示テスト追加 |
| `skills/cmux-team/manager/pool-summary.test.ts` | case A〜E を 5h/7d 別 assert に更新 |
| `skills/cmux-team/manager/dashboard-pool.test.tsx` | `makeSummary` を 5h/7d 受け取りに拡張、二値表示 + min 判定テスト追加 |
| `skills/cmux-team/manager/token-store.test.ts` | `computePoolCapacity` 直接テストの期待値を新仕様に更新 |

## テスト結果

| ファイル | 結果 |
|------|------|
| `pool-status-header.test.ts` | 8 pass / 0 fail |
| `pool-header-display.test.ts` | 15 pass / 0 fail |
| `pool-summary.test.ts` | 7 pass / 0 fail |
| `dashboard-pool.test.tsx` | 19 pass / 0 fail |
| `token-store.test.ts` | 96 pass / 1 skip / 0 fail |
| `pool-next-reset.test.ts` | 8 pass / 0 fail |
| `pool-cli.test.ts` | 3 pass / 0 fail（依存箇所の retest） |

## tsc 結果

`bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json` → exit 0（新規エラー 0 件）

## Plan からの逸脱と理由

### `pool-next-reset.ts` の `afterTokens` シミュレーション

**逸脱**: Plan は「`reset_*_at = nowIso` で reset 直後をシミュレートする」既存ロジックをそのまま流用する想定だったが、新仕様の `computePoolCapacity` では片方の window だけ `null` だと該当 window 側の合計に 0 寄与となってしまうため、`reset_7d_at = nowIso` だと 7d reset 直後の世界で `capacity_7d_pct = 0` となる不整合が生じた（既存テスト `pool-next-reset.test.ts` の「7d 律速ケース」で deltaPct が負になる）。

**変更内容**: `afterTokens` の reset 時刻を「`nowMs + 5h`」「`nowMs + 168h`」にずらし、reset 直後の典型的な window 長を再設定するようにした。これにより 5h / 7d 双方の合計が正しくシミュレートされる。

**理由**: Plan の §4「pool-next-reset.ts の deltaPct 解釈」では「ボトルネック側がどう動くか」を表すと整合的に変わる方針だが、シミュレーション式自体は新仕様の「片方 null = 寄与 0」と相互作用して破綻する。意味的には「reset 直後 = util=0 で次の window の頭」なので 5h/7d 後にずらすのが正しい解釈。

## 作業ブランチ

- worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-366-1777275302`
- branch: `task-366-1777275302/task`

## Inspector フィードバック反映

- Inspector minor (2) を反映: `afterMs*` → `afterIso*` にリネーム（`pool-next-reset.ts` の宣言 2 箇所 + 参照 2 箇所、計 4 箇所）。実体が `Date#toISOString()` の戻り値（string）であり `Ms` suffix が誤解を招くため。動作変更なし。
