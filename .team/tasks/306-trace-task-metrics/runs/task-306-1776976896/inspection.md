# T306 Inspection Report

## Verdict: GO

## Summary

plan.md 4.1-4.4 に沿って trace-store.ts に 3 interfaces + 3 集計関数、main.ts に 3 フォーマッタ + `deriveDuration` + Metrics セクション、i18n.ts に en/ja 両方の `--no-metrics` ヘルプ、trace-store.test.ts に 7 ケースが追加されている。`bun test` は 1175 pass / 0 fail（T305 基準 +7）、`bunx tsc --noEmit` は既存 3 件（T305 時点で申告済み）のみで T306 起因の新規エラー 0 件。SQL は `$taskId` named bind で injection 安全、`COALESCE` による NULL 処理、`Math.max` による動的 padEnd/padStart も正しい。

## Checklist
- [x] plan.md 4.1-4.4 通りに実装されている
- [x] `bun test` 0 fail（1175 pass、T305 基準から +7）
- [x] `bunx tsc --noEmit` 新規エラー 0 件（既存 3 件のみ）
- [x] `--no-metrics` で従来出力が維持される（Implementer が bytewise diff=0 を確認、かつコード読み起こしても Token Usage セクションの出力は `if (!hasFlag("no-metrics"))` ブロックで完全に閉じており、既存行 Task / Run / Worktree / Base / Deliverable / Sessions / `--summary` スタブは改変されていない）
- [x] エラー行合算がテストで assert されている（`trace-store.test.ts` L1087-1122 "エラー行（error NOT NULL）も集計に含まれる"）
- [x] cache hit rate 分母 0 → n/a（`formatCacheHitRate` L4184-4189、分母 0 で "n/a" を返す）
- [x] Duration 欠損時の非表示（`renderTokenUsageSection` L4221-4223 で `durationMs !== null` の時だけ出力）
- [x] NULL role/model の COALESCE 処理（SQL 3 関数とも `COALESCE(role, 'unknown')` / `COALESCE(model, '(unknown)')`）
- [x] db.close() のリーク無し（No sessions ルート L4120、通常ルート L4160 の両方で close）

## Findings

### Critical（GO をブロック）

None

### Important（NOGO 判定の理由）

None

### Minor（後続改善推奨）

1. **`formatCacheHitRate` の分母 0 パスが unit test で assert されていない**
   `renderTokenUsageSection` の出力に間接的に含まれるが、`formatCacheHitRate(0, 0) === "n/a"` の直接テストは無い。コード上自明（`denom === 0` を即 return）だが、将来「分母 0 時に 0.0% と表示してしまう」回帰を防ぎたければ pure 関数の 1 ケースを追加する余地あり。T306 スコープ内の欠陥ではなく、次の trace-task 拡張時に合わせて追加で良い。

2. **`deriveDuration` は resume / restart 経路で複数 assigned 行がある場合、最初の assigned と最後の closed/aborted を結ぶため実稼働時間より長く出る**
   plan.md 6.1 の「走行中タスクでユーザが実行」とは別の境界で、`restart-task` で 2 回目の assigned が出たタスクで起きる。ただし plan.md が明示的にスコープ外としているため T306 の責務ではない。将来的には「assigned → 次の closed/aborted」のペアを折り畳む設計が望ましい。

3. **trace-store.ts L606-612 のコメント 1 行目「trace-task の Metrics セクション用 read-only 集計」は WHAT 寄り**
   CLAUDE.md の「Don't explain WHAT the code does」に厳密に照らすと微妙だが、残り 4 行は SUM の NULL 無視・COALESCE の目的・index 利用・エラー行合算という **非自明な WHY** を記述しており読み手の時間を節約している。trace-store.ts の既存 T305 コメント群と同じトーンなので regression ではない。

4. **`--summary` スタブの判定が `getArg("summary") !== undefined || args.includes("--summary")` のまま**
   `--no-metrics` は `hasFlag("no-metrics")` に統一しており、既存コードとの不整合だが T306 の変更範囲外。スタブなので無害。

## Fix Required

（NOGO ではないため不要）

## 補足：検証実行ログ

- `cd skills/cmux-team/manager && bun test` → `1175 pass / 0 fail / 2887 expect() calls`（所要 51.27s）
- `bunx tsc --noEmit` → 既存 3 件（`conductor.ts(201,3)` / `daemon.test.ts(3870,9)` / `daemon.ts(1558,22)`）のみで T305 時点の申告と一致。T306 由来のエラー 0 件。
- `git diff main --stat` → 4 files changed, 475 insertions(+), 2 deletions(-)。plan.md 7 章の +300 行見積もりに対しテストが少し厚め（+120 → +222）。生産コードは見積もり内。
