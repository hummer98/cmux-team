# T319 Inspection Report

## 判定

**GO**

## サマリー

T319「cmux-team token CLI 実装」は plan.md (Rev 2) と A019 / A020 の規範に厳密に準拠して実装されている。
5 サブコマンド (add/list/remove/rotate/set-plan) は全て要件通り動作し、補償トランザクション方式の整合戦略も add / rotate
両経路で正しく実装されている (DB COMMIT 後に Keychain spawn → 失敗時に deleteToken / 旧 hash 復元 → 補償失敗もログ化)。
組み込まれた pure function (handle sanitize / rateLimitTier 変換 / hashAuthorization / formatNextReset / list 整形)
は副作用ゼロで、テストも 122 pass / 1 skip / 0 fail。リグレッション全体 1360 pass / 0 fail。tsc 新規エラー 0。
セキュリティ面でも `--token` argv 受け口は無く、token を `console.log` する経路も存在しない。
Critical findings は無く、Minor 指摘 1 件 (未使用 import) のみ。

## 検証結果

### 1. テスト実行

| 項目 | 結果 |
|------|------|
| `bun test token-cli.test.ts token-store.test.ts` | **122 pass / 1 skip / 0 fail / 253 expect** |
| `bun test --timeout 600000` (リグレッション) | **1360 pass / 1 skip / 0 fail / 3273 expect (44 files)** |
| `bunx tsc --noEmit` (manager tsconfig) | **TSC_EXIT=0** (新規エラー 0 件) |
| `bun run main.ts token --help` | **OK** (Subcommands + Options 一覧表示) |

### 2. 設計制約

| 項目 | 結果 | 該当箇所 |
|------|------|---------|
| 補償トランザクション (add) | ✅ | `token-cli.ts:509-545` `txInsert()` COMMIT → `maybeStoreTokenInKeychain` → 失敗時 `deleteToken(db, inserted.id)` |
| 補償トランザクション (rotate) | ✅ | `token-cli.ts:741-769` `updateTokenAuth(newHash)` 先 COMMIT → `maybeStoreTokenInKeychain` → 失敗時 `updateTokenAuth(oldHash)` 復元 |
| SQL transaction 内 `spawnSync` 不在 | ✅ | `db.transaction` callback は `token-cli.ts:509-520` の `insertToken` のみ。spawnSync は `token-store.ts` の Keychain ヘルパに完全分離 |
| 巻き戻し失敗時のログ | ✅ | `token-cli.ts:530-534` `token_add_compensation_failed`、`754-757` `token_rotate_compensation_failed` |
| `hashAuthorization` full 64 hex | ✅ | `token-cli.ts:186-188` `sha256("Bearer " + token).digest("hex")`。表示時のみ `slice(0, 12)` (552, 773, 776 行) |
| `auth_hash` DB 保存 = full hex | ✅ | テストで `auth_hash` が `^[a-f0-9]{64}$` を assert (`token-cli.test.ts:579, 930`) |
| handle sanitize | ✅ | `token-cli.ts:105-125` `[a-z0-9]` 以外を除去 → 先頭 4 文字、`@` 始まりは `^@[a-z0-9]+$` + 5 文字以上要求 |
| organization_id 必須 | ✅ | `token-cli.ts:430-436` credential / 対話入力で空なら exit 1 (`Error: organization_id is required.`) |
| `auto` タグ除去 | ✅ | `token-cli.ts:477-483` warning + `filter(t !== "auto")`、空になったら `["any"]` を再付与 |
| `set-plan` 不変 | ✅ | `token-store.ts:368-379` `UPDATE SET plan=?, plan_ratio=? WHERE id=?` のみ。selectable / handle / org_id / tags / auth_hash は更新しない |

### 3. 機能要件 (タスク本文 5 サブコマンド)

| サブコマンド | 結果 | 該当箇所 |
|------|------|---------|
| `add` で credential 自動取得 → DB + Keychain 登録 | ✅ | `cmdTokenAdd` line 399-557、テスト `add: credentials 経路成功` (line 551-582) |
| `list` で pool_capacity 表示 | ✅ | `cmdTokenList` line 578-612。`computePoolCapacity([{handle, plan_ratio, util_5h, util_7d, ...}])` を per_token 1 件で呼んで `per_token[0].cap_pct` を取得 |
| `remove @pers` で DB + Keychain 両方削除 | ✅ | `cmdTokenRemove` line 618-667。`deleteToken` (DB transaction) → `deleteTokenFromKeychain` (best-effort) |
| `rotate @pers` で auth_hash 更新 | ✅ | `cmdTokenRotate` line 673-781。テスト `rotate: 同 organization_id で auth_hash と Keychain が更新される` (line 895-933) |
| `set-plan @pers max-x20` で unknown 補完 | ✅ | `cmdTokenSetPlan` line 787-817。テスト `set-plan: unknown plan を max-x20 に更新` (line 1021-1042) |

### 4. セキュリティ・運用

| 項目 | 結果 | 該当箇所 / 検証コマンド |
|------|------|---------|
| `--token <value>` argv 受け口の不在 | ✅ | `grep -nE "(--token\|argv.*token\|getArg.*token)"` → 0 hit |
| token を `console.log` で出力していない | ✅ | `grep -nE "console\.(log\|error).*\b(accessToken\|token_string)\b"` → 0 hit |
| Keychain 失敗時のメッセージに stderr 含有 | ✅ | `token-cli.ts:536-540, 759-763` で `e instanceof KeychainCommandError ? ${e.message} stderr=${e.stderr} : ...` を組み立てて log + fail メッセージ両方に含めている |
| Keychain stderr の token マスク | ✅ | `token-store.ts:527-530` `maskToken()` で stderr/stdout 内の token 文字列を `***` に置換してから throw |
| ログに auth_hash 全体ではなく prefix 12 文字のみ | ✅ | `token-cli.ts:773` `old_prefix=${oldHash.slice(0, 12)} new_prefix=${newHash.slice(0, 12)}` |

### 5. テストカバレッジ

| 項目 | 結果 | 該当テスト |
|------|------|---------|
| 補償経路 (add) Keychain 失敗 → DB 巻き戻し | ✅ | `add: Keychain 失敗 → DB 巻き戻し (補償トランザクション)` line 757-788 で `__setKeychainTestFailureMode(true)` → `listTokens(db).length === 0` を assert |
| 補償経路 (rotate) Keychain 失敗 → 旧 hash 復元 | ✅ | `rotate: Keychain 失敗 → 旧 auth_hash 復元` line 974-1018 で `auth_hash === oldHash` を assert |
| handle sanitize 境界 (`KDDI-dev` → `@kddi`, `ab` → エラー, `@too$$` → エラー) | ✅ | line 67, 79, 91 で全パターン |
| rateLimitTier 4 値 (max_20x / max_5x / pro / 未知) | ✅ | line 109-141 で 4 値全網羅 |
| organization_id 重複と handle 重複でメッセージが分かれている | ✅ | org_id 重複 (line 612-650) は `/rotate/i`、handle 重複 (line 652-697) は `/handle/i` を assert |
| `list` の cap_pct が per_token 計算で算出 (合算ではない) | ✅ | `cmdTokenList` (line 591-604) でその token 単独の配列を `computePoolCapacity` に渡し `per_token[0].cap_pct` を取る |

### 6. コード品質

| 項目 | 結果 |
|------|------|
| 既存パターン整合 (`envrc-prompt.ts` の readline / `cmdArtifacts` の switch dispatch) | ✅ `readline.createInterface` + `ask` 注入 (line 296-304)、switch dispatch (line 850-871) |
| 不要な抽象化やデッドコードの不在 | ⚠️ Minor 1 件 (`Database` import 未使用、下記参照) |
| ログイベント名規約 (`*_failed` / `*_completed`) | ✅ `token_add_completed` / `token_add_keychain_failed` / `token_add_compensation_failed` / `token_add_resolve_failed` / `token_remove_db_deleted` / `token_remove_keychain_failed` / `token_rotate_completed` / `token_rotate_keychain_failed` / `token_rotate_resolve_failed` / `token_rotate_compensation_failed` / `token_set_plan_completed` |
| 空の `catch {}` 不在 | ✅ token-cli.ts / token-store.ts ともに 0 hit。全 catch で throw / log / fail / warn のいずれかを実施 |

### 7. ヘルプ

`cmux-team token --help` (= `bun run main.ts token --help`) で以下を表示:

```
Usage: cmux-team token <subcommand> [options]

Subcommands:
  add        Register a new OAuth token in DB + macOS Keychain
  list       Show registered tokens with cap_pct / utilization
  remove     Remove a token from DB and Keychain
  rotate     Replace access token (organization_id 不変)
  set-plan   Update plan / plan_ratio (selectable は不変)

Options:
  --source credentials|manual    [add/rotate] input source (default: prompt)
  --credentials-path <path>      [add/rotate] override ~/.claude/.credentials.json
  --handle <name>                [add] display name (e.g. personal, kddi-dev)
  --tags <csv>                   [add] tags (default: any)
  --plan <pro|max-x5|max-x20>    [add] override plan estimated from rateLimitTier
  --yes                          [add/remove/rotate] non-interactive confirm
```

サブコマンド一覧 + 各サブコマンドが受け付ける主要引数を網羅している。

## Findings

### Critical (NOGO に直結)

なし。

### Major (GO だが Implementer / 後続タスクで対応推奨)

なし。

### Minor

1. **`token-cli.ts:19` の `import { Database } from "bun:sqlite";` が未使用**。
   このファイル内で `Database` 型を直接型注釈に使う箇所はなく (関数引数は `initTokenDB()` の戻り値を let で受けて推論)、`tsc --noEmit` ではエラーにならないが、不要 import として後続のクリーンアップで削除可能。Implementer / 後続タスクが触る際にあわせて消せばよく、本タスク単独で修正するほどの影響は無い。

2. **手動検証 (実機 macOS Keychain ラウンドトリップ) は未実施**。
   summary §1 で Implementer 自身が宣言している通り、`KEYCHAIN_TEST_MODE=1` の in-memory Map で全パスを網羅。これは plan §4 サブタスク 13 の方針に整合し、Inspector スコープ外 (本検品もテスト + grep + tsc + ヘルプ動作のみ)。次に macOS 実機で `cmux-team token add` を打つタイミングで検証する想定。

3. **Linux (non-darwin) 実行時の `Error: Keychain is only supported on macOS.` メッセージは静的検証のみ**。
   `ensureKeychainSupported` (line 376-385) のロジック自体は明確だが、CI で Linux 実行する場合の振る舞いはテスト網羅に入っていない。これも本タスクスコープ外で OK。

## Fix Required

該当なし (GO 判定)。
