# T402 実装レポート: util_5h=null 時の Metrics と CLI 表示の整列

## Completed Tasks

- **S1**: `token-format.test.ts` に T402 RED ケースを 3 件追加 (`(t1)` 5h null + 7d 数値、`(t2)` 両軸 null + reset 未通過、`(t3)` 両軸 null + 5h reset 通過 stale) — 完了確認: 3 件 fail (期待通り)
- **S2**: `token-format.ts::formatPerHandleUtilCell` に `snap.util_*==null && !eff.reset*Passed` 分岐を追加 — 完了確認: 23/23 pass
- **S3**: `dashboard-metrics.test.tsx` に T402 RED ケースを 5 件追加 (`(g)` 片側 null、`(h)` 両軸 null、`(i)` reset 通過 stale、`(j)` `5h:  --` placeholder + 7d bar、`(k)` 5h `0%`+`*` と 7d `7d:  --` placeholder の同一行内共存)、加えて CLI/Metrics 等価性検証 1 件 — 完了確認: 3 件 fail ((i)(j)(k))
- **S4**: `buildPoolTokenRowFromSnapshot` の null 判定を `snap?.util_* == null && !eff.reset*Passed` に変更 (reset 通過軸は元 null でも 0 確定)
- **S5**: `buildPoolTokensSection` の cells 構築に軸単位 placeholder (`"5h:  --"` / `"7d:  --"`、各 7 文字、dim) を追加 — 完了確認: 45/45 pass
- **S6**: 関連 6 テストファイル全 pass + `bunx tsc --noEmit` で touched files 型エラー 0 件
- **S7**: 受け入れ条件 ①② が S1 (t1)(t3) と S3 (g)(j)(k) の test レベルで証明済み

## Files Changed

| パス | 変更概要 |
|------|---------|
| `skills/cmux-team/manager/token-format.ts` | `formatPerHandleUtilCell`: `snap.util_5h==null && !eff.reset5hPassed` のとき `display5h="--"` (7d も同様)。reset 通過軸は従来通り `formatUtil(eff.effUtil5h)`。snap=null 早期 return は維持 |
| `skills/cmux-team/manager/dashboard-metrics.ts` | (a) `buildPoolTokenRowFromSnapshot`: `util5h/util7d` 計算を「`snap.util_*==null` かつ reset 未通過なら null、それ以外は `eff.effUtil*`」に変更し、JSDoc 更新。(b) `buildPoolTokensSection`: cells 構築ループで `c.bar5h` がない & `c.row.util5h===null` のとき `ui.text("5h:  --", { dim: true })` を push (7d 同様)。両軸 null の防御的分岐は書かない (両軸 null は `hasSnapshot=false` になり line 277 の no data 経路で吸収される) |
| `skills/cmux-team/manager/token-format.test.ts` | T402 ケース 3 件 (t1)(t2)(t3) を `formatPerHandleUtilCell (T390)` describe 末尾に追加 |
| `skills/cmux-team/manager/dashboard-metrics.test.tsx` | (a) `buildPoolTokenRowFromSnapshot (CLI consistency)` describe に (g)(h)(i) と T402 CLI 等価性検証 1 件を追加。(b) 新 describe `buildMetricsRows: util_5h null axis placeholder (T402)` で (j)(k) を追加 (受け入れ条件②の同一行内共存検証) |

新規作成・削除ファイルなし。i18n キー追加なし (D4 通り `"--"` 文字列リテラル直書き)。

## TDD Cycles / Verification Results

### S1 RED → S2 GREEN (formatPerHandleUtilCell)

- **S1 (RED)**: `bun test --timeout 30000 token-format.test.ts` → `20 pass / 3 fail (T402 t1, t2, t3)` を確認。`(t2)` の error は `display5h: "0%"` が `display5h: "--"` を期待した assertion で fail (既存挙動が `formatUtil(0)="0%"` を返すため)。
- **S2 (GREEN)**: `formatPerHandleUtilCell` に `snap!.util_5h == null && !eff.reset5hPassed ? "--" : formatUtil(eff.effUtil5h)` を実装。
  - `bun test --timeout 30000 token-format.test.ts` → `23 pass / 0 fail`
  - 既存テスト (`@tayo` `util_5h=0.02 + reset 通過 → "0%"+*`、`@kddi` 想定 `0.02/0.97 + reset 未通過 → "2%"/"97%"`) も含めて全 pass を維持。

### S3 RED → S4 GREEN → S5 GREEN (Metrics)

- **S3 (RED)**: `bun test --timeout 30000 dashboard-metrics.test.tsx` → `42 pass / 3 fail (i, j, k)`。
  - (i): `r.util5h: 0` を期待したが現実装は `null` を返す (snap?.util_5h == null → null) → S4 で修正必要。
  - (j): `"5h:  --"` placeholder 描画なし。stringified 出力に `"@partial"` の row が `bar7d` のみで bar5h 軸の placeholder が欠落 → S5 で修正必要。
  - (k): `"7d:  --"` placeholder 描画なし。同上。
  - `(g)` `(h)` および CLI 等価性検証は既に GREEN (現実装で偶然 pass)。
- **S4 (GREEN)**: `buildPoolTokenRowFromSnapshot` を `snap?.util_5h == null && !eff.reset5hPassed ? null : eff.effUtil5h` に変更 (7d も同様)。
  - `grep -n "snap?.util_5h == null && !eff.reset5hPassed" skills/cmux-team/manager/dashboard-metrics.ts` → 1 件 (line 219) を確認。
  - `grep -n "snap?.util_7d == null && !eff.reset7dPassed" ...` → 1 件 (line 221) を確認。
  - この時点で (i) は GREEN だが (j)(k) は依然 fail (cells 構築側の placeholder 描画が未実装のため)。
- **S5 (GREEN)**: `buildPoolTokensSection` の cells 構築ループに `else if (c.row.util5h === null)` 分岐 (および 7d 版) を追加。
  - `bun test --timeout 30000 dashboard-metrics.test.tsx` → `45 pass / 0 fail`
  - (j) (k) GREEN、既存 (a)〜(f), (e), (e2), (f) も pass 維持。

### S6 VERIFY (関連テスト regression)

```text
=== token-format.test.ts ===          23 pass / 0 fail
=== dashboard-metrics.test.tsx ===    45 pass / 0 fail
=== token-cli.test.ts ===             39 pass / 9 skip / 0 fail
=== pool-cli.test.ts ===               4 pass / 0 fail
=== token-store.test.ts ===          154 pass / 1 skip / 0 fail
=== dashboard-issues.test.tsx ===     11 pass / 0 fail
```

`token-cli.test.ts:821` / `pool-cli.test.ts:133` の `@tayo` 想定 (`util_5h=0.02 + reset 通過 → "0%"+*`) は今回の変更の影響を受けないことを確認 (S2 の新分岐は `snap.util_5h==null` のみ対象、数値 0.02 は通常経路を通る)。

### tsc 型チェック

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-402-1777577740
bunx tsc --noEmit 2>&1 | grep -E "(token-format|dashboard-metrics|token-cli|pool-cli)\.(ts|tsx)" | head -20
```

→ touched files の型エラー 0 件。

### S7 review (受け入れ条件)

- **受け入れ条件 ①「同じ snapshot を CLI と Metrics で表示した時、表現が一致」**:
  - `dashboard-metrics.test.tsx` の `(T402 CLI 等価性)` test ケース (snap exists + util_5h=null + util_7d=0.5 + reset 未通過) で CLI 側 `display5h="--"` と Metrics 側 `util5h=null + formatUtil(null)="--"` の同期を 1 fixture で検証。
  - `token-format.test.ts (t1)` と `dashboard-metrics.test.tsx (g)` で同一 fixture (片側 null + 数値) の挙動を双方向に確認済み。
- **受け入れ条件 ②「『値がない』と『reset 通過で 0』が視覚的に区別できる」**:
  - `dashboard-metrics.test.tsx (k)` (5h `util=0 + reset5hPassed=true`、7d `util=null + reset 未通過`) で同一行内に「5h `0%` bar + `*` マーカー」と「7d `"7d:  --"` placeholder」の三者が共存することを直接 string assertion (`expect(s).toContain("0%")` / `expect(s).toContain('"*"')` / `expect(s).toContain("7d:  --")`) で検証。これにより同一 token の 1 行に「値なし軸」と「reset 通過 0 軸」が並ぶケースで視覚的区別が機能することを保証。

## Issues Encountered

特になし。plan の重要な実装制約 (placeholder 7 文字、両軸 null + hasSnapshot=true は構造上発生しないため防御分岐を書かない、旧経路を残さない) はすべて遵守。

- placeholder 文字列は `"5h:  --"` / `"7d:  --"` (各 7 文字、`buildUtilizationBar` の `"5h:  0%"` 出力と先頭 7 文字幅一致) を採用。
- S3 の (k) fixture は plan の最終形 `util5h=0 + util7d=null + hasSnapshot=true + reset5hPassed=true + reset7dPassed=false` を使用 (旧 plan の `util5h=null + reset5hPassed=true` は構造上発生しないため不採用)。
- S5 で「両軸 null + hasSnapshot=true」の防御的分岐は書かず、`hasSnapshot=false` 経路 (line 277 の `metrics_pool_no_data`) に吸収させた。
- 旧挙動 (`formatUtil(0)="0%" for util_*=null`) は S2 で消滅、S2 GREEN 後の token-format.test.ts は新挙動のみ pass する状態。
