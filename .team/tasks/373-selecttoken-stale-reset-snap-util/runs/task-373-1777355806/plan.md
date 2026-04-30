# T373 実装計画書

`selectToken: stale 救済を拡張（reset 未到達軸も snap util を下限として候補化）`

## 1. 対象ファイル一覧

| パス | 役割 | 変更種別 |
|---|---|---|
| `skills/cmux-team/manager/token-store.ts` | `admitCandidates` の stale 判定ブロック改修（核心） | **修正** |
| `skills/cmux-team/manager/pool-throttle.ts` | `countPoolTokens` 内の admit ロジック複製（admit 数カウント）。 T373 で挙動が変わるので合わせる | **修正** |
| `skills/cmux-team/manager/token-store.test.ts` | TC1〜TC8 + T372 系の延長として T373 系テスト 6 ケース追加 | **追加** |
| `docs/spec/09-token-pool.md` | 「候補抽出 4. stale 除外」と「5. ブロッカー除外」を T373 仕様に書き換え | **修正** |
| `docs/spec/07-state-machine.md` | （参考のみ。token pool への参照があるか確認、無ければ触らない） | **読むだけ** |

## 2. `admitCandidates` の現状コード（引用）

`skills/cmux-team/manager/token-store.ts:886-971` より関連箇所のみ抜粋。

```ts
function admitCandidates(
  db: Database,
  policy: SelectTokenPolicy,
  nowIso: string,
): Array<{ token: Token; score: number }> {
  // ... (略: effectiveDefault / now / staleThresholdMs / tokens / activeLeases / 各種 set)

  for (const tok of tokens) {
    // 1) exclude 最優先
    if (excludeSet.has(tok.handle)) continue;
    // 2) selectable=0 は default のみ runtime 昇格
    if (!tok.selectable && tok.handle !== effectiveDefault) continue;
    // 3) lease 中は除外
    if (activeLeases.has(tok.id)) continue;

    const snap = getLatestUsageSnapshot(db, tok.id);

    // 4) stale 判定 + reset 反映による util 上書き（T369）
    let effUtil5h = snap?.util_5h ?? 0;
    let effUtil7d = snap?.util_7d ?? 0;

    if (snap) {
      const recAt = new Date(snap.recorded_at).getTime();
      const isStale = now - recAt > staleThresholdMs;

      if (isStale) {
        const reset5hPast =
          snap.reset_5h_at != null && parseResetEpochMs(snap.reset_5h_at) <= now;
        const reset7dPast =
          snap.reset_7d_at != null && parseResetEpochMs(snap.reset_7d_at) <= now;

        if (!reset5hPast && !reset7dPast) continue;   // ← T373 で削除する行

        if (reset5hPast) effUtil5h = 0;
        if (reset7dPast) effUtil7d = 0;
      }
    }

    // 5) ブロッカー除外: 5h > 95%
    if (effUtil5h > 0.95) continue;

    // 6) admit 判定（略）
    // 7) score = 0.3 * effUtil5h + 0.7 * effUtil7d
  }
}
```

## 3. 修正前後の diff イメージ（疑似コード）

### before（現行 T369 + T372）

```ts
if (isStale) {
  const reset5hPast = snap.reset_5h_at != null && parseResetEpochMs(snap.reset_5h_at) <= now;
  const reset7dPast = snap.reset_7d_at != null && parseResetEpochMs(snap.reset_7d_at) <= now;

  if (!reset5hPast && !reset7dPast) continue;        // 「両軸未到達 = 完全除外」

  if (reset5hPast) effUtil5h = 0;
  if (reset7dPast) effUtil7d = 0;
}
```

### after（T373）

```ts
if (isStale) {
  // T373: reset 済み軸は effUtil=0、未到達軸は snap.util_* を下限として残す。
  //       「stale だから除外」はもう行わない（snap 値が高ければ blocker で止まる）。
  if (snap.reset_5h_at != null && parseResetEpochMs(snap.reset_5h_at) <= now) {
    effUtil5h = 0;
  }
  if (snap.reset_7d_at != null && parseResetEpochMs(snap.reset_7d_at) <= now) {
    effUtil7d = 0;
  }
  // 旧コードの `if (!reset5hPast && !reset7dPast) continue;` は削除する。
  // reset_*_at が null（リセット情報無し）の場合は snap 値そのままを残す。
}
```

### コメント類の更新

- 関数 docstring (`skills/cmux-team/manager/token-store.ts:858-885`) の「**5. stale snapshot の reset 反映 (T369)**」項を T373 仕様に書き換える:
  - 「両軸とも未確定（null / 未来）なら候補外」 → 削除
  - 「reset 済み軸は `effUtil*=0`、未到達軸は `snap.util_*` を下限として残す」 を追記
  - 「stale だけを理由に除外しない。`util_5h > 0.95` のブロッカーで止める」 を明記
- `selectToken` の docstring (`skills/cmux-team/manager/token-store.ts:996-1018`) の「**4. lease / stale / util_5h>0.95 ブロッカーは従来通り除外**」 → 「lease / `effUtil5h>0.95` で除外。stale は除外条件ではなく `effUtil*=0` 上書きで救済」 に書き換える

## 4. `parseResetEpochMs` のシグネチャ確認（T372 で実装済み）

`skills/cmux-team/manager/token-store.ts:747-752`:

```ts
function parseResetEpochMs(v: string): number {
  const n = Number(v);
  if (Number.isFinite(n)) return n * 1000;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}
```

- 入力: `string` (epoch sec の文字列 / ISO 8601 / 不正値)
- 出力: `number`（epoch ms、不正値なら `NaN`）
- 不正値時の `<=` 比較は `NaN <= now` が常に `false` のため安全側 (T372-4 テストで担保済み)
- T373 で要求される使い方は完全に T372 と同形 (`!= null` チェック後に `parseResetEpochMs(...) <= now`)。**新規変更不要**

## 5. spec 更新（`docs/spec/09-token-pool.md`）

### 現状の該当セクション (`docs/spec/09-token-pool.md:235-251`)

```
**候補抽出（優先順位）**:

1. **exclude**: `policy.exclude` に含まれる handle を最優先で除外
2. **selectable=0 の runtime 昇格**: handle が `effectiveDefault` と一致する場合のみ候補化（DB 書き換えなし）
3. **lease 中は除外**（120 秒 TTL）
4. **stale 除外**: `recorded_at` が 30 分以上古い
5. **ブロッカー除外**: `util_5h > 0.95`（5h 使用率 95% 超）
6. **admit 判定**: ...
7. **score 最小を選択**: `score = 0.3 * util_5h + 0.7 * util_7d`（null は 0 扱い）
8. **atomic lease 取得**: ...
```

### 修正後（T373）

```
**候補抽出（優先順位）**:

1. **exclude**: `policy.exclude` に含まれる handle を最優先で除外
2. **selectable=0 の runtime 昇格**: handle が `effectiveDefault` と一致する場合のみ候補化（DB 書き換えなし）
3. **lease 中は除外**（120 秒 TTL）
4. **stale 救済（T373）**: `recorded_at` が 30 分以上古い場合でも除外しない。
   `reset_5h_at` / `reset_7d_at` が過去の軸は `effUtil*=0` として、未到達軸は
   `snap.util_*` を下限として残す（reset 情報自体が null の軸も snap 値を残す）。
   旧仕様（T369: 両軸とも reset 未到達なら除外）は廃止。
   理由: 「久しく使われていない token = 余裕がある」のに stale で永久除外されると
   spawn → snap 更新の循環が起動せずデッドロックする (`@kami` の症状)。
   高 util の stale token は次の 5. ブロッカー判定で止まるため、stale 救済しても安全。
5. **ブロッカー除外**: `effUtil5h > 0.95`（4. で算出した effUtil で判定。stale でも snap 値が高ければ継続ブロック）
6. **admit 判定**: handle == effectiveDefault / include / OSS / tag マッチのいずれか
7. **score 最小を選択**: `score = 0.3 * effUtil5h + 0.7 * effUtil7d`（null は 0 扱い）
8. **atomic lease 取得**: `INSERT OR IGNORE`、120 秒 TTL
```

### 期待動作の表（spec への追加検討）

「stale 救済の挙動」サブセクションに以下のサンプル表を新規追加する:

| handle | snap (5h, 7d) | stale | reset_5h | reset_7d | effUtil_5h | effUtil_7d | score | 結果 |
|---|---|---|---|---|---|---|---|---|
| @kami | (0.07, 0.18) | yes | 未来 | 未来 | 0.07 | 0.18 | 0.147 | **選ばれる** |
| @tayo | (0.02, 0.91) | yes | 過去 | 未来 | 0 | 0.91 | 0.637 | 候補（負け） |
| @kddi | (0.51, 0.85) | no | — | — | 0.51 | 0.85 | 0.748 | 候補（負け） |
| @hot | (0.97, 0.5) | yes | 未来 | 未来 | 0.97 | 0.5 | — | **ブロッカー除外** |

## 6. 追加テストケース 6 件の構造

既存の `describe("selectToken (T369: stale snapshot の util リセット時刻反映)")` ブロック
(`token-store.test.ts:1691-1969`) の末尾、`T372-5` の直後に追加する。
新規 `describe` ブロックは作らず、命名を `T373-N: ...` に統一する（既存 T372 系と並列）。

ヘルパー関数 (`seedStaleSnapshot` / `seedFreshSnapshot` / `pastIso` / `futureIso` /
`pastEpochSec` / `futureEpochSec`) は既存をそのまま再利用する。

### 各ケースの assertion 設計

#### T373-1: stale + 両軸 reset 未到達 + 低 util → admit、score = 0.3·snap.util_5h + 0.7·snap.util_7d

- seed: `@kami` 単独、`util5h=0.07`, `util7d=0.18`, `reset5hAt=futureIso(60)`, `reset7dAt=futureIso(60*24*7)`, `recordedMinutesAgo=74`
- 期待: `selectToken(db, "h-373-1")?.token.handle === "@kami"`
- score 検証: 競合 token (`@hi`) を `seedFreshSnapshot(0.5, 0.5)` で seed し、`@kami` の score (0.147) < `@hi` の score (0.5) なので `@kami` が選ばれること
- これにより effUtil 上書きでなく snap 値そのまま使われていることが確認できる

#### T373-2: stale + 両軸 reset 未到達 + snap.util_5h > 0.95 → ブロッカーで除外

- seed: `@hot` 単独、`util5h=0.97`, `util7d=0.18`, `reset5hAt=futureIso(60)`, `reset7dAt=futureIso(60*24*7)`, `recordedMinutesAgo=50`
- 期待: `selectToken(db, "h-373-2") === null`
- snap 値で blocker 判定が走ること（`effUtil5h=0` に上書きされていないこと）の証明

#### T373-3: stale + 5h reset 過去 / 7d 未到達 → effUtil=(0, snap.util_7d)

- seed 1: `@aux` (`util5h=0.9`, `util7d=0.1`, `reset5hAt=pastIso(5)`, `reset7dAt=futureIso(120)`, stale 50min ago) — 旧 TC1 同等条件、effUtil_5h=0 で score=0.7·0.1=0.07
- seed 2: 競合 `@cmp`、`seedFreshSnapshot(0.05, 0.5)` で score = 0.015 + 0.35 = 0.365
- 期待: `selectToken(db, "h-373-3")?.token.handle === "@aux"`（score 0.07 < 0.365）
- T369 TC1 とほぼ同等だが、5h 過去・7d 未到達のときの effUtil_7d が snap 値（=0.1）として残ることを score 順序で間接確認

#### T373-4: stale + 両軸 reset 過去 → effUtil=(0, 0)（T369 TC2 のリグレッション確認）

- 既存 TC2 と完全同条件で再実行する形になるため、**TC2 に T373 リグレッションコメントを追記し、新規ケースとしては書かない**ことも検討。
- ただし指示書 #4 が明示的に要求しているので「T373-4」として独立させ、既存 TC2 と別 token (`@k4r`) で書く（fixture 重複防止）。
- 期待: `selectToken(...)?.token.handle === "@k4r"` で score 0 < 競合 fresh の score

#### T373-5: fresh snapshot は reset 解釈ロジックを通らずそのまま score 計算

- seed: `@hi` (`util5h=0.9`, `util7d=0.5`) を `recordedMinutesAgo=10`（fresh）で seed、`reset_5h_at`/`reset_7d_at` = pastEpochSec(5)
- 競合: `@cmp` を `seedFreshSnapshot(0.5, 0.5)` （score=0.5）
- 期待: `selectToken(...)?.token.handle === "@cmp"`（`@hi` の score=0.62 が `@cmp` の 0.5 より大きい）
- T372-5 と同一意図だが「reset 過去でも fresh では effUtil 上書きされない」を T373 改修後でも維持することを確認

#### T373-6: DB-level 統合（@kami stale 未到達 / @tayo stale 5h 過去 / @kddi fresh）

- seed:
  - `@kami`: `seedStaleSnapshot(util5h=0.07, util7d=0.18, reset5hAt=futureIso(60), reset7dAt=futureIso(60*24*7), recordedMinutesAgo=74)` → score=0.147
  - `@tayo`: `seedStaleSnapshot(util5h=0.02, util7d=0.91, reset5hAt=pastIso(5), reset7dAt=futureIso(60*24*7), recordedMinutesAgo=60)` → effUtil=(0, 0.91), score=0.637
  - `@kddi`: `upsertUsageSnapshot(util5h=0.51, util7d=0.85, reset_5h_at=null, reset_7d_at=null)` (fresh) → score=0.748
- 期待: `selectToken(db, "h-373-6")?.token.handle === "@kami"`
- 補助 assertion: `selectToken` を 1 度呼んで lease を取った後、第 2 回目の呼び出しでは `@kami` が lease 中で除外され、次点として `@tayo` (0.637) が選ばれることを `releaseLease` 経由でリセットして確認 — **オプション**（やりすぎなら省略）。指示書 #6 は単一 assertion のみ要求しているので、第 2 部分は省略してよい。

### 既存テストとの差分

- 新規追加分のみで既存ケース改変は不要
- T369 TC1〜TC8 はそのまま pass する想定（T373 では「reset 未到達でも候補化」が増えるだけで、既存「reset 過去あり」ケースの挙動は完全保持）
- 既存 TC4（stale + 両軸未来 → null）は T373 で **挙動が変わる**：候補に admit される。**TC4 を改修するか別途扱うか要決定**
  - 推奨: TC4 を「T373 で挙動が変わる」前提で削除 or T373 仕様に書き換える
  - **方針: TC4 は spec から外れた挙動を assert するため、T373 改修と同時に削除する**。代替で T373-1 が逆条件を assert する
  - **TC5（両軸 null）**: 旧仕様では「reset 情報無し」で除外していたが T373 では snap 値そのままで admit される。これも改修必要 → **削除して T373-1 でカバー**（snap 値そのまま score 計算）
  - **改修対象テスト**: TC4・TC5 の **2 件削除** + T372-2（stale + 両軸未来 epoch sec → null）も同様に削除/書き換え

### テスト改修の最終ルール

| 既存テスト | T373 後の挙動 | 対応 |
|---|---|---|
| TC1 (stale + 5h 過去 + 7d 未来) | 同一（effUtil_5h=0, effUtil_7d=snap）→ admit | 維持 |
| TC2 (stale + 両軸過去) | 同一 (effUtil=(0,0), score=0) → admit | 維持 |
| TC3 (stale + 5h 未来 + 7d 過去) | 同一 (effUtil_5h=snap, effUtil_7d=0) → admit | 維持 |
| TC4 (stale + 両軸未来) | **変化**: null → admit (snap 値そのまま) | **書き換え or 削除** |
| TC5 (stale + 両軸 null) | **変化**: null → admit (snap 値そのまま) | **書き換え or 削除** |
| TC6 (fresh は上書きされない) | 同一 | 維持 |
| TC7 (snapshot 無し) | 同一 (score=0 で admit) | 維持 |
| TC8 (stale + 5h 過去 で blocker 回避) | 同一 | 維持 |
| T372-1 (stale + epoch sec(past)) | 同一 | 維持 |
| T372-2 (stale + 両軸 epoch sec(future)) | **変化**: null → admit | **書き換え or 削除** |
| T372-3 (stale + ISO past) | 同一 | 維持 |
| T372-4 (stale + 不正値 → 候補外) | **変化**: null → admit (effUtil 上書きなし、snap 値そのまま) | **書き換え**: blocker で止まるよう util_5h を 0.97 に変更し null assertion を維持、または削除 |
| T372-5 (fresh は上書きなし) | 同一 | 維持 |

**推奨**: TC4 / TC5 / T372-2 / T372-4 を **書き換え**、T373-1〜T373-6 を新規追加。書き換え時は test 名に `(T373: 旧 TC4 挙動変更)` のように明記し、`expect(sel?.token.handle).toBe(...)` の正常系へ転換する。

## 7. 影響範囲チェック

### `admitCandidates` を呼ぶ箇所

`token-store.ts` 内 private 関数のため import なし。同ファイル内 2 箇所:
- `canSelectAnyToken` (L985-994): `length > 0` を peek 用途
- `selectToken` (L1019-1041): sort して lease 取得

両者とも T373 改修で挙動変化を受ける（stale token が増える方向）が、interface 不変なので caller 側の修正不要。

### `pool-throttle.ts: countPoolTokens` の admit ロジック複製

`skills/cmux-team/manager/pool-throttle.ts:102-171` で `admitCandidates` と平行な実装が存在する（dashboard 表示用 admit 数カウント）。**この実装は現状 stale を完全 skip している** (`pool-throttle.ts:142`):

```ts
if (snap) {
  const recAt = new Date(snap.recorded_at).getTime();
  if (nowMs - recAt > STALE_THRESHOLD_MS) continue;   // ← T373 仕様と乖離
}
```

**T373 で必須の修正**: ここも `admitCandidates` と同形に揃える。具体的には:

```ts
let effUtil5h = snap?.util_5h ?? 0;
if (snap) {
  const recAt = new Date(snap.recorded_at).getTime();
  const isStale = nowMs - recAt > STALE_THRESHOLD_MS;
  if (isStale) {
    if (snap.reset_5h_at != null && parseResetEpochMs(snap.reset_5h_at) <= nowMs) {
      effUtil5h = 0;
    }
    // 7d 軸は available 判定に未使用なのでここは省略可
  }
}
if (effUtil5h > POOL_BLOCKER_THRESHOLD) continue;
```

ただし `parseResetEpochMs` は token-store.ts で **module-private**（exportされていない）。
**選択肢**:
1. `parseResetEpochMs` を export して両方で共有
2. `admitCandidates` と `countPoolTokens` の admit ループを 1 つの helper にまとめる（DRY 化）
3. `countPoolTokens` 側に同等関数を private で複製する

**推奨**: 選択肢 1 (`parseResetEpochMs` を export)。最小変更で構造的整合性が保てる。
仕様 §9 (`docs/spec/09-token-pool.md:271-285`) で「pool 有効経路は `selectToken` の admit 判定と完全に同じロジックを共有する」と謳っているので、ここの drift を放置すると spec 違反。

> 注: `pool-throttle.ts` の `available` カウントが多少ズレても dashboard 表示の cosmetic な誤差にとどまる（`canSelectAnyToken` 自体は `admitCandidates` を呼ぶので throttle 判定そのものは正しい）。**ただし指示書 #7「影響範囲チェック」で明示する義務があり、最小限の DRY 化（`parseResetEpochMs` export + `countPoolTokens` 内挿入）はこのタスクのスコープに含める**。

### dashboard の `hasPoolHeadroomFromSummary`

`pool-throttle.ts:183-190` は `PerHandleSummary[]` で計算する pure variant。util_5h のみ見て `< 0.95` を判定するため、T373 改修によるロジック変更の影響を受けない（snap 値そのままで判定するのが本来の意図）。**変更不要**。

### `proxy.ts` / `daemon.ts` / `main.ts`

いずれも `selectToken` / `canSelectAnyToken` の戻り値しか参照しないので interface 不変 → 変更不要。

### 既存テスト範囲

```bash
cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts pool-throttle.test.ts
```

`pool-throttle.test.ts` で `countPoolTokens` の available 計数が変わるテストがあれば追従修正が必要。**実装段階で grep して確認**:

```bash
grep -n "countPoolTokens\|stale\|util_5h" skills/cmux-team/manager/pool-throttle.test.ts
```

## 8. 実装手順（推奨順）

1. `token-store.ts: parseResetEpochMs` を **export** に変更（`function` → `export function`）
2. `token-store.ts: admitCandidates` を §3 の after に書き換え（`continue` 削除）
3. 関数 docstring（admitCandidates / selectToken）を §3 の方針で更新
4. `pool-throttle.ts: countPoolTokens` の stale skip を §7 の effUtil 算出パターンに変更（`parseResetEpochMs` を import）
5. `token-store.test.ts`:
   - TC4・TC5・T372-2・T372-4 を T373 仕様に書き換え（または削除して T373-1〜6 でカバー）
   - T373-1〜T373-6 を T372-5 の直後に追加
6. `bun test --timeout 30000 token-store.test.ts` で 6 ケース pass を確認
7. `bun test --timeout 30000 pool-throttle.test.ts` で countPoolTokens 系の挙動が崩れていないか確認
8. `docs/spec/09-token-pool.md:235-251` を §5 の修正後仕様に書き換え
9. spec に「stale 救済の挙動」サブセクション (§5 末尾の表) を追加
10. `bunx tsc --noEmit` で型エラーが出ていないか確認（cwd: `skills/cmux-team/manager`）

## 9. 完了基準

| # | 基準 | 確認方法 |
|---|---|---|
| 1 | T373-1〜T373-6 が pass | `bun test --timeout 30000 token-store.test.ts -t "T373"` |
| 2 | 既存 token-store.test.ts が全 pass（書き換えた TC4/TC5/T372-2/T372-4 含む） | `bun test --timeout 30000 token-store.test.ts` |
| 3 | pool-throttle.test.ts が全 pass | `bun test --timeout 30000 pool-throttle.test.ts` |
| 4 | `tsc --noEmit` 新規エラーなし | `cd skills/cmux-team/manager && bunx tsc --noEmit` |
| 5 | spec とコードの記述が一致 | `docs/spec/09-token-pool.md` の §候補抽出 4・5 が §5 の修正後文面と一致、TS docstring も同義 |
| 6 | `parseResetEpochMs` の export が壊れていない | grep で `export function parseResetEpochMs` を確認、`pool-throttle.ts` から import されている |
| 7 | `pool-throttle.ts: countPoolTokens` の available 計数が `canSelectAnyToken` と乖離しない | 既存テスト pass で代替 (新規 unit test は不要、structural な対応のみ) |

## 10. リスクと対応

| リスク | 影響 | 対応 |
|---|---|---|
| TC4/TC5/T372-2/T372-4 の書き換えで意図がズレる | テストの carrying value が消失 | 書き換え時に旧テスト名を comment で残し、「T373 で挙動が変わったため admit 側に転換」と明記 |
| `parseResetEpochMs` の export で無関係 caller が増える | 副作用増 | export は token-store.ts 内 + pool-throttle.ts のみ。grep で他 import がないことを最終確認 |
| `pool-throttle.ts` 改修と `token-store.ts` の改修が分裂 | spec §9 の「構造的整合性」違反 | §7 の選択肢 1 で同時改修。差分 review 時に両ファイルが同じ commit に入っているか確認 |
| stale token が大量に admit され始めて、score 順位が想定外になる | 実運用での選択 token がブレる | T373-6 の DB-level 統合テストでガード。docs §「stale 救済の挙動」表を spec に明記して期待動作を凍結 |

## 11. 作業境界（再確認）

- コード変更は行わない（本計画書のみ作成）
- `.team/artifacts/` には書かない
- 出力先 (`/Users/yamamoto/git/cmux-team/.team/tasks/373-selecttoken-stale-reset-snap-util/runs/task-373-1777355806/plan.md`) 以外には成果物を書かない
- 完了したら停止
