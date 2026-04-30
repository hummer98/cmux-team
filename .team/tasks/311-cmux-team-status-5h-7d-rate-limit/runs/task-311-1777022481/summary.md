# T311 結果サマリ: `cmux-team status` に 5h/7d Rate Limit セクションを追加

## 完了状況

- Phase 1（Planner）: plan.md 作成完了 ✅
- Phase 3（Implementer）: TDD で実装、テスト 11 件全件 GREEN ✅
- Phase 4（Inspector）: **GO 判定**（受け入れ条件 10/10 pass）✅

## 変更ファイル

| パス | 種別 | 差分 |
|---|---|---|
| `skills/cmux-team/manager/rate-limit-status.ts` | 新規 | 140 行（純粋関数 `buildRateLimitStatusLines` + 内部ヘルパー） |
| `skills/cmux-team/manager/rate-limit-status.test.ts` | 新規 | 231 行（ユニットテスト 11 件） |
| `skills/cmux-team/manager/main.ts` | 変更 | +12 行（import 1 + Rate Limit セクション 11） |

既存の `rate-limit-display.ts` / `rate-limit-persistence.ts` は一切変更せず、dashboard 動作への影響ゼロ。

## テスト結果

- `bun test skills/cmux-team/manager/rate-limit-status.test.ts`: **11 pass / 0 fail / 34 expect() calls**
- `cd skills/cmux-team/manager && bun test`（全体）: **1226 pass / 0 fail / 2991 expect() calls**
- `bunx tsc --noEmit`: 新規エラー 0 件（baseline 3 件は本タスク範囲外ファイル）

## 受け入れ条件

plan.md 9 節のチェックリスト 10 項目すべて pass。実機 3 シナリオ（正常 / 不在 / 破損）で動作確認済み。

## 実機サンプル出力（正常時）

```
─ Tasks ───────────────────────────────────────────────────
  open: 10  closed: 295
─ Rate Limit ──────────────────────────────────────────────
  5h:  63% ██████░░░░  reset in 1h27m  (2026/04/24 20:00)
  7d:  39% ████░░░░░░  reset in 23h27m  (2026/04/25 18:00)
  status: allowed  (updated 0s ago)
─ Log (last 10) ────────────────────────────────────────
  ...
```

`.team/rate-limit.json` 不在/破損時は `(no rate limit data — proxy not running?)` を表示して他セクションは正常継続。

## 設計判断（Inspector が好評価した点）

1. **純粋関数化**: `main.ts` にロジックを直書きせず `rate-limit-status.ts` に分離 → テスト決定性・dashboard 非汚染・表示拡張容易性を同時実現
2. **既存 `isStale5h` / `isStale7d` 再利用**: T281 の軸独立 stale semantics と一貫、CLI と dashboard でロジック重複なし
3. **二重防衛**: `loadRateLimit` 内部の null フォールバック + 外側 try/catch で Log tail セクションが落ちない

## マージ先

`main`（ローカル ff-only マージ予定）

## 納品情報

- 納品方式: ローカル ff-only マージ
- マージ先ブランチ: `main`
- マージ コミット: `60e2093d1912851584c794f8e19b396972b0398c`
- `8da2a35..60e2093` fast-forward

