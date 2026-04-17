# Inspection Report: T227

## Verdict

**GO**

## Summary

plan revision 2 に沿って永続化・stale ガード 5 箇所・gitignore migration・Zod 検証が全て実装され、新規 26 tests / 既存 413 tests / tsc --noEmit が全て pass。設計レビュー指摘 4 件 + Minor B/E が全て反映されていることを確認した。

## Test Results

- `rate-limit-persistence.test.ts`: **17/17 pass**
- `rate-limit-display.test.ts`: **9/9 pass**
- 全体テスト（manager ディレクトリ）: **413/413 pass**（20 files, 871 expect() calls, 9.84s）
- `bunx tsc --noEmit`: **pass（exit 0）**

## Checks

### 1. 設計レビュー指摘事項（4 件 + Minor）

- ✅ **Review 指摘 1（stale ガード 5 箇所）**: `!isStale(...)` を以下 5 箇所に適用済み:
  - `dashboard.tsx:860-861`（`isThrottled`）
  - `rate-limit-display.ts:46`（旧 dashboard.tsx:236 の forceRed、新モジュールへ移動）
  - `proxy.ts:184-185`（`/rate-limit` エンドポイントの throttled 判定）
  - `daemon.ts:1347-1348`（tick のタスク割当抑止 `throttled5h`）
  - `daemon.ts:1807-1809`（サイドバー throttle 判定）
- ✅ **Review 指摘 2（fire-and-forget 二段 catch）**: `proxy.ts:331-333` / `proxy.ts:371-373` いずれも `persistRateLimit(...).catch((e) => log("rate_limit_persist_failed", e.message).catch(() => {}))` のログ付き二段構造。単独 `.catch(() => {})` は使われていない。
- ✅ **Review 指摘 3（gitignore migration）**: `daemon.ts:393-453` で `existsSync(gitignore)` の if/else 分岐を実装。新規は `rate-limit.json` 込みで生成、既存はコメント行を除外した行単位チェックで `proxy-port` 直後（なければ末尾）に追記し `team_gitignore_migrated` をログ。行存在時は何もせず冪等。
- ✅ **Review 指摘 4（Zod 安全検証）**: `rate-limit-persistence.ts:60-67` で `RateLimitInfoSchema.safeParse` を使用、失敗時は `rate_limit_persist_failed` ログ付き null フォールバック。テストで型不一致・必須欠落・破損 JSON・ENOENT を網羅。
- ✅ **Minor B（`isStale` OR 判定）**: `rate-limit-persistence.ts:81-90` で `!(has5hFuture || has7dFuture)` により OR 判定を実装。9 ケース（両方 null、片方過去+片方 null、両方未来、片方過去・片方未来など）を全てテスト済み。
- ✅ **Minor E（`buildRateLimitDisplay` 切り出し）**: `rate-limit-display.ts` として Ink 非依存の純粋関数モジュールに分離。色は `"green" | "yellow" | "red" | "gray"` 文字列リテラルで返し、`dashboard.tsx:191-201` の `RATE_LIMIT_COLOR_MAP` / `mapRateLimitColor` で RGB 変換。

### 2. plan §4 実装ステップ（Step 1-15）

- ✅ Step 1: `RateLimitInfoSchema` 追加（`schema.ts:176-199`）。`RateLimitInfo` は `z.infer` で再定義。
- ✅ Step 2-3: `rate-limit-persistence.ts` + テスト（17 tests）で TDD 実装。
- ✅ Step 4: `proxy.ts:331-333` / `proxy.ts:371-373` に persist 呼び出し。
- ✅ Step 5: `proxy.ts:184` の `/rate-limit` throttled 判定に isStale ガード。
- ✅ Step 6: `daemon.ts:393-453` の gitignore migration 実装（冪等）。
- ✅ Step 7: `main.ts:409-418` の `initInfra` 直後で `loadRateLimit` + `rate_limit_restored` ログ。
- ✅ Step 8: `main.ts:512-519` の shutdown flush（await 付き）。
- ✅ Step 9: `rate-limit-display.ts` + dashboard.tsx リファクタ完了、旧 `buildRateLimitDisplay` / `buildUtilizationBar` / `formatResetRemaining` を削除。
- ✅ Step 10: `dashboard.tsx:860-861` の `isThrottled` ガード。
- ✅ Step 11: `daemon.ts:1347-1348` の `throttled5h` ガード。
- ✅ Step 12: `daemon.ts:1807-1809` のサイドバー throttle ガード。
- ✅ Step 13: `rate-limit-display.test.ts`（9 tests、しきい値・stale ラベル・rate_limited + stale 優先・TPM フォールバック）。
- ✅ Step 14: `docs/spec/05-install-and-infrastructure.md` に `.team/rate-limit.json` 章を追加、`docs/spec/01-skill-cmux-team.md` に dashboard stale 表示章（2a）を追加。

### 3. CLAUDE.md コーディング規約

- ✅ コメントは全て日本語、コードは英語で統一。
- ✅ 単独 `.catch(() => {})` はなし（既存パターンに従った log() 二段構造のみ）。
- ✅ `bus.emit` / `bus.on` の直接呼び出しは今回の変更に含まれず。
- ✅ error log は `log("rate_limit_persist_failed", ...)` の形で stderr/reason を含めている（CLAUDE.md ログポリシー準拠）。
- ✅ タスクファイル直接編集なし（.team/tasks/ は触れていない）。

### 4. 受け入れ条件の充足

- ✅ **daemon 再起動で前回値表示**: `main.ts:409-418` で `loadRateLimit` → `state.rateLimit` 注入 → `rate_limit_restored` ログ。dashboard は起動時から `state.rateLimit` を参照するため直ちに描画される。
- ✅ **stale 表示方針の明文化**: `docs/spec/01-skill-cmux-team.md` 2a 章 + `docs/spec/05-install-and-infrastructure.md` `.team/rate-limit.json` 章 + `rate-limit-persistence.ts` / `rate-limit-display.ts` の JSDoc で明記。
- ✅ **新応答での上書き**: `proxy.ts:321-333` / `proxy.ts:367-373` で `state.rateLimit = rl` 直後に `persistRateLimit` fire-and-forget。dashboard の `forceRed` も `!stale` で新値を優先する。

### 5. エッジケース・型安全性

- ✅ **ファイル不在**: `ENOENT` は null 返却、ログなし（ノイズ回避）。それ以外の IO エラーは `rate_limit_persist_failed load: read <msg>` ログ付き。
- ✅ **破損 JSON**: `JSON.parse` 失敗時は `rate_limit_persist_failed load: parse <msg>`。
- ✅ **型不一致・必須欠落**: `safeParse` 失敗時は issue path + code を ログ化（`rate_limit_persist_failed load: schema <path>:<code>,...`）。
- ✅ **shutdown race（Minor Note A）**: plan 通り注釈のみ、実装は現状維持（次回起動で stale 判定が正しく効くため実害なし）。
- ✅ **`any` 使用**: `e: any` のみで既存プロキシのパターンに合致。`RateLimitInfoSchema` / `RateLimitInfo` は完全型定義。

## Fix Required

なし（GO）。

## Notes

- **plan 例示スキーマ（§4 Step 1）との差分**: plan では `resetRemaining: z.string().nullable()` が例示されていたが、main ブランチの既存 `RateLimitInfo` interface には `resetRemaining` は存在せず `updatedAt: string` が存在していた。Implementer は現状 interface に合わせて正しく `updatedAt: z.string()` を Schema に含めている（plan §4 Step 1 の「interface の現状に合わせる」指示に準拠）。
- **TPM フォールバックの stale 扱い**: Implementer の判断で TPM（分単位ウィンドウ）は unified 5h/7d とは独立した別系統として isStale ガードを適用せず、従来通りの色分けで表示。テストで担保されており plan §2-4 の stale 概念（unified reset ベース）とも矛盾しない妥当な判断。
- **受け入れ条件 §6（手動 E2E）は未実施**: plan §6 の E2E シナリオ A〜E は実機再起動が必要なため本検品では未実施。実装レベルでは全て担保されていることを確認済みだが、最終的な動作確認は起動後の動作で確認する想定。
- **shutdown race (Minor Note A)**: proxy fire-and-forget と shutdown flush の交差で最大 1 回分古い値が書き込まれる可能性があるが、次回起動の stale 判定で正しく扱える設計になっている。将来的に単一 write queue 化する場合はリファクタ余地あり。
