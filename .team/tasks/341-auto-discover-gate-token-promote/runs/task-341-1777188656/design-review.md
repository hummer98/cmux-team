# Design Review — T341 plan.md

## Verdict: Approved

## Summary

plan.md は AC1〜AC5 を網羅し、参照する既存コードの行番号・signature・呼び出しパターンも実コードと一致しており、そのまま実装着手して良い。残るのは UX と命名上のマイナー指摘のみで、実装中に判断すれば十分（Major 4 件も実装ブロッカーではない）。Q1-Q3 の設計判断（auto-discover 限定 / positional 拡張 / proxy 起動時 1 回キャッシュ）も背景と一致する。

## Findings

### Critical (must-fix before implementation)

- なし

### Major (should-fix)

- **M1: `updateTokensDB` の signature を positional 拡張する場合、引数挿入位置を明示すべき**
  実コードの現 signature は `(authHash, rl, organizationId, surface, role, getState?)`（`proxy.ts:91-98`）。`tokenPoolEnabled` は **`getState?` の前** に挿入しないと optional 引数の規約が崩れる。plan §3-(B) の `// 変更後` シグネチャはこれを満たしているが、§1 影響表には書かれていない。実装時に「`getState?` の直前に必須引数として挿入」と明記しておくこと。読み手の負担を考えると options object 化（`{ tokenPoolEnabled, getState? }` の単一オブジェクト渡し）の方が読みやすく、将来の追加にも強い — 呼び出し点が 2 箇所だけなので差分も小さい。本件 implementer は options object を推奨。

- **M2: manual 経路 promote の `plan='unknown'` + `selectable=1` 問題**
  plan §3-(C) step 12 で `rateLimitTier` が未定義（source=2 / 手動入力）のとき `plan='unknown' / plan_ratio=null` のまま `selectable=1` で UPDATE する。これは `selectToken` 経由でこの token が選ばれ得るが capacity 計算には寄与しない（`computePoolCapacity` は `plan_ratio` を必要とする）状態を生む。最低限、完了メッセージに「plan が unknown の場合は `cmux-team token set-plan @<handle> <plan>` で訂正してください」のヒントを出すか、source=2 で rateLimitTier 取れない場合は対話で plan を聞く UI を入れる方が安全。

- **M3: `newHandle === oldHandle` のときの動作を仕様化する**
  plan §3-(C) step 6 では `newHandle !== oldHandle` のときだけ collision チェックする。同一の場合は UPDATE がそのまま走り、handle 列は no-op。auto-discover handle は `@<orgId 先頭 4-N 文字>`（例 `@cd8d`）なので、ユーザーが `cmux-team token promote @cd8d cd8d-extra` と打つと slug = `cd8d` で newHandle = `@cd8d` となり、handle 変わらず credential_source / selectable / tags だけ昇格する。意図的なら OK（migration はできる）だが、ユーザーが `token list` で「promote したのに handle が変わらない」と混乱しうる。`newHandle === oldHandle` の場合は info ログ「handle は変わりません（display name=...）」を出すと親切。

- **M4: §5.1 の「in-memory keychain stub パターン」記述が proxy gate テストには過剰**
  `__resetInMemoryKeychainForTest()` は `token-store.ts:854` で確かに export されているが、proxy gate のテスト（pool OFF/ON で INSERT されるか）は Keychain を一切触らない。plan の文面では proxy.test.ts の新 describe で `__resetInMemoryKeychainForTest()` を beforeEach に入れる前提に読めるが、不要かつテスト import を増やすので「proxy gate テストでは不要」と明記すること。既存 T323 describe（proxy.test.ts:1112-1150）も呼んでいない。`KEYCHAIN_TEST_MODE=1` だけは setup の便宜上付けても害はない（in-memory map は default で空）。

### Minor (nice-to-have)

- **m1: §2 Table の `usage_snapshots` UPSERT 行範囲**
  実コードでは UPSERT 本体は `proxy.ts:122-131`（`changed` 判定後）。`107-143` は known-token branch 全体（うち 132-143 は T323 の `maybeApplyTokenHandle` 呼び出し）。gate 配置（`else if` 直下）には影響しないので semantic に問題はないが、「known-token branch (107-143)」と書く方が正確。

- **m2: `updateTokenPlan` 直後への新関数追加位置**
  plan は「line 387 付近」と記載。実コードでは `updateTokenPlan` は `token-store.ts:375-386`、空行を挟んで line 388 が次セクションの区切りコメント（`// usage_snapshots`）。新関数は line 387-388 の間（コメント直前）に追加するのが自然。

- **m3: `docs/spec/09-token-pool.md` の `set-plan` 直後への追記位置**
  plan §6 では「line 31-86 (CLI コマンド節)」と書いているが、実ファイルでは `set-plan` セクションが `79-88` 行付近、`## DB スキーマ` が line 90。`promote` 追記は line 89 (set-plan 直後) に挿入するのが正しい。`auto-discover` 節は line 247-253 で 254 行目は空行 → 追記位置として 253-254 の間が無難。

- **m4: T341-P4（env override project=on）テストは冗長**
  `resolveTokenPoolEnabled` の優先度は `config.test.ts` 側で網羅されているため、proxy.test.ts で再検証する価値は薄い。代わりに「proxy 起動時に 1 回キャッシュ → 後から env を変えても挙動不変」という proxy 固有のキャッシュセマンティクスをテストする方が plan §3-(A) の意図と整合する。

- **m5: `cmdTokenPromote` で `db.close()` が exit パス毎に重複している**
  plan §3-(B) の実装スケルトンは exit 1 ごとに `db.close()` を書いている。`cmdTokenAdd` 既存実装は exit 前に close しないコードパスがある（line 116, 124, 129, 138, 156, 162 など）。`process.exit` で OS が fd を回収するので mandatory ではないが、実装中で揃えるなら `try { ... } finally { db.close(); }` 構造の方が読みやすい。これはスタイル提案。

- **m6: §10 Q1 の判断（auto-discover 以外を拒否）の妥当性**
  conductor-prompt の AC3 は「auto-discover 登録の `@cd8d` を promote」しか要求していないため、selectable=1 token への promote 拒否は仕様逸脱ではなく「scope を絞った実装」。妥当。将来 `cmux-team token rename @handle <new-name>` を別コマンドとして追加する余地がある旨を仕様書に一言入れておくと迷子を防げる。

## Recommendations

Approved のため Planner への差し戻しは不要だが、Implementer に伝えるべき推奨事項：

1. **M1**: `updateTokensDB` の引数追加は **options object 化を推奨**（呼び出し点 2 箇所のみ）。positional 拡張する場合は `getState?` の直前に必須引数として挿入し、影響表に注記する
2. **M2**: `cmdTokenPromote` 完了メッセージに plan='unknown' のときの `set-plan` 案内を出す（または source=2 で plan を対話入力）
3. **M3**: `newHandle === oldHandle` の場合は info ログを出して「handle 変更なし」を明示する
4. **M4**: proxy.test.ts の新 describe では `__resetInMemoryKeychainForTest()` を呼ばない（Keychain を使わないため）。token-cli.test.ts の新 describe では既存パターン通り呼ぶ
5. **m1-m6**: 実装中に該当箇所を編集する際に併せて修正

## Verified Against Real Code

| Plan の主張 | 実コード | 結果 |
|-----------|---------|------|
| `proxy.ts:91` の `updateTokensDB` | line 91-162 で関数定義。signature は `(authHash, rl, organizationId, surface, role, getState?)` | ✓ |
| `proxy.ts:107-143` usage_snapshots UPSERT | 厳密には UPSERT 本体は 122-131、132-143 は T323 tokenHandle apply。known-token branch 全体としては 107-143 | △ (semantic ok / 文言は不正確) |
| `proxy.ts:144-158` auto-discover INSERT | `} else if (organizationId) {` で開始、`insertToken` + `log("token_auto_discovered", ...)` まで | ✓ |
| `proxy.ts:346-852` `start()` | export async function start(projectRoot, opts?): Promise<ProxyHandle>、line 346 開始 / line 852 終了 | ✓ |
| `proxy.ts:653-660` 呼び出し点 (streaming) | 6 引数で `updateTokensDB(authHash, extractRateLimit(...), org-header, surface, role, opts?.getState)` | ✓ |
| `proxy.ts:721-729` 呼び出し点 (非 streaming) | 同上 6 引数で呼び出し | ✓ |
| `proxy.ts:47-54` `__resetTokensDbForTest` | export 関数、try/catch + `_tokensDb=null` | ✓ |
| `isTokenPoolEnabled` signature (`config.ts:445-453`) | `Promise<{ enabled: boolean; source: "env"\|"project"\|"global"\|"default" }>` を返す。plan の `decision.enabled` 使用と整合 | ✓ |
| `cmdTokenAdd` (`token-cli.ts:94-208`) | export async function、行範囲一致。macOS guard / source 選択 / probe / handle slug / tags / Keychain → DB 順序すべて plan の引用通り | ✓ |
| `cmdTokenSetPlan:383` の `process.argv[5]` | line 383 で `const planArg = process.argv[5]` | ✓ |
| `getHandleArg` (`token-cli.ts:419-427`) | `process.argv[4]` を読み `@` prefix 補完 | ✓ |
| `getTokenByHandle` / `getTokenByOrganizationId` (`token-store.ts:308-323`) | line 308-323、`Token \| null` を返す | ✓ |
| `storeTokenInKeychain` (`token-store.ts:544-576`) | KEYCHAIN_TEST_MODE で in-memory にフォールバック / 失敗時 KeychainCommandError | ✓ |
| `updateTokenPlan` (`token-store.ts:375-386`) | line 375 export、新関数追加位置として line 387 付近で OK | ✓ |
| `__resetInMemoryKeychainForTest` の export | `token-store.ts:854` で export 済み。`token-cli.test.ts:79` で import 実例あり | ✓ |
| `main.ts:5432-5446` `case "token"` switch | tokenSub の switch、Usage 文言は line 5442 | ✓ |
| `main.ts:114-118` import | `cmdTokenAdd` / `cmdTokenList` / `cmdTokenRemove` / `cmdTokenRotate` / `cmdTokenSetPlan` を `./token-cli` から import 済み。`cmdTokenPromote` 追加先として正しい | ✓ |
| `docs/spec/09-token-pool.md:247-254` auto-discover 節 | line 247 に `## auto-discover` 見出し。本文は 249-253、254 が空行 | ✓ |
| `docs/spec/09-token-pool.md` CLI 節 (plan §6: 31-86) | `### cmux-team token add` から `### cmux-team token set-plan` までは line 31-88、`## DB スキーマ` は line 90。promote 追記位置は line 88-89 の間が正しい | △ (行範囲ずれ / 修正容易) |
| `commands/token.md` 不存在 | `commands/` に token 関連ファイルなし。plan §5-B の判断は正しい | ✓ |
| `proxy.test.ts` 既存 setup パターン (T323) | line 1112-1150 で TOKEN_STORE_DB_PATH per-test ユニーク + KEYCHAIN_TEST_MODE=1 + `__resetTokensDbForTest()`。`__resetInMemoryKeychainForTest` は呼ばれていない | ✓ (M4 関連) |
| `token-cli.test.ts` 既存 setup パターン | line 139-166 で TOKEN_STORE_DB_PATH / KEYCHAIN_TEST_MODE / `__resetInMemoryKeychainForTest` / `setReadlineAnswers` / `withMockedFetch` / `setArgv` 揃っている | ✓ |
