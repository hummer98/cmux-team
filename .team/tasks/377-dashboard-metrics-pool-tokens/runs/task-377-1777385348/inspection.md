# Inspection Report (T377)

## 判定: GO

## 観察結果（GO 判定でも書く）

- **挙動**: `buildPoolTokensSection` 内で全 token の bar を事前計算（`computed` 配列）し、列ごとに `maxGrayPartLen` で最大幅を求め、`padGrayParts` で `color: "gray"` の part のみ `padStart` する設計。bar 本体（最初の `group: true` part）は触らないため、bar 幅は変わらず % 桁の `padStart(3)` も従来通り。
- **hasSnapshot=false 行の扱い**: `bar5h`/`bar7d` を `null` として `computed` に積み、`maxGrayPartLen` 側で `if (!b) continue;` で除外している。snapshot なし行は別経路（`metrics_pool_no_data`）で出力され、最大幅計算に紛れ込まない。テスト 3 で混在ケースをカバー済み。
- **単独 token**: 5h 列の "5m" のみ → `max = "5m".length = 2` → `padStart(2)` は no-op。テスト 4 で `'"5m"'`（pad なし）の存在と `"   5m"`（pad あり）の不在を両方 assert しており、no-op 性が保証されている。
- **シグネチャ**: `rate-limit-display.ts` の `buildUtilizationBar` / `formatResetRemaining` ともに引数・戻り値型に変更なし（grep 確認済み）。`RateLimitPart` を type-only import で持ち出しているのみ。
- **diff スコープ**: `git diff --stat` で 2 ファイルのみ（`dashboard-metrics.ts` +63 行 / `dashboard-metrics.test.tsx` +111 行）。bar 本体・他 Metrics セクション・`rate-limit-display.ts` は変更なし。
- **テスト pad 性の検証**: 複数 token テストは `"   5m"`（pad された結果）と `"1h30m"`（最大幅側そのまま）の両方を assert しており、実装が pad を作動させない場合は fail する。「pad しなくても通る」形にはなっていない。
- **コーディング**: ヘルパー 2 つ（`maxGrayPartLen` / `padGrayParts`）はいずれも 10 行未満で意図が明瞭。後方互換シム・冗長コメント・無関係リファクタなし。コメントは「なぜ事前計算が必要か」の理由のみ書かれており適切。

## 検証コマンド結果

- `bun test --timeout 30000 skills/cmux-team/manager/dashboard-metrics.test.tsx` → **pass**
  - 30 pass / 0 fail / 52 expect() calls / 79.00ms
  - T377 で追加された 4 ケース（複数 5h / 複数 7d / hasSnapshot 混在 / 単独 token）すべて pass
  - 既存 26 ケースも degrade なし
- `cd skills/cmux-team/manager && bunx tsc --noEmit` → **exit=0**
  - 新規エラー件数: **0**
  - `noUncheckedIndexedAccess: true` 環境でも `for (const c of computed)` 形式のため型安全に通る

## スコープ確認

- 変更ファイル一覧:
  - `skills/cmux-team/manager/dashboard-metrics.ts`（+50 / -13、ネット +37）
  - `skills/cmux-team/manager/dashboard-metrics.test.tsx`（+111 / -0）
- diff 行数: **+161 / -13**（合計 174 行変更、追加 161 / 削除 13）
- スコープ外ファイルへの変更: なし
