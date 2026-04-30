# T345 実装計画: token add/promote の source=1 で macOS Keychain を優先する

## 0. 前提確認（実機で済ませた事項）

- 対象ユーザー（`$USER`）の Keychain にはエントリ存在を確認済み:
  - service: `Claude Code-credentials`, account: `$USER`
- JSON top-level keys: `claudeAiOauth`, `mcpOAuth`
- `claudeAiOauth` のキー: `accessToken`, `expiresAt`, `rateLimitTier`, `refreshToken`, `scopes`, `subscriptionType`
- → **`rateLimitTier` は Keychain JSON にも含まれている**ので、`.credentials.json` と同じ shape として扱える

## 1. 実装方針

### 1.1 `readClaudeCredentials` の優先順位ロジック

シグネチャは現状維持（戻り値 `{ accessToken, rateLimitTier } | null`）。優先順位を以下に変更:

```ts
async function readClaudeCredentials(): Promise<{
  accessToken: string;
  rateLimitTier: string | undefined;
} | null> {
  // 1) macOS Keychain（`security find-generic-password` または in-memory test mode）
  const keychainJson = readClaudeCodeKeychain();
  if (keychainJson) {
    const parsed = parseClaudeCredentialJson(keychainJson);
    if (parsed) return parsed;
    // JSON 破損 → file へフォールバック（warn は出さない: 期待される fallback）
  }

  // 2) ~/.claude/.credentials.json
  const credPath = join(homedir(), ".claude", ".credentials.json");
  try {
    const raw = await readFile(credPath, "utf-8");
    return parseClaudeCredentialJson(raw);
  } catch {
    return null;
  }
}

function parseClaudeCredentialJson(raw: string): {
  accessToken: string; rateLimitTier: string | undefined;
} | null {
  try {
    const obj = JSON.parse(raw);
    const oauth = obj?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return { accessToken: oauth.accessToken, rateLimitTier: oauth.rateLimitTier };
  } catch {
    return null;
  }
}
```

### 1.2 Keychain 読み出しの実装方法

`token-store.ts` に新関数を追加（後述「関数の所在」参照）:

```ts
// token-store.ts に追加
const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";

// テスト用に in-memory モードでセットするためのヘルパ
const inMemoryClaudeCodeKeychain = new Map<string, string>();

export function __setClaudeCodeKeychainForTest(account: string, json: string | null): void {
  if (json === null) inMemoryClaudeCodeKeychain.delete(account);
  else inMemoryClaudeCodeKeychain.set(account, json);
}

export function __resetClaudeCodeKeychainForTest(): void {
  inMemoryClaudeCodeKeychain.clear();
}

/**
 * macOS Keychain から Claude Code の credentials JSON 文字列を取得する。
 *
 * - `KEYCHAIN_TEST_MODE === "1"` のときは in-memory 経路に切り替え（既存方針と整合）
 * - 非 macOS の場合は null
 * - `security` exit 44 (errSecItemNotFound) → null
 * - `security` その他の失敗（spawn error / 非ゼロ exit）→ null（呼び出し側で .credentials.json fallback）
 * - JSON parse は本関数では行わず raw string を返す
 */
export function readClaudeCodeKeychain(account: string = process.env.USER ?? ""): string | null {
  if (useInMemory()) {
    return inMemoryClaudeCodeKeychain.get(account) ?? null;
  }
  if (process.platform !== "darwin") return null;
  if (!account) return null;

  const result = spawnSync(
    "security",
    ["find-generic-password", "-s", CLAUDE_CODE_KEYCHAIN_SERVICE, "-a", account, "-w"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.error) return null;          // spawn 自体の失敗
  if (result.status !== 0) return null;   // 44 含めて全て null
  const out = (result.stdout?.toString() ?? "").replace(/\n$/, "");
  return out.length > 0 ? out : null;
}
```

#### `security` コマンド失敗時のフォールバック条件

「**全失敗で fallback**」を採用する。理由:

- exit 44 (errSecItemNotFound) を区別しても呼び出し側の挙動は同じ（次の経路を試す）
- 権限エラーや Keychain ロック中など、44 以外でも fallback したいケースがある
- `.credentials.json` 経路が second source として機能していれば、ユーザー体験は損なわれない
- Keychain の存在強制は「auto-discover」など別経路で別途扱うべきで、source=1 では best-effort で良い

ただし、ログ等への記録は不要（fallback 経路は正常系として扱う）。

### 1.3 関数の所在（選択理由）

| 候補 | 採否 | 理由 |
|---|---|---|
| token-cli.ts に inline | ✗ | spawnSync を CLI 層に直接置くと、token-cli.test.ts の現状の mock 方針（readline / os のみ mock）と整合しない。test では `mock.module("child_process", ...)` を入れる必要が出るが、token-cli の他箇所（`probeOrganizationId` 等）は child_process 非依存でテスト済みなので影響範囲を広げたくない |
| 別関数として export（token-cli.ts 内） | △ | 同上。`spawnSync` を CLI 層から呼ぶと test 層に新たな mock が必要 |
| **token-store.ts に新規関数を追加（採用）** | ✓ | (1) token-store.ts は既に `spawnSync` で Keychain CRUD を実装済み。(2) `useInMemory()` 経路を再利用でき、`KEYCHAIN_TEST_MODE=1` の挙動と整合。(3) `__setClaudeCodeKeychainForTest` を追加すれば test mock が自然に書ける（既存 `__resetInMemoryKeychainForTest` と同形）|

→ **token-store.ts に `readClaudeCodeKeychain` / `__setClaudeCodeKeychainForTest` / `__resetClaudeCodeKeychainForTest` を追加**し、token-cli.ts の `readClaudeCredentials` から import して使う。`parseClaudeCredentialJson` は token-cli.ts 内 private helper のままで良い（CLI 層の都合）。

### 1.4 source 選択 UI のラベル更新

ユーザーに見える文言を Keychain 含む形に変更:

```diff
-    console.log("  [1] Claude Code credential (~/.claude/.credentials.json)");
+    console.log("  [1] Claude Code credential (macOS Keychain / ~/.claude/.credentials.json)");
```

`cmdTokenAdd` (L106) と `cmdTokenPromote` (L484) の 2 箇所。`cmdTokenRotate` の rotate プロンプト (L343) は `[1] credential ファイルから再取得` という別文言なので、こちらも `[1] credential から再取得 (Keychain / ファイル)` に揃える。

## 2. テスト戦略

### 2.1 既存フラグの流用 vs 新フラグ

**既存の `KEYCHAIN_TEST_MODE=1` を流用する。** 理由:

- 既存テストは `KEYCHAIN_TEST_MODE=1` で in-memory に切り替える方針が確立しており、追加フラグを増やすとテストの分岐軸が増えて複雑化する
- token-store.ts の `useInMemory()` は単一の真偽値で判定するので、Claude Code 用の in-memory map も同じフラグでガードするのが自然
- in-memory map は cmux-team 自前 token 用 (`inMemoryKeychain`) と Claude Code 用 (`inMemoryClaudeCodeKeychain`) の 2 つに分けるので、互いに干渉しない

### 2.2 mock 方法

| 対象 | 方法 | 備考 |
|---|---|---|
| `readClaudeCodeKeychain` の Keychain 経路 | `__setClaudeCodeKeychainForTest($USER, json)` で in-memory に値を仕込む | `process.env.KEYCHAIN_TEST_MODE=1` は既存 beforeEach で設定済み |
| `~/.claude/.credentials.json` 経路 | 既存 `writeClaudeCredentials` ヘルパをそのまま流用（HOME=testDir + os.homedir() override 済み）| L235-251 |
| 非 macOS シミュレーション | **既存テスト構造で `KEYCHAIN_TEST_MODE=1` のとき in-memory に何も入れない＝Keychain 経路は null** で、`process.platform` を直接 mock せずに「Keychain なし → file fallback」を再現できる | `process.platform` は readonly。darwin 以外の挙動を分離テストしたいなら別途 `Object.defineProperty` で override するが、in-memory 経路で同等のカバレッジが得られるため不要 |
| `process.env.USER` の fix | beforeEach で固定値（例: "testuser"）に設定し、afterEach で復元 | 既存 originalEnv に `USER` を追加 |

`spawnSync` を直接 mock しない（in-memory 経路で代替）。これにより `child_process` 全体への影響を避ける。

### 2.3 追加するテストケース

`token-cli.test.ts` の新セクション `describe("readClaudeCredentials priority", ...)` を追加。

| # | ケース | セットアップ | 期待 |
|---|---|---|---|
| T1 | macOS Keychain 成功 → Keychain 値が返る | `__setClaudeCodeKeychainForTest("testuser", JSON.stringify({claudeAiOauth: {accessToken: "kc-AAA", rateLimitTier: "default_claude_max_5x"}}))`、ファイル側にも別 token を書く | `cmdTokenAdd` で `accessToken=kc-AAA`, plan=`max-x5` で登録される（ファイル側の値ではなく） |
| T2 | macOS Keychain 失敗（未登録）→ .credentials.json fallback | Keychain は空、ファイル側に `accessToken=file-BBB` | `accessToken=file-BBB` で登録 |
| T3 | 両方失敗 → exit 1（"Claude Code credential が見つかりません..." 文言） | Keychain 空、ファイルなし | `TestExitError` code=1, errors に新文言を含む |
| T4 | Keychain JSON 破損 → file fallback | Keychain に `"this is not json"`、ファイル側に `accessToken=file-CCC` | `accessToken=file-CCC` で登録 |
| T5 | Keychain JSON は有効だが `claudeAiOauth.accessToken` 欠損 → file fallback | Keychain に `{"claudeAiOauth":{}}`、ファイル側に `accessToken=file-DDD` | `accessToken=file-DDD` で登録 |
| T6 | rateLimitTier が Keychain にあれば plan は Keychain 由来で決まる | Keychain `rateLimitTier=default_claude_pro` | plan=`pro` |
| T7 | promote 経路でも同じ優先順位（cmdTokenPromote source=1） | Keychain に値、ファイルに別値 | promote 後の Keychain 内 token は Keychain 由来の値 |
| T8 | rotate 経路でも同じ優先順位（cmdTokenRotate input="1"） | 同上 | rotate 後の `auth_hash` は Keychain 由来 token のもの |

T6 は T1 と統合可能（plan 確認は T1 で兼ねる）。実体は最低 7 ケース（T1〜T5, T7, T8）を追加する。

### 2.4 既存テストへの影響

`writeClaudeCredentials` を使う既存テスト（cmdTokenAdd / cmdTokenRotate / cmdTokenPromote の credentials 経路）は、**Keychain 側に値が入っていない限り fallback してファイルを読む**。beforeEach で `__resetClaudeCodeKeychainForTest()` を呼べば既存テストの挙動は不変。

beforeEach 修正案:

```ts
beforeEach(() => {
  // ...既存処理...
  __resetInMemoryKeychainForTest();
  __resetClaudeCodeKeychainForTest();   // ← 追加
  process.env.USER = "testuser";        // ← 追加（Keychain account の fix）
  askAnswers.length = 0;
});
```

beforeAll で `originalEnv.USER` を退避し、afterAll で復元する。

→ **既存テストは無改修で pass する想定**。

## 3. エラーメッセージ更新箇所

| 箇所 | 旧 | 新 |
|---|---|---|
| L116 (`cmdTokenAdd`) | `Error: ~/.claude/.credentials.json が見つからないか accessToken がありません` | `Error: Claude Code credential が見つかりません（macOS Keychain / ~/.claude/.credentials.json のどちらも読めませんでした）` |
| L349 (`cmdTokenRotate`) | 同上 | 同上 |
| L490 (`cmdTokenPromote`) | 同上 | 同上 |
| L106 (`cmdTokenAdd` UI) | `[1] Claude Code credential (~/.claude/.credentials.json)` | `[1] Claude Code credential (macOS Keychain / ~/.claude/.credentials.json)` |
| L484 (`cmdTokenPromote` UI) | 同上 | 同上 |
| L343 (`cmdTokenRotate` UI) | `[1] credential ファイルから再取得` | `[1] credential から再取得 (macOS Keychain / ファイル)` |

3 箇所のエラーメッセージは同一文言にして、定数化（`CRED_NOT_FOUND_MSG`）してもよいが、現状の token-cli.ts は同様の文言を直接書いているので踏襲する。

## 4. 実装手順 (TDD)

1. **Red 確認**: `token-cli.test.ts` に T1（Keychain 成功）と T2（Keychain 未登録 → file fallback）を先に追加。`__setClaudeCodeKeychainForTest` / `__resetClaudeCodeKeychainForTest` がまだ無いため import エラー → テスト fail。
2. **token-store.ts 改修**: `CLAUDE_CODE_KEYCHAIN_SERVICE` 定数、`readClaudeCodeKeychain` 関数、in-memory map（`inMemoryClaudeCodeKeychain`）、test 用 helper（`__set...` / `__reset...`）を追加・export。
3. **token-cli.ts 改修**: `readClaudeCredentials` を新ロジックに変更。`parseClaudeCredentialJson` を private helper として切り出し。`readClaudeCodeKeychain` を import。**Green 確認**（T1 / T2 が pass）。
4. **残テスト追加**: T3〜T5, T7, T8 を追加してすべて pass することを確認。
5. **caller 更新**: L116 / L349 / L490 のエラーメッセージ更新。L106 / L484 / L343 の UI ラベル更新。
6. **既存テストの非回帰確認**: `bun test --timeout 30000 token-cli.test.ts` を全件実行して全 pass。
7. **型チェック**: `bunx tsc --noEmit` で新規エラーがないこと。

> 補足: 既存テストの中で「ファイル経路で credential を読む」テストは多数あるため、beforeEach で `__resetClaudeCodeKeychainForTest()` を呼んで Keychain 経路を確実に空にする。これを忘れると T1 の影響で他テストが汚染されうる。

## 5. 完了条件

- [ ] `bunx tsc --noEmit`（manager 配下）で本タスク起因の新規エラーが 0
- [ ] `cd skills/cmux-team/manager && bun test --timeout 30000 token-cli.test.ts` が全 pass（既存 + 新規 7 ケース以上）
- [ ] `cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts` が pass（in-memory 系を破壊していないことの確認、もし test ファイルが存在すれば）
- [ ] エラーメッセージ 3 箇所と UI ラベル 3 箇所が更新されている

### 実機確認手順（手動・推奨）

実機での E2E は本タスク完了後に手動で 1 回実行してリグレッションを確認する:

1. 実機の `~/.claude/.credentials.json` を期限切れ状態のまま据え置く（fresh credential は Keychain 側にある状態）
2. `cmux-team token add` を実行 → source=1 を選択
3. 表示されるプロンプトのラベルが `(macOS Keychain / ~/.claude/.credentials.json)` になっていること
4. `organization_id を取得中...` の後に **probe 401 が起きず**、`Found credential:` が表示されること
5. `display name` / `tags` を入力して登録完了 → `cmux-team token list` で当該 token が selectable=yes で表示されること
6. 既存の `@yamamoto` 等を残したまま `cmux-team token promote @<auto-handle> <name>` を試行（auto-discover token がある場合）→ 同様に Keychain 由来で probe 成功
7. テスト後に作った token は `cmux-team token remove @<handle>` で掃除する

リスク低減のため、登録前に `security find-generic-password -s "Claude Code-credentials" -a "$USER" -w | jq .claudeAiOauth.expiresAt` で `expiresAt` を確認し、現在時刻より十分後であることを確認しておくこと。

## 6. やらないこと（タスク本文の確認）

- proxy 側の auto-discover ロジック（`probeAutoDiscover` 等）は触らない
- `~/.claude/.credentials.json` への書き込み・rotate（読み取り専用）
- `mcpOAuth` の取り扱い（本タスクでは `claudeAiOauth` のみ）
- `process.platform` 自体を mock するテスト（in-memory 経路で同等カバレッジを得られるため）

## 7. 影響範囲サマリ

| ファイル | 種別 | 内容 |
|---|---|---|
| `skills/cmux-team/manager/token-store.ts` | 追加 | `CLAUDE_CODE_KEYCHAIN_SERVICE`, `readClaudeCodeKeychain`, in-memory map, `__set/__resetClaudeCodeKeychainForTest` |
| `skills/cmux-team/manager/token-cli.ts` | 修正 | `readClaudeCredentials` ロジック差し替え、`parseClaudeCredentialJson` helper 追加、L106/L116/L343/L349/L484/L490 文言更新 |
| `skills/cmux-team/manager/token-cli.test.ts` | 追加 | `describe("readClaudeCredentials priority")` で 7 ケース、beforeEach で `__resetClaudeCodeKeychainForTest()` + `process.env.USER` 固定 |

公開 API（CLI 引数・出力フォーマット）に破壊的変更はなし。ユーザーに見える変化はソース選択の UI ラベルとエラーメッセージの 2 種のみ。
