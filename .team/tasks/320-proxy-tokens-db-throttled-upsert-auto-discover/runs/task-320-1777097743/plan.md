# T320 実装計画書 — proxy.ts → tokens.db throttled UPSERT + auto-discover

> Revision: 2026-04-25 — design-review.md (Critical C1/C2 + Major M1-M5 + Minor N2/N3/N5) を反映

## 0. ゴールと非ゴール

### ゴール
- proxy.ts が Anthropic API レスポンスを受け取った際、`~/.cmux-team/tokens.db` の `usage_snapshots` を **throttled UPSERT** する
- 未登録トークン（`organization_id` が `tokens` テーブルに無い）を検出したら **auto-discover 登録**（`selectable=0` / `tags=["auto"]` / `plan="unknown"` / `credential_source="auto-discover"`）を行う
- streaming / 非 streaming の両経路で同一ロジックが 1 回だけ走る
- 既存の `.team/traces/traces.db` への `api_usage` INSERT パスは**一切変更しない**
- proxy のクリティカルパス（fetch → response 転送）は **fail-open**（tokens.db 書込失敗で 5xx を返さない）
- **tokens.db 更新は traces.db (`opts.db`) の有無に依存しない独立経路として実装する**（C2）

### Non-goals（本タスクではやらない）
- spawn-agent の token selection ロジック（A019 §データフロー §spawn-agent — 別タスク）
- TUI `pool capacity` 表示 / `cmux-team pool status` コマンド
- `cmux-team token add|list|remove|rotate|set-plan` CLI（T318 で schema/CRUD は既出、CLI は別タスク）
- 機能 OFF 設定（`CMUX_TEAM_TOKEN_POOL=0` / `.team/config.json` の `token_pool.enabled`）の 3 階層実装
- `api_usage` テーブル schema 拡張（`auth_hash` 列追加など — A020 で提案されているが本タスク外）
- token rotation（OAuth refresh）の追跡 — A020 §未解決の疑問
- Keychain への実 token 登録（auto-discover では明示的に **登録しない**）

---

## 1. 設計判断（プロンプト §設計判断ポイント に対する回答）

### 1.1 DB ハンドル singleton をどこで持つか

**結論**: `start(projectRoot, opts)` のクロージャ内で `tokenDb: Database | null` 変数として保持し、`stop()` で close する。

- module-level singleton は test isolation を壊す（複数テストが同じ in-process daemon インスタンスを共有してしまう）
- proxy.test.ts は `beforeEach` で fresh `testDir` を作って `start()` を呼び、`afterEach` で `handle.stop()` する流れなので、`start()` 内ライフサイクルが既存パターンと一致
- 失敗時の挙動: `initTokenDB()` が throw した場合は `tokenDb=null` のまま続行し、本機能は完全に無効化（ログ警告のみ）
- 後段の helper はすべて「`tokenDb === null` なら no-op」で書く

```ts
// proxy.ts start() 内のスケッチ
let tokenDb: Database | null = null;
try {
  tokenDb = initTokenDB();  // env TOKEN_STORE_DB_PATH があればそこ、なければ ~/.cmux-team/tokens.db
} catch (e: any) {
  log("token_store_init_failed", e.message).catch(() => {});
  tokenDb = null;
}
// ... fetchHandlerInner 内では tokenDb を closure 経由で参照
return {
  port: server.port!,
  stop: () => {
    server.stop();
    try { tokenDb?.close(); } catch {}
  },
};
```

### 1.2 auth_hash の Authorization 抽出

**結論**: `Authorization` ヘッダーが `Bearer ` 始まりの値のときだけ hash を計算する。それ以外（`x-api-key` / 欠落 / 別形式 / 小文字 `bearer`）は **本機能を skip**（throttled UPSERT も auto-discover も行わない、ログ警告のみ）。

```ts
function extractAuthHash(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;  // case-sensitive 判定
  const sha = createHash("sha256").update(auth).digest("hex");
  return sha.slice(0, 12);  // A019 §セキュリティ・A020 §2 と同じ 12 文字 prefix
}
```

- A020 §2 で `sha256("Bearer " + token)` 全体をハッシュ対象とする方針を確定済み（プロンプト §1 もこれに従う）
- `x-api-key` 経路は subscription OAuth の本道ではなく、対象外として明示
- 計算対象は **完全な `Authorization` header value**（`"Bearer sk-ant-oat01-..."` 全体）。client が大文字 `Bearer ` で送っているか確認するため `startsWith("Bearer ")` で厳密判定
- RFC 9110 上 auth scheme は case-insensitive だが、Claude Code 本体は実機で `Bearer ` 固定 (A020 §2)。将来仕様が変わった場合に検出できるよう、P1 テストで `"bearer xxx"`（小文字）を null と判定することを明示する（N2）

### 1.3 handle 衝突時の伸長アルゴリズム

**結論**: 4 → 5 → 6 文字の順で `getTokenByHandle()` をループで叩いて空き枠を探す。6 文字でも衝突したら **auto-discover を skip**（warn ログ、cascading retry はしない）。

```ts
function pickAutoDiscoverHandle(db: Database, organization_id: string): string | null {
  const sanitized = organization_id.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  for (const len of [4, 5, 6]) {
    const candidate = sanitized.slice(0, len);
    if (candidate.length < len) break;  // 元 ID が短すぎ → null
    if (!getTokenByHandle(db, candidate)) return candidate;
  }
  return null;
}
```

- A019 §アカウント表記規約の `@xxxx` 規約 (4 文字 + `@`) と異なる仕様だが、**プロンプト §3 の指示を優先**して `@` プレフィックスを付けない素の文字列で登録する
- `organization_id` は UUID 形式（`cd8db5e8-05fb-4aef-bb8c-17bb78e24406`）を想定。`-` を除去して英数のみで先頭を取る
- 6 文字でも衝突するのは pratically 起きないが、起きた場合のログ出力で気付けるようにする（cascade retry で TUI を埋め尽くさない）
- sanitized 文字列が 4 文字未満になる極端ケース（`organization_id = "---"` など）は `cand.length < len` で break → null 返却 → auto-discover skip

### 1.4 throttle 判定の最前に「token が tokens.db に登録済みか」を引く

**結論**: 以下の順序で 1 回の処理に統一する:

```
1. extractAuthHash(headers) → hash が無ければ完全 skip
2. extractRateLimit(headers) → util_5h / util_7d / reset 時刻
3. organization_id = headers.get("anthropic-organization-id")
4. token = getTokenByOrganizationId(db, organization_id)
5a. token == null:
    → auto-discover ルート（pickAutoDiscoverHandle → insertToken with selectable=0）
    → insertToken が UNIQUE 違反で throw した場合は再 SELECT で吸収（concurrent insert race 対応, M5）
    → 直後に upsertUsageSnapshot を呼んで初回 snapshot を入れる（throttle はせず必ず書く）
5b. token != null:
    → throttle 判定（getLatestUsageSnapshot vs 今回値）
    → 変化があれば upsertUsageSnapshot
```

- `organization_id` 検索を主キーにする理由: A019 §確定事項「アカウント識別（account 単位） = `anthropic-organization-id` UUID」。token rotation で `auth_hash` は変わるが `organization_id` は同一なので account 単位の継続性が保てる
- auth_hash 検索 (`getTokenByAuthHash` 相当) は token-store.ts に未実装なので、本タスクでは organization_id を主キーに使う（token-store.ts に新規 API を追加しなくて済む）
- 既存 token に対して `auth_hash` が変わっていた場合の追従（rotation 検出）は本タスク外（A020 §未解決の疑問）。手動で `cmux-team token rotate` する想定

### 1.5 既存 api_usage INSERT との独立並列実行（**修正: C2**）

**結論**: 新ロジック `recordTokenUsage()` は **既存の `api_usage` 経路（`opts.db`）と完全に独立した分岐**として呼ぶ。`opts?.db` の有無に**依存させない**。両者は独立した try/catch で囲み、片方の失敗が他方に波及しないようにする。

#### 非 streaming 経路の配置

`if (opts?.db && url.pathname === "/v1/messages")` ブロックの**外側**に、独立した分岐として書く:

```ts
// proxy.ts 非 streaming 経路（line 538-613 周辺）
if (opts?.db && url.pathname === "/v1/messages") {
  // 既存の api_usage 経路（opts.db に依存）
  safeInsertApiUsage(opts.db, { /* 既存 */ });
}

// ↑ とは独立。tokens.db は ~/.cmux-team グローバル DB なので opts.db 無関係
if (url.pathname === "/v1/messages") {
  recordTokenUsage(tokenDb, upstreamRes.headers, req.headers);
}
```

#### streaming 経路の配置

`drainAndRecord` の `ctx` には、`apiUsage` とは**並列の独立フィールド**として `tokenDb` / `requestHeaders` / `responseHeaders` を持たせる。`if (ctx.apiUsage)` の外で `if (ctx.tokenDb && isMessagesEndpoint)` を判定:

```ts
type DrainCtx = {
  apiUsage?: {  // 既存（opts.db 依存）
    db: Database;
    /* ... */
  };
  // 以下は apiUsage と独立した optional フィールド
  tokenDb?: Database | null;
  requestHeaders?: Headers;
  responseHeaders?: Headers;
  isMessagesEndpoint?: boolean;
};

// drainAndRecord finally 内（line 818-845 周辺）
if (ctx.apiUsage) {
  safeInsertApiUsage(ctx.apiUsage.db, { /* 既存 */ });
}

// ↑ とは独立
if (ctx.tokenDb && ctx.isMessagesEndpoint) {
  recordTokenUsage(ctx.tokenDb, ctx.responseHeaders!, ctx.requestHeaders!);
}
```

- `recordTokenUsage` 内部は **必ず try/catch で全体を囲む**（DB 書込失敗・JSON parse 失敗・unexpected null すべて吸収）
- 失敗時は `console.warn(...)` のみ（logger 注入を避ける理由は §2.2 設計補足）
- 既存 `safeInsertApiUsage` パターンと意図的に揃える（fail-open）
- これにより **standalone proxy（`opts.db` unset）モードでも tokens.db は更新される**。設計層が違う 2 つの DB（project-local traces.db / global tokens.db）の独立性を保つ

### 1.6 既存テストへの影響

**結論**: proxy.test.ts の既存 14 ケース（特に `api_usage (T305)` describe 配下）が**そのまま通る**ことを保証するため、**`TOKEN_STORE_DB_PATH` を proxy.test.ts の `beforeEach` で testDir 配下に向ける**ようにする。

- 影響を受けるのは `api_usage (T305)` describe（line 596-1108）。ここでは upstream mock が `anthropic-organization-id` ヘッダーを返さない / `Authorization` ヘッダーを送らないケースが大半 → 本機能は no-op になるので既存 assertion は通る
- それでも `tokens.db` がデフォルトの `~/.cmux-team/tokens.db` を**汚染するのを防ぐ**ため、proxy.test.ts の各 describe で `process.env.TOKEN_STORE_DB_PATH = join(testDir, "tokens.db")` を beforeEach で設定し、afterEach で revert する
  - これは `token-store.test.ts` の既存パターン（line 60-65）と完全に同じ
- 新規追加するテストケース群（§3）は **同じ describe 配下で initTokenDB を呼んで token を pre-INSERT** するスタイルで書く

### 1.7 streaming / 非streaming 両方で同じ throttle/auto-discover が走るか

**結論**: 共通 helper `recordTokenUsage(tokenDb, responseHeaders, requestHeaders)` を作り、以下 2 箇所から呼ぶ:

- 非 streaming: `proxy.ts` の `/v1/messages` 完全一致分岐内（§1.5 で示した独立分岐）
- streaming: `drainAndRecord` の finally 内、`ctx.tokenDb && ctx.isMessagesEndpoint` 判定（§1.5 で示した独立分岐）

streaming 経路では `drainAndRecord` の `ctx` に `tokenDb` と `requestHeaders`（hash 計算用）と `responseHeaders` を新規で乗せる必要がある。

**Headers の lifecycle（M2 修正）**:
- `responseHeaders: new Headers(upstreamRes.headers)` のように **独立 copy** を ctx に乗せる（参照競合・後段 release のリスクを排除）
- streaming 経路の既存 `resHeaders = new Headers(upstreamRes.headers)`（proxy.ts:442 周辺）を流用してもよい
- `requestHeaders` は `req.headers` の参照のまま渡してよい（`req` は handler 内で生存しており、ctx 経由で drain 完了まで保持される）

**注意**: 完全一致 `/v1/messages` 以外（`/v1/messages/count_tokens` 等）では呼ばない。既存の `isMessagesEndpoint` 判定をそのまま流用する。

---

## 2. アーキテクチャ概観

### 2.1 ファイル構成

| ファイル | 変更種別 | 用途 |
|---------|---------|------|
| `skills/cmux-team/manager/proxy.ts` | 編集 | `recordTokenUsage` 呼び出し追加・`tokenDb` クロージャ化・`extractAuthHash` 追加 |
| `skills/cmux-team/manager/proxy-token-pool.ts` | **新規** | 純粋ロジックを切り出し（`extractAuthHash` / `pickAutoDiscoverHandle` / `shouldUpsertSnapshot` / `recordTokenUsage`） |
| `skills/cmux-team/manager/proxy.test.ts` | 編集 | `TOKEN_STORE_DB_PATH` setup + 新規 describe `tokens_db (T320)` 追加 |
| `skills/cmux-team/manager/proxy-token-pool.test.ts` | **新規（推奨）** | `shouldUpsertSnapshot` / `pickAutoDiscoverHandle` の純粋関数を Bun.serve なしでユニットテスト |

> 推奨理由: 純粋関数を proxy.ts 本体に置くと `Bun.serve` を起動しないと触れず、testing が重い。helper を別ファイルに切り出し、テストは「軽いユニット」+「proxy 経由の統合」の二層にする。

### 2.2 `recordTokenUsage` の擬似コード（**修正: M5 concurrent insert 吸収**）

```ts
// proxy-token-pool.ts
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  getTokenByOrganizationId,
  getTokenByHandle,
  insertToken,
  upsertUsageSnapshot,
  getLatestUsageSnapshot,
  type Token,
  type UsageSnapshot,
} from "./token-store";

// `<` 比較なので 0.01 ちょうどは upsert 側に倒れる（タスク本文「以上」と整合）
export const UTIL_DELTA_THRESHOLD = 0.01;

export function extractAuthHash(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;  // case-sensitive
  return createHash("sha256").update(auth).digest("hex").slice(0, 12);
}

export function pickAutoDiscoverHandle(
  db: Database,
  organization_id: string,
): string | null {
  const sanitized = organization_id.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  for (const len of [4, 5, 6]) {
    const cand = sanitized.slice(0, len);
    if (cand.length < len) break;  // 元 ID が短すぎ
    if (!getTokenByHandle(db, cand)) return cand;
  }
  return null;
}

export interface SnapshotInput {
  util_5h: number | null;
  util_7d: number | null;
  reset_5h_at: string | null;
  reset_7d_at: string | null;
  unified_status: string | null;
}

export function shouldUpsertSnapshot(
  prev: UsageSnapshot | null,
  next: SnapshotInput,
): boolean {
  if (!prev) return true;  // 初回は必ず書く
  if (!sameUtil(prev.util_5h, next.util_5h)) return true;
  if (!sameUtil(prev.util_7d, next.util_7d)) return true;
  if (prev.reset_5h_at !== next.reset_5h_at) return true;
  if (prev.reset_7d_at !== next.reset_7d_at) return true;
  if (prev.unified_status !== next.unified_status) return true;
  return false;
}

// `<` 比較。0.01 ちょうどは sameUtil = false（差分あり扱い）→ upsert 側に倒れる
function sameUtil(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < UTIL_DELTA_THRESHOLD;
}

export function recordTokenUsage(
  tokenDb: Database | null,
  responseHeaders: Headers,
  requestHeaders: Headers,
): void {
  if (!tokenDb) return;
  try {
    const authHash = extractAuthHash(requestHeaders);
    if (!authHash) return;  // Authorization 欠落 / Bearer 以外 → skip

    const orgId = responseHeaders.get("anthropic-organization-id");
    const util5hRaw = responseHeaders.get("anthropic-ratelimit-unified-5h-utilization");
    const util7dRaw = responseHeaders.get("anthropic-ratelimit-unified-7d-utilization");
    const util5h = util5hRaw != null ? parseFloat(util5hRaw) : null;
    const util7d = util7dRaw != null ? parseFloat(util7dRaw) : null;
    const reset5h = responseHeaders.get("anthropic-ratelimit-unified-5h-reset");
    const reset7d = responseHeaders.get("anthropic-ratelimit-unified-7d-reset");
    const unifiedStatus = responseHeaders.get("anthropic-ratelimit-unified-status");

    const next: SnapshotInput = {
      util_5h: util5h != null && !isNaN(util5h) ? util5h : null,
      util_7d: util7d != null && !isNaN(util7d) ? util7d : null,
      reset_5h_at: reset5h ?? null,
      reset_7d_at: reset7d ?? null,
      unified_status: unifiedStatus ?? null,  // 未返却時は null（A020 §「返らなかったヘッダー」想定）
    };

    if (!orgId) {
      // organization_id がなければ token 同定不能 → skip
      // auth_hash 単独同定は本タスク範囲外
      return;
    }

    let token: Token | null = getTokenByOrganizationId(tokenDb, orgId);

    if (!token) {
      // auto-discover
      const handle = pickAutoDiscoverHandle(tokenDb, orgId);
      if (!handle) {
        // 4-6 文字すべて衝突 or sanitized 4 文字未満 → skip
        return;
      }
      try {
        token = insertToken(tokenDb, {
          handle,
          organization_id: orgId,
          auth_hash: authHash,
          plan: "unknown",
          plan_ratio: null,
          tags: ["auto"],
          credential_source: "auto-discover",
          selectable: false,
        });
      } catch (e: unknown) {
        // M5: UNIQUE 違反 (concurrent insert race) を吸収して再 SELECT
        // 当該リクエストでも snapshot を確実に入れるため
        token = getTokenByOrganizationId(tokenDb, orgId);
        if (!token) throw e;  // 別種のエラーは上位 catch へ
      }
      // 初回 snapshot は throttle せず必ず書く（race で先行 INSERT があった場合も
      // upsertUsageSnapshot は ON CONFLICT で更新するので冪等）
      upsertUsageSnapshot(tokenDb, { token_id: token.id, ...next });
      return;
    }

    // throttle 判定
    const prev = getLatestUsageSnapshot(tokenDb, token.id);
    if (shouldUpsertSnapshot(prev, next)) {
      upsertUsageSnapshot(tokenDb, { token_id: token.id, ...next });
    }
  } catch (e: any) {
    // クリティカルパスを汚さない fail-open
    // log は呼び出し側で取れない（proxy.ts logger を import すると循環依存を作りやすい）
    // → console.warn で十分（manager.log には流れないが proxy 標準出力には残る）
    console.warn(`[token-store] recordTokenUsage failed: ${e?.message ?? "unknown"}`);
  }
}
```

> **設計補足**: `proxy.ts` 側の `log` を `proxy-token-pool.ts` から import すると、testing で logger の副作用（`.team/logs/` への書込）が発生して isolation が崩れる。`console.warn` を選ぶことで純粋ロジックモジュールに保つ。manager.log への記録が必要になったら、呼び出し側 (`proxy.ts`) で wrap する形に変更可能（後続改善）。

---

## 3. テスト計画（最小 5 / 最大 10 ケース）

### 3.1 共通 setup（proxy.test.ts に追加）

```ts
// 既存の `describe("api_usage (T305)", ...)` の下に新 describe を追加
describe("tokens_db (T320)", () => {
  let origTokenDbPath: string | undefined;
  let tokenDb: Database;
  let tokenDbPath: string;
  let upstream: ReturnType<typeof Bun.serve>;
  let origAnthropicEnv: string | undefined;

  beforeEach(() => {
    origTokenDbPath = process.env.TOKEN_STORE_DB_PATH;
    tokenDbPath = join(testDir, "tokens.db");
    process.env.TOKEN_STORE_DB_PATH = tokenDbPath;
    // proxy.ts 側で initTokenDB() するので、テスト側の tokenDb は読み取り専用検証用
  });

  afterEach(() => {
    try { tokenDb?.close(); } catch {}
    try { upstream?.stop(); } catch {}
    if (origTokenDbPath !== undefined) {
      process.env.TOKEN_STORE_DB_PATH = origTokenDbPath;
    } else {
      delete process.env.TOKEN_STORE_DB_PATH;
    }
    if (origAnthropicEnv !== undefined) {
      process.env.ANTHROPIC_API_URL = origAnthropicEnv;
    } else {
      delete process.env.ANTHROPIC_API_URL;
    }
  });
  // ... テストケース
});
```

### 3.2 ケース一覧（**修正: M1 / M3 / N3 / N5 反映、計 7 ケース**）

| # | ケース名 | 検証内容 | 主な assert |
|---|---------|---------|------------|
| 1 | **auto-discover: 未登録 token + organization_id ヘッダー有り** | upstream が `anthropic-organization-id` を返し、リクエストに `Authorization: Bearer xxx` を付ける。proxy 経由後に `tokens` テーブルに `selectable=0` / `tags=["auto"]` / `plan="unknown"` で 1 行 INSERT され、`usage_snapshots` に 1 行入る。N5: `unified-status` を返さないケースで snapshot.unified_status === null を併せて確認 | `listTokens(tokenDb).length === 1` / `tokens[0].selectable === false` / `tokens[0].tags.includes("auto")` / `tokens[0].plan === "unknown"` / `tokens[0].credential_source === "auto-discover"` / `getLatestUsageSnapshot(tokenDb, tokens[0].id) !== null` / `snapshot.unified_status === null`（N5） |
| 2 | **auto-discover: organization_id ヘッダー無し → skip** | upstream が `organization_id` を返さないが util ヘッダーは返す。tokens.db には何も書かれない | `listTokens(tokenDb).length === 0` |
| 3 | **登録済み token + util_5h 0.30 → 0.305 (+0.005pt) → UPSERT されない** (M1/N3) | `insertToken()` で pre-INSERT。最初に upstream を 0.30 で 1 回呼んで snapshot を書き、次に 0.305 で呼ぶ。**snapshot.util_5h が 0.30 のまま**であることを直接確認（recorded_at 比較は CI ms 同値で flaky になるため副に降格） | **主**: `snapshot.util_5h === 0.30`（0.305 に書き換わっていない）<br>**副**: `recorded_at` が 1 回目と同値（参考） |
| 4 | **登録済み token + util_5h 0.30 → 0.32 (+0.02pt) → UPSERT される** (M1/N3) | 同様に 0.30 → 0.32 で 2 回呼ぶ。snapshot.util_5h が 0.32 に更新される | **主**: `snapshot.util_5h === 0.32`<br>**副**: `recorded_at` が 1 回目より進む（参考） |
| 5 | **登録済み token + reset 時刻が変化 → UPSERT される** (N3) | util は同じ 0.30 のまま `reset_5h` を変える。snapshot.reset_5h_at が新値に更新される | **主**: `snapshot.reset_5h_at === <新値>`<br>**副**: `recorded_at` 進行（参考） |
| 6 | **streaming SSE 経路 + 登録済み token で throttle が動く** | T305 の SSE fixture を流用しつつ、レスポンスヘッダーに `organization_id` と util を付ける。drainAndRecord 完了後に snapshot が更新される | streaming 完了後に `snapshot.util_5h === <2 回目の値>` |
| 7 | **streaming SSE 経路 + 未登録 token → auto-discover が発火する** (M3 新規) | pre-INSERT なし。SSE finally 内で recordTokenUsage が呼ばれ、tokens テーブルに 1 件 / usage_snapshots に 1 件入る。ctx 経由の orgId/auth_hash 伝搬が壊れていないことを確認 | `listTokens(tokenDb).length === 1` / `snapshot !== null` / `tokens[0].credential_source === "auto-discover"` |
| 8 | **Authorization ヘッダー無し → 完全 skip** | 既存テスト互換：T305 の non-streaming テストはそのまま通る | tokens テーブル空、snapshot 空 |

> **N3 補足**: case 3/4/5 全般で「`recorded_at` 同値・進行」依存を主軸から外し、`util_5h` / `reset_5h_at` の値での確認を主軸とする。CI 上で ms 単位の同値による flaky を避けるため。
> **N5 補足**: case 1 で `unified-status` 未返却を兼ねて検証することで、ケース数を増やさずに parser robustness を担保する。

### 3.3 純粋ロジック側ユニットテスト（proxy-token-pool.test.ts、**修正: C1 / M4 / N2 反映、3 ケース**）

| # | ケース名 | 検証内容 |
|---|---------|---------|
| P1 | `extractAuthHash` Bearer 以外は null (N2 拡張) | (a) `x-api-key` ヘッダーのみ → null<br>(b) Authorization 欠落 → null<br>(c) `Basic xxx` → null<br>(d) **`bearer xxx` (小文字 b) → null**（case-sensitive 判定の確認、将来の互換検出用）<br>(e) `Bearer sk-ant-...` → 12 文字 hex |
| P2 | `pickAutoDiscoverHandle` 衝突パス完全 (M4 拡張) | (a) 衝突なし → 4 文字を返す<br>(b) 4 文字衝突 → 5 文字を返す<br>(c) **4 文字 + 5 文字両衝突 → 6 文字を返す**<br>(d) **4・5・6 全衝突 → null**<br>※ 各ケースで先行 `insertToken` で衝突をセットアップ |
| P3 | `shouldUpsertSnapshot` 境界値 (C1 修正) | (a) prev=null → true（初回）<br>(b) prev=0.30 / next=0.305（diff 0.005, 安定値）→ false<br>(c) prev=0.30 / next=0.32（diff 0.02, 安定値）→ true<br>(d) reset 時刻のみ変化 → true<br>(e) unified_status のみ変化 → true<br>※ FP 不安定値（0.31 など）は使わない。コメントに「`<` 比較なので 0.01 ちょうどは upsert 側」を明記 |

**合計: 8 + 3 = 11 ケース** … と書いたが、case 7 (M3) は case 6 と並列なので片方を吸収する場合は 7 + 3 = 10 でも可。**最大 10 ケース上限を厳守する**ため、case 7 を新規追加 + case 1 に N5 統合 + P1/P2/P3 を上記の通り内部分岐で複合化する形で **proxy.test.ts 8 ケース + proxy-token-pool.test.ts 3 ケース = 11 ケース** に収めるか、P1 を内部分岐 only でカウント 1 として **合計 11 → 10** に圧縮する（Implementer 判断で statement 単位は内部 it.each / describe 単位で増えてもよい）。

> **運用方針**: 「ケース」は describe + it の `it` 単位で数える。10 ケース上限は proxy.test.ts (8) + proxy-token-pool.test.ts (3) = 11 になるが、case 7 を case 1 の SSE 派生として `it.each` の 1 it として吸収すれば 7 + 3 = 10 ケース内に収まる。最終決定は Implementer が pass/fail balance を見て選ぶ。Critical/Major の検証観点が**漏れない**ことを優先する。

### 3.4 検証コマンド

```bash
# worktree root から
cd /Users/yamamoto/git/cmux-team/.worktrees/task-320-1777097743

# 1. proxy 側ユニット + 統合テスト
cd skills/cmux-team/manager && bun test proxy.test.ts

# 2. 純粋ロジック側ユニットテスト（新規追加）
cd skills/cmux-team/manager && bun test proxy-token-pool.test.ts

# 3. token-store の既存テストが壊れていないこと
cd skills/cmux-team/manager && bun test token-store.test.ts

# 4. 型チェック（worktree root）
cd /Users/yamamoto/git/cmux-team/.worktrees/task-320-1777097743 && bunx tsc --noEmit

# 5. 全 manager テスト（regression 確認）
cd /Users/yamamoto/git/cmux-team/.worktrees/task-320-1777097743/skills/cmux-team/manager && bun test
```

---

## 4. 実装手順（ファイル単位）

### Step 1. `skills/cmux-team/manager/proxy-token-pool.ts` を新規作成

**新規ファイル**。§2.2 の擬似コードをそのまま実装する。

- import: `node:crypto` の `createHash`、`bun:sqlite` の `Database`、`./token-store` の関数群と型
- export: `extractAuthHash` / `pickAutoDiscoverHandle` / `shouldUpsertSnapshot` / `recordTokenUsage` / 定数 `UTIL_DELTA_THRESHOLD`
- `recordTokenUsage` の auto-discover ルート内に **M5 修正**（concurrent insert UNIQUE 違反吸収 → getTokenByOrganizationId 再 SELECT）を含める

### Step 2. `skills/cmux-team/manager/proxy-token-pool.test.ts` を新規作成（推奨）

§3.3 の P1/P2/P3 ケースを実装。

- `mkdtempSync` + `initTokenDB` で in-memory DB を作る
- `KEYCHAIN_TEST_MODE=1` は不要（Keychain アクセスはしない）
- 各ケース後に `db.close()` + `rmSync`
- P3 の境界値テストでは FP 不安定値（0.31 など）を避け、`0.305` / `0.32` のような安定値で書く

### Step 3. `skills/cmux-team/manager/proxy.ts` を編集

#### 3a. import 追加（line 8-17 あたり）
```ts
import { initTokenDB } from "./token-store";
import { recordTokenUsage } from "./proxy-token-pool";
```

#### 3b. `start()` 内、line 178 あたり（`upstream` 解決の直後）に `tokenDb` を初期化
```ts
let tokenDb: Database | null = null;
try {
  tokenDb = initTokenDB();
} catch (e: any) {
  log("token_store_init_failed", e.message).catch(() => {});
}
```

#### 3c. 非 streaming 経路: `safeInsertApiUsage()` 呼出しブロック (`if (opts?.db && /v1/messages)`) の**外側**に独立分岐として追加（**C2 修正**）

```ts
// proxy.ts 非 streaming 経路（line 538-613 周辺）
if (opts?.db && url.pathname === "/v1/messages") {
  // 既存の api_usage 経路（変更なし）
  safeInsertApiUsage(opts.db, { /* 既存 */ });
}

// ↑ とは独立した tokens.db 経路（opts.db 有無に依存しない）
if (url.pathname === "/v1/messages") {
  recordTokenUsage(tokenDb, upstreamRes.headers, req.headers);
}
```

> **重要**: `opts?.db` が unset でも `recordTokenUsage` は呼ばれる。tokens.db は `~/.cmux-team/` グローバル DB であり、project-local traces.db (`opts.db`) とは設計層が異なる。

#### 3d. streaming 経路: `drainAndRecord` の `ctx` 型に **`apiUsage` と並列の独立フィールド**として追加（**C2 + M2 修正**）

```ts
type DrainCtx = {
  apiUsage?: {  // 既存（opts.db 依存）
    db: Database;
    /* ... */
  };
  // 以下は apiUsage と並列・独立
  tokenDb?: Database | null;
  requestHeaders?: Headers;        // hash 計算用（参照保持で OK）
  responseHeaders?: Headers;        // util / org_id 取得用（独立 copy）
  isMessagesEndpoint?: boolean;
};
```

呼出し側 (line 485-498) で以下を ctx に乗せる:

- `tokenDb`: closure の `tokenDb`（`null` 可）
- `requestHeaders`: `req.headers`（参照のままで OK、handler 生存中に drain 完了する）
- `responseHeaders`: `new Headers(upstreamRes.headers)` で **独立 copy**（**M2 修正**）。proxy.ts:442 周辺の既存 `resHeaders` を流用してもよい
- `isMessagesEndpoint`: 既存判定の結果を boolean で渡す

#### 3e. `drainAndRecord` finally 内、`safeInsertApiUsage` ブロック (`if (ctx.apiUsage)`) の**外側**に独立分岐として追加（**C2 修正**）

```ts
// drainAndRecord finally 内（line 818-845 周辺）
if (ctx.apiUsage) {
  safeInsertApiUsage(ctx.apiUsage.db, { /* 既存 */ });
}

// ↑ とは独立した tokens.db 経路
if (ctx.tokenDb && ctx.isMessagesEndpoint) {
  recordTokenUsage(ctx.tokenDb, ctx.responseHeaders!, ctx.requestHeaders!);
}
```

> **重要**: `ctx.apiUsage` の有無に関わらず、`ctx.tokenDb` が非 null かつ `/v1/messages` 完全一致なら recordTokenUsage を呼ぶ。

#### 3f. `stop()` 関数内で `tokenDb` を close
```ts
return {
  port: server.port!,
  stop: () => {
    server.stop();
    try { tokenDb?.close(); } catch {}
  },
};
```

### Step 4. `skills/cmux-team/manager/proxy.test.ts` を編集

- 既存 `describe("api_usage (T305)", ...)` の `beforeEach` に `process.env.TOKEN_STORE_DB_PATH = join(testDir, "tokens.db")` を追加し、`afterEach` で revert
  - これにより既存 12 ケースが `~/.cmux-team/tokens.db` を汚さなくなる
- 新規 `describe("tokens_db (T320)", ...)` を追加し §3.2 の 7-8 ケースを実装（M3 で SSE auto-discover ケースを追加）
- 上位レベルの `beforeEach`（line 13-19）にも `process.env.TOKEN_STORE_DB_PATH = ...` を入れる方が安全（statusline / master-state の各テストで proxy.ts が初期化される際にもデフォルト ~ パスを汚染しないため）
- case 3/4/5 では検証主軸を **`util_5h` / `reset_5h_at` の値**に置き、`recorded_at` 比較は副に降格（M1/N3）
- case 1 で `unified-status` 未返却 → `snapshot.unified_status === null` を兼ねて検証（N5）

### Step 5. 検証

§3.4 の検証コマンドを順に実行し、すべて緑であることを確認する。

---

## 5. リスクと緩和策（**修正: M2 / M5 反映**）

| リスク | 緩和策 |
|--------|--------|
| `~/.cmux-team/tokens.db` を CI / 既存ユーザー DB を汚す | proxy.test.ts の最上位 beforeEach で `TOKEN_STORE_DB_PATH` を testDir 配下に向ける |
| streaming で response/request headers の参照が ctx 通過後に release される | **`responseHeaders: new Headers(upstreamRes.headers)` で明示的に独立 copy する**（M2 修正）。streaming 経路の既存 `resHeaders` 変数（proxy.ts:442 付近）を流用してもよい。`requestHeaders` は handler 生存中の参照保持で十分（drain は同 handler 内で完了する） |
| `initTokenDB()` が throw（権限・FS フル） | 既に try/catch で吸収して `tokenDb=null`。本機能は no-op 化、proxy 自体は起動継続 |
| organization_id の正規化（UUID 内 `-` 除去）で 4 文字未満になる | `pickAutoDiscoverHandle` で `cand.length < len` チェック → null 返却 → auto-discover skip（log warn）。proxy-token-pool.test.ts P2 で「全衝突 → null」経路をテスト（M4） |
| concurrent proxy 起動で同 organization_id を 2 重 INSERT | tokens テーブルの `organization_id UNIQUE` 制約で 2 回目が throw → **同一リクエスト内で `getTokenByOrganizationId` で再 SELECT** して snapshot を確実に書く（M5 修正）。これにより race 時の snapshot 取りこぼしを防ぐ |
| `auth_hash` がローテで変わった既存 token への対応 | 本タスクでは追従しない（既存 token の `auth_hash` カラムは更新しない）。手動 `cmux-team token rotate` で対応する想定 — Non-goal に明記 |
| 既存 T305 系テストの `Authorization` 無しが本機能起動を妨げない | `extractAuthHash` で null → 即 return。tokens テーブル空のまま既存 assertion 通過 |
| `opts.db` unset (standalone proxy) で tokens.db 更新が走らない設計バグ | **C2 修正で解消**: `recordTokenUsage` 呼び出しを `if (opts?.db)` ブロック外に出した。tokens.db は `opts.db` の有無に独立して更新される |
| P3 境界値テストで FP 比較に依存して flaky | **C1 修正で解消**: 安定値 (0.305 / 0.32) のみ使用、0.31 のような FP 不安定値を避ける |

---

## 6. 完了基準

- [ ] `proxy-token-pool.ts` 新規作成、`extractAuthHash` / `pickAutoDiscoverHandle` / `shouldUpsertSnapshot` / `recordTokenUsage` を export
  - [ ] `recordTokenUsage` の auto-discover ルートで insertToken UNIQUE 違反を吸収する concurrent insert race 対応 (M5)
- [ ] `proxy-token-pool.test.ts` で 3 ケース（P1/P2/P3）すべて pass
  - [ ] P1 に `bearer xxx`（小文字）→ null 確認を含む (N2)
  - [ ] P2 に「4・5・6 全衝突 → null」分岐を含む (M4)
  - [ ] P3 は安定値 (0.305 / 0.32) で書き、FP 不安定値 (0.31) を使わない (C1)
- [ ] `proxy.ts` で `tokenDb` クロージャ + `recordTokenUsage` 2 箇所呼び出し追加
  - [ ] 非 streaming は `if (opts?.db)` の外側で独立分岐 (C2)
  - [ ] streaming は ctx に `tokenDb` / `requestHeaders` / `responseHeaders` を `apiUsage` と並列の独立フィールドで持たせ、`if (ctx.apiUsage)` の外側で呼ぶ (C2)
  - [ ] `responseHeaders` は `new Headers(upstreamRes.headers)` で独立 copy (M2)
- [ ] `proxy.test.ts` で `TOKEN_STORE_DB_PATH` setup + 新 describe `tokens_db (T320)` 7-8 ケース pass
  - [ ] case 3/4/5 は `util_5h` / `reset_5h_at` 値検証を主軸（M1/N3）
  - [ ] case 7 で「streaming + auto-discover」シナリオを確認 (M3)
  - [ ] case 1 に `unified_status` 未返却 → null 検証を含む (N5)
- [ ] 既存 proxy.test.ts 全ケースが緑
- [ ] 既存 token-store.test.ts 全ケースが緑
- [ ] `bunx tsc --noEmit` が緑

---

## 7. 参照

- A019 設計書: `.team/artifacts/A019-token-pool-design.md`
- A020 probe 結果: `.team/artifacts/A020-token-pool-probe.md`（worktree 内）
- token-store.ts: `skills/cmux-team/manager/token-store.ts`（API 既出）
- token-store.test.ts: `skills/cmux-team/manager/token-store.test.ts`（test pattern 参考）
- proxy.ts 現実装: 行 70-103 (extractRateLimit) / 110-149 (extractRateLimitForApiUsage) / 155-164 (safeInsertApiUsage) / 425-498 (上流 fetch + streaming dispatch) / 538-613 (非 streaming api_usage 書込) / 658-846 (drainAndRecord)
- proxy.test.ts test 構造: 599-606 (initDB(testDir) パターン) / 638-683 (非 streaming T305 fixture) / 685-800 (SSE T305 fixture)
- design-review.md: 同 runs/ ディレクトリ内（本改訂のソース）
