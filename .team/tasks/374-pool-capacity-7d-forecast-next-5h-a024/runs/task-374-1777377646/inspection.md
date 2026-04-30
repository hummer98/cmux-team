# T374 Inspection — pool capacity を 7d forecast ゲージ + next 候補 5h に再設計（A024）

## Verdict

**GO**

## Summary

A024 §計算式 / §検証ケース 1 / 2 / §TUI 表示 / §エッジケース のすべてが実装・テスト・ドキュメントで一致し、`bunx tsc --noEmit` が clean、検品対象 10 ファイルのテストすべてが pass。Phase 順序の R1 原則（各 Phase 末で型チェックが pass）も実機で再現確認済み。CLI と TUI の cross-validate を含むエッジケース処理が網羅され、impl-summary §残課題に挙げられた 4 点はいずれも plan / A024 で本タスク非スコープと明示された範囲内。本タスクの受け入れ基準に逸脱なし。

## Test execution

```
$ cd /Users/yamamoto/git/cmux-team/.worktrees/task-374-1777377646/skills/cmux-team/manager
$ bunx tsc --noEmit
(no output → clean)

$ for f in forecast.test.ts pool-summary.test.ts pool-status-header.test.ts \
           pool-header-display.test.ts pool-cli.test.ts pool-throttle.test.ts \
           pool-next-reset.test.ts token-store.test.ts \
           dashboard-pool.test.tsx dashboard-conductor.test.tsx; do
  bun test --timeout 30000 "$f"
done
```

| ファイル | 結果 |
|---|---|
| `forecast.test.ts` | 16 pass / 0 fail / 66 expect |
| `pool-summary.test.ts` | 12 pass / 0 fail / 42 expect |
| `pool-status-header.test.ts` | 30 pass / 0 fail / 41 expect |
| `pool-header-display.test.ts` | 13 pass / 0 fail / 24 expect |
| `pool-cli.test.ts` | 3 pass / 0 fail / 8 expect |
| `pool-throttle.test.ts` | 25 pass / 0 fail / 31 expect |
| `pool-next-reset.test.ts` | 8 pass / 0 fail / 13 expect |
| `token-store.test.ts` | 128 pass / 1 skip / 0 fail / 234 expect |
| `dashboard-pool.test.tsx` | 2 pass / 0 fail / 11 expect |
| `dashboard-conductor.test.tsx` | 6 pass / 0 fail / 17 expect |

合計 243 pass / 1 skip / 0 fail。tsc は manager dir 内で clean（追加の警告・エラーなし）。

## 検証観点別の所見

### 1. A024 計算式との整合性（GO）

`forecast.ts` の `rateAt` / `integrateBin` / `bar(d) = pool/denom * 100` が A024 §計算式と完全一致。

- `rateAt`: `t < hoursToReset → (1 - util_7d) / hoursToReset` / `t >= hoursToReset → 1/168` を `integrateBin` に展開した形で実装（`forecast.ts:126-147`）。pre rate / post rate の式・係数が一致。
- `integrateBin`: case 1 (`binEnd <= reset`) / case 2 (`binStart >= reset`) / case 3 (straddle) を A024 表通り。境界（`binEnd === reset` / `binStart === reset`）は case 1 の `<=` / case 2 の `>=` に倒す（test "境界 reset" で off-by-one なしを検証）。
- `denom = (binHours / 168) * Σ plan_ratio` も A024 と一致（`forecast.ts:177`）。
- スパークライン文字（`mapBarToSparkline`）は半開区間 `[12.5,25), [25,37.5), ...` を A024 §TUI 表示の 8 段階通り、`>=100 → █` / `<0 → " "` 防御込み。
- 色閾値（`pickSparklineColor`、min ベース、`>=100 green / >=70 yellow / <70 red`）は A024 通り。
- 5h util の色（`pickNextUtilColor`、`>0.95 red / >0.70 yellow / それ以下 green / null gray`）は A024 §5h util の色 通り。境界 0.95 / 0.70 ちょうどは下クラスに倒す（テスト確認済み）。

### 2. A024 §検証ケース 1 / 2（GO）

入力 / 期待値が `forecast.test.ts` で A024 表と一致:

- Case 1: `now=2026-04-28T00:00:00Z` / TZ=UTC / A `util=0.5, reset=NOW+48h` / B `util=0.7, reset=NOW+120h` / 期待 `[108,108,71,71,71,100,100]`。実測 `[108.500, 108.500, 71.000, 71.000, 71.000, 100.000, 100.000]`。最大誤差 0.5 → ±1 内。
- Case 2: `now=2026-04-28T18:00:00Z` / Day 0=6h straddle / A `reset=NOW+40h` / B `reset=NOW+120h` / 期待 `[126,126,94,71,71,78,100]`。実測 `[126.000, 126.000, 93.917, 71.000, 71.000, 78.250, 100.000]`。最大誤差 0.250 → ±1 内。
- Case 1 の token A は `reset = 48h = Day 1 binEnd` に一致する境界 reset。Day 1 で全幅 pre-reset (108) / Day 2 で全幅 post-reset (71) を別 it() で個別 assert しており、case 1 / case 2 の `<=` / `>=` の等号包含が verifies されている。
- impl-summary §検証ケース表の実測値が test 期待値と整合。

### 3. エッジケース実装（GO）

| ケース | 実装位置 | 検証 |
|---|---|---|
| `util_7d` / `reset_7d_at` のいずれかが null | `forecast.ts:isEligible 113-114` | `forecast.test.ts: util_7d == null は除外` / `reset_7d_at == null は除外` |
| `selectable=false` | `forecast.ts:isEligible 112` | `forecast.test.ts: selectable=false は除外` |
| `plan_ratio == null` | `forecast.ts:isEligible 111` | `forecast.test.ts: plan_ratio == null は除外` |
| reset 過去 → post-reset rate | `forecast.ts:hoursToReset 107` で `Math.max(deltaH, 0)` → `integrateBin` case 2 にフォールスルー | `forecast.test.ts: reset が過去なら post-reset rate (1/168)` |
| reset > 7d 先 | `integrateBin` 自然挙動 | `forecast.test.ts: reset が >7d 先なら全 bin が pre-reset rate` |
| 全 bar > 100% | `mapBarToSparkline >= 100 → "█"` | `forecast.test.ts: bars 全要素が >100 でも数値超過を維持` |
| 候補なし | `peekNextToken` が null → `formatNextPart` で `⚠ no eligible account` | `pool-status-header.test.ts: nextCandidate=null` / `pool-header-display.test.ts: nextCandidate=null → yellow` |
| pool OFF | `loadPoolSummary` が null → `buildPoolHeaderLines` 空配列 | `pool-summary.test.ts: case F` / `pool-header-display.test.ts: summary=null` |
| util_5h null（snapshot 待ち） | `formatNextPart`「`5h:—`」 | `pool-status-header.test.ts: util_5h=null + spark 有 → 5h:—` |
| reset_7d_at 全 null | `contributingTokens===0` → spark 省略、next のみ | `pool-status-header.test.ts: contributingTokens=0 → spark 省略、next のみ` |

A024 §エッジケース表の全 6 行 + §エッジケース表（TUI）の 4 行をすべて回帰テスト化。

### 4. peekNextToken の正確性（GO）

- `selectToken` (token-store.ts:1036-1058) と `peekNextToken` (token-store.ts:1079-1096) の admit 経路は **同一の `admitCandidates` 関数** を共有。stale 救済 / blocker `>0.95` / default 昇格 / include / OSS / tag マッチ / score (`0.3 * effUtil5h + 0.7 * effUtil7d`) すべて同期。
- lease は取得しない: `selectToken` のみ `acquireLease` を呼び、`peekNextToken` は呼ばない（差分は L1054 の `acquireLease` 呼び出しの有無のみ）。
- `expireLeases` 副作用は plan §2.2 に明示の通り「pool DB 一貫性維持」のため許容。peek 後の selectToken で同じ token が再度選ばれることを `token-store.test.ts` で検証済み。
- `PeekedToken.util_5h` / `util_7d`: `hasSnapshot` フラグで snapshot 不在時のみ null、effUtil を返す（impl-summary §3 の通り plan §3.7 と整合）。
- score 関数の係数（`w_5h=0.3, w_7d=0.7`）は `selectToken` (line 976) と `peekNextToken`（同じ admitCandidates の score）で一致。

### 5. Phase 順序の R1 原則（GO）

impl-summary 表で全 Phase 末（Phase 0 baseline / Phase 1-9）で tsc clean を記載。実機でも `bunx tsc --noEmit` が clean を再現確認。

design-review v2 で plan §9 Phase 5 step 2 「dashboard.tsx::buildPoolHeader 削除」を Phase 4 (最小限新 API 化) → Phase 5 (完全削除) の 2 段階に分けたという「逸脱」が impl-summary §設計判断 1 で説明されているが、これは R1 原則「拡張 → 切替 → 削除」を厳守するための補強であり、plan の意図に逸脱なし。

### 6. 実テスト実行（GO）

上記 §Test execution の通り、影響範囲 10 テストすべて pass、tsc clean。`bun test` 全体実行は CLAUDE.md ガード通り回避し for ループで個別実行。

### 7. 削除されたコードの妥当性（GO）

| 削除対象 | 妥当性 |
|---|---|
| `pool-surface-row.ts` / `pool-surface-row.test.ts` | A024 §per-handle 行は出さない / plan §6.2 で削除明示。手動確認: `cmux-team token list` / `pool status` で per-token 詳細を確認できるため UX 損失なし |
| `dashboard.tsx::buildPoolHeader` (legacy) | NOTE T363 で「描画経路から外した」と既に明記された dead code を撤去。grep で他参照なし確認済み |
| `dashboard-conductor.test.tsx` から T352 Agent 行 handle 表示テスト削除 | T352 (commit `e1ce0ba`) は「Agent 行のスピナー直後に @handle を配置」した機能。本タスクで per-surface decoration を完全撤去するため、T352 の振る舞いも撤去対象であり、テスト削除は妥当 |

`grep -rn "summary.header\|.header.capacity"` でヒットなし → 旧 header 経路への参照は完全に消えている。

### 8. ドキュメント更新の正確性（GO）

- `docs/spec/09-token-pool.md`: §pool_capacity 指標を §7d Forecast ゲージ + next 候補（A024 / T374）に置換。計算式・bin 切り出し・スパークライン 8 段マッピング・色閾値・next 候補の選定（stale 救済込み）・エッジケース表・廃止: pool_capacity_pct を網羅。実装と整合。
- `README.md` / `README.ja.md`: 新形式 `pool 7d  ██▇▅▅▆█   next: @kddi 5h:65%` を例示し、per-surface decoration 撤去を明記。grep で旧 `<5h:` 例が「撤去された」記述としてのみ残っていることを確認。
- `CHANGELOG.md`: `[Unreleased]` セクションに `Changed` / `Removed` を追加。新仕様の説明と削除ファイル両方を記述。
- `.team/artifacts/A024-pool-capacity-7d-forecast-gauge.md`: §next 候補の選定 の「非 stale」に脚注 `[^stale-rescue]` を追加（plan §8.4 の文面そのまま）。T373 の admit 経路に追従する旨が明記されている。R2 選択肢 A 通り。

### 9. 既知の制限の妥当性（GO）

| 残課題 | 評価 |
|---|---|
| `pool-next-reset.ts` 残置 | plan §6.3 / §10.3 で「本タスクでは残す」と明示。tsconfig が `noUnusedLocals=false` のため tsc 警告なし。後続タスクで「補足表示として残す or 削除」を判断する想定で本タスク非スコープ |
| `computePoolCapacity` 残置 | `pool-cli.ts` / `token-cli.ts` の per-token 表示で `per_token.cap_pct` を引き続き使うため温存（plan §6.1 通り）。`buildPoolSummary` 内で `forCap` を組み立てて呼ぶ経路は維持し集計値はレスポンスに残るが UI で使わない（dead value）→ cleanup は別タスクで対応可能 |
| DST 24h 仮定（Day 1..6） | A024 §確定事項「Day 0 は残り時間のみ（可変幅）/ Day 1..6 は 24h 固定」と整合。Day 1..6 が DST 跨ぎで物理的に 23h or 25h になる場合の bin 端ズレは A024 §エッジケース対象外（許容誤差 ±1% 内） |
| `bun test` 全体禁忌 | CLAUDE.md ガード通り。本タスクの検証は影響範囲を for ループで個別実行する方式 |

### 10. コードクオリティ（軽め、GO）

- NaN / Infinity リスク: `forecast.ts` で `isEligible` が `Number.isFinite` チェック、`hoursToReset` の `Math.max` で負値正規化、`computePool7dForecast` で `denom <= 0 → 0` の防御、`bar < 0 → 0` 防御、eligible 0 件 early return → ガード網羅。
- reset_7d_at の epoch sec vs ISO 文字列: `parseResetEpochMs` を流用（T372 経由）。`forecast.test.ts` に `epoch sec 文字列の reset_7d_at を解釈できる（T372 と整合）` ケースあり。
- `expireLeases` 副作用: plan §2.2 / 本検品 §4 の通り pool DB 一貫性維持のため許容。

## Critical issues

なし。

## Major issues

なし。

## Minor issues

以下は GO 判定に影響しない改善余地（任意）。

### M1. `pool-header-display.ts` の `pickNextUtilColor` import の冗長性

`pool-header-display.ts:48-61` の `buildNextPart` は、util_5h null を関数の最初に分岐して `gray` を返しているため、`pickNextUtilColor(next.util_5h)` が呼ばれるのは `util_5h !== null` のときのみ。`pickNextUtilColor` 自体は null も受けるシグネチャだが、実際には null は呼ばれない。実害なしだが「null は内側で `pickNextUtilColor` に任せる」or「null 分岐を残し pickNextUtilColor から null 受けを削る」のどちらかに統一するとより読みやすい。

### M2. `loadPoolSummary` の `await initTokenDB()` 経路の二重例外吸収

`loadPoolSummary` (`pool-summary.ts:139-159`) は `try/catch` で `enabled` 判定 / `initTokenDB` + policy 解決の両方を吸収して null を返す。挙動的に妥当だが、`isTokenPoolEnabled` の例外と DB open の例外で原因が区別されない（CLI 側で `(rate limit read failed)` のような fallback テキストも出ない）。debug 時にログを残す改善が将来検討可能（ただし plan には明示的指示なし、本タスクスコープ外）。

### M3. `forecast.ts:buildBinRanges` の Day 0 = 0h ケース

now がちょうど local 24:00（=翌日 00:00）に一致した場合、`day0Hours = 0` となり Day 0 bin が `[0, 0]`（空）になる。`integrateBin` で `binEnd - binStart = 0` のため alloc=0、`denom = 0/168 * Σ plan_ratio = 0` → `forecast.ts:178` の `if (denom <= 0) return 0` で 0 が入る。bars[0]=0 と表示され、UI 側で `mapBarToSparkline(0) === " "` になる。挙動は壊れないが Day 0 が秒数単位で巻き直されるエッジケースで「空 cell が出る」のが意外に映る可能性。回避は別タスクで「day0Hours が 0 のとき次の 24h を Day 0 として吸収する」など検討可能。本タスクは A024 §確定事項通りなのでスコープ外。

## Fix Required

なし（GO のため）。
