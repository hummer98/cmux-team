# Inspection Report (T363)

## 判定: GO

## 検証結果

### 1. Subtask 完遂 (1-7)

- [x] **Subtask 1**: `pool-header-display.test.ts` 新規作成 — 12 cases (plan の case 1-11 + formatRelativeDuration cross-validate)。`bun:test` の `describe` / `test` で plan 通り構造化。
- [x] **Subtask 2**: `pool-header-display.ts` 新規実装 — `buildPoolHeaderDisplay(summary): PoolHeaderDisplay` 純粋関数。`PoolSummary` / `RateLimitPart` を import、色閾値 `>=100→green / >=40→yellow / else→red`、`group: true` を `parts[0]` に付与、内部 `formatRelativeDuration` は pool-status-header.ts 等価実装。`now?` 引数は省略 (`remainingMs` 解決済み前提、impl-report の補足通り) — 本判断はテストと CLI 既存ロジックで担保されておりスコープ妥当。
- [x] **Subtask 3**: `dashboard.tsx` 編集
  - L52: `import { buildPoolHeaderDisplay } from "./pool-header-display";` 追加 ✓
  - L1434-1436: `const rl = daemon.pool != null ? buildPoolHeaderDisplay(daemon.pool) : buildRateLimitDisplay(daemon.rateLimit);` ✓
  - L1470 周辺: `...buildPoolHeader(daemon.pool),` 行とコメント `// T351:` 削除 ✓ (`grep "buildPoolHeader(daemon.pool)" dashboard.tsx` → 空)
  - throttling 経路 (L1443-1453) は `rl.parts` をそのまま使い変更不要、`isThrottled` 判定は `daemon.rateLimit` ベースのまま (plan D3 通り)
- [x] **Subtask 4**: `dashboard.tsx::buildPoolHeader` (L460-462) JSDoc 冒頭に T363 保留コメント追加。signature / 関数本体 (L475-493) は不変 ✓
- [x] **Subtask 5**: `dashboard-pool.test.tsx` 既存 case 1-5 (`buildPoolHeader`) は方針 A で残す → 17 pass 継続 ✓
- [x] **Subtask 6**: 関連テスト個別実行で regression なし (下記 §3)
- [x] **Subtask 7**: `bunx tsc --noEmit` で `skills/cmux-team/manager/` 配下に新規エラーなし

### 2. 受け入れ条件

- [x] **TUI ヘッダー右に `pool capacity: NN%` 表示** — `daemon.pool != null` で `buildPoolHeaderDisplay` が `parts[0].text = "pool capacity: NN%"` を返し、L1456-1462 の通常経路 / L1443-1453 の throttling 経路の両方で描画される。
- [x] **ヘッダー直下の `┌─ token pool ─┐` ボックスが出ない** — `grep "buildPoolHeader(daemon.pool)" dashboard.tsx` 空。L1474 で row 配列から削除済み。
- [x] **pool OFF / 取得失敗時のフォールバック (5h/7d 表示)** — 三項演算子 `daemon.pool != null ? ... : buildRateLimitDisplay(daemon.rateLimit)` で明示的にフォールバック。pool-header-display.test case 1 (`null → []`) でガード。
- [x] **5h ≥ 95% スロットリング時の `headerSubtitle` 赤 blink 維持** — `isThrottled` は `daemon.rateLimit` ベース、L1443-1447 の `throttleLabel` 描画ロジックは変更なし。
- [x] **`pool-header-display.test.ts` の純粋関数テスト追加** — 12 cases 緑。
- [x] **`mapRateLimitColor` が "gray" を扱う** — `RATE_LIMIT_COLOR_MAP` (L225-230) に `gray: GRAY` が含まれており、`buildPoolHeaderDisplay` の next reset part (`color: "gray"`) も throttling 経路で正常着色される (regression なし)。

### 3. テスト・型検査

```
$ cd skills/cmux-team/manager && bun test --timeout 30000 pool-header-display.test.ts
bun test v1.3.12 (700fc117)
 12 pass
 0 fail
 24 expect() calls
Ran 12 tests across 1 file. [9.00ms]

$ bun test --timeout 30000 dashboard-pool.test.tsx
 17 pass
 0 fail
 62 expect() calls
Ran 17 tests across 1 file. [85.00ms]

$ bun test --timeout 30000 pool-status-header.test.ts
 7 pass
 0 fail
 22 expect() calls
Ran 7 tests across 1 file. [8.00ms]

$ bun test --timeout 30000 rate-limit-display.test.ts
 13 pass
 0 fail
 32 expect() calls
Ran 13 tests across 1 file. [30.00ms]

$ bunx tsc --noEmit | grep -E "^skills/cmux-team/manager/" || echo "OK"
OK (no output — clean)
```

### 4. スコープ・ノイズ

```
$ git status --short
 M package-lock.json
 M skills/cmux-team/manager/dashboard.tsx
?? skills/cmux-team/manager/pool-header-display.test.ts
?? skills/cmux-team/manager/pool-header-display.ts

$ git diff --stat
 package-lock.json                      |  4 ++--
 skills/cmux-team/manager/dashboard.tsx | 10 +++++++---
 2 files changed, 9 insertions(+), 5 deletions(-)
```

- **package-lock.json**: scope 外。判定 = **Conductor が完了処理 Step 6.5 で revert する minor**。
  - 検証: `git log -1 --format=%H -- package-lock.json` → `e17e586` (T349 commit、main の v4.13.0 release commit `34948bf` よりも前)。release commit が package-lock.json を更新せず、worktree 内の `npm install` 副作用で `4.12.1 → 4.13.0` に同期した差分。本タスクの実装には無関係。
  - 内容も version 文字列 2 行のみ (dependencies の足し引きなし)。
- **その他の diff**: `dashboard.tsx` は plan で予告した編集箇所のみ (import 1 行 / JSDoc 3 行 / 三項演算子 3 行 / L1474 の 2 行削除)。新規 2 ファイルのみ。スコープに収まっている。

### 5. コード品質

- **`pool-header-display.ts` の純粋関数性**: 外部 state 依存なし、副作用なし、Date.now() 等の time-source 参照なし (`remainingMs` 解決済みで渡される設計)。テストで決定論的に検証可能 ✓
- **コメント方針 (CLAUDE.md)**: ファイル冒頭の JSDoc は WHY (CLI 用との対比、色閾値の根拠) を簡潔に説明、本体内コメントは `formatRelativeDuration` の cross-validate 注記のみ。過剰なし ✓
- **`buildPoolHeader` (dashboard.tsx) の JSDoc 保留コメント**: plan 指定通り 2 行 (`NOTE (T363): ...`)、過剰なし ✓
- **import 順序**: T351 の既存コメント `// T351: pool capacity / per-surface handle 表示` の直下に `buildPoolHeaderDisplay` を追加 — plan の指定どおり既存 import の隣接位置 ✓
- **テストの DRY**: `makeSummary` ヘルパーで重複削減、case ごとの assertion が明示的 ✓

### 6. Rate Limit セクション影響なし確認

```
$ grep -n "Rate Limit\|rate.limit" skills/cmux-team/manager/dashboard.tsx
21:import { buildRateLimitDisplay, type RateLimitColor } from "./rate-limit-display";
22:import { isStale5h } from "./rate-limit-persistence";
232:/** rate-limit-display の RateLimitColor を Rezi の RGB 値にマップする */
2108:   * R キーから呼ばれる。rate limit 到達時はエラー表示のみ。
2134:          ? `rate limit: remaining=${e.rateLimit.remaining ?? "?"} reset=${e.rateLimit.resetAt ?? "?"}`
```

- 下方の参照 (L2108 / L2134) はモデル変更時のエラーメッセージ用で、ヘッダー右描画とは無関係。
- 本タスクの編集は L52 / L460-462 / L1434-1436 / L1474 のみで、`─ Rate Limit ─` 詳細セクション (`buildRateLimitSection` 等) には触っていない ✓

## 所感

- plan からの逸脱: `now?` 引数省略の判断 (impl-report 補足) は妥当 — `remainingMs` を呼び出し側で解決する既存設計と整合し、テストの決定論性も保たれる。引数を増やしてもテスト以外で利得がなく、YAGNI として却下する Implementer 判断を支持。
- throttling 中の右側 parts が pool capacity に置き換わる挙動は、plan D3 で議論済みの設計判断。`⏸ THROTTLED` 赤 blink で throttle 視認性は確保され、pool capacity (緑/黄/赤) は別軸の情報として共存する。本仕様で受け入れ条件を満たす。
- `formatRelativeDuration` を再実装した点 (D5) はテスト 12 行で cross-validate しており、共通化の必要が出たら別タスクで `format-duration.ts` 切り出しが妥当。
- 残作業として CLI (`cmux-team status`) 側の `┌─ token pool ─┐` ボックスは依然存在 (plan §1 影響範囲表で本タスクスコープ外と明記)。Conductor が完了報告で「CLI 側も同様に置換するか」を Master / ユーザーに確認すべき後続検討事項として記録。

**判定: GO**
critical 指摘なし。受け入れ条件全達成、テスト全 green、型エラーなし、スコープ逸脱なし。package-lock.json の scope 外 diff は Conductor 完了処理 Step 6.5 で revert すること。Implementer 再起動は不要。
