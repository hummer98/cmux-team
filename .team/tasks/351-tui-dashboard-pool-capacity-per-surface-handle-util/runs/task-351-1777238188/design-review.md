# T351 plan.md design review (revision 2)

## 結論

**Approved**

前回指摘した Recommendation 1〜7 はすべて plan.md の本文と「改訂履歴 (revision 2)」セクションに反映されており、実コードとの整合性も再確認した結果、blocker / major 級の残存指摘はゼロ。minor 指摘は 3 件あるが、いずれも Implementer が Step 進行中に判断・補正できる範囲のもの。

## 前回指摘の取り込み状況

| # | Recommendation 要約 | 取り込み状況 | 備考 |
|---|---|---|---|
| 1 | initTokenDB cache 誤認の撤廃 + DaemonState.tokenDb 新設 | ✓ | §2.1 採用理由 #2 (line 24)・§7.1 (line 285-289)・§3 影響範囲・§4 Step 3 #1〜#3・§6 DoD line 278 すべてで「キャッシュしない」「daemon 起動時 1 度だけ open」「`buildPoolSummary(db)` を直接呼ぶ」が明示。CLI は 1-shot で従来通り `loadPoolSummary` 経由。 |
| 2 | tick / updateTeamJson 事実誤認の修正 | ✓ | §2.1 line 28 で「`tick` 関数ではなく `main.ts:1119-1127` のメインループに挿入する — `tick` 自体は `scanTasks → monitorConductors → proxy 死活` のみで `updateTeamJson` を呼ばない」と明文化。§4 Step 3 #4 で挿入位置を `tick → updateTeamJson → updateSidebarStatus → refreshPoolSnapshot → scheduleRefresh` の順で確定。`DaemonState.rateLimit` との対称性根拠も「state に snapshot を置いて dashboard が読むデータフローの構造的対称性のみ」と限定 (line 23)。 |
| 3 | buildSurfaceRowSuffix API 確定 | ✓ | §2.3 line 99-115 で **案 X (`[surface]` を含まない)** を採用と明記。戻り値構造 (`[ui.text("@kddi"), ui.text("<5h:..>"), ui.text("cap:Z%"), ui.text("⚠"?)]`) を確定。bind なし `(no token)` / pool OFF (`[]`) も明文化。surface 表記の二重出力禁止は §5 case 6/7/8/10 (line 257-261) で assertion 化。 |
| 4 | case A の expected 実値再算出 | ✓ | §2.3 line 78 で `173%` レイアウト例は「2 token 合算想定の架空値」と注釈。§5 case A (line 239-243) で `util_5h=0.5, util_7d=0.5, t_5h=5, t_7d=168, plan_ratio=20` から `flow = min(2.0, 0.0595) = 0.0595` → `cap_pct = 0.0595/(20/168)*100 ≒ 50%` を式変形ごと明記。 |
| 5 | Step 2 「目視確認」の test 化 | ✓ | §4 Step 2 #3 で `cmux-team status > before.txt; ...; diff before.txt after.txt` の手順を pool ON / OFF 双方で実施と明文化 (line 162)。§5 case D (selectable=0 が nextReset 入力に残る)・case E (perHandle キー集合 = listTokens 全 handle) を pool-summary.test.ts に追加 (line 246-247)。 |
| 6 | buildMasterSection 互換記述の弱化 | ✓ | §2.4 line 132 で「**export されていない内部関数**。test ファイルから直接呼ばれる経路もないため、signature 拡張は自由」「optional default はあくまで保険」と明示。§7.4 line 301 でも同旨を確認。 |
| 7 | proxy/dashboard 挙動差 follow-up | ✓ | §7.7 line 313-321 で「**dashboard / daemon 側も同じく boot 時 1 回評価で固定する**」方針に切替（修正案の後者を採用）。`docs/spec/09-token-pool.md` への追記は follow-up タスクとして残し DoD には含めない、と明記。 |

すべて取り込まれており、改訂履歴 (revision 2) セクション (line 325-339) も Recommendation 番号ごとの反映先・主な変更内容を表形式で整理している。

## 残存指摘

### 1. case A 算式の symbolic 表記が誤読を誘う恐れ（minor）

- **項目**: §5 case A line 240-243
- **指摘内容**: 「`t_5h = 5`, `t_7d = 168`, `remaining_5h = remaining_7d = 0.5`」と書かれているが、`remaining = 1 - util` の式変形を 1 行省略している。実コード (`token-store.ts:745-746`) の `remaining5h = Math.max(0, 1 - util5h)` を読まないと「util=0.5 から remaining=0.5 が出る」が読み取れない。Implementer が読み返したときに「fixture の util_5h を 0.5 ではなく remaining_5h=0.5 として直接書く」と誤実装する余地がある。
- **重要度**: minor
- **対応案 (Implementer 判断で OK)**: case A 本文に「`remaining_5h = Math.max(0, 1 - util_5h) = 0.5`」の式を 1 行挿入するだけで誤解の余地が消える。本実装に入る前に test を書く時点で `token-store.ts:745` を再読すれば気づくレベル。

### 2. `buildSurfaceRowSuffix` の「pool OFF (perHandle == null)」の表現がぶれている（minor）

- **項目**: §2.3 line 108 と §4 Step 4 #1 の 4 ケース目 (line 191)
- **指摘内容**: §2.3 では「pool OFF (perHandle == null): 空配列 `[]` を返す」と書いているが、§4 Step 4 #1 のテストケース 4 では「**pool OFF（perHandle に該当 handle なし相当の入力 = capPct:null, util:null）**」と表現されており、これは厳密には「pool ON だが当該 surface の handle が perHandle Map にない」ケース。`buildSurfaceRowSuffix` は input を受ける純関数で、引数として受けるのは個別 handle 用のフィールド (`handle`, `util5h`, `util7d`, `capPct`) であって `perHandle` Map ではない。Step 4 のテスト名「pool OFF」はやや誤解を招く（実際には pool OFF なら呼び出し元が空配列を返すので関数自体に到達しない）。
- **重要度**: minor
- **対応案**: Step 4 #1 のテストケース 4 を「**pool ON だが該当 handle の cap/util データなし (capPct:null, util:null)**」に rename する。動作仕様自体は §2.3 の「pool OFF → 空配列」と整合しており実害はない。

### 3. case D / case E の現行 in-line 実装との等価性が plan で明示されていない（minor、ただし実コード側で確認済み）

- **項目**: §5 case D, case E
- **指摘内容**: plan は case D / case E が「現行 in-line 実装と等価であることを保障する」と読める書き方になっているが、本当に現行 (`main.ts:1444-1483`) の挙動と一致するかは plan 内で検証していない。レビュー側で `main.ts:1460-1468` を再確認したところ、`poolHandleData` は `for (const t of tokens)` で **listTokens の全 handle** に対して entry を作り、`capByHandle.get(t.handle) ?? null` で capPct を埋めるため、`plan_ratio == null` の token は capPct: null になる。`computePoolCapacity` は `plan_ratio == null` を `continue` で除外する (`token-store.ts:741`)。case D の `selectable` 列も `main.ts:1469-1481` で `nextReset` の入力に渡されている。**結論として case D / case E の主張は現行実装と整合しており、buildPoolSummary をこの仕様で実装すれば diff = 0 で通る。**
- **重要度**: minor (実コード照合済み、回帰なしを確認できているため)
- **対応案**: plan §5 case C / case D / case E の脚注に「現行 `main.ts:1444-1483` の in-line 実装と等価」と一言添えるとより安心。Implementer が Step 2 の `diff before.txt after.txt` でも検出可能。

## Recommendations

なし（Approved）。上記 minor 指摘は Implementer が test を書く / Step 2 の diff 検証を通じて自然に検出できる範囲。

## 検証ログ

### plan.md / 前回 design-review.md

- `.team/tasks/351-.../runs/task-351-.../plan.md` 全行 (1-340)
- `.team/tasks/351-.../runs/task-351-.../design-review.md` 全行 (1-185)

### 実コード再確認（Recommendation 反映の妥当性チェック）

- `skills/cmux-team/manager/token-store.ts:725-767` — `computePoolCapacity` の `plan_ratio == null` 時 `continue` 挙動、`remaining = max(0, 1 - util)`、`flow = min(...candidates)`, `cap_pct = flow / REFERENCE_FLOW * 100` を再確認。case A の式変形 (`flow = min(0.5*20/5=2.0, 0.5*20/168≒0.0595) = 0.0595`, `cap_pct = 0.0595 / (20/168) * 100 ≒ 50%`) が plan §5 と整合することを検算。
- `skills/cmux-team/manager/main.ts:1430-1530` — 現行 `cmdStatus` の `poolHandleData` 構築ロジックを再確認。`for (const t of tokens)` で listTokens 全 handle を `poolHandleData` に入れ、`capByHandle.get(t.handle) ?? null` で capPct を埋める。case C / case E の主張と一致。`selectable: t.selectable` を `computeNextReset` の入力に渡している箇所 (line 1479) が case D の主張と一致。

### 重要な照合結果

| 観点 | 確認 |
|---|---|
| `initTokenDB` のキャッシュ有無 | キャッシュなし（前回確認済み）。plan revision 2 はこの実態を正しく反映 |
| `tick` が `updateTeamJson` を呼ぶか | 呼ばない（前回確認済み）。plan revision 2 は `main.ts` メインループ挿入で確定 |
| `case A cap_pct ≒ 50%` の式 | 検算で 50.0% と一致（誤差 < 0.01%） |
| case C `plan_ratio == null` の perHandle 扱い | `computePoolCapacity` は per_token から除外、`poolHandleData` (perHandle) は全 token を含み capPct: null。plan §5 case C と整合 |
| case D `selectable=0` の nextReset 扱い | `computeNextReset` 入力に `selectable: t.selectable` を渡している現行実装と plan §5 case D が整合 |
| `buildSurfaceRowSuffix` の二重出力禁止 | §5 case 6/7/8/10 で `JSON.stringify` した戻り値に `[100]` / `[surface:` が含まれない assertion を明示 |
