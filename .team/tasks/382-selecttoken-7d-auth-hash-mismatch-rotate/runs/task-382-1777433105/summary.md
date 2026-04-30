# T382 結果サマリ

## 完了したサブタスク

1. ✓ Phase 1 (Plan): plan.md を Planner Agent が作成（行番号レベルの詳細設計、テスト名一覧、auth_hash auto rotate を別タスク化する判断含む）
2. ✓ Phase 3 (Impl): Implementer Agent が TDD で実装（赤→緑→refactor）
3. ✓ Phase 4 (Inspection): Inspector Agent が GO 判定。Critical/Major なし、Minor 3 件は scope 外もしくは将来検討事項
4. ✓ Inspector 指摘の Minor (pool-throttle.ts:122 の古いコメント `0.92 OK`) を修正
5. ✓ 二次対応（auth_hash auto rotate）は T384 として follow-up 起票

## 変更ファイル

- `skills/cmux-team/manager/token-store.ts` — `BLOCKER_5H` / `BLOCKER_7D` 定数 export, `admitCandidates` の blocker に 7d 軸を OR 追加, JSDoc を 3 箇所更新
- `skills/cmux-team/manager/pool-throttle.ts` — local `POOL_BLOCKER_THRESHOLD` を削除し token-store の定数 import に置換, `countPoolTokens` の admit ロジックを admitCandidates と一致させて 7d blocker + 7d stale 救済を追加, `hasPoolHeadroomFromSummary` も util7d を見るように更新
- `skills/cmux-team/manager/token-store.test.ts` — `describe("selectToken (T382: 7d blocker)")` に T382-1 〜 T382-6 の 6 ケース追加
- `skills/cmux-team/manager/pool-throttle.test.ts` — T382-T1, T382-T2, T382-C1, T382-C2, T382-H1, T382-H2 の 6 ケース追加
- `docs/spec/09-token-pool.md` — §候補抽出 / 例表 / §構造的整合性の保証 / §閾値 / §peek の 5 箇所を 7d 軸記述に更新（`@over7d` / `@reset7d` の例表行追加含む）

合計 5 ファイル変更、+271 / -28 行、12 テスト追加。

## テスト結果（plan.md §7 に基づき対象を絞って実行）

- `token-store.test.ts`: 134 pass / 1 skip / 0 fail
- `pool-throttle.test.ts`: 31 pass / 0 fail
- `dashboard-pool.test.tsx`: 2 pass / 0 fail
- `pool-summary.test.ts`: 12 pass / 0 fail
- `pool-header-display.test.ts`: 13 pass / 0 fail
- `pool-cli.test.ts`: 3 pass / 0 fail
- `pool-status-header.test.ts`: 30 pass / 0 fail
- `token-cli.test.ts`: 37 pass / 4 skip / 0 fail
- `proxy.test.ts`: 48 pass / 0 fail
- `bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json`: エラーなし

## Dear T318 root cause に対する効力範囲

本実装で防げるもの:
- snapshot が真に util_7d > 0.95 を返す全 token を admit から除外
- `effectiveDefault` 一致 token であっても 7d > 0.95 ならブロッカーで止める
- 全 token が 7d > 0.95 のとき selectToken は null を返し、spawn-agent はフォールバック側に流れる

本実装では防げないもの（T384 で対応予定）:
- snapshot 自体が auth_hash mismatch で凍結し util_7d を実態より低く報告する状況。proxy.ts: updateTokensDB の auto-discover 経路で `tokens.organization_id` UNIQUE constraint failed が発生する根因を解消する別タスク（T384）として切り出し済み。

## 起票した follow-up タスク

- **T384**: `proxy: auth_hash mismatch 時の auto rotate（T382 follow-up）` — draft 状態で起票

## マージコミット / PR

このタスクは `main` への local ff-only merge で納品する想定（後段で commit & rebase & merge）。
