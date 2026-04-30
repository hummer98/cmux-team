# T373 実装サマリー

`selectToken: stale 救済を拡張（reset 未到達軸も snap util を下限として候補化）`

## 変更ファイル一覧

| パス | 行数 diff (insertions / deletions) | 種別 |
|---|---|---|
| `skills/cmux-team/manager/token-store.ts` | +18 / -18 | コア改修 + docstring 更新 |
| `skills/cmux-team/manager/pool-throttle.ts` | +9 / -2 | `countPoolTokens` を effUtil パターンに |
| `skills/cmux-team/manager/token-store.test.ts` | +180 / -14 | T373-1〜6 追加 + TC4/TC5/T372-2/T372-4 書き換え |
| `skills/cmux-team/manager/pool-throttle.test.ts` | +17 / -2 | T4 を T373 仕様に書き換え + T4-blocker 追加、T12 の expected を更新 |
| `docs/spec/09-token-pool.md` | +22 / -8 | 候補抽出 4./5. を T373 仕様に + 期待動作表追加 |

`git diff --stat`:
```
 docs/spec/09-token-pool.md                     |  30 +++-
 skills/cmux-team/manager/pool-throttle.test.ts |  19 ++-
 skills/cmux-team/manager/pool-throttle.ts      |  11 +-
 skills/cmux-team/manager/token-store.test.ts   | 194 +++++++++++++++++++++++--
 skills/cmux-team/manager/token-store.ts        |  36 ++---
 5 files changed, 246 insertions(+), 44 deletions(-)
```

## コア変更内容

### 1. `token-store.ts: parseResetEpochMs` を export

`pool-throttle.ts` から import して共有。同一 stale 救済ロジックを構造的に担保するため。

### 2. `admitCandidates` の stale 判定ブロック改修

旧:
```ts
if (!reset5hPast && !reset7dPast) continue;  // 両軸未到達 → 完全除外
if (reset5hPast) effUtil5h = 0;
if (reset7dPast) effUtil7d = 0;
```

新（T373）:
```ts
if (snap.reset_5h_at != null && parseResetEpochMs(snap.reset_5h_at) <= now) {
  effUtil5h = 0;
}
if (snap.reset_7d_at != null && parseResetEpochMs(snap.reset_7d_at) <= now) {
  effUtil7d = 0;
}
// continue 削除。reset 未到達軸は snap.util_* を下限として残す。
```

### 3. `pool-throttle.ts: countPoolTokens` の admit ロジック整合化

旧: `if (nowMs - recAt > STALE_THRESHOLD_MS) continue;` で stale を完全 skip。
新: `effUtil5h` を `admitCandidates` と同じ式で算出し、`> POOL_BLOCKER_THRESHOLD` 判定。

### 4. docstring / spec 更新

- `admitCandidates` / `selectToken` の docstring 5. と 4. を T373 仕様に書き換え。
- `docs/spec/09-token-pool.md` の候補抽出 4./5. を書き換え + 「stale 救済の挙動」サブセクション（4 行サンプル表）追加。

## 追加・改修したテストケース一覧

### 新規追加（`token-store.test.ts`）

| ケース | seed | 期待 |
|---|---|---|
| T373-1 | stale 両軸未到達 + 低 util (0.07, 0.18) vs fresh @hi (0.5, 0.5) | @kami が選ばれる（snap 値そのまま admit、score=0.147） |
| T373-2 | stale 両軸未到達 + util_5h=0.97 | null（ブロッカー除外） |
| T373-3 | stale 5h 過去 / 7d 未来 + (0.9, 0.1) vs fresh (0.05, 0.5) | @aux が選ばれる（effUtil_7d=0.1 でも勝つ） |
| T373-4 | stale 両軸過去 + (0.9, 0.5) vs fresh (0.05, 0.05) | @k4r が score=0 で勝つ（リグレッション） |
| T373-5 | fresh + reset_*_at 過去 (0.9, 0.5) vs fresh (0.5, 0.5) | @cmp5 が勝つ（fresh は上書きされない） |
| T373-6 | DB 統合: @kami stale 未到達 / @tayo stale 5h 過去 / @kddi fresh | @kami が score=0.147 で勝つ |

### 既存テスト書き換え（admit 側に転換）

| 既存テスト | 旧期待 | 新期待 (T373) | 改修方法 |
|---|---|---|---|
| TC4: stale 両軸未来 | null | snap 値で admit → @k4 | snap.util を (0.07, 0.18) に下げて admit を assert |
| TC5: stale 両軸 reset null | null | snap 値で admit → @k5 | snap.util を (0.05, 0.10) に下げて admit を assert |
| T372-2: stale 両軸 epoch sec(future) | null | snap 値で admit → @kepoch2 | snap.util を (0.05, 0.10) に下げて admit を assert |
| T372-4: stale 不正値 → NaN | null | snap 値で admit → @kbad | snap.util を (0.05, 0.10) に下げて admit を assert |

`pool-throttle.test.ts`:

| 既存テスト | 旧期待 | 新期待 (T373) | 改修方法 |
|---|---|---|---|
| T4: 両方 stale + util=0.1 | throttled=true | throttled=false | テスト名と expect を反転 |
| T4-blocker（新規） | — | throttled=true | util=0.97 で stale でもブロッカーで止まることを assert |
| T12: stale token 含む 3 件 | available=1 | available=2 | stale token (0.1) も admit に算入 |

## 計画書からの逸脱

- **pool-throttle.test.ts T4 / T12 の改修**: 計画書では「実装段階で grep して確認」と記述があったが、T373 仕様変更で実際に挙動が変わるため改修必須。`available` の数を 1→2 に、`throttled` を true→false に転換した。
- **T4-blocker の追加**: T4 の単純な反転だけだと「snap 値が高ければブロッカーで止まる」ことが pool-throttle 側で確認できないため、補助ケースを 1 件追加した（T373-2 と同等の意図を pool-throttle のレイヤで再確認）。

## 確認コマンド結果

```bash
$ bun test --timeout 30000 token-store.test.ts -t "T373"
 10 pass     # T373-1..6 + 書き換えた TC4/TC5/T372-2/T372-4 の合計（テスト名に T373 を含むため）
 0 fail
 10 expect() calls

$ bun test --timeout 30000 token-store.test.ts
 120 pass
 1 skip
 0 fail
 217 expect() calls

$ bun test --timeout 30000 pool-throttle.test.ts
 25 pass
 0 fail
 31 expect() calls

$ bunx tsc --noEmit; echo "exit=$?"
exit=0
```

## 構造的整合性

- `parseResetEpochMs` は `token-store.ts` でのみ定義し export、`pool-throttle.ts` から import。NaN 解釈と `<=` 比較の安全側挙動は T372 と同一。
- `admitCandidates` と `countPoolTokens` の admit ループが同じ effUtil 式で `effUtil5h > POOL_BLOCKER_THRESHOLD` を判定するため、dashboard `available` と spawn 側 admit の乖離は構造的に発生しない。
- `daemon.ts` / `main.ts` への state mutation invariant grep（`taskState[...]=` / `saveTaskState(`）は 0 件を維持。
