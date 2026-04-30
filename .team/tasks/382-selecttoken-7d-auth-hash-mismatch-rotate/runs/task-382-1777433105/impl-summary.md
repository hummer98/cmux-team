# T382 一次対応 実装サマリ

## 概要

`selectToken` の admit ループに 7d ブロッカーを追加し、Dear T318 の root cause（`@tayo` が
util_7d=0.91 で唯一の admit 候補となり monthly limit hit）を構造的に防ぐ。
plan.md §6 の判断に従い、二次対応（proxy.ts の auth_hash auto rotate）は本タスクでは実装しない。

## 変更ファイル一覧（plan.md §2 と一致）

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/token-store.ts` | `BLOCKER_5H` / `BLOCKER_7D` 定数を export 追加。`admitCandidates` の blocker 判定に `effUtil7d > BLOCKER_7D` を OR 条件で追加。JSDoc を `selectToken` / `peekNextToken` / `admitCandidates` 全てで 7d 軸記述に更新。|
| `skills/cmux-team/manager/pool-throttle.ts` | local 定数 `POOL_BLOCKER_THRESHOLD` を削除し `token-store` の `BLOCKER_5H` / `BLOCKER_7D` を import で参照。`countPoolTokens` の admit ロジックに 7d blocker と 7d stale 救済を追加。`hasPoolHeadroomFromSummary` を `util7d` も見るように更新（util7d=null は既存挙動を保持）。|
| `skills/cmux-team/manager/token-store.test.ts` | `describe("selectToken (T382: 7d blocker)")` を新規追加（6 ケース）。|
| `skills/cmux-team/manager/pool-throttle.test.ts` | T382-T1, T382-T2（isThrottled5h）/ T382-C1, T382-C2（countPoolTokens）/ T382-H1, T382-H2（hasPoolHeadroomFromSummary）の 6 ケースを追加。|
| `docs/spec/09-token-pool.md` | §候補抽出 5. ブロッカー除外の 7d 軸追記、stale 救済例表に `@over7d` / `@reset7d` 行追加、§構造的整合性の保証 / §閾値 / §peek（next 候補の選定）の閾値記述を全て両軸に更新。|

`package-lock.json` の差分は本タスク開始前から git status に存在しており、本タスクの diff には含まれない。

## 追加テスト数

| ファイル | 追加テスト |
|---|---|
| token-store.test.ts | 6 件（T382-1〜T382-6） |
| pool-throttle.test.ts | 6 件（T382-T1, T382-T2, T382-C1, T382-C2, T382-H1, T382-H2） |
| **合計** | **12 件** |

## テスト結果（plan.md §7）

### Tier 1: 直接修正したテスト

- `token-store.test.ts`: 134 pass / 1 skip / 0 fail
- `pool-throttle.test.ts`: 31 pass / 0 fail

### Tier 2: 影響範囲の回帰

- `dashboard-pool.test.tsx`: 2 pass / 0 fail
- `pool-summary.test.ts`: 12 pass / 0 fail
- `pool-header-display.test.ts`: 13 pass / 0 fail
- `pool-cli.test.ts`: 3 pass / 0 fail
- `pool-status-header.test.ts`: 30 pass / 0 fail
- `token-cli.test.ts`: 37 pass / 4 skip / 0 fail
- `proxy.test.ts`: 48 pass / 0 fail

### Tier 3: typecheck

- `bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json` → エラーなし

### grep invariants（CLAUDE.md）

- `taskState[...]=` / `ts[...]=` / `saveTaskState(` の {daemon,main}.ts 直接書き込み: 0 件
- `bus.emit` / `bus.on` の eventBus.ts 外呼び出し: 0 件

## 既存テストの回帰確認（plan.md §4.3）

plan.md §4.3 で言及された既存テスト群はすべて緑。特に T373-6 の `@tayo` (util_7d=0.91)
は `0.91 < 0.95` で blocker 不該当のため stale 救済の意図は完全温存される。

## TDD ステップ実施状況（plan.md §5）

1. ブランチ確認: `task-382-1777433105/task` worktree 内で作業
2. token-store.test.ts に 6 件追加 → 4 件 fail を確認（赤）
3. `BLOCKER_5H` / `BLOCKER_7D` 定数追加
4. `admitCandidates` の blocker 判定に 7d 軸を OR 追加 → token-store.test.ts 全件緑
5. pool-throttle.test.ts に 6 件追加 → 2 件 fail を確認（赤）
6. `pool-throttle.ts` 改修（定数 import 化、`countPoolTokens` の 7d blocker + stale 救済、`hasPoolHeadroomFromSummary` の 7d 反映） → 全件緑
7. `docs/spec/09-token-pool.md` 4 箇所を更新
8. 回帰テスト 9 ファイル実行 → 全件緑
9. typecheck → エラーなし
10. （未実施）コミット — Conductor 側で実施想定

## plan.md §6 の二次対応について

二次対応（proxy.ts の auth_hash auto rotate）は本タスクでは実装しなかった。
別タスク化の起票は Conductor が行う想定（指示書「重要な制約 1.」に従う）。

## 所要時間

実装開始から impl-summary 書き出しまで約 15 分（読解・実装・テスト・docs を含む）。
