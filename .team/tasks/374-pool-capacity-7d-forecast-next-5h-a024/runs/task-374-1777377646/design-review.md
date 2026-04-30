# Design Review — T374 plan.md (pool capacity を 7d forecast ゲージ + next 候補 5h に再設計)

## 1. Verdict

**Approved** (with major recommendations to address before / during implementation)

## 2. Summary

A024 仕様への忠実度は高く、計算式・ビン切り出し・スパークライン文字マッピング・色閾値・エッジケースのすべてが §確定事項 / §計算式 / §TUI 表示 と整合する。検証ケース 1 / 2 を回帰テストに落とすアプローチも妥当。一方で **Phase 順序が型エラー期間を生む構造になっている**（PoolSummary.header 削除タイミング）、および **A024 文言（"非 stale" blocker）から admit 救済方針への意図的逸脱の取り扱いが artifact 側に残っていない** の 2 点は、実装着手前に方針を確定させるべき。

## 3. Critical Issues

なし。A024 §計算式、§TUI 表示、§エッジケース のすべてに対し、計画側の対応が一対一で対応している。Case 1 / Case 2 の数値（[108,108,71,71,71,100,100] / [126,126,94,71,71,78,100]）は手計算でも再現でき、付録 A / B の ISO 計算も整合する。

## 4. Major Issues

### M1. Phase 3 と Phase 4-5 の間で tsc が通らない期間が生まれる

`§9 Phase 3` で `PoolSummary.header` を削除し `forecast7d` / `nextCandidate` を追加した時点で、未更新の `pool-status-header.ts` / `pool-header-display.ts` / `dashboard.tsx (legacy buildPoolHeader)` / `pool-status-header.test.ts` / `pool-header-display.test.ts` が型エラーになる。`§9` は各 Phase 末で `bun test --timeout 30000 <file>` を pass させる前提だが、当該テストファイルは依存ファイルの型不整合でコンパイルできない。

該当ファイル: 上記 `grep "header\." | summary\.header"` で `pool-header-display.ts` / `pool-summary.ts` / `pool-status-header.ts`（および各 test）/ `dashboard.tsx` がヒット。`pool-summary.test.ts` の case A-E もすべて `header.capacity*Pct` を assert しているため Phase 3 単独では通らない。

「中間で動作確認できる粒度」（CLAUDE.md §設計原則）に反する。

### M2. A024 文言からの逸脱（非 stale blocker → stale 救済込み admit）の取り扱い

`§10.2` で「A024 §next 候補の選定 が "非 stale" を blocker と書いているが、現行 admit は T373 で stale 救済に方針変更済み。本タスクでは現行 admit と一致させる」と判断している。判断自体は spawn-agent と peek の整合性の観点で正しい（Conductor / Master surface で出した候補と spawn-agent 結果が乖離する方が UX 的に悪い）。

ただし A024 アーティファクト本体（status: confirmed）を更新せずに本計画書だけで方針転換を吸収すると、将来の retro / docs-sync で「A024 と実装が乖離している」と再発見される。**A024 を update して "non-stale 文言は T373 後の admit ロジックに従う" を追記**するか、**T374 完了時に新 artifact（決定）として記録**する必要がある。

### M3. TZ 固定テストの確実性

`§7.1` の `process.env.TZ = "UTC"` を `beforeAll` で設定する方針は、Bun / Node の `process.env.TZ` 変更が **既に作られた Date オブジェクトに反映されない**（V8 が tzdata を起動時に読み込む実装系がある）。Bun の最近のバージョンでは `process.env.TZ` の動的変更を一定程度反映するが、確実性は実装で要確認。

リスク: テストが green でも CI ホストの TZ に依存して数値がブレる可能性がある。Case 2 は Day 0=6h を要求するため特に敏感。

## 5. Minor Issues

### m1. `PeekedToken` に `util_7d` も含める方が将来拡張に強い

`§2.3` で `admitCandidates` の戻り値を `effUtil7d` まで返すように拡張しているのに、`§2.1` の `PeekedToken` は `util_5h` のみ。将来 next: 候補で 7d も併記したい / debug ログに出したい場合に再変更が必要になる。`{ handle, util_5h, util_7d }` で揃えるのが自然。

### m2. `§4.2` 境界値処理は A024 §TUI 表示 「12.5–25%: ▁」と整合するが test で明示すべき

A024 は "12.5–25%: ▁" と書いており、12.5 ちょうどがどちらに倒れるかは曖昧。plan §4.2 は `if (barPct < 12.5) return " "` で「12.5 ちょうどは ▁」を採用しており妥当だが、`§7.4` の境界値テストで `barPct = 12.5 → "▁"` / `barPct = 12.4999 → " "` を明示テーブル化しないと回帰しやすい。

### m3. `pool-cli.ts` / `token-cli.ts` 経路への影響確認が薄い

`§6.1` で「`pool-cli.ts` は `per_token.cap_pct` を引き続き利用」と記述があるが、実装前に grep で `loadPoolSummary` を呼ぶ場所が `header.capacity*Pct` を直接読んでいないかは未確認。`pool-cli.ts` が `cmux-team pool status` で旧 header を出していれば本タスクで合わせて消す必要がある（または明示的に「ここはまだ旧表示を残す」を実装方針に書く）。

### m4. tsconfig の unused チェック

`skills/cmux-team/manager/tsconfig.json` は `noUnusedLocals: false` / `noUnusedParameters: false` のため、`§10.3` で言及されている dead code 警告のリスクは事実上ゼロ。`pool-next-reset.ts` は dead code として残置で問題ない。**この事実を §10.3 に追記しておくと無用な配慮が消えて見通しが良くなる**。

### m5. `peekNextToken` の `expireLeases` 副作用

`§2.4` で `expireLeases` を呼ぶ設計は `selectToken` / `canSelectAnyToken` と同じだが、dashboard が頻繁に再描画するたびに DELETE クエリが走る。実害はないが、test で「`peekNextToken` 連続呼び出しが副作用として lease を再変更しないこと」を 1 ケース足すと将来の最適化（caching）の余地を残せる。

### m6. 検証ケース 1 / 2 の数値の境界条件

Case 1 で Day 1 binEnd=48 (= reset_A)、Day 2 binStart=48。`§1.2 integrateBin` の case 1 (`binEnd <= reset`) と case 2 (`binStart >= reset`) はどちらも等号を含むため、48 ちょうどは Day 1 で「全 pre」、Day 2 で「全 post」となり期待値と整合（手計算で確認済み）。**実装時は等号の包含を test fixture で明示**（境界 reset を持つ token を 1 ケース）すると後で off-by-one を踏みにくい。

## 6. Recommendations

### R1. Phase 順序を「拡張 → 切替 → 削除」に再配列する（M1 の解決）

Phase 3 で **`PoolSummary.header` を残したまま** `forecast7d` / `nextCandidate` を **追加** し、Phase 4-5 で UI を切替、最後に新 Phase 6（旧 6 を 7 に）で `header` フィールドを削除する。具体策:

- Phase 3: `PoolSummary` 型を `{ header, forecast7d, nextCandidate, perHandle }` に **拡張**（header はまだ残す）。`buildPoolSummary` で forecast / nextCandidate を計算しつつ、header も従来通り埋める
- Phase 4: `pool-status-header.ts` を新仕様に書き換え（forecast7d / nextCandidate を読む）。`pool-status-header.test.ts` 全置換
- Phase 5: `pool-header-display.ts` を新仕様に書き換え。`pool-header-display.test.ts` 全置換
- 新 Phase 5.5: `pool-summary.ts` から `header` フィールド削除 + `pool-summary.test.ts` 更新（旧 case A-E は capacity*Pct 検証から forecast7d / nextCandidate 検証に置換）
- Phase 6 以降: 既存通り

これにより各 Phase 末で `bunx tsc --noEmit` が pass する。

### R2. A024 文言の更新 or 新 decision artifact 起票（M2 の解決）

選択肢 A: **A024 を update**（status: confirmed のまま追補）。§next 候補の選定 の「非 stale」を以下の脚注付きで残す:

> ※ T373 以降、現行 `selectToken` admit は stale 救済方針に変更されている。本ヘッダーの next 候補は spawn-agent との整合のため admit 経路に追従し、stale でも reset 通過済み軸の effUtil*=0 救済込みで peek する。

選択肢 B: **新 artifact A025 (decision) を起票**して "T374 で peek を spawn-agent admit と一致させた経緯" を記録、A024 から `superseded_by` でリンクする。

どちらを採用するかは Master 確認推奨。本計画書での **§10.2 注釈だけでは不十分**（artifact 側で確認可能でなければならない、CLAUDE.md「state を外部化」原則）。

### R3. TZ 固定テストの実装方針を具体化（M3 の解決）

実装に入る前に小スクリプトで Bun の `process.env.TZ` 動作を確認し、不安定なら以下の代替案のいずれかに切替:

- **代替案 a**: テスト全体を `TZ=UTC bun test --timeout 30000 forecast.test.ts` で起動（package.json の test script に環境変数を埋め込む / bunfig.toml の env で固定）
- **代替案 b**: `forecast.ts` の `buildBinRanges` を「local 翌 0:00 を求めるロジック」を **入力 nowIso と timezone を引数で受ける純関数**にし、test では `tz="UTC"` を注入。本番呼び出し側のみ TZ を取得する責務を持つ
- **代替案 c**: `Intl.DateTimeFormat("en", { timeZone: "UTC", ... }).formatToParts(now)` で UTC 0:00 までの時間を計算する（`setHours` を使わない）

`§10.4` の DST 安全性テスト（`TZ='America/New_York'` の 3 月 13 日相当）も同じ機構に乗る。**代替案 b を推奨**: pure な純関数性が保たれ DST テストも書きやすい。

### R4. PeekedToken の shape 拡張（m1 の解決）

```ts
export interface PeekedToken {
  handle: string;
  util_5h: number | null;
  util_7d: number | null;   // ← 追加（admitCandidates が effUtil7d を持つので extra cost ゼロ）
}
```

将来 `next: @kddi 5h:65% / 7d:45%` のような表示拡張が必要になった際の互換変更を回避できる。

### R5. 境界値テストの明示テーブル（m2 / m6 の解決）

`forecast.test.ts` / `pool-status-header.test.ts` に以下のテーブルテストを追加:

```ts
test.each([
  [0,       " "],
  [12.4999, " "],
  [12.5,    "▁"],
  [25,      "▂"],
  [87.5,    "▆"],
  [99.9999, "▇"],
  [100,     "█"],
  [150,     "█"],
])("mapBarToSparkline(%f) === %p", (input, expected) => {
  expect(mapBarToSparkline(input)).toBe(expected);
});
```

forecast 側は「reset がちょうど bin 境界に一致する」ケースを 1 つ足す（A024 Case 1 そのものが該当するので、追加実装は最小）。

### R6. § 10.3 と pool-cli.ts 確認の事前追記

- `§10.3` に「`tsconfig.json: noUnusedLocals=false / noUnusedParameters=false` のため `pool-next-reset.ts` の dead 化は警告にならない」と明記
- 実装着手の最初の grep で `pool-cli.ts` / `token-cli.ts` が `header.capacity*Pct` を読んでいないことを確認し、読んでいたら `§6.1` のスコープに追記する

---

## 受け入れ判定の根拠

A024 §計算式・§TUI 表示・§エッジケース・§検証ケース のすべてが、計画側で明示的かつ正確に対応されている。Major 3 件はいずれも**設計の根幹（forecast 計算 / next peek / UI 表示）には影響しない**運用上の整地（実装フェーズ順 / artifact 整合 / TZ 注入手段）であり、Recommendations の対応は実装者が plan に追補するか先に R1 / R2 を解決してから着手すれば十分。

総合: **Approved**。R1（Phase 順序）と R2（artifact 更新方針）は実装着手前に確定させ、R3（TZ）は forecast.ts 着手の最初の段階で検証して plan に方針を追記すること。
