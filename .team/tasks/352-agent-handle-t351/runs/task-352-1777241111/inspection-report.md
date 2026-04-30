# T352 Inspection Report

## Verdict
GO

## Test Results
- `bun test --timeout 30000 dashboard-conductor.test.tsx dashboard-pool.test.tsx dashboard-issues.test.tsx dashboard-metrics.test.tsx`
  - **68 pass / 0 fail / 196 expect() calls**（4 ファイル合算）
- `bunx tsc --noEmit`
  - **0 errors**（exit 0、出力なし）

## Findings

### 仕様適合性（task.md / plan.md / design-review.md）

- **(severity: none)** Agent 行の spinner / roleIcon 直後に `@handle` 挿入 → `dashboard.tsx:758-797` で 3 status すべてに対応。
  - running: `[surface](CYAN)` → `spinChar(CYAN)` → `@handle(CYAN)` → `label`
  - idle: `[surface](CYAN)` → `roleIcon(plain)` → `@handle(plain)` → `label(dim)`
  - asking: `[surface](YELLOW)` → `?(YELLOW)` → `roleIcon(YELLOW)` → `@handle(YELLOW)` → `label(YELLOW)`
- **(severity: none)** 色仕様: running CYAN / idle plain / asking YELLOW を `style.fg` で正しく付与。idle 行は roleIcon の dim を解除し taskTitle のみ dim を維持（plan §2 / design-review minor #2 の判断と整合）。
- **(severity: none)** 未バインド時の handle 完全省略: `showAgentHandle = perHandle != null && a.tokenHandle != null` を条件式として 3 status すべてに適用。`buildPoolSuffixForSurface(..., false)` 側でも `tokenHandle == null → []` で `(no token)` を出さない。
- **(severity: none)** Master / Conductor 行への波及なし: `dashboard.tsx:507`（Master）, `:617`（Conductor）はいずれも 3 引数呼び出し（`includeHandle` 省略 → default `true`）で T351 挙動を維持。

### Design Review Recommendations 5 件

| # | Recommendation | 対応 | 備考 |
|---|---|---|---|
| 1 | `pool-surface-row.ts` 戻り値順序契約テスト必須化 | ✅ `dashboard-pool.test.tsx` case 11 (T352 順序契約) で 4 入力パターン × 「先頭ノードに `@handle` 含む / 後続ノードに含まない」を assertion 化 | `slice(1)` の安全性が tests で固定化された |
| 2 | case 8 で `countSurfaceLabel` 検証を残す | ✅ `dashboard-pool.test.tsx` case 8 で `(no token)` assertion を `not.toContain` に反転しつつ `countSurfaceLabel("200")==1` / `countSurfaceLabel("100")==1` を残存 | テスト本来の重複禁止 invariant を保持 |
| 3 | T352-7 (pool OFF) を `@` 不在 / suffix 不在に絞り込む | ✅ `expect(json).not.toContain("@")` / `not.toContain("<5h:")` / `not.toContain("cap:")` / `not.toContain("(no token)")` の 4 条件で表現。dim 構造の完全一致は assert していない | idle dim 範囲変更の波及で test が落ちないよう適切に絞り込み |
| 4 | T352-8 順序 assertion を単方向不等式に | ✅ `idxSurface < idxSpinner < idxHandle < idxLabel` の chained `toBeLessThan`。`indexOf` の見つからなかった時の -1 を `idxSurface > -1` で先に弾く | plan §5 / design-review #4 と一致 |
| 5 | テストに `style.fg` assertion を含める | ✅ T352-1（running, CYAN_VALUE = `rgb(0,180,180)`）と T352-3（asking, YELLOW_VALUE = `rgb(200,160,0)`）で `RegExp` による fg 値マッチを assertion 化。`@rezi-ui/core` の `rgb()` で integer 化された CYAN_VALUE もテストファイル冒頭で算出 | T352-2 (idle plain) は dim:true 不在のチェックで補完 |

### コード品質

- **(severity: none)** `buildPoolSuffixForSurface` の `includeHandle: boolean = true` 追加は plan (A) と一致。default `true` で既存 caller（Master / Conductor）の互換を破壊しない。
- **(severity: none)** `slice(1)` の安全性は `dashboard-pool.test.tsx` case 11 で「bound 入力で先頭は必ず `@handle` text node」契約として固定化済み。design-review minor #1 の整合性懸念を解消。
- **(severity: none)** Agent 行 3 status すべてが新レイアウトに切り替わっており、`ui.row` の null 子要素（`showAgentHandle ? ui.text(...) : null`）は既存 `dashboard.tsx:719` の利用実績パターンを踏襲。
- **(severity: none)** `daemon.ts` 等の上流変更なし（task.md「`tokenHandle` は agents snapshot に既に含まれる」と整合）。

### テスト品質

- **(severity: none)** 新規 T352-1〜T352-8 の 8 ケースが `dashboard-conductor.test.tsx` に追加され全 pass。Conductor は `@conductor`、Agent は `@kddi` の異なる handle を用いて重複検出可能な構成（`json.split("@kddi").length - 1` で出現回数を assertion）。
- **(severity: none)** 既存 case 6/7/9/10（surface ラベル重複禁止）に regression なし。case 8 は仕様変更を反映しつつ重複禁止 invariant を保持。
- **(severity: none)** `dashboard-issues.test.tsx` / `dashboard-metrics.test.tsx` も regression 0。

### 軽微な note（修正不要）

- **(severity: minor / informational)** T352-2 で idle handle が dim でないことを検証する際、`json.slice(idx-80, idx+80)` の文字列範囲スキャンで `"dim":true` 不在を確認する方式。`indexOf('"text":"@kddi"')` を起点にしているため Conductor 行 (`@conductor`) のノードと混同する可能性はないが、JSON node 境界を厳密に切り出していない点はやや fragile。今回はテスト fixture が `Conductor=@conductor / Agent=@kddi` と異 handle で構成されているため誤検出の余地はなく、実害なし。
- **(severity: informational)** `cmux-team start` での実機目視確認は本検品では実施していない（design-review #5 で必須化推奨されていた項目）。色変更（CYAN/YELLOW）と dim 範囲縮小は JSON snapshot test で構造的にカバー済みのため致命的ではないが、納品前に Conductor / Manager 側で実機確認しておくと万全。

## Fix Required

なし（GO）。

## Notes

- `dashboard.tsx` のコメント追記（L546-552, L753-757, L760-761, L781-782, L787-789）が plan / design-review の判断根拠を行内に説明しており、将来読みに親切。特に「先頭が必ず `@handle` text node である契約は dashboard-pool.test.tsx case 11 で固定化済み」のクロスリファレンスが入っているため、`slice(1)` を見て驚いた未来の読者が契約テストにすぐ辿れる。
- `pool-surface-row.ts` は plan §3 通り完全に無変更（`formatSurfaceRow` 等の CLI 経路にも影響なし）。design boundary が守られている。
- `buildPoolSuffixForSurface` のシグネチャは「surface row 整形 + dashboard 表示都合 (handle 抑止)」の 2 責務に薄く広がった。design-review notes 末尾の指摘どおり、将来 Master 行も含む広範な表示制御が必要になった時点で caller 種別 (`master`/`conductor`/`agent`) で param 化する案 (B) への再リファクタを検討。今回は YAGNI で OK。
- 検証コマンドは指示された 4 ファイル限定 + tsc のみ実施。CLAUDE.md の `bun test` 全体実行禁忌方針および inspector の作業境界（出力先以外への変更禁止）に整合。
