# Inspection Report: T320

検品者: Inspector Agent (surface:90)
検品日: 2026-04-25
worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-320-1777097743`

## Verdict
**GO**

実装は plan.md の §1〜§7 にほぼ忠実に追従しており、design-review.md (Round 2 Approved) で残存していた M4 任意項目（sanitized 4 文字未満 → null の純粋テスト）も追加吸収済み。テスト 4 種すべて緑、`bunx tsc --noEmit` も緑。fail-open / 既存 `safeInsertApiUsage` パスの非破壊・stop での DB close すべて確認できた。

---

## A. 仕様適合

- ✓ **auth_hash = sha256("Bearer " + token) 12 文字 prefix**
  `proxy-token-pool.ts:35-39` の `extractAuthHash`：`auth.startsWith("Bearer ")` で case-sensitive 判定 → `createHash("sha256").update(auth).digest("hex").slice(0, 12)`。仕様通り。
- ✓ **throttled UPSERT が util_5h/7d 1pt 以上変化 / reset / unified_status 変化で発火**
  `proxy-token-pool.ts:76-94` の `shouldUpsertSnapshot` + `sameUtil` (UTIL_DELTA_THRESHOLD = 0.01, `<` 比較)。
- ✓ **auto-discover が selectable=0 / tags=["auto"] / plan="unknown" / credential_source="auto-discover"**
  `proxy-token-pool.ts:148-157` の `insertToken` 呼出しで全フィールド合致。
- ✓ **実 token を Keychain に登録していない**
  `grep storeTokenInKeychain proxy-token-pool.ts proxy.ts` ヒット 0。`auth_hash` 列のみ書き込み。
- ✓ **既存 `.team/traces/traces.db` (`api_usage`) パスは無変更**
  `proxy.ts:620-637` (非 streaming) と `proxy.ts:871-889` (streaming) の `safeInsertApiUsage` 呼出順・引数とも main 比で同一（差分は `if (opts?.db && /v1/messages)` 判定式が `apiUsageCtx = isMessagesEndpoint && opts?.db ? {...} : null` に再構成されただけで、INSERT 引数は完全保存）。
- ✓ **DB ハンドルが `start()` クロージャ内に閉じ込められている**
  `proxy.ts:188` で `let tokenDb: Database | null = null` として `start()` 内 closure 変数。module-level singleton (旧 `_tokensDb` / `getTokensDB`) は完全削除済み (diff の最初の 90 行で確認)。
- ✓ **`stop()` で `tokenDb?.close()` が呼ばれる**
  `proxy.ts:673-680` で `try { tokenDb?.close(); } catch {}`。

## B. レビュー指摘の解消（C1/C2/M1-M5）

- ✓ **C1: shouldUpsertSnapshot 境界値 FP 安定値 (0.305 / 0.32) と `<` 比較整合**
  `proxy-token-pool.test.ts:167-189` で `0.30 → 0.305 → false` / `0.30 → 0.32 → true`。`UTIL_DELTA_THRESHOLD` 定数値テスト (line 45-47) も独立に存在。FP 不安定値 (0.31) 不使用を確認。
- ✓ **C2: `recordTokenUsage` が `if (opts?.db)` ブロックの外側に独立分岐**
  非 streaming: `proxy.ts:643-645` で `if (url.pathname === "/v1/messages") recordTokenUsage(...)` と独立。streaming: `proxy.ts:894-900` で `if (ctx.tokenUsage)` 単独判定（`ctx.apiUsage` の有無に依存しない）。`tokenUsageCtx` は `tokenDb && isMessagesEndpoint` のみで生成 (proxy.ts:499-504)。
- ✓ **M1: テスト検証主軸が `util_5h` / `reset_5h_at` 値**
  case 3: `expect(snapshot!.util_5h).toBe(0.3)` (proxy.test.ts:1306)
  case 4: `expect(snapshot!.util_5h).toBe(0.32)` (proxy.test.ts:1374)
  case 5: `expect(snapshot!.reset_5h_at).toBe("2026-04-25T05:30:00Z")` (proxy.test.ts:1444)
  `recorded_at` 比較は使われていない（flaky 排除）。
- ✓ **M2: streaming `responseHeaders` が `new Headers(upstreamRes.headers)` の独立 copy**
  `proxy.ts:499-504`：`responseHeaders: new Headers(upstreamRes.headers)`。参照競合のリスクなし。
- ✓ **M3: streaming + auto-discover テスト追加**
  `proxy.test.ts:1525-1591` の case 7「streaming SSE + 未登録 token → auto-discover が発火する」。SSE 完了後に `tokens` 1 件 + `snapshot.util_5h === 0.20` + `unified_status === "allowed"` を検証。ctx 経由の orgId/auth_hash 伝搬の生存確認に十分。
- ✓ **M4: handle 4-6 全衝突 / sanitized 4 文字未満の skip**
  proxy-token-pool.test.ts:119-131 で (d) 全衝突 → null + (e) sanitized 4 文字未満 → null (`pickAutoDiscoverHandle(db, "---")`)。N8 の任意改善も取り込み済み。
- ✓ **M5: `insertToken` UNIQUE 違反吸収 + 再 SELECT**
  `proxy-token-pool.ts:147-162`：`try { insertToken(...) } catch { token = getTokenByOrganizationId(...); if (!token) throw e; }`。直後に `upsertUsageSnapshot` で初回 snapshot を確実に書く（`ON CONFLICT` で冪等）。

## C. コード品質

- ✓ **fail-open: `recordTokenUsage` 内部の最上位 try/catch**
  `proxy-token-pool.ts:112-177` で全体を try でラップ。catch は `console.warn` のみで proxy のクリティカルパス (fetch → response 転送) に伝播しない。
- ✓ **logger.ts 循環依存回避**
  `grep logger proxy-token-pool.ts` で import 行 0（コメント言及のみ）。`console.warn` を使用 (line 176)。
- ✓ **既存 12 ケース proxy.test.ts が `~/.cmux-team/tokens.db` を汚さない**
  `proxy.test.ts:13-19` の最上位 `beforeEach` で `process.env.TOKEN_STORE_DB_PATH = join(testDir, "tokens.db")` を設定し、afterEach で revert (line 30-39)。describe `tokens_db (T320)` に閉じない最上位設置で全テスト保護。
- ✓ **不要な変更・リファクタリング・コメント差分の混入なし**
  proxy.ts の主な diff は: (1) 旧 `_tokensDb` シングルトン全削除、(2) `import { recordTokenUsage }` 追加、(3) `tokenDb` クロージャ初期化、(4) `apiUsageCtx` 構造の `isMessagesEndpoint && opts?.db` 条件式微調整（既存挙動と等価）、(5) `tokenUsageCtx` 追加、(6) `drainAndRecord` ctx 型に `tokenUsage` 並列フィールド追加、(7) finally 内 `if (ctx.tokenUsage) recordTokenUsage(...)`、(8) stop で close。すべて plan §4 Step 1〜5 と整合。
- ✓ **新規ファイルに dead code / 不要 export なし**
  `extractAuthHash` / `pickAutoDiscoverHandle` / `shouldUpsertSnapshot` / `recordTokenUsage` / `UTIL_DELTA_THRESHOLD` / `SnapshotInput` のみ export。`sameUtil` は内部関数 (export 無し)。
- ✓ **`crypto` import が `node:crypto` の `createHash`**
  `proxy-token-pool.ts:14`: `import { createHash } from "node:crypto"`. Bun 互換 OK（旧 proxy.ts は `crypto` 短縮名 import だったが node: prefix に正規化）。

## D. テスト実行結果

```
$ cd skills/cmux-team/manager
$ bun test proxy-token-pool.test.ts
  20 pass / 0 fail / 21 expect() calls / 150ms

$ bun test proxy.test.ts
  44 pass / 0 fail / 171 expect() calls / 3.23s
  (既存 36 + T320 新規 8)

$ bun test token-store.test.ts
  57 pass / 1 skip / 0 fail / 108 expect() calls / 1.34s
  (skip 1 件は既存 macOS Keychain 実機テスト、T320 と無関係)

$ bun test  (全 manager)
  1323 pass / 1 skip / 0 fail / 3184 expect() calls / 63.21s (44 ファイル)

$ bunx tsc --noEmit
  exit 0 (緑)
```

すべて緑 → GO 候補成立。

## E. 影響範囲

- **proxy.ts 他経路 (statusline / master-state / count_tokens)**: 副作用なし。`/v1/messages` 完全一致でしか `recordTokenUsage` を呼ばない (proxy.ts:643 / 894)。`apiUsageCtx` 構造の `isMessagesEndpoint && opts?.db` 条件式は元の `!!opts?.db && url.pathname === "/v1/messages"` と論理等価で、count_tokens など他 endpoint の挙動変化なし。`tokenDb` 初期化失敗時 `null` 続行で proxy 自体は動く。
- **既存テスト全体（manager/）緑**: 1323 pass / 0 fail。既存 36 ケースの proxy.test.ts も全緑。
- **token-store.test.ts 変更なし**: `git diff main -- skills/cmux-team/manager/token-store.test.ts` ヒット 0。既存 57 pass / 1 skip 維持。
- **`isMessagesEndpoint` 判定の意味的変化**: 旧実装では `apiUsageCtx` だけが `isMessagesEndpoint` を必要としていたが、tokens.db 経路でも同判定が必要になったため `const isMessagesEndpoint = url.pathname === "/v1/messages"` に共通化された。`apiUsageCtx` の生成条件 (`isMessagesEndpoint && opts?.db`) は旧 `!!opts?.db && url.pathname === "/v1/messages"` と論理等価 → api_usage 経路の挙動・テスト結果ともに不変。

## Critical findings (NOGO の場合)

なし。

## Minor observations (任意の改善提案)

1. **proxy-token-pool.ts:124-125 の `parseFloat`**
   `parseFloat("abc") === NaN` を `isNaN` で弾いて null 化しているが、Anthropic API は実機で常に有効値を返す前提（A020）。仕様上 OK だが、極端な不正値（`null` 文字列など）が来た場合のログトレースは無いので将来 robustness を高めたければ `console.warn` 1 行追加してもよい（必須ではない）。
2. **`extractAuthHash` ヘッダー名 `authorization`**
   `Headers.get` は case-insensitive なので問題なし。ただし auth scheme 自体は `startsWith("Bearer ")` で case-sensitive 判定（A020 §2 の「実機 `Bearer ` 固定」前提）。将来仕様変更を検出するための P1 (d) 小文字 `bearer` テストが既に存在するため OK。
3. **proxy.test.ts の `await new Promise((r) => setTimeout(r, 50))`** (case 1, 2, 3, 4, 5, 8) と **200ms** (case 6, 7)
   `recordTokenUsage` の同期実行を待つための sleep だが、非 streaming 経路では `recordTokenUsage` は同期呼び出し → 50ms は overshoot、streaming は drainAndRecord が `.catch(() => {})` 投げ放しなので 200ms は最低限必要。CI で flaky になっていないので現状維持で問題ない。
4. **`drainAndRecord` 内で `recordTokenUsage` が finally の最後**
   既存 `safeInsertApiUsage` の直後に置かれており、片方の例外がもう片方に波及しないかは `safeInsertApiUsage` 自体が内部 try/catch を持つことで担保 (`proxy.ts:157-167`)。レイヤ的には `recordTokenUsage` も独自に try/catch を持つので二重防護。OK。

## 結論

**GO**。実装は plan.md および design-review.md (Round 2 Approved) の全要件を満たし、Round 1 で挙がった C1/C2/M1-M5 もすべて解消。M4 の任意項目（sanitized 4 文字未満の純粋テスト）も追加されており完全解消。全テスト緑 (1323 pass / 0 fail / 1 unrelated skip)、`bunx tsc --noEmit` 緑、既存 `api_usage` 経路は非破壊。マージ可。
