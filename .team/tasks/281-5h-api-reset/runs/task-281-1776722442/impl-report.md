# T281 実装レポート

## 要約

`isStale` の 5h/7d OR 判定を軸別の `isStale5h` / `isStale7d` に分離し、5h reset 過去 / 7d reset 未来の状態でも daemon の throttle ガードが解除されるよう修正した。plan.md §6 の TDD 手順（Step 1–4）に従い、赤 → 緑 → リファクタの順で進めた。全 810 テスト通過（別件 flaky あり、下記参照）。plan.md からの逸脱なし。

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/rate-limit-persistence.ts` | `isStale` を削除し `isStale5h` / `isStale7d` を新規 export。`isFuture` ヘルパは共用で温存 |
| `skills/cmux-team/manager/rate-limit-persistence.test.ts` | 旧 `describe("isStale")` を削除、`describe("isStale5h")` 8 ケース + `describe("isStale7d")` 6 ケースを新規追加 |
| `skills/cmux-team/manager/rate-limit-display.ts` | `stale` を `stale5h` / `stale7d` / `allStale` に分割。バー単位で軸別 GRAY 化、`forceRed` は `!stale5h` で判定、`(stale)` サフィックスは `allStale` のときのみ |
| `skills/cmux-team/manager/rate-limit-display.test.ts` | 軸別 stale リグレッションテスト 4 件を追加（5h 過去/7d 未来、5h 未来/7d 過去、それぞれの `unifiedStatus=rate_limited` 併用） |
| `skills/cmux-team/manager/daemon.ts` | L30 import を `isStale5h` に変更、L2515（`throttled5h` ガード）・L3333（sidebar `⏸ throttled`）を `isStale5h` に置換 |
| `skills/cmux-team/manager/proxy.ts` | L15 import を `isStale5h` に変更、L193（`/rate-limit` エンドポイント）を `isStale5h` に置換 |
| `skills/cmux-team/manager/dashboard.tsx` | L21 import を `isStale5h` に変更、L1092（TUI ヘッダー `⏸ THROTTLED`）を `isStale5h` に置換 |
| `skills/cmux-team/manager/main.ts` | L53 import を `isStale5h, isStale7d` に変更、L486 起動時ログを `stale5h=<bool> stale7d=<bool>` 形式に更新 |

`isStale` の呼び出し元は grep で 0 件を確認済み（bare `\bisStale\b` で検索）。

## 追加・更新したテスト

### 新規追加

- `rate-limit-persistence.test.ts::isStale5h` — 8 ケース
  - `rl=null` / `rl=undefined` / `unified5hReset=null`（7d が未来でも影響しない）/ `unified5hReset 過去` / `unified5hReset 未来`（7d が過去でも影響しない）/ **T281 リグレッション（5h 過去 / 7d 未来 → stale）** / 解釈不能な reset 文字列 / `unifiedStatus` 不干渉
- `rate-limit-persistence.test.ts::isStale7d` — 6 ケース
  - `rl=null` / `rl=undefined` / `unified7dReset=null` / `unified7dReset 過去` / `unified7dReset 未来` / 解釈不能
- `rate-limit-display.test.ts` — T281 軸別 stale リグレッション 4 件
  - 5h 過去 / 7d 未来 → 5h バー GRAY・7d バー緑・`(stale)` なし
  - 5h 未来 / 7d 過去 → 7d バー GRAY・5h バー緑・`(stale)` なし
  - 5h 過去 / 7d 未来 + `rate_limited` → 7d も赤にしない（`forceRed` 発動せず）
  - 5h 未来 / 7d 過去 + `rate_limited` → 5h は赤（`forceRed` 発動）、7d は GRAY

### 削除

- 旧 `describe("isStale")` 全ケース（特に `L139-142` の「5h 過去 / 7d 未来 → non-stale」は T281 の意図と逆転するため削除）

### 既存継続

- `rate-limit-display.test.ts:70-90`（両軸 stale → 全 GRAY + `(stale)`、stale + rate_limited で赤にしない）は両軸 stale のケースなので新実装でも継続通過

## 最終テスト実行結果

```
$ cd skills/cmux-team/manager && bun test
 810 pass
 0 fail
 1946 expect() calls
Ran 810 tests across 27 files. [36.97s]
```

該当テストファイル単独:

```
$ bun test rate-limit-persistence.test.ts rate-limit-display.test.ts
 30 pass
 0 fail
 44 expect() calls
```

### flaky test 観測（T281 と無関係）

フルスイートを 3 回実行したところ、2 回目のみ `main.test.ts::PreToolUse hook 挙動 (§4.2)` 11 件が失敗した（1 回目・3 回目は全通過）。`bun test main.test.ts` 単独実行では 110/110 pass。テスト順序依存の shared-state 問題で、cmux send hook 検証系（rate-limit とは無関係）。本タスクの変更箇所とも関連がなく、既存の flaky と判断。

### 型チェック

既存の型エラー 3 件（`conductor.ts:197` / `daemon.test.ts:3720` / `daemon.ts:1538`）が残存するが、baseline（git stash 後）でも同一エラーを確認済み。T281 の変更由来ではない。`grep isStale | rate-limit` での新規型エラーは 0 件。

## plan.md からの逸脱

なし。plan.md §6 Step 1〜4 の TDD 手順・§9 のパッチイメージ通りに実装した。

軽微な調整点:

- Recommendations R1〜R3（任意）は実装時の配慮で吸収（docstring で軸独立を明示、Step 2 完了時点で `rate-limit-display.test.ts` の既存緑を確認、ログ形式変更に伴う docs / README の grep 確認は `rg -n 'rate_limit_restored' README* docs/` で該当なしを確認）。
- `isStale5h` の docstring に「7d は観測のみ。assignment ガードは 5h のみ」方針を記載（plan.md §7.5 準拠）。
- `rate-limit-display.ts` の docstring を軸別セマンティクスに合わせて書き直し。

## 次フェーズ（Inspector）への引き継ぎ事項

### 受け入れ条件の達成状況

- [x] 5h reset 過去 / 7d reset 未来で `daemon.ts` の throttle ガードが解除される（`isStale5h` が true を返すため `!isStale5h(...)` が false、`throttled5h = false`）— `rate-limit-display.test.ts::T281 リグレッション` の 4 件と `rate-limit-persistence.test.ts::isStale5h::T281 リグレッション`（5h 過去 / 7d 未来 → 5h は stale）で担保
- [x] 対応するユニットテストを追加（上記 18 件）
- [x] dashboard の `⏸ throttled` 表示が 5h reset 通過時に外れる（`dashboard.tsx:1092` / `daemon.ts:3333` が共に `isStale5h` を参照）
- [x] 既存のテストが通る（既存 `rate-limit-display.test.ts` 9 件すべて継続通過、全 810 テスト通過）

### 確認観点

1. **破壊的 API 変更の完全性**: `isStale` 呼び出しが残っていないこと → `grep -rn "\bisStale\b" skills/cmux-team/manager` で 0 件確認済み
2. **挙動の一貫性**: 5h 専用と分類した 4 箇所（daemon L2515, daemon L3333, proxy L193, dashboard L1092）が全て `isStale5h` を使っていること
3. **表示セマンティクスの意図的変化**: 7d reset が過去だと 7d バーが GRAY 化される（plan.md §7.2）。これは意図した変化
4. **ログフォーマットの破壊的変更**: `rate_limit_restored stale=<bool>` → `stale5h=<bool> stale7d=<bool>`。外部パーサは存在しない（grep 済み）

### 未検証（任意の E2E）

plan.md §8.4 の「`.team/rate-limit.json` に 5h 過去 / 7d 未来を仕込み、`cmux-team start` → dashboard で `⏸ THROTTLED` が消える・assignment が動くことを目視確認」は、daemon 起動が必要で worktree 内では実行していない。Inspector / 手動検証に委ねる。

### スコープ外（本タスクでは扱わない）

- 7d throttle ガードの新規追加（plan.md §10）
- `persistRateLimit` / `loadRateLimit` の永続化フォーマット変更
- dashboard の stale 表示 UI 大規模リニューアル
- `RateLimitInfo` スキーマへの stale フラグ追加

## コミット戦略

単一コミットで完結させる想定（plan.md §7.1）。`isStale` を削除した時点で呼び出し元 6 箇所の置換が全て完了していないとビルドが壊れるため、部分 push は不可。Conductor 側で最終コミットすること。
