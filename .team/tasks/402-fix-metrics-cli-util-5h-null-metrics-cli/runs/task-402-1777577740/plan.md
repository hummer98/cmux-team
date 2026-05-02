# T402 実装計画書: util_5h=null 時の Metrics と CLI 表示の整列

## 1. 課題分析

### `snap.util_5h=null` と `snap.util_5h=0` の意味の違い

| 値 | 意味 | 発生条件 |
|----|------|---------|
| `snap.util_5h === null` | **値が来ていない** | proxy が rate limit ヘッダを未観測 / DB row は作られたが `util_5h` 列を埋められなかった (例: subscription token の初回登録直後で `anthropic-ratelimit-*` 未観測) |
| `snap.util_5h === 0` | **使用量 0 (実使用 0 or reset 後)** | 観測済みかつ実利用 0、もしくは `computeEffUtil` が `reset_5h_at` 経過 stale snapshot を effUtil=0 で上書きした結果 (`reset5hPassed=true`) |

両者は意味が直交するため、表示でも区別すべき。

### CLI / Metrics 双方の現挙動の根本原因

`formatPerHandleUtilCell` (token-format.ts:55-67) と `buildPoolTokenRowFromSnapshot` (dashboard-metrics.ts:211-229) は同じ `computeEffUtil` 経由だが、**null の扱い方** が逆になっている:

| 経路 | snap exists + util_5h=null のとき |
|------|---------------------------------|
| CLI | `eff.hasSnapshot=true` → `formatUtil(eff.effUtil5h)` = `formatUtil(0)` = `"0%"` ← `null` 情報が消える |
| Metrics | `util5h = snap?.util_5h == null ? null : eff.effUtil5h` で **`null` を優先**保持 → `buildPoolTokensSection` の `r.util5h !== null` ガードで bar 非描画 (空欄相当) |

`computeEffUtil` の `effUtil5h = snap.util_5h ?? 0` (token-store.ts:1006) で null を 0 に倒すため、effUtil 値だけ見ると null と 0 が同一視される。`null` 情報を保つには **呼び出し側で snap.util_5h を直接確認する** 必要があるが、CLI 側はそれをしていない。

加えて、Metrics 側は null のとき bar も placeholder も出さず空欄になるため、「reset 通過で 0」と「値がない」が一見区別できない。

### 「reset 通過で 0」と「値が来ていない (null)」の区別が壊れている経路

| ケース | snap | reset5hPassed | 現 CLI | 現 Metrics | 期待される一致した表現 |
|--------|------|--------------|--------|-----------|---------------------|
| (1) snap=null | null | false | `"--"` | `metrics_pool_no_data` 行 | 既に一致 |
| (2) snap exists + util_5h=null + reset 未通過 | exists, util_5h=null | false | `"0%"` | (空欄) | ✗ 乖離 → `"--"` で一致させたい |
| (3) snap exists + util_5h=null + reset 通過 | exists, util_5h=null | true | `"0%"` + `*` | (空欄) + `*` | ✗ 乖離 → `"0%"` + `*` (reset 通過は 0 確定) |
| (4) snap exists + util_5h=0 + reset 通過 | exists, util_5h=0 | true | `"0%"` + `*` | `0% bar` + `*` | 既に一致 |
| (5) snap exists + util_5h=数値 | exists | - | 数値% | 数値% bar | 既に一致 |
| (6) snap exists + util_5h=null + util_7d=数値 + 5h reset 通過 stale | exists, util_5h=null, util_7d=数値 | true | `"0%"` + `*` (5h) / 数値% (7d) | `0% bar` + 数値 bar + `*` | reset 通過軸は 0 確定、他軸は通常表示 |

(2) と (3) が本タスクで解決すべき乖離。(6) は片軸 null + 他軸数値 + 片軸 reset 通過の混合ケースで、D5 「reset 通過軸は元 null でも 0」を適用する代表例。

(3) は理論上は起こりにくい (proxy が `reset_5h_at` を観測したのに `util_5h` を観測していない状態) が、防御的に挙動を定義する。

## 2. 技術アプローチ

### 採用方針: **案 C を改良 — 「null vs 0 の区別」を CLI/Metrics 双方で同じ視覚言語 (`"--"` 表記) で表現**

| 状態 | CLI 表示 | Metrics 表示 |
|------|---------|-------------|
| 値がない (snap=null OR util_*=null かつ reset 未通過) | `"--"` (formatUtil(null) 既存挙動) | dim `"--"` (新 placeholder) |
| reset 通過で実質 0 (util_*=null OR 0、reset 通過) | `"0%"` + 行末 `*` | `0% bar` + 行末 `*` |
| 通常使用率 | `"42%"` | `42% bar` |

null と 0 を分ける軸は **`snap.util_*` が null かつ `reset*Passed=false` か** 否か。`reset*Passed=true` のときは「snap.util_* が null でも実質 0 とみなす」ことに統一する (reset 通過の意味を優先する。たとえ元 null でも reset_*_at が過去なら新ウィンドウは 0 から始まっている、という解釈)。

### 採用理由 (D1)

| 案 | 結論 | 理由 |
|----|------|------|
| 案 A: Metrics を CLI に合わせる (null → 0 で 0% バー) | **却下** | 「値がない」と「reset 通過 0」を視覚的に区別できなくなる。受け入れ条件②に違反 |
| 案 B: CLI を Metrics に合わせる (CLI で null → "-"/"--") | **採用 (片側)** | CLI の `formatUtil(null)="--"` 既存挙動と整合。`formatPerHandleUtilCell` の現実装は **既存の "--" パターンに合致していなかった** だけで、合致させるのが自然 |
| 案 C: 両者を合わせて新表現 (例: dim "—") | **却下** | CLI 側の既存 `formatUtil(null)="--"` を上書きすることになり、token list / pool status の他の null 表示 (`NEXT_RESET=--`、`CAP=--`) と表記が割れる。新規記号の導入はメリットなし |

→ **CLI の `"--"` 既存パターンに Metrics 側を合わせる (案 B 派生)** が最小変更かつ既存の視覚言語を壊さない最良案。null 専用の新記号は導入しない。

### null vs 0 の区別を CLI/Metrics 双方で同じ視覚言語で表現する (必須要件)

- **CLI**: `formatPerHandleUtilCell` で snap exists でも `snap.util_5h==null && !reset5hPassed` のとき `display5h="--"`、reset 通過なら `"0%"` + `*`。
- **Metrics**: `buildPoolTokenRowFromSnapshot` で **`reset*Passed=true` のときは util を 0 確定** に変更 (元 null でも 0 で扱う)。これにより null として残るのは「snap.util_*=null かつ reset 未通過」のケースのみとなる。`buildPoolTokensSection` で `r.util5h===null && r.hasSnapshot` の軸に dim `"5h:  --"` placeholder を描画する (現状の空欄を埋める)。

### 既存パターンとの整合性

- CLI の `formatUtil(null)="--"`、`formatReset(null)="--"`、pool-cli.ts:83 の `capStr=="--"` と統一。
- token-format.ts:61 の `eff.hasSnapshot=false` 分岐 (snap=null) も既に `display5h="--", display7d="--"` を返している。これと同じ表記を「snap exists + util_*=null + reset 未通過」軸にも適用するだけ。
- Metrics 側 `metrics_pool_no_data="no data"/"データなし"` は handle 行全体が no data のときの専用表示で、軸単位の null とは区別する。軸単位の placeholder は `"--"` 文字列リテラルで揃える (i18n 不要 = D4)。

### 「reset 通過時は元 null でも 0」とする根拠

- `computeEffUtil` (token-store.ts:1013-1022) は `reset_*_at` 経過 stale snapshot に対して `effUtil*=0` で上書きし `reset*Passed=true` を立てる。元 `snap.util_5h=null` のときも `null ?? 0 = 0 → 0` が `effUtil5h` に入り `reset5hPassed=true` が立つ。
- すなわち `computeEffUtil` 自身は「reset 通過したら 0 確定」の意味付けを既に表現している。null 維持を優先すると `computeEffUtil` の意味と矛盾する。
- よって Metrics の `util5h` フィールドも `reset5hPassed=true` のときは `effUtil5h=0` を採用し、null として残るのは reset 未通過の純粋な「未観測」のみとする。

## 3. 変更対象

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/token-format.ts` | `formatPerHandleUtilCell` で `snap.util_5h==null && !eff.reset5hPassed` のとき `display5h="--"` に分岐 (7d も同様)。reset 通過軸はこれまで通り `formatUtil(eff.effUtil5h)="0%"` |
| `skills/cmux-team/manager/dashboard-metrics.ts` | (a) `buildPoolTokenRowFromSnapshot` の `util5h/util7d` 計算式を「snap.util_*==null かつ reset*Passed=false なら null、それ以外 (reset 通過 or 値あり) は eff.effUtil*」に変更。 (b) `buildPoolTokensSection` の cells 構築で `c.row.util5h===null && c.row.hasSnapshot` の軸に dim `"5h:  --"` placeholder ui.text を出す (7d 同様)。`hasSnapshot` 全体 false のときの no data 行は既存挙動のまま |
| `skills/cmux-team/manager/token-format.test.ts` | snap exists + util_5h/util_7d=null の新ケースを 3 件追加 (5h null + 7d 数値 / 両軸 null / 両軸 null + 5h reset 通過済み) |
| `skills/cmux-team/manager/dashboard-metrics.test.tsx` | 同 fixture で `buildPoolTokenRowFromSnapshot` の戻り値検証 + `buildMetricsRows` 出力に `"5h:  --"` placeholder が描画されることの検証 (3 ケース追加) |

i18n キー追加は **しない** (D4)。`"--"` は CLI と Metrics で共通の文字列リテラルとして直接書く。

新規作成・削除ファイル: なし。

## 4. サブタスク分割 (TDD)

> **制約**: 旧挙動 (`formatPerHandleUtilCell` の `formatUtil(0)="0%"` for util=null) と新挙動を並行させない。S2 完了時点で「snap exists + util_5h=null + reset 未通過 → "0%"」は消滅していること。

### S1: token-format.test.ts に新規ケースを追加 (red)

- **対象ファイル**: `skills/cmux-team/manager/token-format.test.ts`
- **内容**: `describe("formatPerHandleUtilCell (T390)")` 末尾に T402 ケースを 3 件追加。`snap()` ヘルパーは既存をそのまま再利用。
  - **(t1)** `snap exists + util_5h=null + util_7d=0.5 + reset 未通過 (両軸とも未来 reset)` → `{ display5h: "--", display7d: "50%", marker: "" }`
  - **(t2)** `snap exists + util_5h=null + util_7d=null + 両 reset 未通過` → `{ display5h: "--", display7d: "--", marker: "" }`
  - **(t3)** `snap exists + util_5h=null + util_7d=null + 5h reset 通過 stale + 7d reset 未到達` → `{ display5h: "0%", display7d: "--", marker: "*" }` (reset 通過軸は `"0%"` 確定、未通過軸は `"--"` 維持)
- **メソッド制約**: 新ケースは既存 `STALE_RECORDED` / `FRESH_RECORDED` 定数を使い、現行 fixture と同じ pattern。新たな helper は作らない。
- **完了条件**: `cd skills/cmux-team/manager && bun test --timeout 30000 token-format.test.ts` を実行すると **3 件 fail** する状態 (S2 で green)。
- **検証コマンド**: `cd skills/cmux-team/manager && bun test --timeout 30000 token-format.test.ts 2>&1 | tail -20`

### S2: token-format.ts::formatPerHandleUtilCell に null 分岐を実装 (green)

- **対象ファイル**: `skills/cmux-team/manager/token-format.ts`
- **内容**: `formatPerHandleUtilCell` (line 55-67) の `display5h`/`display7d` 計算を以下に置き換える:
  ```ts
  // T402: snap exists + util_*=null かつ reset 未通過 → "--" を維持し、null と 0 を区別する
  const display5h =
    snap!.util_5h == null && !eff.reset5hPassed
      ? "--"
      : formatUtil(eff.effUtil5h);
  const display7d =
    snap!.util_7d == null && !eff.reset7dPassed
      ? "--"
      : formatUtil(eff.effUtil7d);
  ```
  `eff.hasSnapshot=false` 分岐 (line 60-62) は手を入れない (snap=null は引き続き `"--"`)。`marker` ロジック (line 65) も手を入れない。
- **メソッド制約**: `snap!.util_5h` は `eff.hasSnapshot=true` 後に到達するため必ず non-null snapshot 参照。`!` non-null assertion を使う (既存コメント line 52 で `snap=null` は line 60 で早期 return される旨を再確認)。
- **完了条件**:
  - S1 の (t1)/(t2)/(t3) を含む `token-format.test.ts` 全 24 件 pass。
  - 既存テスト @tayo / @kddi 等 (line 132-200) も pass を維持。
- **検証コマンド**: `cd skills/cmux-team/manager && bun test --timeout 30000 token-format.test.ts 2>&1 | tail -10`

### S3: dashboard-metrics.test.tsx に新規ケースを追加 (red)

- **対象ファイル**: `skills/cmux-team/manager/dashboard-metrics.test.tsx`
- **内容**:
  1. **`describe("buildPoolTokenRowFromSnapshot (CLI consistency)")` に追加**: 同 `snap()` ヘルパー / `NOW_MS` を再利用して以下 3 ケースを追加。
     - **(g)** `snap exists + util_5h=null + util_7d=0.5 + 両 reset 未通過` → `{ util5h: null, util7d: 0.5, hasSnapshot: true, reset5hPassed: false, reset7dPassed: false }` (片側 null)
     - **(h)** `snap exists + util_5h=null + util_7d=null + 両 reset 未通過` → `{ util5h: null, util7d: null, hasSnapshot: false, reset5hPassed: false, reset7dPassed: false }` (snap exists でも値全 null は no data 扱い、既存挙動)
     - **(i)** `snap exists + util_5h=null + util_7d=null + 5h reset 通過 stale` → `{ util5h: 0, util7d: null, hasSnapshot: true, reset5hPassed: true, reset7dPassed: false }` (T402 仕様: reset 通過軸は 0 確定)
  2. **`describe("buildMetricsRows: pool tokens marker (T401)")` の隣に新 describe `buildMetricsRows: util_5h null axis placeholder (T402)` を追加**:
     - **(j)** `util5h=null + util7d=0.5 + hasSnapshot=true` の row を渡すと、出力文字列に **行内に `"5h:  --"` が含まれ、かつ 7d 側の bar (`"50%"`) も含まれる**。`"*"` マーカーは出ない。
     - **(k)** `util5h=0 + util7d=null + hasSnapshot=true + reset5hPassed=true + reset7dPassed=false` (5h reset 通過、7d は純粋 null) の row を渡すと、出力文字列に **5h 軸の `"0%"` bar と末尾 `"*"` マーカー、7d 軸の `"7d:  --"` placeholder の三つが同一行内に含まれる**。これにより受け入れ条件②「『値がない』と『reset 通過で 0』が視覚的に区別できる」が同一行内 fixture で証明される (CRITICAL: 両ケース共存検証)。
  3. **CLI 等価性検証 ((d) と同パターン)**: token-format.test.ts (t1)/(t3) と同 fixture を使い、`formatPerHandleUtilCell` と `buildPoolTokenRowFromSnapshot` で「null 軸 → CLI で `"--"` / Metrics で `util_*===null` の状態」が同期していることを 1 ケース確認。
- **メソッド制約**: テストパス用フィクスチャは既存パターン踏襲 (`PoolTokenRow` の必須フィールド `reset5hPassed/reset7dPassed/hasSnapshot` を全て埋める)。
- **完了条件**: 上記新ケース全件が S4/S5 完了後に pass。
- **検証コマンド**: `cd skills/cmux-team/manager && bun test --timeout 30000 dashboard-metrics.test.tsx 2>&1 | tail -20`

### S4: buildPoolTokenRowFromSnapshot の null 判定を変更 (green)

- **対象ファイル**: `skills/cmux-team/manager/dashboard-metrics.ts`
- **内容**: line 217-218 の式を以下に置き換える:
  ```ts
  // T402: reset 通過軸は元 null でも 0 確定 (computeEffUtil の意味と整合)。
  // null として残るのは「snap exists かつ util_*=null かつ reset 未通過」のみ。
  const util5h =
    snap?.util_5h == null && !eff.reset5hPassed ? null : eff.effUtil5h;
  const util7d =
    snap?.util_7d == null && !eff.reset7dPassed ? null : eff.effUtil7d;
  ```
  `hasSnapshot` 計算 (line 225) はそのままで OK (`util5h !== null || util7d !== null` で十分。reset 通過時は片側でも 0 が入るので true になる)。
- **メソッド制約**: `eff = computeEffUtil(snap, nowMs)` は引き続き 1 回呼び出し。`snap?.util_5h * 1.0` のような生値直接演算は禁止。コメント (line 202-209) は実態を反映するよう更新。
- **完了条件**:
  - S3 (g)/(h)/(i) が pass。
  - 既存 (a)〜(f) ケース (line 555-714) も pass を維持 (特に `(h)` は既存挙動と整合: snap exists + 両軸 null は hasSnapshot=false)。
- **検証コマンド**: `grep -n "snap?.util_5h == null && !eff.reset5hPassed" skills/cmux-team/manager/dashboard-metrics.ts` で 1 件、 `grep -n "snap?.util_7d == null && !eff.reset7dPassed" skills/cmux-team/manager/dashboard-metrics.ts` で 1 件。

### S5: buildPoolTokensSection の軸別 null placeholder 描画 (green)

- **対象ファイル**: `skills/cmux-team/manager/dashboard-metrics.ts`
- **内容**: line 286-294 の cells 構築ループを以下に置き換える:
  ```ts
  const cells: any[] = [ui.text(c.row.handle.padEnd(maxHandleLen))];
  if (c.bar5h) {
    cells.push(...partsToUiText(padGrayParts(c.bar5h.parts, max5hGray)));
  } else if (c.row.util5h === null) {
    // T402: snap exists で軸 util=null（値が来ていない）は dim "5h:  --" を出して
    //       「reset 通過で 0」(0% bar) と視覚的に区別する。先頭 7 文字幅を
    //       buildUtilizationBar の "5h:  0%" と揃える (label + ":" + " " + " --" = 7 文字)。
    cells.push(ui.text("5h:  --", { dim: true }));
  }
  if (c.bar7d) {
    cells.push(...partsToUiText(padGrayParts(c.bar7d.parts, max7dGray)));
  } else if (c.row.util7d === null) {
    cells.push(ui.text("7d:  --", { dim: true }));
  }
  if (c.row.reset5hPassed || c.row.reset7dPassed) { ... }
  ```
- **メソッド制約**:
  - placeholder 表記は `"5h:  --"` / `"7d:  --"` (各 7 文字)。`buildUtilizationBar` (rate-limit-display.ts:110) の出力フォーマット `${label}:${pct.toString().padStart(3)}% ${bar}` は `"5h:  0%"` (label + ":" + 3-padded pct + "%") の **先頭 7 文字** を生成するため、placeholder の先頭 7 文字 `"5h:  --"` (label + ":" + " " + " --") とちょうど同幅で縦に揃う。bar 文字 `█░` は出さない (値がないので bar も出さないのが意図)。
  - `c.row.hasSnapshot=false` 行 (line 277-284 の handle 全体 no data 表示) は変更せず別経路で処理される。**論証**: S4 の判定式により `util5h=null` ⇔ `snap.util_5h==null && !reset5hPassed`、`util7d=null` ⇔ `snap.util_7d==null && !reset7dPassed`。両軸とも null になるとき `hasSnapshot = snap !== null && (util5h !== null || util7d !== null) = false` が必ず成立し、line 277 の no data 経路で吸収される。よって本ループ内で「両軸 placeholder」を出力する分岐は不要 (防御的に書かないこと)。
  - `max5hGray` / `max7dGray` の計算は bar が出る軸のみが対象 (line 273-274)。placeholder 行は計算対象外で OK。
- **完了条件**:
  - S3 (j)/(k) が pass。
  - 既存テスト 41 件 (T401 の 37 件 + 本タスクの 3-4 件) が全 pass。
- **検証コマンド**: `cd skills/cmux-team/manager && bun test --timeout 30000 dashboard-metrics.test.tsx 2>&1 | tail -20`

### S6: 関連テストファイルのレグレッション確認

- **対象ファイル**:
  - `skills/cmux-team/manager/token-format.test.ts`
  - `skills/cmux-team/manager/dashboard-metrics.test.tsx`
  - `skills/cmux-team/manager/token-cli.test.ts` (line 821 で `"0%"` を含むことを確認している @tayo 想定ケースが影響を受けないか)
  - `skills/cmux-team/manager/pool-cli.test.ts` (line 133 同上)
  - `skills/cmux-team/manager/token-store.test.ts` (computeEffUtil 直接の挙動確認)
  - `skills/cmux-team/manager/dashboard-issues.test.tsx`
- **内容**: 全 6 ファイルが pass することを確認。
  - 特に `token-cli.test.ts:821` / `pool-cli.test.ts:133` の "@tayo" は `util_5h=0.02` (null ではない) で reset 通過のケースなので、本タスクの変更の影響を受けない (`"0%"` 表示維持)。
- **完了条件**:
  ```bash
  cd skills/cmux-team/manager && for f in token-format.test.ts dashboard-metrics.test.tsx token-cli.test.ts pool-cli.test.ts token-store.test.ts dashboard-issues.test.tsx; do bun test --timeout 30000 "$f" || exit 1; done
  ```
  全件 pass。
- **メソッド制約**: `bun test` 全体実行は禁忌 (CLAUDE.md 既知の注意点)。個別ファイル実行のみ。

### S7: 受け入れ条件の手動確認 (review)

- **対象ファイル**: なし (動作確認)
- **内容**:
  1. **受け入れ条件 ①「同じ snapshot を CLI と Metrics で表示した時、表現が一致」** を S1 (t1) と S3 (g)/(j) のテストでカバーしていることを確認。具体的には fixture を共有し、CLI 側 `display5h="--"` と Metrics 側 `util5h=null + placeholder "5h:  --"` が同期して描画されることを保証する。
  2. **受け入れ条件 ②「『値がない』と『reset 通過で 0』が視覚的に区別できる」**:
     - 値がない: CLI `"--"`, Metrics dim `"5h:  --"` (bar なし、先頭 7 文字幅)
     - reset 通過 0: CLI `"0%" + *`, Metrics `5h:  0% ░░░░...` bar + `*` (先頭 7 文字幅)
     - S3 (k) (`util5h=0 + util7d=null + reset5hPassed=true`) で同一行内に「5h `0%` bar + `*` マーカー」と「7d `"7d:  --"` placeholder」の三者が共存することを確認するテストを置く (CRITICAL: 両ケース共存検証)。
- **完了条件**: S3 の (j)/(k) と S1 の (t1)/(t3) が pass。

## 5. リスク

### pool-cli / token-cli 出力フォーマットの後方互換 (CLI は機械可読される可能性)

- 現状 `formatPerHandleUtilCell` は **snap exists + util_5h=null** のとき `"0%"` を返している。これを `"--"` に変える破壊的変更 (D3 の主要影響範囲)。
- **影響範囲**: snap exists + util_*=null は subscription token 登録直後の極短時間 / proxy が rate limit ヘッダ非対応リクエストのみ観測した直後に発生。実運用の定常状態ではほぼ起きない。
- **下流への影響**: 同じ CLI 出力では既に `"--"` が複数箇所で使われている (`NEXT_RESET=--` / `CAP=--` / formatUtil(null) 経由の 5H_USE/7D_USE)。grep で `"0%"` を期待する側は存在しない (CLAUDE.md「機械可読される可能性」は仮想的、実装で grep する箇所は無い)。
- **`"0%"` の grep 結果一覧** (D3 の根拠):

  ```
  skills/cmux-team/manager/pool-cli.test.ts:133  → @tayo (util_5h=0.02, reset 通過) — 影響なし
  skills/cmux-team/manager/token-cli.test.ts:821 → 同上
  skills/cmux-team/manager/dashboard-metrics.test.tsx:621-622 → CLI 等価性検証 — 影響なし
  skills/cmux-team/manager/token-format.test.ts:143/171 → util_5h=数値 — 影響なし
  ```

  すべて util_5h が **数値** のテストで `null` ケースではないため、本タスクの破壊的変更 (snap exists + util_*=null → `"--"`) の影響を受けない。
- **後方互換**: 取らない (CLAUDE.md feedback「後方互換コードは不要」)。CHANGELOG にだけ「snap exists で util_*=null の軸は `"0%"` ではなく `"--"` に変わる」と一行記載するのが望ましいが、本タスクのスコープでは CHANGELOG は触らず、実装と test の更新のみ。

### スナップショット形式の取り違え (`snap=null` vs `snap.util_5h=null` の区別)

- `eff.hasSnapshot` の意味は **「snapshot row が DB に存在し、かつ utilization 列が片方でも非 null」** ではなく、**「snapshot row 自体が存在 (snap !== null)」** だけ。`hasSnapshot=true` でも軸の util が null になる組み合わせがある。
- token-format.ts:60-62 の早期 return は **`snap===null` の場合のみ** で、軸 util が null かは関知していない。S2 で追加する分岐は早期 return の **後** に置くため、`snap!=null && (util_5h===null || util_7d===null)` のパスを正しく処理する。
- `PoolTokenRow.hasSnapshot` (dashboard-metrics.ts:225 の式 `snap !== null && (util5h !== null || util7d !== null)`) は本タスク変更後も意味が変わらない: reset 通過時は util*=0 が入るので `util5h !== null` が true になり、`hasSnapshot=true` を維持する。

### 既存テストでハードコードされた `"0%"` 文字列

- `token-cli.test.ts:821`: "@tayo" 行に `"0%"` を期待。これは `util_5h=0.02 (≠ null)` + reset 通過のケースで、表示は今後も `"0%"` 維持 (S2 の新分岐は `util_5h==null` のみが対象)。
- `pool-cli.test.ts:133`: 同上。
- `token-format.test.ts:143/171`: 既存 `display5h: "0%"` は全て util 数値ありのケース。影響なし。
- 影響を受けるテスト断面はないことを S6 で確認する。

### Metrics 側の placeholder と padding 計算の整合

- `max5hGray` / `max7dGray` (line 273-274) は **bar が出る token のみ** が計算対象 (line 304-315)。placeholder 軸 (`util*===null`) は計算対象外なので、placeholder 行と bar 行で reset 残時間列の縦揃えが破綻することはない。
- `"5h:  --"` placeholder (label + ":" + " " + " --" = **7 文字**) は `buildUtilizationBar` の `"5h:  0%"` (label + ":" + 3-padded pct + "%" = **7 文字**) と先頭幅が一致するため、bar あり行と placeholder 行が縦に揃う設計。

## 6. 既存型エラーの先読み

```bash
bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json 2>&1 | grep -E "(token-format|dashboard-metrics|token-cli|pool-cli|i18n)"
```

実行結果: **(no matching errors)**  (Planner 検証時 / 2026-04-30 時点)

### 6.1 本タスクのスコープで解消するエラー

該当なし。

### 6.2 後続タスク (cleanup) に分離するエラー

該当なし。

> 注: S4 で `buildPoolTokenRowFromSnapshot` 内の判定式を変更しても返り値型 `PoolTokenRow` のフィールドは変わらないため、呼び出し側の型エラーは発生しない。

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| **D1** | 案 A/B/C のどれを採用するか | **案 B 派生 (CLI 既存の `"--"` パターンに Metrics を合わせる + reset 通過時は CLI も Metrics も `"0%"` に統一)** | (1) 案 A は受け入れ条件②「null と 0 の区別」に違反。(2) 案 C の新表現 (em dash 等) は CLI 内の他の null 表記 (`NEXT_RESET=--`, `CAP=--`) と表記が割れる。(3) 案 B 派生は既存の `formatUtil(null)="--"` パターンに整列するだけで、`computeEffUtil` の意味 (reset 通過 → 0) とも整合する |
| **D2** | null と 0 の視覚的区別をどう実装するか (CSS / 文字 / dim) | **CLI と Metrics 共通の文字列リテラル `"--"` を使い、Metrics 側のみ `dim: true` を付ける** | (1) CLI 側は dim 概念がないので `"--"` 直書き。(2) Metrics 側は `ui.text("5h:  --", { dim: true })` で他の placeholder (`metrics_label_no_data` / `metrics_pool_no_data`) と同じ視覚優先度に揃える。(3) Mark 列の `"*"` は dim、現状維持 |
| **D3** | CLI 後方互換 ("--"/"0%" 採用なら破壊的変更の影響範囲) | **破壊的変更を許容、CHANGELOG に注記しない (本タスクスコープ外)** | (1) 影響範囲は subscription token 登録直後等の極短時間で発生する `snap exists + util_*=null` の稀なケース。 (2) CLAUDE.md feedback「後方互換コードは不要」。(3) grep `"0%"` で確認: pool-cli.test.ts:133 / token-cli.test.ts:821 / dashboard-metrics.test.tsx:621-622 / token-format.test.ts:143,171 はすべて util_5h=数値ケースのみで影響なし (リスク節参照)。(4) 受け入れ条件は CLI/Metrics 一致の方が優先 |
| **D4** | 軸単位 null placeholder に i18n キーを追加するか | **追加しない**。`"--"` 文字列リテラル直書き | (1) CLI 側の `formatUtil(null)="--"` も既に直書き。(2) i18n 化すると CLI/Metrics でキーが分かれて drift する可能性。 (3) `"--"` は記号で、英日とも同じ表記で済む。 (4) 将来 `"--"` を別表記にしたければそのとき定数化すれば良い (YAGNI) |
| **D5** | reset 通過時に元 `snap.util_*=null` だった軸を 0 と扱うか null と扱うか | **0 と扱う (reset 通過の意味を優先)** | (1) `computeEffUtil` (token-store.ts:1013-1022) は元値が null でも reset 通過なら effUtil=0 として返す。これと整合させる。(2) reset 通過は「実利用が新ウィンドウで 0 から始まっている」を意味し、null (未観測) より strong な情報。(3) reset5hPassed=true は marker `*` で「元 null だった可能性も含む」状態を表現できる |
| **D6** | placeholder 表記を `"5h:  --"` (7 文字) にするか単に `"--"` にするか | **`"5h:  --"` を採用 (軸ラベルを残し、bar 行と先頭 7 文字幅を一致させる)** | `buildUtilizationBar` の出力 `"5h:  0% █████░░░░░"` は `${label}:${pct.toString().padStart(3)}% ${bar}` で先頭 7 文字 `"5h:  0%"` (label + ":" + 3-padded pct + "%")。placeholder も同じ 7 文字幅 `"5h:  --"` (label + ":" + " " + " --") にすることで、bar あり行と placeholder 行の先頭ラベル位置が縦に揃い、ユーザーが「どの軸が値なし」かを一目で識別できる。短く `"5h: --"` (6 文字) にすると 1 文字ズレて視覚整列が壊れる |
| **D7** | テストで CLI 等価性をどう示すか | **token-format.test.ts と dashboard-metrics.test.tsx で同 fixture を共有** (T401 D6 と同方針) | 既存 (d) ケースの fixture 共有パターンを T402 (t1)/(g) でも踏襲。「同じ入力 → 両関数が同じ判断」を fixture 共有で示すのが最も明示的 |
| **D8** | Metrics 側 placeholder を bar の代わりに出すかバー描画も継続するか | **bar 描画はせず、軸ラベル + `"--"` のみ出す** | (1) 値がないのに bar 描画は意味的に矛盾。(2) `buildUtilizationBar` の `utilization` パラメータは number 必須なので null では呼べない。(3) `0% bar` を出すと「reset 通過 0」と区別がつかない (受け入れ条件②違反) |

## 完了条件サマリ

- 計画書に 1〜7 章を記載 ✓
- (S1〜S7 完了後) 受け入れ条件 ①② が test レベルで証明されている
- 関連 6 テストファイル個別実行で全 pass
- touched files の `bunx tsc --noEmit` がエラーなし
- pool-cli / token-cli の "@tayo" 系既存出力フォーマットに変化なし (utilization 数値ありケースは現状維持)
