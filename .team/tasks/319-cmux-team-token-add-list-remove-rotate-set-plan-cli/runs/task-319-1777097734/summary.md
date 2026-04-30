# T319 Implementation Summary

## 実装範囲

### 新規ファイル
- `skills/cmux-team/manager/token-cli.ts` — `cmdToken` ディスパッチャ + 5 サブコマンド (add/list/remove/rotate/set-plan) + pure function 群 (validateAndNormalizeHandle / rateLimitTierToPlan / parseCredentialFile / hashAuthorization / formatNextReset / formatTokenListRow / formatTokenListTable) + resolveTokenInput
- `skills/cmux-team/manager/token-cli.test.ts` — 上記の単体 + 統合テスト 56 ケース

### 既存ファイル変更
- `skills/cmux-team/manager/token-store.ts` — `deleteToken` / `updateTokenAuth` / `updateTokenPlan` を追加 (合計 ~50 行)
- `skills/cmux-team/manager/token-store.test.ts` — 追加 API のテスト 11 ケース追加
- `skills/cmux-team/manager/main.ts` — import 1 行 + switch case 3 行 (配線のみ)

### 追加した token-store API
- `deleteToken(db, token_id)` — leases / usage_snapshots / tokens を transaction で明示削除 (冪等)
- `updateTokenAuth(db, token_id, new_auth_hash)` — auth_hash 列のみ更新 (rotate の補償用)
- `updateTokenPlan(db, token_id, plan, plan_ratio)` — plan / plan_ratio のみ更新 (selectable / tags / handle / org_id は不変)

### 追加した CLI サブコマンド
- `cmux-team token add` — credentials.json 自動取得 / manual 貼付け、handle/tags/plan 補完、補償トランザクション登録
- `cmux-team token list` — 8 列表示 (HANDLE/PLAN/TAGS/SELECTABLE/CAP/UTIL_5H/UTIL_7D/NEXT_RESET) cap_pct は per-token computePoolCapacity で算出
- `cmux-team token remove @handle [--yes]` — DB + Keychain から削除 (Keychain 失敗は warn のみ)
- `cmux-team token rotate @handle` — organization_id 不変チェック後に補償トランザクション更新
- `cmux-team token set-plan @handle pro|max-x5|max-x20` — plan / plan_ratio のみ更新

## 設計判断 (plan.md からの追加判断)

1. **stdout 表示を console.log 経由に統一**
   - plan は明記していなかったが、`cmdTokenList` の出力をテストで `console.log` キャプチャするため、当初の `process.stdout.write` から `console.log(...)` に変更。末尾改行は `formatTokenListTable` 側で付与した分を `replace(/\n+$/, "")` で剥がしてから渡す。動作・出力結果は同一。

2. **テスト用フック `__setKeychainTestFailureMode` を `token-cli.ts` に置く**
   - plan の "Design Reviewer Minor" 提案では token-store.ts 側の test-only export として記載されていた。実際には Keychain 失敗パスが必要なのは CLI 側（補償トランザクションの分岐テスト）のみであり、token-store の責務（純粋な Keychain ラッパ）に test 用の差し込みを混ぜると `storeTokenInKeychain` の意味論が変わってしまうため、token-cli.ts 側で `maybeStoreTokenInKeychain` ラッパ + フラグを定義した。failure mode は call-site でのみ有効で、`storeTokenInKeychain` 自体は変更していない。

3. **resolveTokenInput の subscription input**
   - plan は `subscriptionType` を rate-limit-tier プロンプトの後で取る記述が無かった（"Rate limit tier" のみ列挙）。実装では subscription も対話で訊くプロンプトを追加。空文字なら null 化。テストでも 4 値を渡す形に整合させた。これは plan からの逸脱というより不足を補完したもの。

4. **`cmux-team token list` 0 件表示**
   - plan に明記がなかったので "No tokens registered. Run `cmux-team token add` to register one." を出力。テストもこの文言を期待している。

5. **process.exit のテスト化**
   - plan には記載がないが、`fail()` ヘルパが `process.exit(code)` を呼んだ後で `throw new Error("__unreachable_after_exit_${code}")` を投げる構造にし、テストで `process.exit` を spy する場合（実際に exit せず例外を投げるモック）でも以後の `never` 経路が型/実行両面で安全に動くようにした。

## テスト結果

- `bun test skills/cmux-team/manager/token-cli.test.ts skills/cmux-team/manager/token-store.test.ts` → **122 pass / 1 skip / 0 fail / 253 expect**
  - token-cli.test.ts: 56 pass / 0 fail / 126 expect
  - token-store.test.ts: 66 pass / 1 skip / 0 fail / 127 expect (追加 11 ケース含む)
- `bun test --timeout 600000` (リグレッション全体) → **1360 pass / 1 skip / 0 fail / 3273 expect / 44 files**
- `bunx tsc --noEmit` (`skills/cmux-team/manager/tsconfig.json`) → **0 件** (新規エラー無し / 既存エラー無し)
- `bun run skills/cmux-team/manager/main.ts token --help` → ヘルプ出力 OK
- 不変条件 grep:
  - `taskState[...] =` / `saveTaskState(` / `bus.(emit|on)` 直接呼び出し → いずれも 0 hits を維持
  - `case "token":` → main.ts 5059 行に 1 件配線済み

## 残課題・懸念

1. **macOS 実機 Keychain での確認は実施していない** — テストは `KEYCHAIN_TEST_MODE=1` の in-memory Map で全パスを検証している。`add`/`rotate`/`remove` の実機ラウンドトリップは Inspector 段階で `cmux-team token add` を実行して確認する想定 (plan §4 サブタスク 13 の手動検証項目)。
2. **対話入力の readline テストカバレッジは無い** — `ask` を関数注入で差し替える構造のため、デフォルトの `readlineAsk` 自体は手動操作でのみ動作確認になる (plan の方針に整合)。
3. **non-darwin 環境 (Linux) でのエラーメッセージは静的検証のみ** — `ensureKeychainSupported` が exit 1 + 明示メッセージを出すパスは、テストでは `KEYCHAIN_TEST_MODE=1` 経由で skip されるため挙動の手動確認はしていない。CI 等で Linux で動かす場合の最初のメッセージとして期待動作。
4. **set-plan の selectable 昇格は意図的にスコープ外** (plan §10 / D14)。auto-discover で登録された `selectable=false` の token を手動で selectable=true へ上げる導線は本タスクに含まない。

## 確認手順 (Inspector 向け)

### 自動検証

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-319-1777097734

# 1. token 関連テスト全緑
bun test skills/cmux-team/manager/token-cli.test.ts skills/cmux-team/manager/token-store.test.ts

# 2. リグレッション全緑
bun test --timeout 600000

# 3. tsc 新規エラー 0 件 (manager の tsconfig)
( cd skills/cmux-team/manager && bunx tsc --noEmit )

# 4. ヘルプ動作
bun run skills/cmux-team/manager/main.ts token --help
```

### macOS 実機での手動検証 (必要に応じて)

```bash
# add → list → rotate → remove のラウンドトリップ
cmux-team token add --source credentials --handle personal --yes
cmux-team token list                          # cap_pct 100% 表示を確認
cmux-team token rotate @pers --source credentials --yes
cmux-team token remove @pers --yes

# Keychain にも反映されていることを直接確認
security find-generic-password -s cmux-team-token -a @pers -w
```

### 重点レビュー箇所

1. **補償トランザクション** (`token-cli.ts` 内 `cmdTokenAdd` / `cmdTokenRotate`):
   - `db.transaction(() => insertToken(...))` の COMMIT 後に Keychain spawn が起きていること
   - Keychain 失敗時に `deleteToken` / `updateTokenAuth(oldHash)` で巻き戻されていること
   - 巻き戻し自体が失敗してもログを残して exit すること
2. **organization_id 必須化** (`cmdTokenAdd` の `if (!resolved.organizationId)`):
   - credential / manual いずれも空なら `Error: organization_id is required.` で exit 1 になっていること
3. **handle sanitize** (`validateAndNormalizeHandle`):
   - `@` 始まりは `@[a-z0-9]+` で長さ 5 文字以上を要求 / それ以外は小文字化 + 非英数除去 + 先頭 4 文字
4. **auto タグ除去** (`cmdTokenAdd` 内): `--tags any,auto,kddi` で `auto` が消えて `["any","kddi"]` になり、警告が出ること
5. **auth_hash full 64 hex** (`hashAuthorization` + `insertToken` / `updateTokenAuth`): DB に保存されているのが 64 文字 hex で、表示時のみ先頭 12 文字に切られていること (`Registered: ... auth_hash:abcdef123456...`)
6. **set-plan の selectable 不変**: `selectable=false` の token を `set-plan` しても `selectable` が 0 のままであること (test `selectable / handle / organization_id / tags は不変` で検証済み)
