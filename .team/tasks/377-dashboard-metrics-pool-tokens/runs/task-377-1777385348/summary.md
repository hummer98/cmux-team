# T377 — dashboard Pool Tokens 時刻列パディング揃え

## 結果

- 判定: GO（Inspector）
- 採用案: A（`buildPoolTokensSection` 側で揃える）
- 変更ファイル: 2 ファイル / +161 / -13

## 完了したサブタスク

| Phase | 内容 | 結果 |
|---|---|---|
| 3 | Implementer による実装と TDD | 完了（4 新規テスト pass） |
| 4 | Inspector 検品 | GO |

## 変更ファイル

- `skills/cmux-team/manager/dashboard-metrics.ts`
  - `buildPoolTokensSection` で全 token の bar を事前計算する `computed` 配列を導入
  - 列ごと最大 gray part 幅を返す `maxGrayPartLen` ヘルパー追加
  - gray part のみ `padStart(maxLen)` する `padGrayParts` ヘルパー追加
  - `RateLimitPart` を type-only import
- `skills/cmux-team/manager/dashboard-metrics.test.tsx`
  - 新 describe `buildMetricsRows: Pool Tokens reset alignment (T377)` に 4 ケース追加

`buildUtilizationBar` / `formatResetRemaining` のシグネチャは不変。

## テスト

```
bun test --timeout 30000 skills/cmux-team/manager/dashboard-metrics.test.tsx
→ 30 pass / 0 fail / 52 expect() / 79.00ms
```

T377 追加分 4 ケース全て pass:
1. 複数 token 5h: `"5m"` → `"   5m"` に padStart で揃う
2. 複数 token 7d: `"1d"` → `" 1d"` に padStart で揃う
3. `hasSnapshot=false` 混在時、snapshot 有り行同士が揃う
4. 1 token のみ: 余分なパディングが入らない

## tsc

```
cd skills/cmux-team/manager && bunx tsc --noEmit
→ exit=0、新規エラー 0
```

## マージ

- 方式: ローカル ff-only マージ
- マージ先: `main`
- マージコミット SHA: （後段で記録）

## 想定外の判断

- Implementer 着手中、bootstrap の `npm install` で `package-lock.json` が 4.16→4.17 に書き換わったが、これは release 由来の差分でタスクスコープ外のため revert（diff を 2 ファイルに閉じるという完了条件遵守）
- `noUncheckedIndexedAccess` 対応のため、parallel 配列ではなく `{ row, bar5h, bar7d }` 1 オブジェクト配列で `for (const c of computed)` する形に組み替えた
