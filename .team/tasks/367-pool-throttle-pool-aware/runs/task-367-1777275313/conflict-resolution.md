# Conflict Resolution: T367 / Step 8 semantic resolution

## taskRunId

`task-367-1777275313`

## branch

`task-367-1777275313/task`

## rebase target

`main` (local-ahead-of-origin: local main = `d7e662b` / origin/main = `23ae108`)

## pre-rebase HEAD

`f3557d8e3397fed69434d01c13125d2c0f7cf2ae` (worktree commit before rebase)

## post-rebase HEAD

`f3b25e3` (rebased on top of `d7e662b`)

## 衝突 commit 表

| 相手 commit | message | 触ったファイル |
|---|---|---|
| `d7e662b` | `fix(token-store): selectToken stale snapshot のリセット済み軸を util=0 として候補化 (T369)` | `token-store.ts` / `token-store.test.ts` |
| `1036efb` | `feat(manager): pool capacity を 5h / 7d 別表示に変更 (T366)` | auto-merged: `dashboard-pool.test.tsx`, `dashboard.tsx`, `pool-cli.ts`, `pool-header-display.{ts,test.ts}`, `pool-next-reset.ts`, `pool-status-header.{ts,test.ts}`, `pool-summary.{ts,test.ts}`, `token-store.ts` |

## 衝突ファイル別採用方針

### `skills/cmux-team/manager/token-store.ts`

- **箇所**: `admitCandidates` 関数の JSDoc コメントブロック（コード本体は git auto-merge 済み）
- **HEAD (T369)**: 詳細な選択ロジック説明（手順 1〜9。手順 5 で「stale snapshot の reset 反映」を明記）
- **T367 側**: `canSelectAnyToken` と `selectToken` が同じ admit ロジックを共有することで pool-throttle と spawn-agent の admit 整合性が構造的に保証される、という責務説明
- **採用**: T367 側の構造責務説明を冒頭に置き、続けて T369 側の詳細手順 1〜9 を残す。手順 9 末尾に「`selectToken` のみ。`canSelectAnyToken` は peek」と注記して両者の差分を明記
- **理由**: 両者は補完関係。構造責務（なぜこの関数が存在するか）と詳細手順（何をするか）の両方が必要

### `skills/cmux-team/manager/token-store.test.ts`

- **箇所 1**: `selectToken (T369)` describe 宣言と `canSelectAnyToken (T367)` describe 宣言の間（ヘッダーセパレーター）
- **箇所 2**: TC8 末尾と T367 テスト群の間（describe 終端）
- **HEAD (T369)**: `selectToken (T369: stale snapshot の util リセット時刻反映)` describe + `seedStaleSnapshot` / `pastIso` / `futureIso` helper + `seedFreshSnapshot` helper + TC1〜TC8（8 件）
- **T367 側**: `canSelectAnyToken (T367)` describe + `seedFreshSnapshot` helper + admit/exclude/lease/default 昇格/閾値の 5 件
- **採用**: 両 describe を順序を保って統合。T369 describe を先に置き、その内部に T369 専用 helper（`seedStaleSnapshot`, `pastIso`, `futureIso`）と共通 helper（`seedFreshSnapshot`）と TC1〜TC8 を配置。続いて新しいセパレーターと `canSelectAnyToken (T367)` describe を置き、その内部にローカルの `seedFreshSnapshot` と T367 テスト 5 件を配置
- **理由**: 両者は別の関数を別々にテストしており、test の意味的衝突なし。describe スコープが分離されているため `seedFreshSnapshot` の重複定義は機能上問題なし（リファクタの余地は今回スコープ外）

## Resolution Strategy

T369 と T367 は両者とも `selectToken` 周辺を編集していたが、本質的には **直交する変更**:

- **T369**: `selectToken` の admit 経路 *内* で stale snapshot の util を reset 時刻ベースで上書きするロジック追加
- **T367**: `selectToken` の admit ループを `admitCandidates` private 関数に extract し、新 `canSelectAnyToken` でも共有

つまり T367 の `admitCandidates` 関数に T369 のロジックがそのまま組み込まれた形で main 側 (T369) と worktree 側 (T367) の両方の意図が成立する。実際に rebase 後の `admitCandidates` は手順 5（T369）のロジックを内包しており、`canSelectAnyToken` 経由でも reset 反映が効く。これは pool-throttle 判定にとっても望ましい挙動（stale でも reset 過去なら「実は使える」と正しく判定）。

JSDoc と test の conflict marker は表面的な衝突（コメント行と describe ブロックの並び順）であり、**意味論的衝突は無い**。両側の意図を完全に保持した形で統合した。

## Verification

| 検証項目 | 結果 |
|---|---|
| (1) scope_violation | 不検出。手動編集は `token-store.{ts,test.ts}` の conflict marker 周辺のみ。CHANGED に出る他の差分（dashboard.tsx, pool-summary.ts, pool-cli.ts 等）はすべて T366 由来の git auto-merge 結果 |
| (2) bun test | 600 pass / 0 fail / 1 skip / 1745 expect (`token-store.test.ts`, `pool-throttle.test.ts`, `proxy.test.ts`, `daemon.test.ts`, `pool-summary.test.ts`, `pool-header-display.test.ts`, `dashboard-pool.test.tsx`, `dashboard-conductor.test.tsx`, `main.test.ts` の 9 ファイル) |
| (3) bunx tsc --noEmit | exit 0、新規エラー 0 件（manager ディレクトリで実行） |

## Iterations

1 回（最初の rebase で 2 ファイルの conflict marker 解消 → continue → 全検証 pass）。iteration 上限 5 回まで余裕あり。
