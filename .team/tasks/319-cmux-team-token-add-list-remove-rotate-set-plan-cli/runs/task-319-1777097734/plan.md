# T319 cmux-team token CLI 実装計画書（Rev 2）

`cmux-team token {add,list,remove,rotate,set-plan}` の 5 サブコマンドを実装する。
T318 で導入された `skills/cmux-team/manager/token-store.ts`（DB + Keychain + pool capacity 計算）の利用層を CLI として被せ、tokens.db のライフサイクル管理（登録・参照・削除・ローテ・plan 補完）をユーザー操作可能にする。

> **改訂履歴**
> - **Rev 2 (2026-04-25)**: Design Reviewer の Changes Requested を受けて改訂。
>   - A019 を main repo absolute path から実読し、handle UX / tag 設計 / TUI 表示 / auto token の `set-plan` 取扱を反映（D1 撤回）
>   - DB × Keychain の整合方式を「補償トランザクション」に統一（SQL transaction 内 `spawnSync` 案を破棄）
>   - `validateAndNormalizeHandle` のロジックを `[a-z0-9]` 以外を除去 → 先頭 4 文字に変更
>   - `organization_id` を必須化（NOT NULL UNIQUE 違反の事前防止）
>   - `auth_hash` を full 64 文字 hex で保存することを明確化（A020 §後続実装への提言準拠）
>   - `formatNextReset` を `7d @ Apr 27 09:00` 形式に統一
>   - cap_pct を整数表示（A019 §TUI 整合）
>   - `set-plan` のスコープ明記（selectable 昇格はスコープ外）

## 1. 課題分析

### 現状

- T318 で `~/.cmux-team/tokens.db` のスキーマ（`tokens` / `usage_snapshots` / `leases`）と CRUD ヘルパが入った（`skills/cmux-team/manager/token-store.ts`）。Keychain 連携、pool capacity 計算、テスト用 in-memory フォールバックも揃っている。
- ただし **ユーザーがトークンを登録・確認・更新する手段が無い**。`insertToken` は内部関数で、CLI も TUI も無い。
- 後続の token-pool 機能（spawn-agent 選択 / proxy auto-discover / TUI 表示）は、まずこの CLI による「人間が登録した selectable=true なトークン」の集合があって初めて意味を持つ。

### 根本要件

| 要素 | 内容 | 出典 |
|------|------|------|
| 入力経路 | `~/.claude/.credentials.json` 自動取得 / 手動貼付け | A019 §`cmux-team token add` UX、T319 conductor-prompt §1 |
| 識別子 | `@xxxx`（name から `[a-z0-9]` 以外を除去 → 先頭 4 文字）。重複エラー | A019 §アカウント表記規約、§`token add` UX 例（`personal` / `kddi-dev`）|
| 値の保管 | DB は メタ情報のみ。token 本体は macOS Keychain | A019 §セキュリティ、A020 §schema 設計 |
| plan 分類 | rateLimitTier → max-x20 / max-x5 / pro / unknown の 4 分類 | A019 §plan 導出、T319 conductor-prompt |
| pool capacity | A019 §pool_capacity 式（`computePoolCapacity` 既存実装） | A019 §pool_capacity、token-store.ts:592-627 |
| auth_hash | `sha256("Bearer " + token)` の **full 64 文字 hex** を DB に保存。表示時のみ先頭 12 文字 | A020 §schema 設計（後続実装提言）|
| セキュリティ | shell history / capture-pane 露出回避（argv で token を渡さない） | A019 §セキュリティ、A020 §運用上の注意 |
| tag 設計 | `any` / `oss-only` / `org:<code>` / `auto` の 4 系統。`auto` は auto-discover 専用で `add` 経路では入力させない | A019 §タグ設計 |

### 影響範囲

- 主要変更: `skills/cmux-team/manager/main.ts`（switch case 追加）、`skills/cmux-team/manager/token-cli.ts`（新規）、`skills/cmux-team/manager/token-store.ts`（不足 API 3 関数追加）
- テスト追加: `skills/cmux-team/manager/token-cli.test.ts`、`skills/cmux-team/manager/token-store.test.ts`（追加 API 分）
- 既存機能への破壊変更なし（純粋追加）

## 2. 技術アプローチ

### 採用アプローチ

**`skills/cmux-team/manager/token-cli.ts` に CLI 実装を分離し、`main.ts` から `cmdToken()` を 1 行で呼び出す**。

理由:
- サブコマンドが 5 つあり、各々が「対話入力」「credential パース」「Keychain 操作」「DB 更新」を組み合わせる中規模ロジック。`main.ts`（既に 5,000 行超）に直書きすると密度が一段上がる。
- 既存の `agent-instructions.ts`（`get-agent-instructions` 等）や `direnv-check.ts` と同等の分離粒度。
- pure function 単位（handle 検証・rateLimitTier 変換・credential JSON パース・list 行整形）でテスト可能になる。

### 代替案と却下理由

| 案 | 却下理由 |
|----|---------|
| `main.ts` に `cmdToken()` 直書き | 5 サブコマンド × 対話入力 × Keychain 例外処理で 500-700 行になる。テスト分離もしにくい |
| `bin/cmux-team.js` に CLI ロジック追加 | bin はランチャ専用（既存ポリシー）。実体は manager/ に置くのが整合的 |
| サブコマンドごとに別ファイル（`token-add.ts` 等） | 5 ファイル × 数十行 + 共通 helper は過度な分割。1 ファイル + 内部 export で十分 |

### 既存パターンとの整合性

- **対話入力**: `envrc-prompt.ts:42-55` で `readline/promises` の `createInterface` を使う既存パターンに合わせる。テスト容易性のため `ask: (prompt) => Promise<string>` を引数で差し替え可能にする（既存 `EnsureOptions.ask` と同形）。
- **DB 初期化**: `initTokenDB()` を関数頭で呼び、`db.close()` を `try/finally` で確実に。
- **エラー処理**: `KeychainCommandError` は `stderr` を含むメッセージで `console.error` 出力 → `process.exit(1)`。`KeychainUnsupportedError` は「macOS でのみサポート」を明示。
- **switch dispatch**: `cmdArtifacts()` (`main.ts:4783`) と同形で `args[1]` でサブコマンド分岐。
- **テスト**: `token-store.test.ts` の `mkdtempSync` + `TOKEN_STORE_DB_PATH` 上書き + `KEYCHAIN_TEST_MODE=1` パターンを踏襲。

### 構造的解決の検討

「対話入力 / credential ファイル / 非対話フラグ」の 3 経路で同じ「token 文字列 + organization_id + plan を集める」処理を行うため、**`resolveTokenInput()` を 1 つの pure function に集約**する。`source: "credentials" | "manual"` のディスパッチで分岐し、結果は同じ `ResolvedTokenInput` 型を返す。これにより `add` / `rotate` 双方で再利用でき、テストも入力 source 単位でテーブル駆動できる。

### DB × Keychain の整合戦略（補償トランザクション）

T319 では **DB と Keychain にまたがる更新を補償トランザクション方式で行う**。SQL transaction の中で `spawnSync` を呼ばない。

理由:
- `storeTokenInKeychain` は `security add-generic-password -U`（upsert）で Keychain 副作用が即時確定するため、SQL rollback では戻らない。「transaction 内で spawn → COMMIT 直前に SQLITE_BUSY → Keychain に orphan」の不整合を生む。
- Keychain spawnSync は数百ms〜数秒（unlock prompt が出れば数十秒）かかり、proxy（T320）の `usage_snapshots` UPSERT を WAL の write lock で待たせる。

採用パターン（`add` / `rotate` 共通の擬似コード）:

```ts
// add 経路
const token_id = db.transaction(() => insertToken(db, {...}))();   // 先に DB COMMIT
try {
  storeTokenInKeychain(handle, accessToken);
} catch (e) {
  // 補償: Keychain 失敗時は DB を巻き戻し
  deleteToken(db, token_id);
  throw new Error(`Keychain failed; rolled back DB. Re-run \`token add\`. cause=${e}`);
}

// rotate 経路
const oldHash = token.auth_hash;
updateTokenAuth(db, token.id, newHash);   // 先に DB UPDATE COMMIT
try {
  storeTokenInKeychain(handle, newToken); // Keychain は -U upsert
} catch (e) {
  // 補償: 旧 hash で巻き戻し（Keychain 側は冪等で副作用なし）
  updateTokenAuth(db, token.id, oldHash);
  throw new Error(`Keychain failed; rolled back DB to old auth_hash. Re-run \`token rotate\`. cause=${e}`);
}
```

冪等性の前提:
- `deleteToken` は冪等（存在しない id でも例外を出さない設計、subtask 1）
- Keychain `add-generic-password -U` は upsert で冪等
- `updateTokenAuth` は SET 文 1 本で冪等

これにより「DB に row があるが Keychain 値が無い」「Keychain は新値だが DB は旧 hash」の片寄り状態を一切生まない（最終状態は「両方更新済み」または「両方旧値」のどちらかに収束）。

## 3. 変更対象

### 新規ファイル

| パス | 概要 |
|------|------|
| `skills/cmux-team/manager/token-cli.ts` | `cmdToken()` 本体。サブコマンド分岐、対話入力、handle/credential/plan/Keychain の整流ロジック、list 整形 |
| `skills/cmux-team/manager/token-cli.test.ts` | pure function（handle 検証 / rateLimitTier 変換 / credential パース / list 整形 / next-reset 整形）のテストと、サブコマンド統合テスト（DB + in-memory Keychain） |

### 既存ファイル変更

| パス | 変更概要 |
|------|---------|
| `skills/cmux-team/manager/main.ts` | switch（line 4964 付近）に `case "token":` 追加、import を 1 行追加 |
| `skills/cmux-team/manager/token-store.ts` | 不足 API 追加: `deleteToken`、`updateTokenAuth`、`updateTokenPlan`。`deleteToken` は `usage_snapshots` / `leases` を明示的にトランザクション削除（FK は `ON DELETE CASCADE` 未設定のため明示削除が安全）。 |
| `skills/cmux-team/manager/token-store.test.ts` | 追加 API 3 つのテスト追加 |

### 削除ファイル

なし（純粋追加）。

## 4. サブタスク分割

TDD 前提（テスト → 最小実装 → リファクタ）。**1〜4 は token-store 拡張、5〜10 は CLI 本体、11〜13 は配線・統合**。

### 1. `token-store.ts` に `deleteToken` を追加（テストファースト）

- **対象**: `token-store.test.ts`（テスト先行）→ `token-store.ts`（実装）
- **API**: `export function deleteToken(db: Database, token_id: number): void`
- **動作**: `BEGIN; DELETE FROM leases WHERE token_id=?; DELETE FROM usage_snapshots WHERE token_id=?; DELETE FROM tokens WHERE id=?; COMMIT;` を `db.transaction()` で実行
- **テスト**:
  - 既存 token + usage_snapshot + lease がある状態で `deleteToken` → 3 テーブル全てから消えていること
  - 存在しない id でも例外が出ないこと（冪等。補償トランザクションでの再呼び出し用）
- **完了条件**: `bun test skills/cmux-team/manager/token-store.test.ts` 緑

### 2. `token-store.ts` に `updateTokenAuth` を追加

- **API**: `export function updateTokenAuth(db: Database, token_id: number, new_auth_hash: string): void`
- **動作**: `UPDATE tokens SET auth_hash=? WHERE id=?`
- **テスト**: `insertToken` → `updateTokenAuth` → `getTokenByHandle().auth_hash` が新値（**full 64 文字 hex**）に変わっていること
- **完了条件**: テスト緑

### 3. `token-store.ts` に `updateTokenPlan` を追加

- **API**: `export function updateTokenPlan(db: Database, token_id: number, plan: TokenPlan, plan_ratio: number | null): void`
- **動作**: `UPDATE tokens SET plan=?, plan_ratio=? WHERE id=?`
- **テスト**: 既存 unknown plan の token に対して `updateTokenPlan(db, id, "max-x20", 20.0)` → `plan` / `plan_ratio` が更新されていること
- **完了条件**: テスト緑

### 4. `token-cli.ts` の pure function 群を実装（テストファースト）

`token-cli.test.ts` で以下を先に書き、`token-cli.ts` に実装する。

| 関数 | シグネチャ | 検証パターン |
|------|----------|-------------|
| `validateAndNormalizeHandle` | `(name: string) => string` | 詳細は下表 |
| `rateLimitTierToPlan` | `(tier: string \| null \| undefined) => { plan: TokenPlan; plan_ratio: number \| null }` | `default_claude_max_20x` → `(max-x20, 20.0)`、`default_claude_max_5x` → `(max-x5, 5.0)`、`default_claude_pro` → `(pro, 1.0)`、未知/null → `(unknown, null)` |
| `parseCredentialFile` | `(path: string) => { accessToken, organizationId?, rateLimitTier?, subscriptionType? }` | `~/.claude/.credentials.json` の `claudeAiOauth` ノードから抽出。`organizationId` 等の欠損は undefined を返す（必須化は呼び出し側 `cmdTokenAdd` の責務）。ファイル不在は `Error("credentials not found at ...")` |
| `hashAuthorization` | `(token: string) => string` | `sha256("Bearer " + token)` の **full 64 文字 hex**（A020 §schema 設計準拠）。表示用 prefix は `hash.slice(0, 12)` を呼び出し側で取る |
| `formatNextReset` | `(util_5h_reset, util_7d_reset, now) => string` | 近い方のラベル + ローカル時刻。形式は **`5h @ HH:MM`** または **`7d @ MMM DD HH:MM`**（例: `7d @ Apr 27 09:00`）。両方 null → `"-"`。テストは `process.env.TZ = "Asia/Tokyo"` を固定し、月名は英 3 文字略（toLocale を使わず `["Jan",...,"Dec"][m]` で組む） |
| `formatTokenListRow` | `(token, snapshot, capPct) => string[]` | 8 列を文字列配列で返す。tags は `["any","kddi"]` → `"any,kddi"`、selectable は `"yes"/"no"`、cap_pct は **整数 + `%`**（`Math.round(capPct) + "%"`）、util は `41%/49%`（整数）、snapshot 不在は `-` |
| `formatTokenListTable` | `(rows: string[][]) => string` | 列幅揃えの整形（既存 `cmdArtifacts` の `padEnd` パターン） |

#### `validateAndNormalizeHandle` の詳細仕様

**A019 §アカウント表記規約「handle 形式: `@xxxx` = name の先頭 4 文字（小文字英数のみ）」+ §`token add` UX 例「`kddi-dev`」を許容する設計。**

ロジック:
1. `name` が `@` で始まる → そのまま検証 (4 文字以上 + handle 部分が `[a-z0-9]+` のみ。長さ 5 文字以上 = `@` + 4 文字以上)
2. `name` が `@` で始まらない → 大文字を小文字化 → `[a-z0-9]` 以外を除去 → 先頭 4 文字を取る → `@` を前置 → 4 文字未満ならエラー

テストケース:

| 入力 | 期待結果 | 根拠 |
|------|---------|------|
| `personal` | `@pers` | A019 UX 例 |
| `kddi-dev` | `@kddi` | A019 UX 例（小文字+ハイフン入力） |
| `KDDI-dev` | `@kddi` | sanitize で大文字→小文字、`-` 除去 |
| `kddi_dev` | `@kddi` | sanitize で `_` 除去 |
| `ab` | エラー（`name must contain at least 4 alphanumeric characters; got "ab"`）| sanitize 後 4 文字未満 |
| `--` | エラー | sanitize 後 0 文字 |
| `@pers` | `@pers` | `@` 明示入力はそのまま検証 |
| `@too$$` | エラー（`handle must match @[a-z0-9]+`）| `@` 明示入力で不正文字 |
| `@a` | エラー（`handle must be at least 5 chars (@ + 4)`）| `@` 明示で短すぎる |

**完了条件**: 各 pure function のテストが緑。実装は副作用ゼロ（fs/spawn/db に触らない）。`parseCredentialFile` のみ fs 触るが path を引数で受けるためテストで一時ファイル経由検証。

### 5. `token-cli.ts` の `resolveTokenInput` を実装（対話 + credential 統合）

- **API**: `export async function resolveTokenInput(opts: { source: "credentials" | "manual"; ask: (q: string) => Promise<string>; credentialsPath?: string; }): Promise<ResolvedTokenInput>`
  - `ResolvedTokenInput = { accessToken: string; organizationId: string | null; rateLimitTier: string | null; subscriptionType: string | null; }`
- **動作**:
  - `source=credentials` → `parseCredentialFile(opts.credentialsPath ?? defaultCredentialsPath())`
  - `source=manual` → `ask("Paste OAuth access token: ")` で取得（trim、空ならエラー）。`ask("Organization ID: ")` で取得（trim、空でも続行 → 後段 `cmdTokenAdd` で必須化検査）。`ask("Rate limit tier (default_claude_max_20x / _max_5x / _pro / RET to skip): ")` も同様。
- **テスト**: `ask` をモック（`async (q) => "fake-token"` 等）。両 source パスをテーブル駆動で検証。`organizationId` 空文字入力 → null 返却を確認。

### 6. `cmdTokenAdd` を実装

- **対象**: `token-cli.ts` 内 `async function cmdTokenAdd(args: string[]): Promise<void>`
- **動作**:
  1. `[1] credentials / [2] manual` を `ask` で選択（`--source credentials|manual` で非対話バイパス）
  2. `resolveTokenInput()` で credential 取得
  3. **`organization_id` 必須化検査**: credential / 対話入力のいずれでも空のまま到達した場合は exit 1。エラーメッセージ:
     ```
     Error: organization_id is required.
       credential ファイルが古い形式の場合は Anthropic Console (https://console.anthropic.com/settings/general)
       から確認して再実行してください。manual source なら `Organization ID:` プロンプトに入力してください。
     ```
  4. 既存 `getTokenByOrganizationId()` で重複検査 → 既存ならエラー終了（「同 organization_id は既に @xxxx で登録済み。rotate を使ってください」）
  5. `validateAndNormalizeHandle` を呼び handle 確定（`--handle <name>` 引数 or 対話入力 `display name (例: personal, kddi-dev): `）
  6. `getTokenByHandle()` で重複検査 → 既存ならエラー終了
  7. `rateLimitTierToPlan` で plan / plan_ratio を決定し対話で確認（`--plan` で上書き可、unknown でも続行可）
  8. `tags` 入力（`--tags any,kddi` か対話、デフォルト `["any"]`）。**`auto` タグは `add` 経路では入力させない**（auto-discover 専用、A019 §タグ設計）。`auto` を含む入力は警告 + 除去。
  9. `hashAuthorization` で `auth_hash`（full 64 hex）算出
  10. **補償トランザクション登録**:
      ```ts
      const insertedId = db.transaction(() => insertToken(db, {handle, organization_id, auth_hash, plan, plan_ratio, tags, selectable: 1, credential_source}))();
      try {
        storeTokenInKeychain(handle, accessToken);
      } catch (e) {
        deleteToken(db, insertedId);
        throw new Error(`Keychain store failed; DB rolled back. Re-run \`cmux-team token add\`. cause=${e}`);
      }
      ```
  11. 完了表示: `Registered: @pers  max-x20  tags:[any]  auth_hash:abcdef123456...  ✓`（hash は先頭 12 文字のみ）
- **テスト**: `KEYCHAIN_TEST_MODE=1` + tmp DB + `ask` モック + tmp credentials.json で 6 経路を検証
  - credentials 成功（plan 自動 + tags=any）
  - credentials の organization_id 不在 → exit 1（正しいエラーメッセージ）
  - credentials の organization_id 重複 → exit 1
  - manual 成功
  - handle 重複 → exit 1
  - **Keychain 失敗 → DB 巻き戻し**: `KEYCHAIN_TEST_MODE` を「次の store で throw」モードに切り替え、`add` 後に `listTokens` が 0 件であることを assert（補償が効いている確認）

### 7. `cmdTokenList` を実装

- **動作**:
  1. `listTokens(db)` で全件取得
  2. 各 token について `getLatestUsageSnapshot(db, token.id)` を引く
  3. `computePoolCapacity` に **その token 1 つだけの配列**を渡して per_token[0].cap_pct を取得（A019 §pool_capacity「アカウント単体の pool_capacity 寄与」要件）
  4. `formatTokenListRow` で行を組み、`formatTokenListTable` でヘッダ + パディング整形
- **列**: `HANDLE / PLAN / TAGS / SELECTABLE / CAP / UTIL_5H / UTIL_7D / NEXT_RESET`
- **表示形式**: cap_pct / util_5h / util_7d は **整数表示**（A019 §TUI、conductor-prompt.md 整合）。`NEXT_RESET` は `7d @ Apr 27 09:00` 形式。
- **テスト**: tmp DB に 3 件（max-x20 健全、max-x5 利用率高め、unknown plan で snapshot なし）を仕込み、出力に各値が含まれることを検証。snapshot 不在の行に `-` が出ること、tags が `,` 区切りで連結されることも assert。

### 8. `cmdTokenRemove` を実装

- **引数**: `args[2]` = handle（`@pers` 形式必須）
- **動作**:
  1. `getTokenByHandle(db, handle)` → 不存在ならエラー終了
  2. `ask("Remove @pers (and its Keychain entry)? [y/N]: ")` で確認（`--yes` で非対話スキップ）
  3. **削除順序**: `db.transaction(() => deleteToken(db, token.id))` を先に COMMIT → 次に `deleteTokenFromKeychain(handle)`（Keychain は冪等削除）。Keychain 失敗は warn のみ（DB から消えていれば spawn 経路では使われない）
- **テスト**: `--yes` 経由で 1 件削除 → DB 0 件、in-memory Keychain も空。Keychain 削除失敗時は DB 削除済みのまま warn ログを出すこと。

### 9. `cmdTokenRotate` を実装

- **引数**: `args[2]` = handle
- **動作**:
  1. `getTokenByHandle()` で既存取得（不存在ならエラー）
  2. `resolveTokenInput()` で新 credential を取得（source 選択は `add` と同じ対話）
  3. **organization_id 不変チェック**: 既存 `token.organization_id` と新 credential の `organizationId` が異なればエラー終了（「rotate ではなく add すべき」のヒント表示）。新 credential の organizationId が空の場合も同等扱いで保守的にエラー終了。
  4. `hashAuthorization` で新 auth_hash 算出
  5. **補償トランザクション更新**:
     ```ts
     const oldHash = token.auth_hash;
     updateTokenAuth(db, token.id, newHash);   // DB 先 COMMIT
     try {
       storeTokenInKeychain(handle, newAccessToken); // Keychain は -U upsert
     } catch (e) {
       updateTokenAuth(db, token.id, oldHash);  // 補償: 旧 hash に戻す
       throw new Error(`Keychain store failed; DB rolled back to old auth_hash. Re-run \`cmux-team token rotate\`. cause=${e}`);
     }
     ```
  6. handle / tags / plan / organization_id は維持
- **テスト**:
  - 同 organization_id での rotate 成功 → Keychain 値と DB auth_hash が更新されていること
  - 異なる organization_id でのエラー終了
  - **Keychain 失敗 → 旧 auth_hash 復元**: `KEYCHAIN_TEST_MODE` で throw させ、rotate 後に `getTokenByHandle().auth_hash === oldHash` を assert

### 10. `cmdTokenSetPlan` を実装

- **引数**: `args[2]` = handle、`args[3]` = `pro` / `max-x5` / `max-x20`
- **動作**:
  1. plan 引数バリデーション（3 値以外はエラー）
  2. `getTokenByHandle()` → 不存在ならエラー
  3. plan → plan_ratio マップ: `{ pro: 1.0, "max-x5": 5.0, "max-x20": 20.0 }`
  4. `updateTokenPlan(db, token.id, plan, ratio)`
- **スコープ**:
  - `selectable=false` の token（auto-discover 由来 / 手動無効化）に対しても **plan / plan_ratio の更新のみ実施する**。selectable=true への昇格は本タスクのスコープ外（後続で `cmux-team token enable @auto` 等を別途検討）。
  - tags / handle / organization_id / auth_hash は不変。
- **テスト**:
  - unknown plan の token を `set-plan @pers max-x20` → `plan / plan_ratio` 更新確認
  - **`selectable=0` の auto token を `set-plan @auto max-x20`** → plan / plan_ratio のみ更新、`selectable` は 0 のまま（不変）を assert
  - 不正な plan 名でエラー終了確認

### 11. `cmdToken` ディスパッチャを実装

- **対象**: `token-cli.ts` の `export async function cmdToken(args: string[]): Promise<void>`
- **動作**: `args[1]` で `add / list / remove / rotate / set-plan` を分岐。未指定 / `--help` で `showHelp` 相当のヘルプを表示
- **テスト**: 不正サブコマンドで `process.exit(1)` するモックテスト

### 12. `main.ts` への配線

- **対象**: `skills/cmux-team/manager/main.ts`
- **変更**:
  - import 追加: `import { cmdToken } from "./token-cli";`
  - switch（line 4964-5057 付近）に `case "token": await cmdToken(args); break;` を追加
- **完了条件**: `bun run skills/cmux-team/manager/main.ts token --help` でヘルプ表示

### 13. 動作確認（実 DB / 実 Keychain は対象外、grep + dry-run のみ）

- **対象**: 既存 `token-store.test.ts` + 新 `token-cli.test.ts`
- **検証コマンド**:
  - `bun test skills/cmux-team/manager/token-cli.test.ts skills/cmux-team/manager/token-store.test.ts` → 全緑
  - `grep -n "case \"token\":" skills/cmux-team/manager/main.ts` → 1 件ヒット
  - `bunx tsc --noEmit 2>&1 | grep -E "(token-cli|token-store|main)\.ts" || echo "no new errors"` → 新規エラーなし
- **手動検証（Conductor が macOS 上で実機確認するときのみ）**:
  - `cmux-team token add` で credential 自動取得 → DB に 1 件、Keychain に 1 件登録
  - `cmux-team token list` で pool_capacity が表示
  - `cmux-team token remove @pers` で DB + Keychain 両方から削除
  - `cmux-team token rotate @pers` で auth_hash 更新

## 5. リスク

| リスク | 影響 | 対策 |
|--------|------|------|
| **macOS 以外で Keychain が使えない** | Linux/CI で `cmdTokenAdd` が `KeychainUnsupportedError` で落ちる | テストは `KEYCHAIN_TEST_MODE=1` で in-memory フォールバック使用。CLI 実行時は `isKeychainSupported()` を頭でチェックし、未対応なら明示エラー（exit 1）+ macOS が必要な旨を表示 |
| **`~/.claude/.credentials.json` が存在しない / フィールド欠損** | `add` の credential source 経路が落ちる | `parseCredentialFile` で path 不在 → `Error("credentials not found at ...")` を投げ CLI 側で catch → 「manual source を試してください」と促す。`organizationId` は **必須**（subtask 6.3 で exit 1）。`rateLimitTier` / `subscriptionType` は欠損許容（plan=unknown で続行） |
| **対話入力のテストが書きにくい** | テストカバレッジ低下 | `ask: (q) => Promise<string>` を全関数の引数に取り、テストではモック関数を渡す（`envrc-prompt.ts` と同形） |
| **shell history / ps 露出**（A020 §運用上の注意） | token が漏れる | `add` / `rotate` で **token は argv から受けない**。stdin 対話のみ（`--source credentials` でファイル経由は OK）。テストもこの境界を超えない |
| **DB 書き込み中に Keychain が失敗 → 不整合**（補償トランザクション採用の根拠） | 「DB に row があるが Keychain 値が無い / Keychain は新値だが DB は旧 hash」状態が一時的にでも生じうる | **補償トランザクション方式を採用**。SQL transaction 内で `spawnSync` を呼ばない（spawnSync が WAL を長時間ロックするリスク + Keychain `-U` upsert は副作用即確定で SQL rollback 無意味のため）。`add` は「DB INSERT COMMIT → Keychain store → 失敗時 deleteToken で巻き戻し」、`rotate` は「DB updateTokenAuth → Keychain store → 失敗時 旧 hash で再 updateTokenAuth」で最終整合を保つ。冪等性は `deleteToken`（subtask 1）と Keychain `-U` で担保 |
| **handle 重複検査と insert の TOCTOU** | 同時 2 プロセスで同じ handle を登録すると UNIQUE 違反 | `tokens.handle UNIQUE` 制約で DB 側が弾く。CLI は UNIQUE 違反例外を「handle 重複」エラーメッセージにマップして表示 |
| **rotate 時に新 credential の organization_id が不在** | 不変チェックが空振り | 既存 `token.organization_id` が非空で新 credential の `organizationId` が null の場合は「organization_id 不一致」と同等扱いでエラー終了（保守的） |
| **`auto` タグの誤入力** | A019 が auto-discover 専用と規定する `auto` タグを手動 `add` で付けると、auto-discover 側のロジックと衝突 | `cmdTokenAdd` で tags 入力に `auto` が含まれていたら警告 + 除去（A019 §タグ設計に準拠） |

## 6. 既存型エラーの先読み

```bash
bunx tsc --noEmit 2>&1 | grep -E "^skills/cmux-team/manager/(main|token-store|token-cli)\.ts" || true
```

→ 出力なし（既存エラー 0 件、新規追加ファイル `token-cli.ts` も未作成）。

#### 6.1 本タスクのスコープで解消するエラー
| ファイル | エラー | 方針 |
|---------|-------|------|
| 該当なし | — | — |

#### 6.2 後続タスク（cleanup）に分離するエラー
| ファイル | エラー | 分離理由 | 予定 cleanup タスク名 |
|---------|-------|---------|---------------------|
| 該当なし | — | — | — |

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | 規範文書（A019 / A020）との整合 | **A019 を main repo absolute path（`/Users/yamamoto/git/cmux-team/.team/artifacts/A019-token-pool-design.md`）から読み込み済み。本 plan は A019 §アカウント表記規約 / §タグ設計 / §`token add` UX / §pool_capacity / §TUI 表示 と A020 §schema 設計（後続実装提言）に準拠する** | **Rev 2 で改訂**: 当初 plan は A019 を不在と誤判定していた（worktree から `.team/` が gitignore で見えないため）。Reviewer 指摘を受け main repo absolute path 経由で実読し、handle UX（`personal` / `kddi-dev` 例）/ tag 4 値（`any` / `oss-only` / `org:<code>` / `auto`）/ TUI 整数表記 / `auto` token の `set-plan` 取扱を全て plan に反映 |
| D2 | CLI 実体の置き場所（main.ts 直書き vs 別ファイル） | `skills/cmux-team/manager/token-cli.ts` に分離 | サブコマンド 5 つ × 対話入力 + Keychain で 500 行超になる見込み。テスト分離の容易さと、既存 `agent-instructions.ts` / `direnv-check.ts` の分離粒度との整合性 |
| D3 | 対話入力ライブラリ | Node.js `readline/promises` を使う | 既存 `envrc-prompt.ts` と同じ。外部依存追加なし。`ask` 関数を引数化してテスト容易性を確保 |
| D4 | `add` / `rotate` の入力経路統合 | `resolveTokenInput()` 1 関数に集約 | source=credentials/manual の分岐ロジックが add と rotate で重複するため、最初から関数分離（CLAUDE.md「構造的に重複するコードは最初から関数分離」） |
| D5 | `auth_hash` 列のフォーマット | `sha256("Bearer " + token)` の **full 64 文字 hex** を DB に保存。表示/index は先頭 12 文字 | A020 §schema 設計（後続実装提言節 line 55, 111）が「テーブル上は full hash（64 文字）を保存し、表示/索引は prefix 12 文字で行うのが安全（衝突余地）」と明記。A019 §セキュリティ「`auth_hash`（12 文字 prefix）」は表示時の表現を指していると解釈し、実装は A020 後段に揃える。**T320（proxy lookup）/ T321（spawn-agent）も同じ前提で full 64 hex を比較する** |
| D6 | Keychain 不在環境（Linux 等）での挙動 | `add` / `rotate` 実行時に `isKeychainSupported()` 確認 → 未対応なら exit 1 + 明示メッセージ | T319 は macOS 前提。silent fallback は危険（DB に row があるが token 値が取れない状態を生む） |
| D7 | DB と Keychain の原子性保証 | **補償トランザクション方式**（SQL transaction 内で `spawnSync` を呼ばない）| **Rev 2 で改訂**: 当初は「SQL transaction 内で Keychain spawnSync」を採用していたが、(a) Keychain `-U` の副作用は即時確定で SQL rollback では戻らない（COMMIT 直前の SQLITE_BUSY で Keychain orphan を生む）、(b) spawnSync が数百ms〜数十秒かかり WAL write lock を保持する間 proxy の `usage_snapshots` UPSERT を待たせる、の 2 点で破棄。代わりに「DB COMMIT → Keychain → 失敗時 DB を補償（add は deleteToken / rotate は旧 hash で updateTokenAuth）」の補償トランザクションを採用。Keychain `-U` upsert と `deleteToken` の冪等性で最終整合を保証 |
| D8 | `remove` の usage_snapshots / leases 削除方式 | `deleteToken()` 関数内でトランザクション + 明示 DELETE | 既存 schema は `ON DELETE CASCADE` 未設定。`PRAGMA foreign_keys=ON` だけでは CASCADE は働かないため明示削除が必要 |
| D9 | 非対話モードのフラグ提供 | `--source credentials/manual`、`--handle <name>`、`--tags <csv>`、`--plan <plan>`、`--yes`（remove 確認スキップ） を提供 | テスト容易性 + パイプ対応。**ただし `--token <value>` は提供しない**（A019 §セキュリティ / A020 §運用注意：argv 露出回避） |
| D10 | `set-plan` の plan_ratio マップを CLI 側に持つか共通化するか | CLI 側（`token-cli.ts`）に持つ | rateLimitTier 経由のマップは `rateLimitTierToPlan`（4 値→ratio）、CLI 直接指定は plan→ratio（3 値）。性質が違う（前者は Anthropic 用語、後者は内部用語）ので共通化しない |
| D11 | `list` の cap_pct 表示の単位 | per_token[0].cap_pct を **整数 + `%`** で表記（`Math.round`）| **Rev 2 で改訂**: A019 §TUI 表示（`cap: 100%` 整数）と conductor-prompt.md（`100%` / `40%`）に揃える。当初 plan の `73.4%`（小数 1 桁）を撤回 |
| D12 | `formatNextReset` の表示形式 | `5h @ HH:MM` または `7d @ MMM DD HH:MM`（例: `7d @ Apr 27 09:00`） | **Rev 2 で改訂**: conductor-prompt.md の例（`5h @ 14:30` / `7d @ Apr 27`）に揃える。テストは TZ を `Asia/Tokyo` 固定、月名は `["Jan",...,"Dec"][m]` で組んで locale 非依存に |
| D13 | `tags` 入力に `auto` を許すか | `add` 経路では **不許可**（警告 + 除去） | A019 §タグ設計「`auto` # auto-discover 登録（selectable: false）」より、`auto` は proxy 自動登録の予約タグ。手動 `add` で付与すると auto-discover 側のロジックと衝突する |
| D14 | `set-plan` のスコープ | **plan / plan_ratio のみ更新。`selectable` の昇格は本タスクのスコープ外** | A019 は auto-discover 登録 token を `selectable: false` で登録すると規定する一方、その昇格コマンドは A019 にも明示なし。本タスクは「unknown plan を補完する」用途に限定し、selectable 制御は別 issue で扱う（後続候補: `cmux-team token enable @auto`） |
| D15 | `token-store.ts` への 3 関数追加が T318 の責務だったか | T318 は CLI が必要とする CRUD のうち add 系（`insertToken` / `getTokenByHandle` / `getTokenByOrganizationId` / `listTokens` / `getLatestUsageSnapshot`）に限定。delete / update 系（`deleteToken` / `updateTokenAuth` / `updateTokenPlan`）は CLI 実装時にスコープが固まるため T319 で追加（YAGNI） | T320 / T321 でも同種の追加が発生しうるため、責務分担の判断軸として「使う側のタスクが追加する」を Decision Log に明文化 |
