# T341 実装結果

plan.md §9 の Step 1-5 をすべて TDD で実装し、design-review.md の Recommendations (M1-M4 + 関連 minor) を反映した。

## 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/proxy.ts` | `updateTokensDB` を options object 化（M1）、`isTokenPoolEnabled` import 追加、`start()` 起動時に token pool decision を 1 度評価しクロージャ束縛、`else if (organizationId)` 直下に `if (!tokenPoolEnabled) return` gate 挿入、2 箇所の呼び出し点を `{ tokenPoolEnabled, getState }` 形式に更新、`proxy_token_pool_resolved` ログ追加 |
| `skills/cmux-team/manager/token-store.ts` | `updateTokenPlan` 直後に `updateTokenPromoteFields(db, token_id, fields)` を新規 export。1 statement で `handle / auth_hash / plan / plan_ratio / tags / credential_source / selectable=1` を atomic UPDATE |
| `skills/cmux-team/manager/token-cli.ts` | `cmdTokenPromote` を新規 export（`cmdTokenSetPlan` 直後）。`updateTokenPromoteFields` import 追加。Keychain 先 → DB 後の順序、organization_id 検証、`newHandle === oldHandle` の info ログ（M3）、`plan === 'unknown'` で `set-plan` ヒント表示（M2）、`try/finally` で `db.close()` 構造（m5）を実装 |
| `skills/cmux-team/manager/main.ts` | import に `cmdTokenPromote` を追加、`case "token"` switch に `case "promote"` を追加、Usage 文言を `add\|list\|remove\|rotate\|set-plan\|promote` に更新 |
| `docs/spec/09-token-pool.md` | `set-plan` 直後に `### cmux-team token promote` セクションを追加（M2 ヒントと M3 同一 handle 挙動を記載、`token rename` の将来 scope に言及—m6）、`auto-discover` 節に「pool 機能 OFF では走らない (T341)」+「proxy 起動時 1 回キャッシュ」の説明を追記 |

## 追加テスト

| ファイル | テスト | ケース数 |
|---|---|---|
| `skills/cmux-team/manager/proxy.test.ts` | `describe("proxy: auto-discover gate (T341)")`: T341-P1 (pool OFF / 未知 token は INSERT されない), T341-P2 (pool ON / auto-discover INSERT される), T341-P3 (pool OFF / 既知 token の usage_snapshots UPSERT は維持), T341-P4 (proxy 起動時 1 回キャッシュ — m4 推奨に従い env override から差し替え) | 4 |
| `skills/cmux-team/manager/token-store.test.ts` | `describe("updateTokenPromoteFields (T341)")`: 正常系 (handle/source/selectable=1 切替), token_id 維持で usage_snapshots 不変 (AC4), `plan_ratio=null` 保存 | 3 |
| `skills/cmux-team/manager/token-cli.test.ts` | `describe("cmdTokenPromote (integration)")`: R-promote-1 (credential 経路), R-promote-2 (manual 経路 + tags), R-promote-3 (org_id 不一致 → exit 1 & DB 不変), R-promote-4 (旧 handle 不在), R-promote-5 (新 handle 衝突), R-promote-6 (auto-discover 以外を拒否), R-promote-7 (probe 失敗), R-promote-8 (usage_snapshots 維持), R-promote-9 (newHandle === oldHandle で info ログ), R-promote-10 (plan='unknown' で set-plan ヒント表示), R-promote-11 (引数不足 Usage) | 11 |

## テスト結果

```
proxy.test.ts          43 pass / 0 fail / 157 expect()
token-cli.test.ts      24 pass / 0 fail /  4 skip / 104 expect()
token-store.test.ts    96 pass / 0 fail /  1 skip / 176 expect()
```

`bunx tsc --noEmit` (skills/cmux-team/manager) → exit 0、新規エラー 0。

## design-review 推奨事項の対応状況

| 区分 | ID | 内容 | 対応 |
|---|---|---|---|
| Major | M1 | `updateTokensDB` を options object 化推奨 | 反映済み — `opts: { tokenPoolEnabled: boolean; getState?: () => any }` の単一 object に変更。呼び出し点 2 箇所も合わせて更新 |
| Major | M2 | `plan='unknown'` のとき `set-plan` ヒントを出す | 反映済み — `cmdTokenPromote` 完了メッセージ末尾に plan が `unknown` の場合のみ `Hint: ... set-plan ${newHandle} <pro\|max-x5\|max-x20>` を出力。R-promote-10 で検証 |
| Major | M3 | `newHandle === oldHandle` のとき info ログ | 反映済み — collision check の else 分岐で「情報: handle は変わりません（display name=... → @xxx）」を出力し、credential / plan / tags のみ更新する旨を表示。R-promote-9 で検証 |
| Major | M4 | proxy.test.ts では `__resetInMemoryKeychainForTest()` を呼ばない / token-cli.test.ts は既存パターン | 反映済み — proxy.test.ts の T341 describe では Keychain reset を import せず使用しない。`KEYCHAIN_TEST_MODE=1` のみ既存 T323 と同じ環境衛生のため設定。token-cli.test.ts は既存 `beforeEach` の `__resetInMemoryKeychainForTest()` 呼び出しをそのまま継承 |
| Minor | m1 | §2 影響表の文言は known-token branch の意 | 実装には影響なし（記載のみの指摘）。ノーアクション |
| Minor | m2 | `updateTokenPromoteFields` の追加位置は line 387-388 の間 | 反映済み — `updateTokenPlan` の直後に追加 |
| Minor | m3 | docs の `promote` 追記位置と auto-discover gate 追記位置 | 反映済み — set-plan セクション直後 (line 88-89 間) に `promote`、auto-discover 節末尾 (line 253 付近) に gate を追記 |
| Minor | m4 | T341-P4 を「proxy 起動時 1 回キャッシュ」に差し替える | 反映済み — env override テストではなく「起動後に env を変えても挙動不変」を検証 |
| Minor | m5 | `db.close()` を `try/finally` で揃える | 反映済み — `cmdTokenPromote` 全体を `try { ... } finally { db.close(); }` で囲み、各 exit パスでの個別 `db.close()` を排除 |
| Minor | m6 | 「`cmux-team token rename` を別コマンドとして将来追加する余地」を仕様書に明記 | 反映済み — docs/spec/09-token-pool.md の `promote` セクション末尾に明記 |

## AC との対応（plan §8）

| AC | 内容 | 検証 |
|---|---|---|
| AC1 | pool OFF で `claude` を動かしても tokens.db に INSERT されない | T341-P1 ✓ |
| AC2 | pool ON では従来通り auto-discover が走る | T341-P2 ✓ |
| AC3 | `token promote @cd8d kddi` で selectable=1 / handle=@kddi / plan / Keychain 登録 | R-promote-1, R-promote-2 ✓ |
| AC4 | promote 前後で `usage_snapshots` が壊れない（token_id 維持） | R-promote-8 + token-store.test.ts §updateTokenPromoteFields 第 2 ケース ✓ |
| AC5 | pool OFF でも proxy の usage tracking は機能する | T341-P3 ✓ |

## ガードレール遵守

- `bus.emit` / `bus.on` 直接呼び出し: 追加なし（既存コードそのまま）
- `taskState[...] =` / `saveTaskState(`: 触っていない
- 外部コマンド失敗時の stderr/stdout ログ: `cmdTokenPromote` の probe 失敗は console.error にメッセージあり（トークン情報は含めず）
- hook shell 分岐: 触っていない
- `bun test` 全体実行: 行わず、3 ファイル個別に実行

## 未対応・残課題

なし。plan §9 Step 1-5 と design-review M1-M4 + minor m1-m6 をすべて反映した。
