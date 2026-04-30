# T390 実装計画 — pool status / token list の per-handle 表示を effUtil(stale 救済反映後) に揃える

## 1. 概要 (3 行)

- `cmux-team pool status` / `cmux-team token list` の per-handle 行 `5H USE` / `7D USE` を `usage_snapshots` 生値から **stale 救済反映後の effUtil**(`selectToken` / `peekNextToken` と同じ値) に切り替える。
- そのために `token-store.ts: admitCandidates` (947-962) と `pool-throttle.ts: countPoolTokens` (140-156) に inline 重複している stale 救済 + reset 反映ロジックを **pure 関数 `computeEffUtil`** として抽出し、CLI 表示・admit・throttle 判定の 3 箇所が同一実装を共有する。
- snap 生値と effUtil が乖離する token (reset 通過済み stale) は per-handle 行の 5H/7D 列に短い ASCII マーカー `*` を付けて視認できるようにする。

## 2. 影響ファイル一覧

### 実装 (src)

| ファイル | 変更概要 | 行数概算 |
|---|---|---|
| `skills/cmux-team/manager/token-store.ts` | `computeEffUtil` を新規 export。`admitCandidates` (912-962) を `computeEffUtil` 呼び出しに置換。`STALE_THRESHOLD_MS` 定数を新規 export (admit 内 inline `30 * 60 * 1000` を取り除く)。 | +50 / -16 |
| `skills/cmux-team/manager/pool-throttle.ts` | `countPoolTokens` (140-156) を `computeEffUtil` 呼び出しに置換。既存の private `STALE_THRESHOLD_MS = 30 * 60 * 1000` (line 42) は `token-store.ts` の export を import に切り替える (重複定数の解消)。 | +5 / -22 |
| `skills/cmux-team/manager/token-format.ts` | `formatPerHandleUtilCell(snap, nowMs): { display5h: string; display7d: string; marker: string }` を新規 export。`formatUtil` は維持 (他箇所からも使われる単純な値→文字列変換)。 | +35 / 0 |
| `skills/cmux-team/manager/pool-cli.ts` | per-handle 行の `5H USE` / `7D USE` 列を `formatPerHandleUtilCell` で組み立てる。マーカー接尾辞 (`*`) は最終列で保持。padEnd 幅を 1 文字分拡張。フッタに凡例 `(* = reset 通過済みで実質クリア)` を 1 行追加。 | +12 / -3 |
| `skills/cmux-team/manager/token-cli.ts` | 同様に per-handle 行 `UTIL_5H` / `UTIL_7D` 列を `formatPerHandleUtilCell` で組み立てる。フッタ凡例も同様。 | +12 / -3 |

### テスト

| ファイル | 変更概要 | 行数概算 |
|---|---|---|
| `skills/cmux-team/manager/token-store.test.ts` | `describe("computeEffUtil")` 新規。代表ケース 6-8 件 (後述 §8.1)。 | +120 |
| `skills/cmux-team/manager/token-format.test.ts` | `describe("formatPerHandleUtilCell")` 新規。reset 通過済み stale / fresh / snap=null / 全パターン。 | +90 |
| `skills/cmux-team/manager/pool-throttle.test.ts` | 既存の T373/T382 ケース (`countPoolTokens` の T12 / C2 等) はそのまま pass することを確認 (破壊回帰なし)。テスト追加なし。 | 0 |
| `skills/cmux-team/manager/pool-header-display.test.ts` (既存 / 該当があれば) | `peekNextToken` が effUtil ベースであることを示す既存 assertion を確認 (後述 §6)。テスト追加は最小 (reset_5h_at 過去 + stale で next: 表示が effUtil の % になる 1 ケース)。 | +30 |

### spec / docs

| ファイル | 変更概要 | 行数概算 |
|---|---|---|
| `docs/spec/09-token-pool.md` | `### cmux-team token list` (line 72-74) と `## 7d Forecast ゲージ + next 候補` セクションに「per-handle 行の `5H USE` / `7D USE` は **effUtil**(stale 救済反映後の値) を表示する。snap 生値と異なる行には末尾マーカー `*` を付ける」旨を追記。`#### stale 救済の挙動 (T373)` のサンプル表 (line 263-272) にも CLI 表示列を追加検討 (または注釈で言及)。`pool status` 表示仕様の 1 段落を追加。 | +25 |

合計: 実装 +114 / -44、テスト +240、spec +25。

## 3. 新 pure 関数 `computeEffUtil` の API 確定

### 3.1 シグネチャ (`UsageSnapshot` の実フィールド名で確定)

`token-store.ts:44-53` の実型定義:
```ts
export interface UsageSnapshot {
  id: number;
  token_id: number;
  util_5h: number | null;
  util_7d: number | null;
  reset_5h_at: string | null;
  reset_7d_at: string | null;
  unified_status: string | null;
  recorded_at: string;        // タスク本文の draft の `collected_at` ではなくこちら
}
```

最終 API:

```ts
/** snapshot の stale 判定 + reset 軸ごとの 0 上書きを反映した effUtil を算出する pure 関数 (T390)。
 *  - admit (admitCandidates) / throttle (countPoolTokens) / 表示 (per-handle 行) の 3 箇所が共有する唯一の実装。
 *  - snap=null (snapshot 不在) は { effUtil5h: 0, effUtil7d: 0, hasSnapshot: false, isStale: false, reset5hPassed: false, reset7dPassed: false } を返す。
 *  - reset_*_at の不正値・空文字は parseResetEpochMs が NaN を返すので `<=` 比較が常に false → 救済しない。
 */
export function computeEffUtil(
  snap: UsageSnapshot | null,
  nowMs: number,
  staleThresholdMs: number = STALE_THRESHOLD_MS,
): {
  effUtil5h: number;
  effUtil7d: number;
  hasSnapshot: boolean;
  isStale: boolean;
  reset5hPassed: boolean;
  reset7dPassed: boolean;
};
```

戻り値はタスク本文の draft より 1 フィールド (`hasSnapshot`) 多い。理由は `peekNextToken` の `hasSnapshot` 判定 (`token-store.ts:1108`) と、`countPoolTokens` の `stale` カウント (`pool-throttle.ts:113-118`) が必要としているため、抽出時に同時に集約することで 4 箇所の inline 判定 (`recAt = new Date(snap.recorded_at).getTime()` + `nowMs - recAt > THRESHOLD` の繰り返し) を削れる。

### 3.2 export 場所の判断 — `token-store.ts` 内 export を採用

候補:
- (A) `token-store.ts` 内 export に追加
- (B) 新ファイル `skills/cmux-team/manager/token-eff-util.ts` を作る

採用: **(A) `token-store.ts` 内 export**。理由:
1. 既存の `parseResetEpochMs` (line 756) / `BLOCKER_5H` / `BLOCKER_7D` (line 20-22) と同じ「token-store の admit ロジックに密結合した pure helper」のレイヤー。`pool-throttle.ts` も `parseResetEpochMs` を `token-store` から import している (line 24) ので追従が自然。
2. 新ファイル分割は `UsageSnapshot` 型を re-export するか型循環を起こすため、コスト > メリット。
3. `token-store.ts` は 1154 行で巨大だが、本タスク追加分は 50 行程度で許容範囲。将来「pool 計算 helper」を分離する場合は別タスクで `parseResetEpochMs` ごと移すのが筋。

### 3.3 `STALE_THRESHOLD_MS` 定数の置き場所

現状:
- `token-store.ts: admitCandidates` 内 line 917 に `const staleThresholdMs = 30 * 60 * 1000;` (function-local)
- `pool-throttle.ts:42` に `const STALE_THRESHOLD_MS = 30 * 60 * 1000;` (file-local)

採用: **`token-store.ts` で `export const STALE_THRESHOLD_MS = 30 * 60 * 1000;` を新規宣言**し、`pool-throttle.ts` 側はこれを import する。`computeEffUtil` の `staleThresholdMs` 引数は default 値としてこの定数を使う。

理由: 30 分閾値は admit / throttle / 表示の 3 箇所で同期しなければならないため、唯一の真理ソースが必要。テストからは引数で別値を注入できるよう default 引数として残す (既存の admit 内 inline 値も同じ意味で「テスト時に override したい」気配があるが現状 hard-coded)。

## 4. 既存呼び出し箇所のリプレース計画

### 4.1 `token-store.ts: admitCandidates` (912-962)

差分 (概念):
- before: 915-917 で `now` / `staleThresholdMs` を計算 → 941 で `getLatestUsageSnapshot` → 947-962 で inline stale 判定 + reset 反映 → 989 で `score = 0.3 * effUtil5h + 0.7 * effUtil7d` / `hasSnapshot: snap !== null`
- after: 915 で `now` を計算 → 941 で `getLatestUsageSnapshot` → `const eff = computeEffUtil(snap, now);` → 967 `if (eff.effUtil5h > BLOCKER_5H) continue;` / 968 `if (eff.effUtil7d > BLOCKER_7D) continue;` → 989 `const score = 0.3 * eff.effUtil5h + 0.7 * eff.effUtil7d;` / `hasSnapshot: eff.hasSnapshot`

挙動が変わらないことの担保:
- `pool-throttle.test.ts: T1-T5 / B1-B6 / T373 ケース / T382 ケース` が pass し続けることを確認 (既存 admit/throttle 経路を全網羅)
- `token-store.test.ts: selectToken` 関連テスト (`computePoolCapacity` 以降に存在する admit/lease テスト群) が pass

### 4.2 `pool-throttle.ts: countPoolTokens` (102-182)

差分:
- before: 110-118 で `stale` カウントを 1 ループ目、134-156 で 2 ループ目に inline stale 救済 + reset 反映
- after: 1 ループに統合。`for (const tok of allTokens) { const snap = getLatestUsageSnapshot(db, tok.id); const eff = computeEffUtil(snap, nowMs); if (eff.isStale) stale++; ... if (eff.effUtil5h > BLOCKER_5H) continue; if (eff.effUtil7d > BLOCKER_7D) continue; ... }`
- 結果: ループ統合により `getLatestUsageSnapshot` 呼び出しが N 回 → N 回 (変わらず)、コード重複が消える。
- file-local `STALE_THRESHOLD_MS` (line 42) は削除して `token-store` の export を使う。

挙動担保: `pool-throttle.test.ts: countPoolTokens` の T12 / 302-310 / T382-C1 / T382-C2 が pass し続けること。

## 5. `token-format.ts` の表示変更

### 5.1 新 helper API

```ts
/** per-handle 行の 5H/7D 列とマーカーを組み立てる (T390)。
 *  - util 値は computeEffUtil の effUtil*(stale 救済反映後) を %% 表示
 *  - snap 生値が effUtil と異なる軸が 1 つでもあれば marker = "*"、なければ ""
 *  - snap=null は formatUtil(null)="--" 相当を返し、marker=""
 *  - 5H/7D 列の幅は呼び出し側 (pool-cli.ts / token-cli.ts) で padEnd するため、padEnd しない生文字列を返す
 */
export function formatPerHandleUtilCell(
  snap: UsageSnapshot | null,
  nowMs: number,
): { display5h: string; display7d: string; marker: string };
```

実装方針:
- 内部で `computeEffUtil(snap, nowMs)` を呼ぶ
- `display5h = formatUtil(snap?.util_5h ?? null)` ではなく **effUtil ベースで** `formatUtil(eff.hasSnapshot ? eff.effUtil5h : null)` を返す
- marker 判定: `(eff.reset5hPassed || eff.reset7dPassed) && eff.isStale && eff.hasSnapshot` のとき `"*"`(= snap 生値と effUtil が乖離する条件と同値)
- 既存の `formatUtil` / `formatReset` / `formatSelectable` には変更を加えない (後方互換)

### 5.2 マーカー文字選定 — `*`

候補比較:

| 候補 | ASCII | 視認性 | 既存意味との衝突 | 採否 |
|---|---|---|---|---|
| `*` | yes | ◎ | cmux markdown 内で「強調」と解釈される可能性は低い (リスト記号は行頭のみ)。dashboard/CLI plain text で目立つ | **採用** |
| `↻` | no (Unicode U+21BB) | ◎ | reset を直接示すアイコンとして意味的に最適だが、CJK ターミナル幅問題があり padEnd の文字数計算が崩れる | 不採用 |
| `†` | no (U+2020) | ○ | 脚注を示唆するが、表示環境次第で 0 幅 / 2 幅になる | 不採用 |
| `^` | yes | △ | `*` より目立たず、「上向き / べき乗」の連想で誤読の余地 | 不採用 |

**採用: `*`** — ASCII 1 byte / 表示幅 1 / cmux の plain text TUI で確実に表示。CHAR の `padEnd` 文字数計算とも安全。

spec 09-token-pool.md にも「マーカー `*` は『snap は高 util だが reset 通過済みで effUtil=0、つまり実質クリア状態』を示す」と明記する。

### 5.3 `nowMs` の取得方法 — 引数で受ける

`formatReset` (line 23) は `Date.now()` を内部で呼ぶ。これは「reset 時刻まで何時間か」が極端な精度を要しないからだが、`formatPerHandleUtilCell` は **テスト容易性** のため `nowMs` を引数で受ける。

呼び出し側 (`pool-cli.ts` / `token-cli.ts`) で `Date.now()` を 1 回計算してループ全体に渡す (n 回呼び出しの境目で日付がまたぐ事故も防げる、副次効果)。

## 6. dashboard.tsx の確認結果

`pool-header-display.ts:48-61: buildNextPart` は `summary.nextCandidate.util_5h` を表示する。`pool-summary.ts:90-92` から `summary.nextCandidate = peekNextToken(db, policy, nowIso)`。`token-store.ts:1094-1111: peekNextToken` は `admitCandidates` の戻り値の `effUtil5h` をそのまま `util_5h` として返している (`token-store.ts:1108`)。

**結論: `next: @handle 5h:NN%` ヘッダーはすでに effUtil ベース**。本タスクではコード追加なし。

確認用テストの追加 (最小):
- `pool-summary.test.ts` または `pool-header-display.test.ts` に「reset_5h_at が過去 + stale + util_5h=0.91 の token が next 候補のとき、`next.util_5h === 0` (effUtil) で表示が `5h:0%` になる」という 1 ケース。
- 既存テストが該当ケースをカバーしていれば追加不要。`grep -n "reset_5h_at.*past\|effUtil5h" pool-header-display.test.ts pool-summary.test.ts` で事前に確認した上で判断する (実装ステップ 5)。

## 7. TDD 実装ステップ (赤 → 緑 → リファクタ)

### Step 1: `computeEffUtil` の test → stub → 実装

1.1 (赤) `token-store.test.ts` に `describe("computeEffUtil", ...)` を追加。§8.1 の代表ケース 6-8 件。stub なしで実行 → ReferenceError で失敗。
1.2 (緑) `token-store.ts` に `STALE_THRESHOLD_MS` export と `computeEffUtil` を追加。テスト pass。
1.3 (リファクタ) — なし (pure 関数で完結)。

### Step 2: admit / throttle のリプレース (既存テストで pass 確認)

2.1 `token-store.ts: admitCandidates` を `computeEffUtil` 呼び出しに置換。
2.2 `pool-throttle.ts: countPoolTokens` を `computeEffUtil` 呼び出しに置換。`STALE_THRESHOLD_MS` の重複 const を削除して import に切替。
2.3 `bun test --timeout 30000 token-store.test.ts pool-throttle.test.ts` を実行。**T373 / T382 / B1-B6 全 pass を確認**。

CLAUDE.md より `bun test` 全体実行禁忌のため、関連 test ファイルだけを `for f in token-store.test.ts pool-throttle.test.ts; do bun test --timeout 30000 "$f"; done` で個別実行する。

### Step 3: `formatPerHandleUtilCell` の test → 実装

3.1 (赤) `token-format.test.ts` に `describe("formatPerHandleUtilCell", ...)` を追加。§8.2 の 5-7 ケース。`expect(formatPerHandleUtilCell)` が undefined で失敗。
3.2 (緑) `token-format.ts` に `formatPerHandleUtilCell` を追加 (`computeEffUtil` を import)。

### Step 4: `pool-cli.ts` / `token-cli.ts` の per-handle 行を切り替え

4.1 `pool-cli.ts:74-105` のループ内で `formatPerHandleUtilCell(snap, Date.now())` を使い、5H USE / 7D USE 列の文字列とマーカーを組み立てる。マーカーは行末 (NEXT_RESET の後ろ) に 1 char append、または 7D USE 列の padEnd 内 (`fmt.display7d + fmt.marker`)。
   - 採用: **マーカーは 7D USE 列に append**(`${fmt.display7d}${fmt.marker}` を `padEnd(7)` する)。理由: 「snap と effUtil が乖離する」という意味は両軸どちらかに乖離があるという意味だが、`reset_7d_at` 通過の方が高 util token で頻発する (@tayo / @kddi が該当軸)。表示上、7D の右に `*` がつくと「7D 軸が回復した」と直感的に伝わる。
4.2 `token-cli.ts:317-355` も同パターンで切替。
4.3 `pool-cli.test.ts` / `token-cli.test.ts` が存在すれば pass 確認 (grep で存在を確認)。

### Step 5: spec 09-token-pool.md 更新

5.1 `### cmux-team token list` (line 72-74) のリストに「per-handle 行の `5H USE` / `7D USE` は stale 救済反映後の effUtil を表示する (spawn-agent / peekNextToken と同じ値)」追記。
5.2 `### per-handle 行は出さない` (line 473-475) は dashboard ヘッダーの話なので変更不要。代わりに **新セクション** `### per-handle 行の effUtil 表示 (T390)` を `## 7d Forecast ゲージ + next 候補` の下に挿入し、マーカー `*` の意味と例を 1 段落で記載。
5.3 `#### stale 救済の挙動 (T373)` のサンプル表 (line 265-272) に「CLI 表示」列を追加するか、表直下に「CLI per-handle 行は effUtil 列を表示するため、@tayo は 5H:0% / 7D:91% (※ reset5h は通過しているので 5H 列は 0%)」のような注釈を 1 段落で追加。
5.4 `## 関連ファイル` (line 547-561) の `token-format.ts` 行に `+ formatPerHandleUtilCell (T390 で per-handle 行の effUtil 表示を追加)` を追記。

### Step 6: 全体テスト pass 確認

CLAUDE.md ガイドに従い、関連 test ファイルだけを個別実行:

```bash
cd skills/cmux-team/manager
for f in token-store.test.ts token-format.test.ts pool-throttle.test.ts pool-summary.test.ts pool-header-display.test.ts; do
  bun test --timeout 30000 "$f"
done
```

`pool-cli.test.ts` / `token-cli.test.ts` が存在すれば追加実行。

## 8. テスト戦略

### 8.1 `computeEffUtil` の代表 6-8 ケース (4×4 マトリクスから縮約)

| # | snap | nowMs | 期待 effUtil5h | 期待 effUtil7d | hasSnapshot | isStale | reset5hPassed | reset7dPassed | 意図 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | null | now | 0 | 0 | false | false | false | false | snapshot 不在の base ケース |
| 2 | (0.5, 0.5, null, null, recorded=now) | now | 0.5 | 0.5 | true | false | false | false | fresh + reset 情報なし → snap そのまま |
| 3 | (0.5, 0.5, null, null, recorded=now-35min) | now | 0.5 | 0.5 | true | true | false | false | stale だが reset 情報なし → 救済しない (@kami 系) |
| 4 | (0.02, 0.91, past, future, recorded=now-35min) | now | 0 | 0.91 | true | true | true | false | @tayo 想定: 5h reset 通過 / 7d 未到達 |
| 5 | (0.02, 0.97, future, future, recorded=now-35min) | now | 0.02 | 0.97 | true | true | false | false | @kddi 想定: stale だが reset 未到達なので snap そのまま (マーカーつかない) |
| 6 | (0.5, 0.99, future, past, recorded=now-35min) | now | 0.5 | 0 | true | true | false | true | @reset7d 想定: 7d reset 通過 |
| 7 | (0.97, 0.5, future, future, recorded=now-35min) | now | 0.97 | 0.5 | true | true | false | false | 高 util stale + reset 未到達 → blocker でブロック対象 (呼び出し側で除外、computeEffUtil は数値だけ返す) |
| 8 | (0.5, 0.99, "garbage", past, recorded=now-35min) | now | 0.5 | 0 | true | true | false | true | reset_5h_at が不正値 → parseResetEpochMs が NaN → `<=` false → 5h 救済しない (spec line 274 の挙動を担保) |

ケース 4-5-6 は spec 09-token-pool.md line 265-272 の表とほぼ一致しているので、表のサンプルを SSOT として採用する。

### 8.2 `formatPerHandleUtilCell` の代表 5-7 ケース

| # | snap | 期待 display5h | 期待 display7d | 期待 marker | 意図 |
|---|---|---|---|---|---|
| 1 | null | "--" | "--" | "" | snapshot 不在 |
| 2 | (0.5, 0.5, null, null, fresh) | "50%" | "50%" | "" | fresh: マーカーなし |
| 3 | (0.02, 0.91, past, future, stale 35min) | "0%" | "91%" | "*" | @tayo 想定。effUtil5h=0 で snap 0.02 と乖離 → marker |
| 4 | (0.02, 0.97, future, future, stale 35min) | "2%" | "97%" | "" | @kddi 想定。reset 通過なし → 乖離なし → marker なし |
| 5 | (0.5, 0.99, future, past, stale 35min) | "50%" | "0%" | "*" | 7d reset 通過 |
| 6 | (0.97, 0.5, future, future, stale 35min) | "97%" | "50%" | "" | stale だが reset 通過なし |
| 7 | (0.5, 0.5, null, null, recorded=now-35min) | "50%" | "50%" | "" | stale だが reset 情報なし → 救済も乖離も発生しない |

### 8.3 既存テストでの破壊回帰チェック

- `pool-throttle.test.ts` の T373 系 (T4 / T4-blocker / T12 / T382-C2) と T382 系 (T1/T2/C1) はすべて effUtil 経路で動作する → 変更後も同じ結果が出ることを確認
- `token-store.test.ts` の `selectToken` / `peekNextToken` 関連テスト (`grep -n "selectToken\|peekNextToken" token-store.test.ts`) が pass
- `token-format.test.ts` の既存 `formatUtil` / `formatReset` / `formatSelectable` テストは無変更で pass

### 8.4 統合: pool-cli / token-cli の出力 assertion

既存に `pool-cli.test.ts` / `token-cli.test.ts` がある場合は per-handle 行の文字列 assertion を追加する (reset 通過済み stale token が含まれるシナリオで `5H USE` 列が `0%`、行末に `*` がつくこと)。
存在しない場合は本タスクで導入はせず、`token-format.test.ts` 側で組み立てを単体担保するに留める (呼び出し側 CLI は printf 系で副作用が大きく、テスト導入コスト > 本タスクの便益)。

## 9. risk / 注意点

1. **既存挙動破壊リスク (admit / throttle)**: `computeEffUtil` 抽出の同値性は `pool-throttle.test.ts` の T373 / T382 ケース群がそのまま pass することで担保される。抽出ステップでロジックを「整理」してしまわないよう、まず 1:1 リプレース → テスト pass を確認 → その後の整理は別コミットにする。
2. **表示変更によるユーザー混乱**: `pool status` で「@tayo の 7D が 91% から 0% に変わって見える」変化はユーザーが驚く可能性。マーカー `*` だけでは説明不足のため、`pool status` の最終行に短い凡例 `(* = reset 通過済みで実質クリア)` を追加する (実装コスト 2 行)。
3. **`STALE_THRESHOLD_MS` の値の同一性**: 30 分は spec line 240 / 243 で「30 分以上古くても」と書かれている。export 化に伴って spec の数値表記が import 値と一致することを目視確認。spec の数値を変えるタスクが将来発生したら本定数も追従する旨を spec のコメントに記す。
4. **マーカーの幅計算**: 既存の `padEnd(6)` / `padEnd(7)` (pool-cli.ts:101-102 / token-cli.ts:351-352) が ASCII 前提で組まれている。マーカー `*` は ASCII 1 char なので `${display}${marker}` を渡しても padEnd は安全に効く (マーカー有り行が 1 文字長くなるが、それは意図通りの「目立たせる」効果)。
5. **テスト時の `Date.now()` モック**: `token-format.test.ts` の既存 `formatReset` テスト (line 27-38) は `Date.now()` 直接依存だが、本タスクの `formatPerHandleUtilCell` は `nowMs` 引数で受けるので時刻モックは不要。テスト中は `const NOW_MS = new Date("2026-04-25T10:00:00.000Z").getTime()` 固定で組む (`pool-throttle.test.ts:32-33` と同パターン)。
6. **dashboard.tsx (line 1991-2002) の Ink ペイン**: ここは `snap.util_5h` を生で詰めている。タスクスコープ外 (タスク本文の「TUI dashboard.tsx ヘッダー行の挙動変更」スコープ外条項)。**触らない**。

## 10. 受け入れ基準のチェックリスト

- [ ] `computeEffUtil` の単体テスト (8.1) が 6-8 ケース全 pass
- [ ] `formatPerHandleUtilCell` の単体テスト (8.2) が 5-7 ケース全 pass
- [ ] `pool-throttle.test.ts` の既存 T373 / T382 系全 pass (admit/throttle 経路の破壊回帰なし)
- [ ] `token-store.test.ts` の既存 admit / lease / capacity 系全 pass
- [ ] `token-format.test.ts` の既存 `formatUtil` / `formatReset` / `formatSelectable` テスト全 pass
- [ ] `cmux-team pool status` 実行で @tayo 想定 token (snap 0.02/0.91, reset_5h_at 過去, reset_7d_at 未来, stale) の 5H USE 列が `0%`、行末 (または 7D 列右) に `*` マーカー
- [ ] 同コマンドで @kddi 想定 token (snap 0.02/0.97, reset 両軸未来) の 7D USE 列が `97%` のまま、マーカーなし
- [ ] `cmux-team token list` 実行で同様の表示変化
- [ ] `pool-header-display.ts` の `next:` ヘッダーが effUtil ベースであることを 1 ケースで明示 (既存 or 新規)
- [ ] `docs/spec/09-token-pool.md` の `cmux-team token list` / `pool status` / `7d Forecast` セクションに「per-handle 行は effUtil 表示」「マーカー `*` の意味」が明記される
- [ ] CLI 出力フッタに凡例 `(* = reset 通過済みで実質クリア)` が表示される

## 11. 重要な参照ポイント (ファイル:行)

- `skills/cmux-team/manager/token-store.ts:20-22` — BLOCKER_5H / BLOCKER_7D 定数
- `skills/cmux-team/manager/token-store.ts:44-53` — UsageSnapshot 型定義 (フィールド名: `recorded_at` / `util_5h` / `util_7d` / `reset_5h_at` / `reset_7d_at`)
- `skills/cmux-team/manager/token-store.ts:756-761` — parseResetEpochMs (NaN 戻りで「未到達扱い」になる仕様)
- `skills/cmux-team/manager/token-store.ts:912-997` — admitCandidates (特に 917 / 941 / 947-962 / 989 / 995)
- `skills/cmux-team/manager/token-store.ts:1094-1111` — peekNextToken (effUtil をそのまま util_5h/7d として返す)
- `skills/cmux-team/manager/pool-throttle.ts:42` — file-local STALE_THRESHOLD_MS (削除対象)
- `skills/cmux-team/manager/pool-throttle.ts:102-182` — countPoolTokens (特に 110-118 と 134-156 が DRY 対象)
- `skills/cmux-team/manager/token-format.ts:1-43` — 全体 (formatPerHandleUtilCell の追加先)
- `skills/cmux-team/manager/pool-cli.ts:74-105` — per-handle 行ループ (5H USE / 7D USE 列の差し替え対象)
- `skills/cmux-team/manager/token-cli.ts:317-355` — token list per-handle 行ループ (同上)
- `skills/cmux-team/manager/pool-header-display.ts:48-61` — buildNextPart (effUtil ベース確認済み、無変更)
- `docs/spec/09-token-pool.md:72-74` — token list セクション (spec 追記先 1)
- `docs/spec/09-token-pool.md:240-276` — stale 救済仕様 (変更なし、CLI 表示列の追記検討)
- `docs/spec/09-token-pool.md:377-475` — 7d Forecast / next 候補セクション (per-handle 行 effUtil の新サブセクション追加先)
- `docs/spec/09-token-pool.md:547-561` — 関連ファイル表 (token-format.ts 行に追記)

## 12. 補足: スコープ外であることの再確認

- TUI dashboard.tsx 1991-2002 の Pool ペインの per-row 表示は本タスクで触らない (タスク本文「スコープ外」条項)
- `--raw` フラグや usage_snapshots 保持期間 / GC は本タスク対象外
- dashboard.tsx の next: ヘッダーは無変更 (既に effUtil ベース)
