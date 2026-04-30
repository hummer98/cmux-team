# T391 — claude-credentials → subscription source 移行 サマリ

## 完了したサブタスク

- token-store.ts: `CredentialSource` を `manual / subscription / auto-discover` に再定義し、`claude-credentials` リテラルを廃止
- token-store.ts: `auth_hash` / `organization_id` を NULL 許容に変更し、旧 NOT NULL schema を起動時に table re-create する migration を追加
- token-store.ts: 起動時 data migration `claude-credentials` → `subscription` / `auth_hash=NULL`
- token-store.ts: `shouldInjectCredential` / `assertCanRetrieveFromKeychain` / `updateTokenOrganizationId` を export
- token-cli.ts: `cmux-team token add --subscription <handle>` を新設（keychain に書かず subscription source で登録、`--plan / --tags / --organization-id` をサポート）
- token-cli.ts: `cmux-team token add --from-claude-credentials` で exit 1 + "removed in v4.20.0. Use --subscription" メッセージ
- token-cli.ts: `cmux-team token migrate-subscription` を新設（subscription row の keychain entry 一括削除、冪等）
- token-cli.ts: `token list` の CRED 列で `manual / oauth-native / auto` を表示
- token-cli.ts: `cmdTokenAdd` の対話 UI を manual のみに簡略化（旧 `[1]` cred 自動読み込みは廃止、subscription は flag 経由）
- token-cli.ts: `cmdTokenPromote` の credential_source は `manual` に統一（`claude-credentials` リテラル削除）
- main.ts: spawn-agent の token pool 経路で `shouldInjectCredential` 判定を追加し、subscription なら `CMUX_CLAUDE_TOKEN` を inject せず `token_pool_subscription_no_inject` ログ
- main.ts: token サブコマンドルーティングに `migrate-subscription` を追加
- proxy.ts: `updateTokensDB` の Phase 構成を整理（Phase 1 / Phase 2 (auto-rotate or auth_hash 初観測) / Phase 2.5 (organization_id 初観測 — 新規) / Phase 3 / Phase 4）。Phase 1〜2.5 は `rl=null` でも動作
- 既存テスト更新: `claude-credentials` リテラル参照を `manual` または subscription 経路に置換、cmdTokenAdd の `[1]` を新仕様に合わせて answer 番号を調整、cred 自動読み込み前提のテスト T4/T6 と readClaudeCredentials priority T1〜T5 を skip
- 新規テスト追加: `cmdTokenAdd --subscription` 7 件、`--from-claude-credentials` exit 1 1 件、`cmdTokenMigrateSubscription` 2 件、`shouldInjectCredential` / `assertCanRetrieveFromKeychain` 各 1 件、subscription NULL 値の挿入・transition 4 件、claude-credentials → subscription migration 3 件
- docs/spec/09-token-pool.md: credential_source セクションを新設し subscription 認証フロー / v4.20.0 migration を明記、tokens schema を NULL 許容に更新
- docs/spec/glossary.md: credential_source / subscription の用語項目を追加
- README.md: `token add --subscription` の例追加、manual / subscription 使い分けセクション追加、`token migrate-subscription` を Token Pool 表に追加
- CHANGELOG.md: v4.20.0 (BREAKING) エントリを追加（廃止項目 / 新設コマンド / migration / 関連 incident）
- package.json / package-lock.json: v4.19.0 → v4.20.0

## 変更ファイル一覧

```
CHANGELOG.md
README.md
docs/spec/09-token-pool.md
docs/spec/glossary.md
package-lock.json
package.json
skills/cmux-team/manager/main.ts
skills/cmux-team/manager/proxy.ts
skills/cmux-team/manager/token-cli.test.ts
skills/cmux-team/manager/token-cli.ts
skills/cmux-team/manager/token-store.test.ts
skills/cmux-team/manager/token-store.ts
```

## テスト結果

- `bunx tsc --noEmit`: 0 errors
- `bun test --timeout 30000 <file>` を CLAUDE.md 推奨方法（individual file loop）で全 manager test を実行: **全ファイル 0 fail**
  - token-store.test.ts: 144 pass / 1 skip
  - token-cli.test.ts: 38 pass / 9 skip（T391 で意味を失った旧 cred 経路テストを skip）
  - proxy.test.ts: 57 pass

## 受け入れ条件チェック

- [x] `cmux-team token add --subscription @newsub --plan max-x20` が成功し、keychain に entry が作られない
- [x] `cmux-team token add --from-claude-credentials @x` が "removed in v4.20.0. Use --subscription" エラーで非ゼロ exit
- [x] daemon 起動時、既存 `claude-credentials` row が migration で `subscription` + `auth_hash=NULL` に変わる
- [x] subscription token が pool 選択された agent で `CMUX_CLAUDE_TOKEN` が exportVars に含まれない（ログ `token_pool_subscription_no_inject`）
- [x] `cmux-team token migrate-subscription` 実行後、subscription row の keychain entry が削除されている（冪等）
- [x] proxy が subscription row の `auth_hash IS NULL` / `organization_id IS NULL` を初回観測時に UPDATE する
- [x] T384 auto-rotate が subscription でも refresh 後の auth_hash を吸収する
- [x] `bun test` 上記方法で実行して全 PASS
- [ ] **v4.20.0 が npm 公開済み** — 本タスクでは package.json / lock を v4.20.0 に上げ、ローカルマージまで実行する。`bun run release` / `npm publish` は外部公開アクションのためユーザー判断で別途実行をお願いします（タスク本文の「Release」項目に従う場合は、マージ後に CI が green であることを確認してから `npm publish` を実行してください）

## 設計判断 / トレードオフ

- **後方互換は取らない**: CLAUDE.md feedback「後方互換コードは不要」に従い、`claude-credentials` リテラルを完全削除。旧 row は起動時 migration で `subscription` に置換されるため、ユーザー操作は不要。`--from-claude-credentials` flag は明示的なエラーで exit 1 にして利用者に新コマンドへ誘導
- **対話 UI の簡略化**: cmdTokenAdd の `[1] Claude Code credential` 自動読み込み経路は廃止し、manual 経路のみに簡略化。subscription は `--subscription` flag 経由のみで登録（非対話）。これにより `claude-credentials` source の意図しない再登録経路を構造的に閉じる
- **promote の credential_source は `manual` 固定**: cmdTokenPromote の `[1]` 経路（cred 読み込み）は残したが credential_source は `manual` に統一。subscription を新規登録したい場合は `--subscription` を使う設計とした
- **Phase 構成の再整理**: proxy.ts の `updateTokensDB` を Phase 1 / 2 / 2.5 / 3 / 4 に分割し、`rl=null` でも auth_hash / organization_id の同期だけは進む構造にした。401 等で rate-limit ヘッダ不在の応答が返っても subscription row の初期値埋めが進む
- **schema migration の guard**: `migrateClaudeCredentialsToSubscription` でカラム存在チェックを追加（既存の proxy T384-F1 テストが auth_hash カラムを drop した状態で initTokenDB を呼ぶため）

## 残課題 / 注意事項

- npm publish は本セッションでは実行していない（外部公開アクションのためユーザー判断）
- proxy.ts の Phase 2.5（subscription organization_id 初観測経路）の direct integration test は本タスクでは未追加。現状は token-store の `updateTokenOrganizationId` の unit test と既存 proxy test の組み合わせでカバーしているが、subscription 専用 proxy test を後続タスクで追加する余地あり
- 対話 UI で旧 `[1]` を選んでいたユーザーは、新仕様で `[1]` が manual 経路に変わった点に注意。Claude Code 本体の credential を借りたい場合は cmdTokenPromote の `[1]` 経路を使うか `--subscription` flag を使う

## マージ予定

- 納品方式: ローカル ff-only マージ
- 対象ブランチ: `main`
