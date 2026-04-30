# T320 実装サマリー — proxy.ts → tokens.db throttled UPSERT + auto-discover

実装日: 2026-04-25
worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-320-1777097743`
plan: `plan.md`（design-review.md Approved）
TDD 手順: `proxy-token-pool.test.ts` を先に追加 → 純粋ロジック実装 → proxy.ts 統合 → 統合テスト追加

## 変更ファイル一覧

### 新規

| ファイル | 概要 |
|---------|------|
| `skills/cmux-team/manager/proxy-token-pool.ts` | 純粋ロジック切り出し（`extractAuthHash` / `pickAutoDiscoverHandle` / `shouldUpsertSnapshot` / `recordTokenUsage` / 定数 `UTIL_DELTA_THRESHOLD`） |
| `skills/cmux-team/manager/proxy-token-pool.test.ts` | P1〜P3 + 補助ケースのユニットテスト |

### 編集

| ファイル | 概要 |
|---------|------|
| `skills/cmux-team/manager/proxy.ts` | `tokenDb` クロージャ + `recordTokenUsage` 呼び出しを非 streaming / streaming の両経路で `opts.db` から独立分岐として追加。`stop()` で `tokenDb?.close()` |
| `skills/cmux-team/manager/proxy.test.ts` | 最上位 `beforeEach` で `TOKEN_STORE_DB_PATH` を testDir に向ける setup を追加。新 describe `tokens_db (T320)` 8 ケース実装 |

## 追加した関数 / 定数

`skills/cmux-team/manager/proxy-token-pool.ts`:

- `UTIL_DELTA_THRESHOLD = 0.01`（export 定数。`<` 比較なので 0.01 ちょうどは upsert 側に倒れる）
- `extractAuthHash(headers): string | null`
- `pickAutoDiscoverHandle(db, organization_id): string | null`（4 → 5 → 6 文字の順、衝突 / sanitized 不足時 null）
- `shouldUpsertSnapshot(prev, next): boolean`
- `recordTokenUsage(tokenDb, responseHeaders, requestHeaders): void`
  - 内部例外は最上位 try/catch で吸収（fail-open、`console.warn` のみ）
  - auto-discover 経路で `insertToken` UNIQUE 違反を `getTokenByOrganizationId` 再 SELECT で吸収（M5）

`skills/cmux-team/manager/proxy.ts`:

- `start()` 内で `tokenDb: Database | null` をクロージャ保持。`initTokenDB()` 失敗時は `tokenDb=null` のまま続行（`token_store_init_failed` ログ）
- 非 streaming `/v1/messages` 経路: `if (opts?.db && ...)` ブロックの**外側**に独立分岐で `recordTokenUsage(tokenDb, upstreamRes.headers, req.headers)` を呼ぶ
- streaming 経路: `drainAndRecord` の `ctx` に `tokenUsage: { tokenDb, requestHeaders, responseHeaders }` を `apiUsage` と並列の独立フィールドで持たせる。`responseHeaders` は `new Headers(upstreamRes.headers)` で独立 copy（M2）。finally 内で `if (ctx.tokenUsage) recordTokenUsage(...)`
- `isMessagesEndpoint` 判定を `url.pathname === "/v1/messages"` のみに分離（既存 `opts.db` 依存と切り離す、C2）
- `stop()` で `try { tokenDb?.close(); } catch {}` を追加

## 追加したテストケース

### `proxy-token-pool.test.ts`（純粋ロジック、20 件 pass）

- `UTIL_DELTA_THRESHOLD` 定数値の確認（1 件）
- `extractAuthHash` (P1, N2): 欠落 / x-api-key / Basic / 小文字 bearer / Bearer + token / 同一値の決定論性（6 件）
- `pickAutoDiscoverHandle` (P2, M4): 衝突なし / 4 衝突 / 4・5 衝突 / 4・5・6 全衝突 / sanitized 4 文字未満 / 大文字混じり（6 件）
- `shouldUpsertSnapshot` (P3, C1): prev=null / 0.30→0.305 / 0.30→0.32 / reset のみ / unified_status のみ / null↔数値 / 両 null（7 件）

### `proxy.test.ts` 新 describe `tokens_db (T320)`（統合、8 件 pass）

| # | ケース | 検証内容 |
|---|-------|---------|
| 1 | auto-discover (case 1, N5) | 未登録 + organization_id ヘッダー有り → tokens 1 件（selectable=0 / tags=auto / plan=unknown / credential_source=auto-discover）+ snapshot.unified_status=null |
| 2 | organization_id 無し (case 2) | tokens テーブル空 |
| 3 | throttle 内 (case 3, M1/N3) | 0.30→0.305 → snapshot.util_5h === 0.30（書き換わらない） |
| 4 | throttle 越え (case 4, M1/N3) | 0.30→0.32 → snapshot.util_5h === 0.32 |
| 5 | reset 変化 (case 5, N3) | reset_5h_at のみ変化 → 新値に更新 |
| 6 | streaming + 既存 token (case 6) | SSE 完了後 snapshot.util_5h === 0.55 |
| 7 | streaming + auto-discover (case 7, M3) | SSE finally で auto-discover が発火、tokens 1 件 + snapshot 入る |
| 8 | Authorization 無し (case 8) | tokens テーブル空 |

## テスト結果

```
$ bun test proxy-token-pool.test.ts
20 pass / 0 fail / 21 expect() calls

$ bun test proxy.test.ts
44 pass / 0 fail / 171 expect() calls   (既存 36 + T320 新規 8)

$ bun test token-store.test.ts proxy-token-pool.test.ts
77 pass / 1 skip / 0 fail / 129 expect() calls

$ bun test  (全 manager)
1323 pass / 1 skip / 0 fail / 3184 expect() calls   (44 ファイル, 60.71s)
```

`skip` 1 件は既存 token-store.test.ts の Keychain 実機テスト（macOS 以外でのスキップ）で本タスクと無関係。

## tsc 結果

```
$ bunx tsc --noEmit   (skills/cmux-team/manager/)
（出力なし、緑）
```

## 設計判断で plan から逸脱した点

なし。plan.md §1〜§7 の指示通りに実装した。任意推奨だった以下も取り込み済み:

- N8: `pickAutoDiscoverHandle` の sanitized 4 文字未満 → null を P2 (e) として明示テスト
- M4 完全カバー: P2 で「4・5・6 全衝突 → null」もテスト
- N5: case 1 で `unified-status` 未返却 → null を統合検証
- M3: streaming + auto-discover を case 7 として独立追加

streaming 経路の `drainAndRecord` ctx 設計では、plan §4 Step 3d で例示された
`{ tokenDb, requestHeaders, responseHeaders, isMessagesEndpoint }` 4 フィールド
構成ではなく、**`tokenUsage: { tokenDb, requestHeaders, responseHeaders } | null`**
という **nullable オブジェクトに集約する**形にした。理由:

- 既存の `apiUsage` も `null` 可なオブジェクトに集約済み（直接同じパターン）
- `isMessagesEndpoint` を ctx に持たせると drainAndRecord 側で「`tokenDb` 非 null かつ `isMessagesEndpoint`」の二重判定が必要だが、呼び出し側で集約しておけば finally 内は単純な `if (ctx.tokenUsage)` だけで済む
- 設計意図（apiUsage と並列の独立フィールド）は維持されている

## 完了基準チェック

- [x] `proxy-token-pool.ts` 新規作成、4 関数 export
  - [x] M5 concurrent insert race 対応
- [x] `proxy-token-pool.test.ts` で P1/P2/P3 + 補助ケース pass
  - [x] N2 小文字 bearer → null
  - [x] M4 全衝突 → null
  - [x] C1 安定値 (0.305 / 0.32)
- [x] `proxy.ts` で `tokenDb` クロージャ + `recordTokenUsage` 2 箇所呼び出し
  - [x] C2 非 streaming は `if (opts?.db)` の外側
  - [x] C2 streaming は ctx 並列フィールド + `if (ctx.apiUsage)` の外側
  - [x] M2 `responseHeaders` を `new Headers(upstreamRes.headers)` で独立 copy
- [x] `proxy.test.ts` で `TOKEN_STORE_DB_PATH` setup + tokens_db describe 8 ケース pass
  - [x] M1/N3 case 3/4/5 値検証主軸
  - [x] M3 case 7 SSE auto-discover
  - [x] N5 case 1 unified_status null
- [x] 既存 proxy.test.ts 全ケース緑（36/36 pass、regression なし）
- [x] 既存 token-store.test.ts 全ケース緑（既存と同一 pass 数）
- [x] `bunx tsc --noEmit` 緑
