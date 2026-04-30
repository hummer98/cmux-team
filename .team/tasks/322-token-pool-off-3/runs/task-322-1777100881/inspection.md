# T322 Inspection Report

## Verdict
GO

## Verification Results

### テスト・型チェック
- `bun test`（manager 全体、`CMUX_TEAM_LOGGER_STRICT=1`）: **pass** — 1314 pass / 1 skip / 0 fail / 3147 expects across 43 files。本タスク追加分（resolveTokenPoolEnabled 16 + smoke 3 = 19 ケース）は全て pass。
- `bunx tsc --noEmit`（manager）: **pass** — exit 0、新規 TypeScript エラー 0 件。

### タスク本文 §検証要件 (1〜6) の判定

| # | 要件 | 判定 | 根拠 |
|---|---|---|---|
| 1 | `CMUX_TEAM_TOKEN_POOL=0` で無効 | ✅ | `config.ts:194` で `0`/`false`/`off` を `enabled=false, source=env` に解決。test #1〜#3 |
| 2 | `.team/config.json: { "token_pool": { "enabled": false } }` で無効 | ✅ | 実装は plan 決定 D3 通り camelCase の `tokenPool` で受ける。test #7、smoke `project=true` |
| 3 | `~/.cmux-team/config.yaml: token_pool: { enabled: true }` + 他なし で有効 | ✅ | yaml 慣習に従い snake_case の `token_pool` を読み出して `tokenPool` に正規化。`config.ts:235-242`。test #10 + smoke `global` |
| 4 | 未設定時は無効（opt-in） | ✅ | `config.ts:208` で fallback default が `enabled: false, source: default`。test #12、#13、smoke `default` |
| 5 | `cmdSpawnAgent` 冒頭で `isTokenPoolEnabled` を呼び、false なら selection スキップ | ✅ | `main.ts:2535-2561`。T321 try/catch ブロックは破壊せず、外側に enable ガードを 1 段追加（plan §4 通り「ガード 1 段追加」）。OFF 時は `token_pool_skipped` ログのみ |
| 6 | `cmux-team start` 初期化ログに pool の有効/無効を出力 | ✅ | `main.ts:657-668`、`fetch_before_worktree` ログ直後に `token_pool_config enabled=<on|off> source=<env|project|global|default>` を 1 行 emit。env 不正値で fail-fast (exit 1) |

### 検品観点 1〜9 の判定

| 観点 | 判定 | コメント |
|---|---|---|
| 1. plan §1〜§9 一致度 | ✅ | 影響範囲・signature・優先順位・テスト数・実装ステップ・完了条件すべて plan 記載と整合。乖離は summary 記載の補足判断 3 件（`process.env.HOME ?? homedir()`、project 型違反 fallback、yaml dynamic import）のみで、いずれも妥当 |
| 2.a 優先順位ロジック | ✅ | `config.ts:186-209` で env → project → global → default の short-circuit。test #1〜#13 で網羅 |
| 2.b env キー値解釈 | ✅ | plan §3.1 と完全一致。`""` は未指定扱い（既存 `resolveAutoUpdateMode` 流儀、決定 D2）。`yes` / `2` は throw（test #14, #15） |
| 2.c project 型違反処理 | ✅ | `typeof projectVal === "boolean"` 判定で string `"true"` 等は未指定扱いに落として次層へフォールバック。最後の test ケースで実証 |
| 2.d cmdSpawnAgent T321 ブロック | ✅ | 「壊して書き換え」ではなく「ガード 1 段追加」。enabled の場合のみ既存 selection ロジックを実行。`token_pool_assigned` ログに `source=` を追加した部分も plan §4 例示通り |
| 2.e cmdStart `token_pool_config` ログ | ✅ | 出力位置（`fetch_before_worktree` 直後）・kind 命名（既存 `auto_update_config` 等と整合）・フォーマット (`enabled=<on|off> source=…`) すべて plan §5 通り |
| 3. テスト網羅性 | ✅ | plan §6 テーブル 15 ケース全 + 型違反 1 ケース + smoke 3 ケース = 19 ケース。table-driven で各分岐を直接検証 |
| 4. `bun test` 実行 | ✅ | 1314 pass / 0 fail |
| 5. `bunx tsc --noEmit` | ✅ | exit 0 |
| 6.a `bus.emit`/`bus.on` 直接呼び出し | ✅ | `rg "bus\.(emit|on)\b" skills/cmux-team/manager` 0 件（eventBus.ts 除外） |
| 6.b `taskState[...] =` / `saveTaskState(` 直接書き込み | ✅ | `daemon.ts` / `main.ts` で 0 件 |
| 6.c 空の `catch {}` | ✅ | 新規追加コードに空 catch なし。既存 `try { previousProxyPort = ... } catch {}` などは本タスク差分外 |
| 7. コード品質・命名 | ✅ | `resolveAutoUpdateMode` / `resolveFetchBeforeWorktree` と同じ命名・signature・JSDoc スタイル。`{ enabled, source }` 返却で運用ログに source を残せる |
| 8. 後方互換 | ✅ | `TeamConfig.tokenPool` は optional。既存 `.team/config.json` で `tokenPool` 未指定時は `default(false)` に確定し、env も project も global も使われない場合は token pool selection 自体がスキップされる。T321 までの動作を変えうる箇所だが、plan §0 の方針通り「opt-in に倒す」ため意図的 |
| 9. テストの HOME 上書き副作用 | ✅ | smoke describe の `beforeEach` で `originalHome` 退避、`afterEach` で復元 + `mkdtemp` した fakeHome を rm。Bun はデフォルト直列実行（並列フラグなし）のため他テストへの干渉なし。1314 pass で実証 |

## Findings

### critical
なし。

### major
なし。

### minor

1. **D2「`""` を false」解釈差の合意確認が未着地**
   タスク本文には「`""` を false」と読める記述があるが、plan §決定 D2 で「既存 `resolveAutoUpdateMode` と揃え、空文字＝未指定（fallback）」に倒している。実装も plan 通り（`config.ts:192` で `raw === ""` を fallback 扱い）。これは構造的整合性の観点で正しい判断だが、タスク発注者へ確認を残しておくのが望ましい。test #9 で project にフォールバックすることが明示的に検証されている。

2. **`loadGlobalConfig` の readFile catch がファイル不在以外も silent null**
   `config.ts:226-229` の最初の `try { readFile } catch { return null; }` は、ファイル不在のみならずパーミッションエラー等の I/O エラーも silent に null へ落とす。plan §3.3 は「ファイル不在 → null、parse 失敗 → console.warn」と分けて書いていたため厳密には plan 乖離だが、best-effort 方針の範囲内。実害は「`~/.cmux-team/config.yaml` が読めないときに global を使えない」だけで daemon は default で動く。loadConfig の既存パターン（`} catch { return {}; }`）と統一されている点も妥当。

3. **`process.env.HOME ?? homedir()` の採用**
   summary の plan 乖離 1 件目。Bun の `os.homedir()` が HOME 環境変数を尊重しない実装に対応するため採用。token-store と同じ流儀で、本番 / テストどちらでも期待通り。HOME を明示的に unset する稀ケースでのみ `homedir()` にフォールバック。

4. **`loadGlobalConfig` の `await import("yaml")` 動的 import**
   summary の plan 乖離 3 件目。loadGlobalConfig 未呼び出し経路（テスト等）で yaml モジュールを resolve しなくて済むようにした判断は妥当。bun ランタイムでも問題なし。

5. **smoke test の HOME 副作用**
   `beforeEach` で `delete process.env.CMUX_TEAM_TOKEN_POOL` を実行している。グローバル describe block の他テストが `CMUX_TEAM_TOKEN_POOL` を設定していないので副作用はない。`afterEach` で復元済み。

## Fix Required (NOGO の場合のみ)
N/A（GO のため不要）。

## Notes

- **手動検証**: plan §8 step 7 の `cmux-team start` 4 パターン手動検証は worktree 内 daemon を起動できないため未実施。logging 経路への到達自体は単体テストで間接検証されているが、QA 環境での起動ログ確認が望ましい点は summary の通り。
- **plan §4 の T321 温存方針**: `cmdSpawnAgent` 改修は外側にガードを 1 段追加するだけで、T321 で導入された try/catch・`token_pool_assigned` / `token_pool_fallback` ログ・`initTokenDB` / `selectToken` / `retrieveTokenFromKeychain` の呼び出し順序を破壊していない。`token_pool_assigned` ログに `source=` を追記した点のみ追加情報で、T321 のテスト互換性を壊さない（grep で関連テストを確認する限り source 文字列を assertion していない）。
- **CLAUDE.md「構造的正しさを優先」整合**: 既存 `resolveAutoUpdateMode` / `resolveFetchBeforeWorktree` と同じ「`{ value, source }` を返す純粋関数 + async I/O wrapper」パターンを踏襲しており、layered な責務分離が明示的。今後 plan 設定や notify 設定を追加する際も `loadGlobalConfig` の戻り値型を拡張するだけで済む拡張可能な構造になっている。
- **package-lock.json の差分**: `git diff --stat` に `package-lock.json | 4 +-` が出るが、これはリポジトリ root の lock で、別タスク由来の既存差分。本タスク影響範囲外。
- **reviewer への申し送り**: D2「`""` を false vs 未指定」と「parse 失敗時の console.warn が logger 経由でない」の 2 点は plan/summary でも申し送られているため、reviewer 側で最終判断を残すのみ。
