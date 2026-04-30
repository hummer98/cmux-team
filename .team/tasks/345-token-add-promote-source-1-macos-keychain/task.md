---
id: 345
title: token add/promote の source=1 で macOS Keychain を優先する
priority: high
created_by: surface:56
created_at: 2026-04-26T11:32:14.289Z
---

## タスク
## 背景

macOS では Claude Code が credential を **macOS Keychain**（service: `Claude Code-credentials`, account: `$USER`）に保存・refresh している。`~/.claude/.credentials.json` は初回生成後ほぼ更新されない stale snapshot。

現状の `readClaudeCredentials`（`skills/cmux-team/manager/token-cli.ts:51`）は `.credentials.json` しか読まないため、macOS ユーザーが `cmux-team token add` source=1 を選んでも:
- 期限切れの token が読まれて probeOrganizationId が 401 → "organization_id を取得できませんでした" で失敗する
- `cmux-team token promote` でも同じ問題（line 488）

実機で `expiresAt` を確認した結果:
- credentials.json: 2026-04-06 09:23 JST 期限切れ（mtime 4月5日）
- Keychain: 2026-04-26 17:38 JST（fresh）

## 期待動作

`readClaudeCredentials` を以下の優先順位に変更:

1. **macOS の場合**: `security find-generic-password -s "Claude Code-credentials" -a <user> -w` で Keychain から JSON を取得し、`claudeAiOauth.accessToken` / `rateLimitTier` を返す
2. **失敗した / 非 macOS**: 既存どおり `~/.claude/.credentials.json` を読む
3. どちらも失敗 → 既存の error message（ただし `~/.claude/.credentials.json が見つからない` は誤解を招くので "Claude Code credential が見つかりません（Keychain / .credentials.json のどちらも読めません）" 等に調整）

Keychain JSON の shape は `.credentials.json` と同じ:

\`\`\`json
{ "claudeAiOauth": { "accessToken": "...", "refreshToken": "...", "expiresAt": 1234567890123, "scopes": [...], "subscriptionType": "..." } }
\`\`\`

`rateLimitTier` が Keychain JSON にも入っているかは要確認（あれば plan 自動判定が継続動作、なければ `unknown` フォールバック）。

## 影響箇所

`skills/cmux-team/manager/token-cli.ts` 内 3 箇所の caller:
- L114: `cmdTokenAdd`
- L347: `cmdTokenRotate`（推測。要確認）
- L488: `cmdTokenPromote`

メッセージ文言も「~/.claude/.credentials.json が見つからない」を Keychain 含む表現に更新。

## テスト

- `token-cli.test.ts` に Keychain mock テストを追加（`KEYCHAIN_TEST_MODE=1` 環境を流用するか、`security` 実行を関数注入で差し替える）
- 既存 `.credentials.json` フォールバックパスのテストは維持
- 非 macOS（process.platform !== "darwin"）では従来通り credentials.json のみ

## やらないこと

- proxy 側の auto-discover ロジックは触らない（既に env 経由で token を観測しているので影響なし）
- `~/.claude/.credentials.json` の rotate/書き込みはしない（読み取り専用）
