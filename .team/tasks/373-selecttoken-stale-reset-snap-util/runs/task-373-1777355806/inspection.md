# T373 検品結果

`selectToken: stale 救済を拡張（reset 未到達軸も snap util を下限として候補化）`

## 判定

**PASS**

理由:
- 観点 A〜F すべて NG なし。
- T373-1〜T373-6 が計画書 §6 通りに実装され、TC4/TC5/T372-2/T372-4 も計画書 §6 のテーブル通り「null 期待 → admit 期待」に転換されている。
- `admitCandidates` から旧 `if (!reset5hPast && !reset7dPast) continue;` が完全に削除され、`effUtil5h` / `effUtil7d` が if 外で `let` 宣言されているため stale ブロックの外でもスコア計算に正しく伝搬している。
- `parseResetEpochMs` は `export` 済み、import 元は `pool-throttle.ts` 1 箇所のみ（無関係 caller の追加なし）。
- `pool-throttle.ts: countPoolTokens` も `admitCandidates` と同形の effUtil 算出に揃っており、`POOL_BLOCKER_THRESHOLD` で判定。
- spec (`docs/spec/09-token-pool.md`) の候補抽出 4./5. が新仕様文面に書き換えられ、サンプル表（@kami / @tayo / @kddi / @hot 4 行）が plan §5 と一致。
- tsc 0 エラー、token-store.test.ts 120 pass / 1 skip / 0 fail、pool-throttle.test.ts 25 pass / 0 fail。

差し戻しは不要。

## 観点別マトリクス

| 観点 | 結果 | 詳細 |
|------|------|------|
| A1. token-store.test.ts 全 pass | OK | 120 pass / 1 skip / 0 fail / 217 expect |
| A2. pool-throttle.test.ts 全 pass | OK | 25 pass / 0 fail / 31 expect |
| A3. T373-1〜T373-6 が存在し計画書 §6 通り | OK | `token-store.test.ts:1984-2130` に 6 件存在、grep 確認済み |
| A4. TC4/TC5/T372-2/T372-4 が admit assertion に転換 | OK | いずれも `expect(sel?.token.handle).toBe(...)` に転換、テスト名に `(T373: 旧 null → admit 転換)` を明記 |
| B5. `if (!reset5hPast && !reset7dPast) continue;` 削除 | OK | `grep` で 0 件、`token-store.ts:929-940` の after 形になっている |
| B6. effUtil5h/7d スコープ・伝搬 | OK | `token-store.ts:926-927` で `let` 宣言、stale ブロックの後 `:944` `:965` で参照 |
| B7. `parseResetEpochMs` export + pool-throttle が import | OK | `token-store.ts:747` `export function`、`pool-throttle.ts:24` で named import |
| B8. `pool-throttle.ts: countPoolTokens` が effUtil 同形 | OK | `pool-throttle.ts:142-150`、`admitCandidates` と同じ条件式（5h 軸のみ。7d 軸は available 判定に未使用なので省略は計画書 §7 と整合） |
| B9. `effUtil5h > POOL_BLOCKER_THRESHOLD` で判定 | OK | `pool-throttle.ts:150`（旧 `snap.util_5h > ...` は残っていない） |
| C10. spec とコードの実挙動が一致 | OK | `09-token-pool.md:240-252` の 4./5. と `admitCandidates` の挙動が一致（reset null 軸は snap 値そのまま、`effUtil5h>0.95` でブロッカー） |
| C11. spec に「stale 救済の挙動」サンプル表 4 行 | OK | `09-token-pool.md:256-265` に @kami/@tayo/@kddi/@hot の 4 行表。plan §5 の表と完全一致 |
| C12. docstring 更新 | OK | `admitCandidates` (`token-store.ts:872-876` の項目 5 / `:876` 項目 6) と `selectToken` (`:1004-1005` 項目 4) が T373 仕様を反映 |
| D13. `bunx tsc --noEmit` 0 エラー | OK | `cd skills/cmux-team/manager && bunx tsc --noEmit` exit=0 |
| D14. 変更ファイル 5 件 | OK | git diff --stat: 5 files, 246 insertions, 44 deletions（実装サマリーと一致） |
| D15. `parseResetEpochMs` import が `pool-throttle.ts` のみ | OK | `grep -rn parseResetEpochMs skills/cmux-team/manager/` で `token-store.ts`（定義 + 内部 2 箇所）と `pool-throttle.ts`（import + 1 callsite）のみ |
| E16. T369 TC1〜TC8 のうち維持対象が pass | OK | TC1/TC2/TC3/TC6/TC7/TC8 はコード変更なしで pass。TC4/TC5 は計画通り書き換え |
| E17. T372-1/T372-3/T372-5 が pass | OK | コード変更なし、`bun test -t "T372"` 8 ケース全 pass |
| E18. 空 DB の不変性 | OK | TC4 等で他 token がない初期状態（DB に該当 handle なし）で `null` を返す挙動が `selectToken` の構造で保たれている（`admitCandidates` が空配列なら `selectToken` は L1029-1041 で null 返却）。新規ロジック追加なしで保持 |
| F19. `taskState[...] =` / `saveTaskState(` 直接書き込み | OK | `daemon.ts` / `main.ts` への新規追加なし。token-store.ts / pool-throttle.ts には元々これらが無く今回も無い |
| F20. `bus.emit` / `bus.on` の直接呼び出し | OK | 新規追加なし。token-store.ts / pool-throttle.ts に該当呼び出しなし |

## 確認コマンド出力

```bash
$ cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts
 120 pass
 1 skip
 0 fail
 217 expect() calls
Ran 121 tests across 1 file. [1233.00ms]

$ cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts -t "T373"
 10 pass
 111 filtered out
 0 fail
 10 expect() calls
Ran 10 tests across 1 file. [54.00ms]
# 内訳: T373-1〜6 + 名称に "T373" を含む書き換え 4 件 (TC4/TC5/T372-2/T372-4) = 10

$ cd skills/cmux-team/manager && bun test --timeout 30000 pool-throttle.test.ts
 25 pass
 0 fail
 31 expect() calls
Ran 25 tests across 1 file. [124.00ms]

$ cd skills/cmux-team/manager && bunx tsc --noEmit; echo "exit=$?"
exit=0

$ git diff --stat
 docs/spec/09-token-pool.md                     |  30 +++-
 skills/cmux-team/manager/pool-throttle.test.ts |  19 ++-
 skills/cmux-team/manager/pool-throttle.ts      |  11 +-
 skills/cmux-team/manager/token-store.test.ts   | 194 +++++++++++++++++++++++--
 skills/cmux-team/manager/token-store.ts        |  36 ++---
 5 files changed, 246 insertions(+), 44 deletions(-)
```

## 計画書 / 実装サマリーとの整合性

### 計画書との一致点

- 対象ファイル一覧 (§1) 5 件 + `docs/spec/07-state-machine.md` は読むだけ → diff 上 5 件、07 への変更なし。
- §3 の after 疑似コード ↔ `token-store.ts:929-940` 完全一致。
- §5 の修正後 spec 文面 ↔ `09-token-pool.md:240-252` 完全一致（句読点・順序まで）。
- §5 のサンプル表 4 行（@kami / @tayo / @kddi / @hot）↔ `09-token-pool.md:260-265` 完全一致。
- §6 のテスト 6 ケースの seed 値・期待 handle ↔ `token-store.test.ts:1984-2130` 完全一致。
- §7 §8 の `parseResetEpochMs` export + `pool-throttle.ts` import で共有 ↔ 実装通り。

### 実装サマリーで明示されている計画からの逸脱

`pool-throttle.test.ts` T4/T12 の改修は計画書では「実装段階で grep して確認」（§7 末尾）と記述があり、T4-blocker の追加は計画書には書かれていなかった。実装サマリー §計画書からの逸脱 で明記されている通り、T373 仕様変更で実際に挙動が変わるため改修は必須であり、補助の T4-blocker 追加（util=0.97 でブロッカー検証）も pool-throttle レイヤでの構造的整合性を担保する妥当な追加。逸脱だが**正当化されており検品上 OK**。

### その他

- `pool-throttle.ts:140-150` の effUtil 算出は計画書 §7 推奨（選択肢 1: `parseResetEpochMs` export）通り。7d 軸は available 判定で未使用のため省略され、計画書 §7 の「7d 軸は available 判定に未使用なのでここは省略可」の判断と一致。
- `selectToken` docstring (`token-store.ts:1004-1005`) は計画書 §3 「stale は除外条件ではなく `effUtil*=0` 上書きで救済」を反映済み。

## FAIL 項目

なし。

## Inspector 補足

- T373-2 のみ `expect(sel).toBeNull()` を保持しブロッカー除外を assert している。これは計画書 §6 T373-2 の意図（`util_5h=0.97` で blocker 検証）と完全に一致。
- T373-3 の score 検証: `@cmp` (fresh 0.05/0.5) score = 0.365、`@aux` (effUtil 0/0.1) score = 0.07 → @aux 勝利。計算正しい。
- T373-6 の DB 統合: @kami 0.147 < @tayo 0.637 < @kddi 0.748 で @kami 勝利。`reset_5h_at=null, reset_7d_at=null` の `@kddi` (fresh) は stale ブロックを通らず snap 値そのまま。計算正しい。
- TC4 で `recordedMinutesAgo: 50` (stale 閾値 30 分超) と `reset5hAt/7dAt: futureIso(60/120)` の組み合わせが「stale + 両軸 reset 未到達」を厳密に再現しており、T373 改修の核心を保証している。
