# T341 実装計画 — auto-discover gate + `token promote`

## ゴール（再掲）

1. **auto-discover gate**: `proxy.ts` の `updateTokensDB` が pool 設定を尊重し、pool OFF では未知 token を `tokens.db` に INSERT しない（usage_snapshots 更新は維持）。
2. **`cmux-team token promote @auto-handle <new-display-name>`**: auto-discover 登録済み token を正規 handle に昇格させる。

---

## 1. 影響ファイル一覧

### 変更（既存ファイル）

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/proxy.ts` | `updateTokensDB` に `tokenPoolEnabled: boolean` を渡し、line 144-158 の auto-discover INSERT 分岐を gate。`start()` 起動時に `isTokenPoolEnabled(projectRoot)` を 1 度評価してクロージャにキャッシュ。 |
| `skills/cmux-team/manager/token-cli.ts` | `cmdTokenPromote()` を新規追加。`readClaudeCredentials` / `probeOrganizationId` / `computeAuthHash` / `PLAN_MAP` を再利用。 |
| `skills/cmux-team/manager/main.ts` | `case "token"` の switch に `case "promote": await cmdTokenPromote(); break;` を追加（5435 行付近）。`token-cli` からの import に `cmdTokenPromote` を追加（114-118 行付近）。`Usage:` 文言更新（5442 行）。 |
| `skills/cmux-team/manager/token-store.ts` | （任意・推奨）`updateTokenPromoteFields` を新規追加。1 トランザクションで `handle / auth_hash / plan / plan_ratio / tags / credential_source / selectable` を atomic に更新する（既存 `updateTokenAuth` / `updateTokenPlan` の追加では列が足りない）。 |
| `docs/spec/09-token-pool.md` | auto-discover 節（247-254 行）に「pool 機能 OFF では走らない」を明記。`token promote` の CLI リファレンスを追加。 |

### 変更（既存テスト）

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/proxy.test.ts` | 新規 `describe("proxy: auto-discover gate (T341)", ...)` を追加。pool OFF / pool ON / 既知 token + pool OFF（usage 更新は維持される）の 3 ケース。 |
| `skills/cmux-team/manager/token-cli.test.ts` | 新規 `describe("cmdTokenPromote (integration)", ...)` を追加。R-promote-1〜R-promote-7 のケース。 |

### 追加（新規ファイル）

なし。

---

## 2. 関連既存コード（行番号は確認済み）

### gate 用

| 関数 / 定数 | 場所 | 用途 |
|-------------|------|------|
| `updateTokensDB` | `proxy.ts:91-162` | auto-discover & usage UPSERT のエントリポイント。signature を変更する |
| auto-discover INSERT 分岐 | `proxy.ts:144-158` | pool 判定で skip する対象 |
| `usage_snapshots` UPSERT | `proxy.ts:107-143` | pool OFF でも維持する（gate 対象外） |
| `start()` | `proxy.ts:346-852` | `projectRoot` を受け取る関数。先頭で `isTokenPoolEnabled` を 1 度実行してフラグをクロージャ束縛する |
| `streaming path` 呼び出し | `proxy.ts:653-660` | 引数追加対象（1） |
| `非 streaming path` 呼び出し | `proxy.ts:721-729` | 引数追加対象（2） |
| `isTokenPoolEnabled` | `config.ts:445-453` | 3 階層（env → project → global → default=false）解決 |
| `__resetTokensDbForTest` | `proxy.ts:47-54` | テストで singleton をリセット（既存） |

### promote 用

| 関数 / 定数 | 場所 | 用途 |
|-------------|------|------|
| `cmdTokenAdd` | `token-cli.ts:94-208` | 同形 UI（source 選択 / probe / handle 採番 / tags / Keychain 保存）の参考実装 |
| `cmdTokenRotate` | `token-cli.ts:328-375` | credential 再取得経路の実装パターン |
| `readClaudeCredentials` | `token-cli.ts:51-64` | `~/.claude/.credentials.json` 読み込み |
| `probeOrganizationId` | `token-cli.ts:71-86` | `/v1/models` で `anthropic-organization-id` 取得 |
| `computeAuthHash` | `token-cli.ts:34-36` | `sha256("Bearer "+token)` の 12 文字 prefix |
| `PLAN_MAP` | `token-cli.ts:38-42` | `rateLimitTier` → `{plan, ratio}` |
| `getTokenByHandle` / `getTokenByOrganizationId` | `token-store.ts:308-323` | DB 検索 |
| `storeTokenInKeychain` | `token-store.ts:544-576` | Keychain 保存（in-memory モード対応） |
| `getHandleArg` | `token-cli.ts:419-427` | `process.argv[4]` から `@handle` 抽出 |
| サブコマンド登録ポイント | `main.ts:5432-5446` | `case "token"` switch |

### auto-discover によって生成される `credential_source` / `tags` / `selectable`

`proxy.ts:144-158` の現在の値：

- `credential_source: "auto-discover"`
- `tags: ["auto"]`
- `selectable: false`
- `plan: "unknown"` / `plan_ratio: null`

→ promote 後はそれぞれ `manual` or `claude-credentials` / 入力 tags / `selectable=1` / probe で得た plan に置き換える。

---

## 3. 設計判断

### (A) auto-discover gate のキャッシュ方法

**採用**: **proxy 起動時 1 回キャッシュ（リクエスト毎評価しない）**。

理由：
- pool 設定の変更は daemon 再起動を伴う（`.team/config.json` / `~/.cmux-team/config.yaml` / env）。proxy が動いている間は不変と仮定して問題ない。
- `loadConfig` / `loadGlobalConfig` は I/O を伴うため、リクエスト毎に呼ぶと proxy のレイテンシに影響する。
- `start()` は async なので `await isTokenPoolEnabled(projectRoot)` を先頭で実行し、`tokenPoolEnabled` をクロージャ束縛するだけで済む。
- 起動失敗時（`CMUX_TEAM_TOKEN_POOL` の値不正で throw）は Manager 側の `cmdStart`（`main.ts:670-681`）と同じ fail-fast に揃える。proxy の `start()` 内で再 throw すれば呼び出し元（`main.ts:705`）の `try/catch` が `proxy_start_failed` ログを出して継続する。

### (B) `updateTokensDB` の signature 変更

```ts
// 現在
function updateTokensDB(authHash, rl, organizationId, surface, role, getState?)

// 変更後
function updateTokensDB(authHash, rl, organizationId, surface, role, tokenPoolEnabled: boolean, getState?)
```

→ 7 引数で読みづらいので **options object に再構成** する案も検討したが、呼び出し点が 2 箇所だけなので最小差分で済むよう positional のまま追加する。可読性重視なら options object にする（実装時に判断）。

gate 適用箇所：

```ts
} else if (organizationId) {
  if (!tokenPoolEnabled) {
    return; // T341: pool OFF では auto-discover skip
  }
  // 既存 INSERT ロジック（lines 144-158）
}
```

`else if` 入口で gate するので、既知 token の usage_snapshots UPSERT（line 107-143）は影響しない。

### (C) promote の `auth_hash` 検証ロジック

仕様要件: 「取得した token の auth_hash と DB 既存の `organization_id` が一致することを検証（不一致なら error）」

→ 厳密には「probe で取れた organization_id が DB の既存レコードと一致するか」を見る。auth_hash は新規 token のものに更新するので「一致するはず」だが完全一致は要求しない（auth_hash は token 文字列依存で、auto-discover 時の値と promote 時の値は必ずしも同じとは限らないため）。

**実装フロー（cmdTokenPromote）**:

1. `process.argv[4]`（旧 handle）と `process.argv[5]`（new display name）を必須として受け取る
2. 不足なら usage 表示 → exit 1
3. macOS / `KEYCHAIN_TEST_MODE=1` 以外は exit 1（既存 `cmdTokenAdd:96-99` と同じガード）
4. `getTokenByHandle(db, oldHandle)` で existing token を取得
   - 見つからない → exit 1
   - `credential_source !== "auto-discover"` の場合は警告して続行 vs exit 1 → **exit 1（厳密）**。promote は auto-discover 専用 migration コマンドなので、selectable=1 の token の handle 変更は別コマンド（未実装、out of scope）にする
5. new display name から handle slug 生成（`add` と同じロジック: 小文字英数 4 文字 → `@xxxx`）
6. 衝突チェック: `getTokenByHandle(db, newHandle)` が既存（自分以外）なら exit 1
7. source 選択 UI（`add` と同一）→ accessToken / rateLimitTier
8. `probeOrganizationId(accessToken)` → null なら exit 1
9. **organization_id verification**: probe 結果 == existing.organization_id か比較。不一致なら exit 1（メッセージ: `auto-discover の token とは別アカウントです`）
10. `computeAuthHash(accessToken)` で newAuthHash 算出
11. tags プロンプト（default `["any"]`、入力空も `["any"]`）
12. plan / plan_ratio: rateLimitTier → `PLAN_MAP` で解決（取得不能なら `unknown` / null。後で `set-plan` で訂正可能）
13. `storeTokenInKeychain(newHandle, accessToken)`
14. **DB 更新（1 トランザクション）**:
    ```sql
    UPDATE tokens SET
      handle = ?, auth_hash = ?, plan = ?, plan_ratio = ?, tags = ?,
      credential_source = ?, selectable = 1
    WHERE id = ?
    ```
    `usage_snapshots.token_id` は同じ id を維持するので壊れない。`leases` は通常 0 件（auto-discover 期間中に lease は取られない）。
15. 完了メッセージ表示

**Keychain 失敗時の補償**: 仕様には書かれていないが、`storeTokenInKeychain` が throw した場合、DB 更新前なので何もしなくて safe。逆に DB 更新後に Keychain が失敗すると、handle と Keychain の handle が乖離する → `add` と同じ「順序: Keychain 先 → DB 後」を守れば自然と冪等。

**選定**: **Keychain 先（成功時のみ DB 更新）** を採用。`cmdTokenAdd` の line 189-201 と同じ順序。

### (D) handle 衝突時のエラー型

`add` と揃える: `console.error` + `process.exit(1)`。`Error` を throw しない（既存 `cmdTokenAdd:184-187` の流儀）。

### (E) `updateTokenPromoteFields` API（推奨）

`token-store.ts` に専用関数を追加すると単体テストしやすく、実装が読みやすい：

```ts
export function updateTokenPromoteFields(
  db: Database,
  token_id: number,
  fields: {
    handle: string;
    auth_hash: string;
    plan: TokenPlan;
    plan_ratio: number | null;
    tags: string[];
    credential_source: CredentialSource;
  },
): void {
  db.prepare(`
    UPDATE tokens SET
      handle = ?, auth_hash = ?, plan = ?, plan_ratio = ?,
      tags = ?, credential_source = ?, selectable = 1
    WHERE id = ?
  `).run(
    fields.handle,
    fields.auth_hash,
    fields.plan,
    fields.plan_ratio,
    JSON.stringify(fields.tags),
    fields.credential_source,
    token_id,
  );
}
```

これがあれば `token-cli.ts` 側はシンプルな関数呼び出しに留まる。

---

## 4. 段階的実装手順（TDD）

### Step 1: auto-discover gate（proxy.ts）

#### 1-A: テスト先行（proxy.test.ts に追加）

```ts
describe("proxy: auto-discover gate (T341)", () => {
  // beforeEach: testDir / TOKEN_STORE_DB_PATH / __resetTokensDbForTest（既存パターン）

  test("pool OFF: 未知 authHash + organization_id を流しても tokens は INSERT されない", async () => {
    process.env.CMUX_TEAM_TOKEN_POOL = "0";
    // upstream は organization_id ヘッダ + rate limit を返す
    // start(testDir) → POST /v1/messages（authorization: 新 token）
    // expect tokens table: row 数 0
  });

  test("pool ON: 未知 authHash + organization_id → auto-discover INSERT される", async () => {
    process.env.CMUX_TEAM_TOKEN_POOL = "1";
    // expect tokens row 1, credential_source='auto-discover', selectable=0
  });

  test("pool OFF: 既知 authHash の usage_snapshots は更新される", async () => {
    process.env.CMUX_TEAM_TOKEN_POOL = "0";
    // 事前に insertToken で既知 token を入れる
    // /v1/messages → util_5h が変化したら upsert される
  });
});
```

実行: 全 fail（gate 未実装）

#### 1-B: 実装

1. `proxy.ts` 先頭の import に `isTokenPoolEnabled` を追加（`from "./config"`）
2. `start()` 内（line 357 付近、`upstream` 解決の直後）で:
   ```ts
   let tokenPoolEnabled: boolean;
   try {
     const decision = await isTokenPoolEnabled(projectRoot);
     tokenPoolEnabled = decision.enabled;
   } catch (e: any) {
     // env 不正等は再 throw（呼び出し元の proxy_start_failed ログに乗る）
     throw e;
   }
   ```
3. `updateTokensDB` の signature に `tokenPoolEnabled: boolean` を追加（`getState?` の前）
4. line 144 の `} else if (organizationId) {` 直後に gate insert
5. 呼び出し点 2 箇所（line 653-660 / line 721-729）に `tokenPoolEnabled` を渡す

#### 1-C: 緑化

`bun test --timeout 30000 skills/cmux-team/manager/proxy.test.ts` で新規 3 ケースが green。既存 T323 ケースが壊れていないこと確認。

---

### Step 2: `updateTokenPromoteFields` 追加（token-store.ts）

#### 2-A: テスト先行（token-store.test.ts に追加）

```ts
describe("updateTokenPromoteFields", () => {
  test("auto-discover token を正規 token に変換する", () => {
    // insertToken(handle:@cd8d, credential_source:auto-discover, selectable:false, plan:unknown, tags:[auto])
    // updateTokenPromoteFields(...)
    // getTokenByHandle(@kddi) → row が更新されている（auth_hash / plan / tags / credential_source / selectable=1）
    // organization_id は変わらない
  });

  test("既存 token_id を保持する（usage_snapshots が壊れない）", () => {
    // 同上 + 事前 upsertUsageSnapshot
    // promote 後 getLatestUsageSnapshot(token_id) が引ける
  });
});
```

#### 2-B: 実装

§3-(E) の関数を `token-store.ts` の `updateTokenPlan` 直後（line 387 付近）に追加。

#### 2-C: 緑化

`bun test --timeout 30000 skills/cmux-team/manager/token-store.test.ts`。

---

### Step 3: `cmdTokenPromote` 実装（token-cli.ts）

#### 3-A: テスト先行（token-cli.test.ts に追加）

```ts
describe("cmdTokenPromote (integration)", () => {
  test("R-promote-1: 正常系 credential 経路で promote 成功", async () => {
    // 1. 既存 auto-discover token を仕込む（@cd8d, organization_id=cd8db5e8..., credential_source='auto-discover', selectable=false）
    // 2. writeClaudeCredentials({accessToken:'new-token', rateLimitTier:'default_claude_max_20x'})
    // 3. setArgv("promote", "@cd8d", "kddi")
    // 4. setReadlineAnswers("1", /* tags */ "any")
    // 5. withMockedFetch("cd8db5e8...", () => cmdTokenPromote())
    // 6. expect: getTokenByHandle("@kddi") not null, plan='max-x20', plan_ratio=20.0,
    //    selectable=true, credential_source='claude-credentials', tags=['any']
    // 7. expect: retrieveTokenFromKeychain("@kddi") === 'new-token'
    // 8. expect: getTokenByHandle("@cd8d") === null（旧 handle は消滅）
  });

  test("R-promote-2: 正常系 manual 経路で promote 成功（tags 入力あり）", async () => {
    // setReadlineAnswers("2", "manual-token", "any,kddi")
    // withMockedFetch(同 organization_id)
    // → tags=['any','kddi']
  });

  test("R-promote-3: organization_id 不一致 → exit 1", async () => {
    // 既存 organization_id=cd8db5e8...
    // withMockedFetch("DIFFERENT-ORG") → exit 1, error メッセージに「別アカウント」を含む
    // DB は変更されないこと
  });

  test("R-promote-4: 旧 handle が存在しない → exit 1", async () => {
    // setArgv("promote", "@missing", "foo")
    // → exit 1, error メッセージに @missing を含む
  });

  test("R-promote-5: 新 handle が既存と衝突 → exit 1", async () => {
    // 事前に @kddi を insertToken
    // 別の auto-discover @cd8d → promote @cd8d kddi
    // → exit 1, error メッセージに @kddi を含む
  });

  test("R-promote-6: 旧 handle が auto-discover ではない（selectable=1）→ exit 1", async () => {
    // 既存 @pers (credential_source='manual', selectable=true)
    // → exit 1, error メッセージに「promote は auto-discover 専用」相当
  });

  test("R-promote-7: probe 失敗 → exit 1（DB / Keychain 変更なし）", async () => {
    // withMockedFetch(null) → exit 1
    // 旧 @cd8d は変更されない
  });

  test("R-promote-8: usage_snapshots は維持される（token_id 不変）", async () => {
    // promote 前に upsertUsageSnapshot
    // promote 後 getLatestUsageSnapshot(token.id) が引ける
  });
});
```

#### 3-B: 実装

`token-cli.ts` の `cmdTokenSetPlan` の前後に `cmdTokenPromote` を追加：

```ts
export async function cmdTokenPromote(): Promise<void> {
  const oldHandle = getHandleArg();
  const newDisplayName = process.argv[5];
  if (!newDisplayName) {
    console.error("Usage: cmux-team token promote @<auto-handle> <new-display-name>");
    process.exit(1);
  }

  // macOS / Keychain ガード（既存 cmdTokenAdd と同じ）
  if (process.platform !== "darwin" && process.env.KEYCHAIN_TEST_MODE !== "1") {
    console.error("Error: token pool は macOS Keychain が必要です（macOS 以外は未対応）");
    process.exit(1);
  }

  const db = initTokenDB();
  const existing = getTokenByHandle(db, oldHandle);
  if (!existing) {
    console.error(`Error: ${oldHandle} は登録されていません`);
    db.close(); process.exit(1);
  }
  if (existing.credential_source !== "auto-discover") {
    console.error(
      `Error: ${oldHandle} は auto-discover ではありません（credential_source=${existing.credential_source}）。`
        + ` promote は auto-discover token の正規昇格専用です。`
    );
    db.close(); process.exit(1);
  }

  // new handle 採番（add と同じロジック）
  const slug = newDisplayName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4);
  if (!slug) {
    console.error("Error: display name に使える英数字が含まれていません");
    db.close(); process.exit(1);
  }
  const newHandle = `@${slug}`;
  if (newHandle !== oldHandle) {
    const collision = getTokenByHandle(db, newHandle);
    if (collision) {
      console.error(`Error: handle ${newHandle} は既に使用されています`);
      db.close(); process.exit(1);
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let accessToken: string;
  let rateLimitTier: string | undefined;
  let credentialSource: "claude-credentials" | "manual";
  let tags: string[];
  try {
    console.log("source:");
    console.log("  [1] Claude Code credential (~/.claude/.credentials.json)");
    console.log("  [2] 手動入力（token を貼り付け）");
    const source = (await prompt(rl, "> ")).trim();
    if (source === "1") {
      const cred = await readClaudeCredentials();
      if (!cred) {
        console.error("Error: ~/.claude/.credentials.json が見つかりません");
        db.close(); process.exit(1);
      }
      accessToken = cred.accessToken;
      rateLimitTier = cred.rateLimitTier;
      credentialSource = "claude-credentials";
    } else if (source === "2") {
      accessToken = (await prompt(rl, "token を貼り付け: ")).trim();
      if (!accessToken) {
        console.error("Error: token が空です");
        db.close(); process.exit(1);
      }
      rateLimitTier = undefined;
      credentialSource = "manual";
    } else {
      console.error("Error: 1 または 2 を選択してください");
      db.close(); process.exit(1);
    }

    process.stdout.write("organization_id を取得中...");
    const probedOrgId = await probeOrganizationId(accessToken);
    process.stdout.write("\r");
    if (!probedOrgId) {
      console.error("Error: organization_id を取得できませんでした");
      db.close(); process.exit(1);
    }
    if (probedOrgId !== existing.organization_id) {
      console.error(
        `Error: 取得した token は ${oldHandle} と別アカウントです`
          + ` (existing=${existing.organization_id.slice(0,8)}... probed=${probedOrgId.slice(0,8)}...)`
      );
      db.close(); process.exit(1);
    }

    const tagsRaw = (await prompt(rl, "tags (default: any): ")).trim();
    tags = tagsRaw
      ? tagsRaw.split(",").map(t => t.trim()).filter(Boolean)
      : ["any"];
  } finally {
    rl.close();
  }

  const planEntry = rateLimitTier ? PLAN_MAP[rateLimitTier] : undefined;
  const plan = planEntry?.plan ?? "unknown";
  const planRatio = planEntry?.ratio ?? null;
  const newAuthHash = computeAuthHash(accessToken);

  // Keychain 先、DB 後
  storeTokenInKeychain(newHandle, accessToken);
  updateTokenPromoteFields(db, existing.id, {
    handle: newHandle,
    auth_hash: newAuthHash,
    plan,
    plan_ratio: planRatio,
    tags,
    credential_source: credentialSource,
  });
  db.close();

  console.log(`\nPromoted: ${oldHandle} → ${newHandle}  ${plan}  tags:[${tags.join(", ")}]  ✓`);
}
```

新たに必要な import：

```ts
import { updateTokenPromoteFields } from "./token-store";
```

#### 3-C: main.ts の switch 拡張

- 114-118 行付近の import に `cmdTokenPromote` を追加
- 5435-5439 行の switch に `case "promote": await cmdTokenPromote(); break;` を追加
- 5442 行の Usage を `Usage: cmux-team token add|list|remove|rotate|set-plan|promote` に更新

#### 3-D: 緑化

`bun test --timeout 30000 skills/cmux-team/manager/token-cli.test.ts`

---

### Step 4: 統合（main.ts シナリオ確認）

1. `bun build` で TypeScript エラーがないことを確認
2. 手元で `cmux-team token --help` 等で usage 表示を確認

---

### Step 5: ドキュメント

#### 5-A: `docs/spec/09-token-pool.md`

- 247 行 `## auto-discover` セクションに以下を追記：

```md
**pool 機能 OFF では走らない（T341）**

`isTokenPoolEnabled` が false の場合、proxy は未知 authHash を観測しても tokens.db に INSERT しない。
- 既知 token の `usage_snapshots` 更新（throttled UPSERT）は引き続き動作する
- これにより pool 機能を使わない project では tokens.db が空のまま維持される
```

- `## CLI コマンド` セクション（31 行付近）に `### cmux-team token promote` を追加：

```md
### `cmux-team token promote @<auto-handle> <new-display-name>`

auto-discover で登録された token を正規 handle に昇格させる migration コマンド。

`@<auto-handle>` は `selectable=0` / `credential_source=auto-discover` / `tags=["auto"]` の token を対象とする。

```
$ cmux-team token promote @cd8d kddi-dev
source:
  [1] Claude Code credential (~/.claude/.credentials.json)
  [2] 手動入力（token を貼り付け）
> 1
organization_id を取得中...

tags (default: any): any

Promoted: @cd8d → @kddi  max-x20  tags:[any]  ✓
```

- token 取得は `add` と同じ source 選択 UI（claude credential / 手動入力）
- 取得した token の `organization_id` が DB の既存 `organization_id` と一致することを検証（不一致なら error）
- 旧 token_id を維持するので `usage_snapshots` は壊れない
- 新 handle が既存と衝突する場合は error
- 元の token が auto-discover ではない（`selectable=1` 等）場合も error
```

#### 5-B: `commands/token.md` 等の他ドキュメント

存在しないので不要。

---

## 5. テスト戦略

### 5.1 proxy.test.ts に追加

| ID | ケース | アサーション |
|----|--------|-------------|
| T341-P1 | pool OFF + 未知 authHash | tokens 件数 = 0、`token_auto_discovered` ログなし |
| T341-P2 | pool ON + 未知 authHash | tokens 件数 = 1、`credential_source='auto-discover'`、`selectable=0` |
| T341-P3 | pool OFF + 既知 authHash + util 変化 | usage_snapshots が UPSERT される（util_5h が新値） |
| T341-P4 | pool OFF (env=0) を override する project=on の組み合わせ | env が最優先（既存 `resolveTokenPoolEnabled` ロジック確認） |

#### in-memory keychain stub パターン

`token-cli.test.ts` の流儀を踏襲：

```ts
beforeEach: process.env.KEYCHAIN_TEST_MODE = "1";
afterEach: delete process.env.KEYCHAIN_TEST_MODE;
__resetTokensDbForTest();   // proxy singleton リセット
__resetInMemoryKeychainForTest();
process.env.TOKEN_STORE_DB_PATH = `${testDir}/tokens-${rand}.db`;
process.env.CMUX_TEAM_TOKEN_POOL = "0" / "1";
```

### 5.2 token-cli.test.ts に追加

§4 Step 3-A の R-promote-1〜R-promote-8（8 ケース）。

mock 戦略は既存 `cmdTokenAdd` テストと同一：
- `mock.module("readline", ...)` + `setReadlineAnswers(...)`
- `process.env.HOME = testDir` + `homedirOverride`
- `withMockedFetch(orgId, ...)` で `probeOrganizationId` をモック
- `process.argv` を `setArgv("promote", "@cd8d", "kddi-dev")` で組み立て
- `process.exit` を例外化 → `TestExitError`

### 5.3 token-store.test.ts に追加

§4 Step 2-A の `updateTokenPromoteFields` 単体テスト（2 ケース）。

### 5.4 全体回帰

```bash
cd skills/cmux-team/manager
for f in proxy.test.ts token-cli.test.ts token-store.test.ts config.test.ts; do
  bun test --timeout 30000 "$f"
done
```

`bun test` 全体実行は禁忌（CLAUDE.md ガード）。

---

## 6. ドキュメント変更箇所（再掲・差分粒度）

| ファイル | 場所 | 種類 |
|---------|------|------|
| `docs/spec/09-token-pool.md` | line 247-254 (auto-discover 節) | 追記（pool OFF skip） |
| `docs/spec/09-token-pool.md` | line 31-86 (CLI コマンド節) | 追加（`token promote` リファレンス） |

---

## 7. リスク・懸念点

### R1: 既存テストへの影響

- `proxy.test.ts` の T323 既存テストは `__resetTokensDbForTest` で env を上書きしているが、`CMUX_TEAM_TOKEN_POOL` は未設定。`isTokenPoolEnabled` のデフォルト = `false` のため、新しい gate 適用後は既存 T323 テストでも auto-discover が走らない。**だが** T323 は「既知 token」のテストなので auto-discover branch 自体に入らず、影響なし。要確認: line 1183 で事前 `insertToken` してから流す → 既知パス → tokenHandle apply のみ → ✓ 影響なし。

- 既存テストで「pool ON 前提」のものがあれば壊れる可能性。今回 `proxy.test.ts` には pool ON 前提のテストは無さそうだが grep で再確認すること。

### R2: organization_id UNIQUE 制約の扱い

`tokens.organization_id UNIQUE`（schema line 114）。promote は既存 row を UPDATE するだけで、新 row は作らないため UNIQUE 衝突は発生しない。逆に `cmux-team token add` で同じ organization_id を新規 INSERT しようとすると `(line 178)` で error → これが本タスク背景の問題。promote 経路で migration できれば回避可能。

### R3: Manager 稼働中の race

- promote 実行中に proxy が並行動作している場合：
  - **シナリオ A**: promote が DB UPDATE する前に proxy が同 organization_id の API call 観測 → 既存 row（auto-discover handle）の `usage_snapshots` を更新するだけ。問題なし
  - **シナリオ B**: promote が DB UPDATE 直後に proxy が API call 観測 → 既存 row（既に promote 済み）の `usage_snapshots` を更新。問題なし
  - **シナリオ C**: promote と proxy が同時に DB に書き込む → SQLite WAL なので片方ずつシリアライズされる。`UPDATE` と `UPSERT` は別 row 操作（異なる token_id）なら衝突しない。同一 row へのアクセスはアトミック
- `tokenPoolEnabled=false` で gate 適用後は、proxy が新規 INSERT を試みること自体がない（既知 token の usage 更新のみ）→ さらに safe

### R4: token-cli.ts の hard-coded `process.argv[5]`

`getHandleArg` は `process.argv[4]` を返す。promote では `argv[4]=@handle`、`argv[5]=newDisplayName`。`cmdTokenSetPlan:383` の `process.argv[5]` と同じ位置取り。問題なし。

### R5: `KEYCHAIN_TEST_MODE` 切り替えで in-memory map 漏れ

`__resetInMemoryKeychainForTest` を `beforeEach` で必ず呼ぶ（既存 token-cli.test.ts のパターン）。

### R6: rateLimitTier 不明な promote → plan='unknown'

仕様には「`plan` / `plan_ratio` を `/v1/models` probe で取得 (`token add` と同じロジック)」とあるが、`token add` は probe で plan を取らず `rateLimitTier` から PLAN_MAP で決めている（`cmdTokenAdd:142-144`）。実態に合わせて「rateLimitTier から決定。manual 経路や rateLimitTier 取得不能時は `unknown`、後で `set-plan` で訂正」とする。実装を仕様に合わせるのか仕様文を実態に合わせるのかは、本タスクでは **実装を既存 add パターンに揃え、ドキュメントの記述を「rateLimitTier 由来」に修正** とする。

### R7: `getTokensDB` シングルトンのテスト並行実行

`proxy.ts:32` で module スコープの `_tokensDb` を持つ。テスト間で `__resetTokensDbForTest` を必ず呼ぶ。並行実行（`bun test` の test 単位 isolation）でも `TOKEN_STORE_DB_PATH` を per-test ユニーク名にすれば fd 共有の問題は出ない（既存 T323 setUp パターン）。

---

## 8. AC1〜AC5 と実装ステップの対応表

| AC | 内容 | 実装ステップ | 検証テスト |
|----|------|-------------|-----------|
| AC1 | pool OFF で `claude` を動かしても tokens.db に INSERT されない | Step 1 (auto-discover gate) | T341-P1 |
| AC2 | pool ON では従来通り auto-discover が走る | Step 1 (gate の OR 分岐) | T341-P2 |
| AC3 | `token promote @cd8d kddi` で selectable=1 / handle=@kddi / plan / Keychain 登録 | Step 2 + Step 3 (promote 実装) | R-promote-1, R-promote-2 |
| AC4 | promote 前後で `usage_snapshots` が壊れない（token_id 維持） | Step 2 (`updateTokenPromoteFields` が id 固定 UPDATE) | R-promote-8 + token-store.test.ts §2-A 第 2 ケース |
| AC5 | pool OFF でも proxy の usage tracking（既知 token snapshot 更新）は機能する | Step 1 (gate は `else if` 分岐のみで、上の usage UPSERT には影響しない) | T341-P3 |

---

## 9. 実装順序サマリ（最終）

1. **Step 1**: proxy.ts gate（テスト先行 → 実装 → green） — AC1, AC2, AC5
2. **Step 2**: token-store.ts の `updateTokenPromoteFields` 追加（テスト先行） — AC4 基盤
3. **Step 3**: token-cli.ts の `cmdTokenPromote` + main.ts switch 登録（テスト先行） — AC3, AC4
4. **Step 4**: TypeScript build 確認 / 手動 smoke
5. **Step 5**: docs/spec/09-token-pool.md 更新

各 Step で 1 PR 相当に分けても良いが、AC1-5 の整合性のため 1 タスク内で全部実装するのが妥当。

---

## 10. 確認事項（実装着手前に Conductor が判断する余地のある点）

- (Q1) `cmdTokenPromote` の `credential_source` が `auto-discover` 以外の token を拒否するか、警告のみで続行するか → **本計画では拒否（exit 1）**。仕様書に「auto-discover で登録された token を正規 handle に migration」とあるため。
- (Q2) `updateTokensDB` の signature: positional 拡張 vs options object → **positional 拡張**（最小差分）。実装時に readability が問題なら options 化を検討。
- (Q3) gate を proxy 起動時に評価するキャッシュ寿命 → **proxy プロセス生存期間**。daemon 再起動が pool 設定変更の前提（既存運用と一貫）。
