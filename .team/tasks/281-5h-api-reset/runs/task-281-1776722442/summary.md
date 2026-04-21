# T281 サマリー

## タスク
5h スロットル中に API 停止すると reset 時刻を過ぎても解除されないバグ修正。

## 完了したサブタスク
1. Planner: plan.md（軸別 isStale 分離設計）
2. Design Reviewer: Approved
3. Implementer: TDD で `isStale()` を `isStale5h()` / `isStale7d()` に分離。呼び出し元 6 箇所を軸別に置換。ユニットテスト 18 ケース追加
4. Inspector: GO

## 変更ファイル
- `skills/cmux-team/manager/rate-limit-persistence.ts` — `isStale5h` / `isStale7d` 追加、旧 `isStale` 削除
- `skills/cmux-team/manager/rate-limit-persistence.test.ts` — 新規 14 ケース
- `skills/cmux-team/manager/rate-limit-display.ts` — バーごとに軸別判定
- `skills/cmux-team/manager/rate-limit-display.test.ts` — 新規 4 ケース（T281 リグレッション）
- `skills/cmux-team/manager/daemon.ts` — L2515 / L3333 で `isStale5h` 参照
- `skills/cmux-team/manager/proxy.ts` — L193 で `isStale5h` 参照
- `skills/cmux-team/manager/dashboard.tsx` — L1092 で `isStale5h` 参照
- `skills/cmux-team/manager/main.ts` — `rate_limit_restored` ログを軸別表記（`stale5h=<bool> stale7d=<bool>`）に変更

## テスト結果
- rate-limit 関連: 34 pass / 0 fail
- 全体: 810 pass / 0 fail

## マージコミット
e60bdd3 (ローカルマージ)
