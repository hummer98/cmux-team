# T366 検品レポート

## 判定: GO

## 検品サマリー

- **仕様充足**: OK。`PoolCapacityResult` / `PoolHeaderInput` の型変更、TUI / CLI 出力フォーマット
  (`pool capacity: 5h NN% / 7d NN%`)、`min(5h, 7d)` ベースの色分け、`per_token` の min ベース維持、
  旧フィールド (`capacity_pct` / `capacityPct`) の完全削除すべて要件通り実装されている。
- **テスト結果**: pool 系 7 ファイルすべて pass（pool-status-header 8/0、pool-header-display 15/0、
  pool-summary 7/0、dashboard-pool 19/0、token-store 96 pass + 1 skip / 0、
  pool-next-reset 8/0、pool-cli 3/0）。
- **型整合**: `bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json` exit 0、新規エラー 0 件。
- **Plan 逸脱の妥当性**: summary.md 記載の `pool-next-reset.ts::afterTokens` シミュレーション変更
  （`reset_*_at = nowIso` → `nowMs + 5h` / `nowMs + 168h` にずらす）は妥当。新仕様の
  `computePoolCapacity` で「片方 window だけ `null` だと該当側合計が 0 寄与」となる仕様変更との
  相互作用で生じた整合性破綻に対するピンポイント修正であり、意味的にも「reset 直後＝次の window
  の頭」と一致する（pool-next-reset.test.ts 「7d 律速ケース」が deltaPct > 0 で pass）。

## Findings

### Critical (NOGO 判定の根拠)

なし。

### Major (GO だが修正推奨)

なし。実装・テスト・型・フォーマットすべて要件と Plan に整合している。

### Minor (任意修正)

1. **`docs/spec/09-token-pool.md` L268 の式が旧仕様のまま**
   - `pool_capacity_pct = sum(flow_i) / REFERENCE_FLOW * 100` という旧式（min 集約後の単一値）
     のまま残っており、新仕様の「5h / 7d 別合計」は反映されていない。
   - T366 の作業境界外（コード変更タスクであり docs 更新は含まれていない）なので別タスク
     （/docs-sync 等）で追従するのが適切。本検品では blocker としない。

2. **`skills/cmux-team/manager/pool-next-reset.ts` L101-104 の変数名**
   - `afterMs5h` / `afterMs7d` は実体が `Date#toISOString()` の戻り値（string）であり、`Ms` という
     suffix と乖離している。`afterIso5h` / `afterIso7d` 等が自然。可読性のみの問題で動作には影響なし。

3. **`util_5h = 1.0`（残量ゼロ）の literal テストケース不在**
   - `computePoolCapacity` 内で `remaining = Math.max(0, 1 - util)` のため挙動は単調連続だが、
     エッジケース観点（`capacity_5h_pct = 0` を直接示す literal ケース）が unit test に明示的には
     含まれていない（`reset_5h_at: null` 経由の `0 寄与` ケースで実質カバーされてはいる）。
     プロダクション挙動には影響なし。

4. **`package-lock.json` の version 文字列が `4.12.1 → 4.14.1` に変わっている**
   - T366 とは無関係の変更（おそらく worktree 作成時のベース差分）。検品範囲では実害なしで、
     実装ファイルではないため GO 阻害要因とはしない。Conductor がコミット時に意図しない巻き込みが
     ないか念のため確認する程度で良い。

## Fix Required (NOGO の場合)

NOGO ではないため不要。

---

## 補足: 検品で確認した観点と結果

| 観点 | 結果 |
|------|------|
| `PoolCapacityResult` を `capacity_5h_pct` / `capacity_7d_pct` に変更 | OK (token-store.ts:785-789) |
| `PoolHeaderInput` を `capacity5hPct` / `capacity7dPct` に変更 | OK (pool-status-header.ts:17-23) |
| TUI 表示が `pool capacity: 5h NN% / 7d NN%` | OK (pool-header-display.ts:38) |
| CLI 表示が `pool capacity: 5h NN% / 7d NN%` | OK (pool-status-header.ts:34, pool-cli.ts:108-110) |
| 色分けが `min(5h, 7d)` ベース | OK (pool-header-display.ts:32-34, dashboard.tsx:534-535) |
| `per_token` は min ベース維持 | OK (token-store.ts:774-782) |
| 旧フィールド `capacity_pct` / `capacityPct` の完全削除 | OK (`grep` で残存なし。残るのはテストファイル冒頭コメントのみで挙動に影響しない) |
| `pool-next-reset.ts` の deltaPct を min ベース | OK (pool-next-reset.ts:96, 113) |
| `pool-cli.ts` 末尾出力を新フォーマット | OK (pool-cli.ts:108-110) |
| `token-cli.ts:325` の destructuring 影響 | OK (`{ per_token }` のみ参照、型エラーなし) |
| 5h / 7d が異なるケースの assertion | OK (token-store ケース 1/3/4、pool-header-display 7b/7c、dashboard-pool 5b/5c、pool-summary case A) |
| `util_5h=null` フォールバック | OK (token-store.test.ts L828-842 で `util` null は満タン扱い) |
| 両 reset null フォールバック | OK (token-store.test.ts L862-877 で 5h=0 / 7d=100) |
| 空 tokens 配列 | OK (token-store.test.ts L879-884 で 5h=0 / 7d=0) |
| MIN_HOURS clamp で 5h が finite | OK (token-store.test.ts L890-908) |
| 罫線幅 60 文字制約 (D10) | OK (pool-status-header.test.ts L91-104) |
| 色閾値 ≥100 GREEN / ≥40 YELLOW / <40 RED 維持 | OK (pool-header-display 案 case 5/6/7) |
| tsc 新規エラー 0 件 | OK (`bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json` exit 0) |
| 影響範囲（変更ファイル一覧） | summary.md 記載の 12 ファイル（実装 7 + テスト 5）に限定。冗長な巻き込みなし（package-lock.json は無関係差分） |
