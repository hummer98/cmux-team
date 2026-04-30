# Implementation Report (T363)

## 実施したサブタスク

- [x] Subtask 1: `pool-header-display.test.ts` 追加（12 cases: case 1-11 + formatRelativeDuration cross-validate）
- [x] Subtask 2: `pool-header-display.ts` 実装（buildPoolHeaderDisplay 純粋関数）
- [x] Subtask 3: `dashboard.tsx` ヘッダー右側を `daemon.pool != null ? buildPoolHeaderDisplay : buildRateLimitDisplay` の三項演算子に差し替え + L1470 の `buildPoolHeader(daemon.pool)` 呼び出し削除 + import 追加
- [x] Subtask 4: `dashboard.tsx::buildPoolHeader` の JSDoc 冒頭に T363 保留コメントを追加（export / signature / 本体は変更なし）
- [x] Subtask 5: `dashboard-pool.test.tsx` は方針 A（既存 case 1-5 をそのまま残す）で変更なし
- [x] Subtask 6: 関連テスト個別実行で regression なし
- [x] Subtask 7: TypeScript 型チェック OK

## 変更ファイル

- `skills/cmux-team/manager/pool-header-display.ts` (新規, 69 行)
- `skills/cmux-team/manager/pool-header-display.test.ts` (新規, 138 行)
- `skills/cmux-team/manager/dashboard.tsx` (修正)
  - L52: `import { buildPoolHeaderDisplay } from "./pool-header-display";` を追加
  - L460-462: `buildPoolHeader` JSDoc 冒頭に T363 保留コメント追加
  - L1432-1434: `const rl = daemon.pool != null ? buildPoolHeaderDisplay(daemon.pool) : buildRateLimitDisplay(daemon.rateLimit);`
  - L1470 周辺: `...buildPoolHeader(daemon.pool),` 行（コメント `// T351:` 含む）を削除

## テスト結果

```
$ bun test --timeout 30000 pool-header-display.test.ts
bun test v1.3.12 (700fc117)
 12 pass
 0 fail
 24 expect() calls
Ran 12 tests across 1 file. [7.00ms]

$ bun test --timeout 30000 pool-status-header.test.ts
 7 pass
 0 fail
 22 expect() calls
Ran 7 tests across 1 file. [7.00ms]

$ bun test --timeout 30000 dashboard-pool.test.tsx
 17 pass
 0 fail
 62 expect() calls
Ran 17 tests across 1 file. [107.00ms]

$ bun test --timeout 30000 rate-limit-display.test.ts
 13 pass
 0 fail
 32 expect() calls
Ran 13 tests across 1 file. [34.00ms]
```

## tsc 結果

```
$ bunx tsc --noEmit | grep -E "skills/cmux-team/manager/(pool-header-display|dashboard\.tsx|pool-status-header|rate-limit-display)"
(no output — clean)
```

manager ディレクトリ全体でも該当エラーなし。

## 完了条件チェック

- [x] `bun test --timeout 30000 pool-header-display.test.ts` 全 case green (12/12)
- [x] `bun test --timeout 30000 dashboard-pool.test.tsx` 引き続き green (17/17)
- [x] `bunx tsc --noEmit` で対象ファイル群に新規エラーなし
- [x] `grep -n "buildPoolHeader(daemon.pool)" skills/cmux-team/manager/dashboard.tsx` が **空**
- [x] `grep -n "buildPoolHeaderDisplay" skills/cmux-team/manager/dashboard.tsx` が **2 件**（import + 呼び出し）
- [x] `impl-report.md` を出力ディレクトリに書き出した

## plan からの逸脱

なし。plan の Subtask 1-7 + 方針 A をそのまま適用。

### 補足

- `pool-header-display.test.ts` は plan の case 1-11 を全て満たす + 「formatRelativeDuration cross-validate」(2h30m / 3d2h / 2h / 3d) を追加して計 12 cases。pool-status-header.ts の private `formatRelativeDuration` と等価実装（D5）であることを test で担保するため。
- `buildPoolHeaderDisplay` の signature は plan の `(summary: PoolSummary | null, now?: number) => PoolHeaderDisplay` から `now?` を省略した `(summary) => PoolHeaderDisplay`。`nextReset.remainingMs` が既に「現時点からの残り ms」として渡される設計（既存 `pool-status-header.ts::buildPoolHeaderLines` と同じ）なので now 引数は不要と判断。`pool-summary.ts::computeNextReset` 側で now を解決済み。
