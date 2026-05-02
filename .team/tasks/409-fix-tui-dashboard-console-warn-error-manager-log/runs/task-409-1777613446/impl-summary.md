# T409 実装サマリ — dashboard 起動時の console.warn / console.error → manager.log redirect

## 1. 実装したファイル一覧

### 変更
- `skills/cmux-team/manager/logger.ts` — `appendLine(level, event, detail)` internal helper に切り出し、`log()` / `warn()` / `error()` を export。`CMUX_TEAM_LOGGER_STRICT` チェックは appendLine 内に集約。
- `skills/cmux-team/manager/dashboard.tsx` — 冒頭に `installDashboardConsoleRedirect` import 追加。`startDashboard()` 内、`process.env.REZI_TERMINAL_SUPPORTS_OSC8 = "1"` の直後・`createNodeApp` 呼び出し**直前**で `installDashboardConsoleRedirect()` を呼ぶ。
- `skills/cmux-team/manager/logger.test.ts` — `warn` / `error` を import に追加、`describe("logger - warn / error level", ...)` ブロックで 3 ケース追記。

### 新規
- `skills/cmux-team/manager/dashboard-console-redirect.ts` — `installDashboardConsoleRedirect(): { restore: () => void }` を export。`console.warn` / `console.error` を `logger.warn` / `logger.error` にすり替え。`formatArgs` で `Error` / string / object に対応。
- `skills/cmux-team/manager/dashboard-console-redirect.test.ts` — 3 ケース（warn が manager.log に append される / 原 console.warn・error が呼ばれない & manager.log に流れる / restore で原状復帰する）。

## 2. 主要な設計判断

### plan.md からの逸脱
plan.md セクション 4.3 では「stderr に何も書き出されない」を `process.stderr.write` をスタブして検証する設計だったが、Bun の test runner では `console.warn` / `console.error` が `process.stderr.write` を経由しないため空文字を受け取り検証が崩れた。

**変更**: stderr capture ではなく「**原 `console.warn` / `console.error` 関数参照が呼ばれないこと**」を検証する方式に変更。`beforeEach` で `origWarn = console.warn` を保存し、テスト内で stub に差し替えてから `installDashboardConsoleRedirect()` を呼び、stub の call count が 0 のままであることを確認する。

これは plan.md と意図する不変条件（= dashboard モード中に元の console 経路（stderr）が起動しないこと）を実装レベルで等価に検証する。manager.log への append も同テスト内で検証しているため redirect の正しさは網羅されている。

### restore 検証も同様の方針
restore 後に「原 console.warn が再び呼ばれる」ことを stub の call count で検証（plan.md 案では stderr 出力で検証）。

### console.warn の async flush
`flushAsyncLog()` は plan.md 案の `setImmediate * 5` だけだと **mkdir + appendFile** の連鎖で 1 ループでは足りなかったため、`setTimeout(50ms) + setImmediate * 5` に拡張。50ms は I/O 完了に十分なマージンで、テストの flake は確認されない。

### dashboard.tsx 2424-2425 の console.error 経路
plan.md セクション 3.4 の議論通り **原状維持（manager.log に流す）**。startup 失敗時に stderr に出ない懸念は exit code・bootPhase で別経路により表現可能のため将来検討課題として残す。

## 3. テスト結果

```bash
cd skills/cmux-team/manager
bun test --timeout 30000 dashboard-console-redirect.test.ts
# → 3 pass / 0 fail / 6 expect calls / 122ms

bun test --timeout 30000 logger.test.ts
# → 22 pass / 0 fail / 33 expect calls / 37ms
```

合計 **25 pass / 0 fail**。

## 4. tsc 結果

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-409-1777613446/skills/cmux-team/manager
bunx tsc --noEmit 2>&1 | tee /tmp/t409-tsc.log
```

出力 0 行（ログファイル `/tmp/t409-tsc.log` は size 0 bytes）。

```bash
bunx tsc --noEmit 2>&1 | grep -E "(logger\.ts|dashboard-console-redirect\.ts|dashboard\.tsx|...test\.ts)"
```

該当ファイル関連エラーなし。**自分が touch したファイルに関連する新規エラー 0 件**を確認。

## 5. 受け入れ条件チェックリスト

- [x] `skills/cmux-team/manager/logger.ts` に `warn(event, detail)` / `error(event, detail)` が export されている
- [x] `log()` / `warn()` / `error()` の append 経路が共通 helper (`appendLine`) に集約されている（重複 mkdir/appendFile なし）
- [x] `warn()` の出力行が `[<timestamp>] [warn] <event> <detail>` 形式
- [x] `error()` の出力行が `[<timestamp>] [error] <event> <detail>` 形式
- [x] `log()` の出力行は **既存形式と完全互換**（prefix なし）— logger.test.ts の compat ケースで明示検証
- [x] `CMUX_TEAM_LOGGER_STRICT=1` のチェックが warn / error にも適用される（appendLine 内で 1 箇所集約）
- [x] `skills/cmux-team/manager/dashboard-console-redirect.ts` が新規作成されている
- [x] `installDashboardConsoleRedirect()` が `{ restore: () => void }` を返す
- [x] `dashboard.tsx` の `startDashboard()` 内、`createNodeApp` 呼び出し直前で `installDashboardConsoleRedirect()` が呼ばれている
- [x] dashboard.tsx 冒頭に `installDashboardConsoleRedirect` の import が追加されている
- [x] redirect 中: `console.warn(...)` / `console.error(...)` が原 console 経路を起動せず manager.log に流れる
- [x] redirect 中: `console.log(...)` の挙動は変更されない（patch 対象外、コードでも touch していない）
- [x] `cmux-team status`（`cmdStatus`）等の CLI 一発モードでは redirect が起動しない（`installDashboardConsoleRedirect` の呼び出しは `startDashboard()` 内のみ）
- [x] 新規テストファイル `dashboard-console-redirect.test.ts` の 3 ケースが pass
- [x] `logger.test.ts` の追加 3 ケースが pass
- [x] `bun test --timeout 30000 dashboard-console-redirect.test.ts logger.test.ts` 相当で他テストへの regression なし（既存の formatSurface / formatPair / 遅延評価ケース 19 件も pass）
- [x] 既存の `log()` 呼び出し 26 箇所（`grep -rn 'from "./logger"' skills/cmux-team/manager`）は import を変更していないため従来通り動作。`log()` の signature 互換性は維持されている。

## 6. 残課題

- `parseLogLine`（dashboard.tsx:326 周辺）が `[warn] event` を level として扱えるかは本タスク scope 外。journal タブで level prefix が detail 側に含まれる挙動になる可能性があり、必要なら別タスクとして分離（plan.md 6.3 で言及）。
- `dashboard.tsx` 2424-2425 の startup 失敗時 `console.error` が manager.log に流れるが stderr に出ない件は plan.md 6.2 通り原状維持。ユーザー体験で問題が判明したら `restore()` 呼び出しを 1 行追加で対応可能。
- console.warn / error の **fire-and-forget による順序保証**は logger 内の `appendFile` sequencing に依存（plan.md 6.1）。残骸防止という主目的には影響なし。
