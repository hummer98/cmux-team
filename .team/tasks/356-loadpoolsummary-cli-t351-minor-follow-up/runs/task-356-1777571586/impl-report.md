# T356 実装レポート — loadPoolSummary 失敗時の CLI ログ復元

- 対象タスク: T356 / minor follow-up of T351
- 作業 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-356-1777571586`
- 実装方針: callback 注入 (`onError?: (e: Error) => void`) — D1 採用

## Completed Tasks

- [x] **S1**: `loadPoolSummary` に `onError` callback を追加
- [x] **S2**: CLI `cmdStatus` で旧 console.log フォーマットを復元
- [x] **S3**: 単体テスト case G / H / I の追加（実 DB 経路）
- [x] **S4**: 全体 regression 確認（pool 関連 80 テスト + tsc）

## Files Changed

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/pool-summary.ts` | `loadPoolSummary` に第 3 引数 `options?: { onError?: (e: Error) => void }` を追加。build catch で `options?.onError?.(e instanceof Error ? e : new Error(String(e)))` を呼び `null` を返す。gate catch は無変更（silent OFF 維持）。JSDoc に T356 の仕様と「gate 失敗は OFF と等価で `onError` を呼ばない」旨を追記 |
| `skills/cmux-team/manager/main.ts` | `cmdStatus` の `loadPoolSummary` 呼び出しに `{ onError: (e) => console.log(`  (token pool read failed: ${e?.message ?? e})`) }` を渡す。先頭 2 スペースインデント、テンプレートは旧 commit `935b2a3` 削除前と完全一致 |
| `skills/cmux-team/manager/pool-summary.test.ts` | case G / H / I の 3 テストを追加（既存 case A〜F は無修正） |

daemon 側 (`daemon.ts:434-445` `refreshPoolSnapshot`) は `buildPoolSummary` を直呼びしており `loadPoolSummary` は経由しないため、本変更で daemon 経路は **挙動不変**（計画 §5 R1 検証済）。

## TDD Cycles / Verification Results

### S3 / S1 (RED → GREEN)

**RED**: case G/H/I を先に追加してテスト実行

```
$ bun test --timeout 30000 pool-summary.test.ts
14 pass / 1 fail (case G: captured.length expected 1 received 0)
```

case G が期待どおり失敗。case H / I は当時の silent fallback 仕様でも null 返却で素通り（後方互換が維持される証跡）。

**GREEN**: `loadPoolSummary` に `options.onError` を追加し build catch で発火

```
$ bun test --timeout 30000 pool-summary.test.ts
15 pass / 0 fail (48 expect calls)
```

**REFACTOR**: 不要な抽象なし。`e instanceof Error ? e : new Error(String(e))` のラップは D6 に基づく型安全化のみ。

### S2 (CLI 修正)

ビルド確認:

```
$ bun build skills/cmux-team/manager/main.ts --target=bun --outdir=/tmp/cmux-team-build-check
Bundled 653 modules in 54ms
main.js                                        3.69 MB  (entry point)
```

エラー 0。

### S4 (VERIFY / regression)

pool 関連テスト一通り:

```
===== pool-summary.test.ts =====    15 pass / 0 fail
===== pool-cli.test.ts =====         4 pass / 0 fail
===== pool-status-header.test.ts =====   30 pass / 0 fail
===== pool-throttle.test.ts =====    31 pass / 0 fail
```

合計 80 PASS / 0 FAIL。

tsc 型チェック:

```
$ bunx tsc --noEmit 2>&1 | grep -E "^(pool-summary\.ts|main\.ts)" || echo "(no errors in target files)"
(no errors in target files)

$ bunx tsc --noEmit; echo "exit=$?"
exit=0
```

target 2 ファイルおよび全体でエラー 0。

## DB 破損再現方法の選択理由（D5）

計画書の 3 候補から **候補 3: tokens.db を非 SQLite なゴミバイトで上書き** を採用した。

### 採用理由

1. **実 DB 経路で reproducible** — `new Database(dbPath)` 自体は遅延 open のため成功するが、続く `db.exec("PRAGMA journal_mode=WAL;")` または `db.exec(SCHEMA_V1)` が SQLite header 不一致で throw する。`loadPoolSummary` 内 `try { initTokenDB(); ... }` の build catch が確実に発火する。
2. **flaky でない** — 環境変数とファイル内容のみで完結し、umask / 親プロセス権限 / OS 差異の影響を受けない。CI でも安定して再現する。
3. **mock 不要** — D5 制約「mock 経路ではなく実 DB 経路」を満たす。`loadPoolSummary` 内部の握りつぶしを構造的に検出できる。

### 不採用理由

- **候補 1 (dirPath を read-only に chmod)**: 親 dir の権限変更は afterEach の `rmSync` が EPERM で失敗するリスクあり。OS / ユーザによる挙動差も大きい。
- **候補 2 (TOKEN_STORE_DB_PATH を不正パスに設定)**: ディレクトリを指す等の場合、`mkdirSync(dirPath, { recursive: true, ... })` が先に走ってしまい `dirPath = dirname(envPath)` の解決と齟齬する可能性。挙動が implementation detail に依存しやすい。

### 実装した再現コード（抜粋）

```ts
const dbDir = mkdtempSync(join(tmpdir(), "cmux-pool-corrupted-"));
const dbPath = join(dbDir, "tokens.db");
writeFileSync(dbPath, "not a sqlite file" + "\x00".repeat(100));
process.env.CMUX_TEAM_TOKEN_POOL = "1";        // gate 強制 ON
process.env.TOKEN_STORE_DB_PATH = dbPath;       // 破損 DB を指す
// ... loadPoolSummary を呼ぶ
```

`CMUX_TEAM_TOKEN_POOL=1` で gate 層は確実に ON、build 層で `initTokenDB` の `db.exec(SCHEMA_V1)` が `SQLITE_NOTADB` 系の例外を投げる。

## Issues Encountered

特になし。計画書 §3 〜 §7 の指示通りで実装が完結した。

### Decision Log の遵守

| ID | 計画 | 実装 |
|----|------|------|
| D1 | callback 注入 | ✓ `onError?: (e: Error) => void` |
| D2 | console.log（CLI） | ✓ `console.log(`  (token pool read failed: ...)`)` |
| D3 | 先頭 2 スペース + 旧テンプレート | ✓ `  (token pool read failed: ${e?.message ?? e})` |
| D4 | gate 失敗は `onError` を呼ばない | ✓ gate catch は据え置き |
| D5 | 実 DB 破損で再現（mock 禁止） | ✓ 候補 3 採用 |
| D6 | signature `(e: Error) => void` + 内部 wrap | ✓ `e instanceof Error ? e : new Error(String(e))` |

## DoD チェック（計画書 §8）

- [x] `loadPoolSummary` に `onError` 引数が追加され、build 失敗時のみ呼ばれる
- [x] `cmdStatus` で旧 console.log フォーマット (`  (token pool read failed: ...)`) が復元される
- [x] `pool-summary.test.ts` に case G / H / I の 3 件が追加され PASS
- [x] 既存 case A〜F が無修正で継続 PASS
- [x] `pool-summary.ts` / `main.ts` で `bunx tsc --noEmit` エラー 0
- [x] daemon 経路 (`refreshPoolSnapshot`) は無変更で挙動不変
