# T356 検品レポート — loadPoolSummary 失敗時の CLI ログ復元

- 対象タスク: T356 / minor follow-up of T351
- 検品 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-356-1777571586`
- 採用方針: callback 注入 (`onError?: (e: Error) => void`) — D1
- 検品時刻: 2026-05-01

## Verdict: GO

## Summary

計画書の S1〜S4 と Decision Log D1〜D6 が全て遵守され、`loadPoolSummary` への `onError` callback 追加、CLI 側 console.log 復元（旧 commit `935b2a3` 削除前と完全一致）、case G/H/I の実 DB 経路テストが揃って成立している。pool 関連テスト 80 件全 PASS、touched 3 ファイル + 全体で `tsc --noEmit` エラー 0、daemon 経路は `buildPoolSummary` 直呼びのため無変更で挙動不変。Critical / Major / Minor すべて 0 件。

## Findings

### 1. 計画充足（severity: none）— OK

- **S1**（`onError` 追加）: `pool-summary.ts:141-163` で signature が `(projectRoot, nowIso?, options?: { onError?: (e: Error) => void }) => Promise<...>` に変更され、build catch（`159-162`）で `options?.onError?.(e instanceof Error ? e : new Error(String(e)))` が発火。gate catch（`147-152`）は無変更で silent OFF を維持。
- **S2**（CLI 復元）: `main.ts:1484-1488` で `loadPoolSummary(PROJECT_ROOT, undefined, { onError: (e) => console.log(`  (token pool read failed: ${e?.message ?? e})`) })` の形に書き換わっている。
- **S3**（テスト追加）: `pool-summary.test.ts:413-490` に case G / H / I を追加。case G は実 DB 破損で `onError` 発火を検証、case H は `onError` 未指定で throw せず `null` を返す後方互換、case I は gate OFF で `onError` を呼ばない分離保証。
- **S4**（regression）: 後述「テスト」「型」項目で全 PASS。
- **Decision Log**: D1〜D6 全て報告書通りに実装に反映されている（D5: 候補 3 = tokens.db を非 SQLite バイトで上書き を採用）。

### 2. Dead/Zombie Code（severity: none）— OK

- 不要コード残存なし。`loadPoolSummary` 内部 catch は新ロジックに置き換わっており、旧 silent fallback の痕跡なし。
- テストファイルも既存 case A〜F は無変更で、追加分は `T356:` コメントで明示的に区切られている。

### 3. テスト（severity: none）— OK

```
pool-summary.test.ts        15 pass / 0 fail (48 expect calls)
pool-cli.test.ts             4 pass / 0 fail
pool-status-header.test.ts  30 pass / 0 fail
pool-throttle.test.ts       31 pass / 0 fail
合計                         80 pass / 0 fail
```

新規 case G/H/I は全 PASS、既存 case A〜F は無修正で継続 PASS。

### 4. 設計原則（severity: none）— OK

- **DRY/SSOT**: callback 注入は既存パターン「log 流路は呼び出し側責任」（daemon は `log("error", …)` / CLI は `console.log`）と整合。`loadPoolSummary` は CLI 専用 wrapper のため daemon 経路に影響しない。
- **抽象化過多なし**: `(e: Error) => void` という最小 signature。callback 例外の防御 (`try {} catch {}` ラップ) を追加していない点も計画書 R5（YAGNI）に従っている。
- **JSDoc 更新**: `pool-summary.ts:127-139` に T356 仕様（`onError` 呼び出し条件、gate 失敗は OFF と等価扱い）が明記され、コードと文書が同期。

### 5. 統合（severity: none）— OK

- `main.ts:1486` の `cmdStatus` が `loadPoolSummary` 唯一の production caller で、`onError` を渡している（`grep` で全件確認）。
- daemon (`daemon.ts:434-445` `refreshPoolSnapshot`) は `buildPoolSummary` を直呼びしており `loadPoolSummary` を経由しない。本変更で daemon 経路は完全に挙動不変。
- TOKEN_STORE_DB_PATH / `CMUX_TEAM_TOKEN_POOL` の処理は既存のままで、副作用なし。

### 6. 型エラーゼロ化（severity: none）— OK

```
$ bunx tsc --noEmit
exit=0
```

touched 3 ファイル（`main.ts` / `pool-summary.ts` / `pool-summary.test.ts`）および全体で `tsc --noEmit` エラー 0 を確認。

### 7. 旧フォーマット復元の正確性（severity: none）— OK

旧 commit `935b2a3` 削除前と diff:

```
old: console.log(`  (token pool read failed: ${e?.message ?? e})`);
new: console.log(`  (token pool read failed: ${e?.message ?? e})`);
```

完全一致。先頭 2 スペース・テンプレート・丸括弧の有無、すべて旧実装と一致。

### 8. テスト品質 — DB 破損再現の妥当性（severity: none）— OK

- D5「mock 経路ではなく実 DB 経路」を遵守。`writeFileSync(dbPath, "not a sqlite file" + "\x00".repeat(100))` で実ファイルを破損 → `TOKEN_STORE_DB_PATH` で path 注入 → `initTokenDB` 内 `db.exec(...)` 段階で SQLITE_NOTADB 例外発火、という構造的経路。
- `CMUX_TEAM_TOKEN_POOL=1` で gate を確実に ON にしてから build 層を試している（gate 失敗 vs build 失敗の分離が正しく保たれる）。
- `try/finally` で env と tmp dir をクリーンアップ、case 間の汚染なし。flaky 性も確認できなかった。

## Fix Required

なし（GO 判定）。

## 参考: 検証コマンドと結果

```
$ bun test --timeout 30000 pool-summary.test.ts pool-cli.test.ts pool-status-header.test.ts pool-throttle.test.ts
80 pass / 0 fail

$ bunx tsc --noEmit
exit=0

$ git diff main...HEAD --name-only -- '*.ts' '*.tsx'
skills/cmux-team/manager/main.ts
skills/cmux-team/manager/pool-summary.test.ts
skills/cmux-team/manager/pool-summary.ts
```
