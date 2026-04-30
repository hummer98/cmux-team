# タスク割り当て

## タスク内容

---
id: 391
title: refactor(token-pool): claude-credentials を廃止し subscription source に置換 (Dear T340 401 起因)
priority: high
created_at: 2026-04-30T07:22:32.055Z
---

## タスク
# 背景

Dear リポジトリの T340 で agent A[467] が起動直後に 401 authentication_error で crash した（2026-04-30 15:37 JST）。原因は `credential_source=claude-credentials` で snapshot した OAuth token が stale 化していたこと。

trace 詳細:

- A[467] handle=@tayo (token_id=4, source=claude-credentials)
- api_usage に `401 authentication_error × 6` (Dear `.team/traces/traces.db`、2026-04-30T06:37:29.946Z〜32.233Z UTC)
- 画面に `Please run /login · API Error: 401` 表示で idle stuck → `agent_done trigger=session_ended status=crashed` (15:54:01)
- worktree 成果物なし（`M package-lock.json` のみ）

事前兆候: 2026-04-29 11:14 に `token_db_update_failed auth_hash=f8f6086f3a57 err=UNIQUE constraint failed: tokens.organization_id` が記録されていた。Claude Code が refresh して新 auth_hash を発行した痕跡だが、当時 pre-T384 で auto-rotate されなかった。

# 根本原因

`claude-credentials` source の設計が subscription の OAuth ライフサイクルと噛み合わない:

- subscription token は Claude Code 本体が `~/.claude/.credentials.json` で refresh 管理する
- cmux-team は `cmux-team token add --from-claude-credentials` 時点の access token を keychain に snapshot する設計だった
- Claude Code 側が refresh するたびに cmux-team の snapshot は stale 化する
- spawn-agent (`main.ts:2680` 周辺) が `CMUX_CLAUDE_TOKEN=<stale>` を export → claude 起動時に `CLAUDE_CODE_OAUTH_TOKEN` に inline rename → API が 401 を返す
- T384 auto-rotate は proxy が **新 auth_hash を観測したとき** のみ発動する。401 レスポンスでは `extractRateLimit()` が rate-limit ヘッダー不在で null を返し `recordRateLimit()` 早期 return → Phase 2 未到達 (`proxy.ts:120` の `if (!rl) return;`)。よって 401 経路では auto-rotate が救済できない

# 設計方針

`credential_source` を以下の 3 種に整理する:

| source | keychain 保存 | spawn-agent inject | 用途 |
|---|---|---|---|
| `manual` | あり | あり | API key（永続） |
| `subscription` | **なし** | **なし** | Claude Max。Claude Code 本体が認証管理 |
| `auto-discover` | あり | n/a | proxy 観測専用。selectable=0 |

`claude-credentials` リテラルは削除し、後方互換は取らない（CLAUDE.md feedback 「後方互換コードは不要」）。subscription token は **inject せず** Claude Code 本体の認証経路に委ねることで、refresh も Claude Code が自動で行う。proxy は引き続き `ANTHROPIC_BASE_URL` 経由でリクエストを観測し、auth_hash 更新は T384 auto-rotate が吸収する。

# 実装スコープ

## コード

1. `skills/cmux-team/manager/token-store.ts`
   - `CredentialSource = "manual" | "subscription" | "auto-discover"` に変更（`claude-credentials` リテラルを削除）
   - subscription source では `retrieveTokenFromKeychain` を呼ばない。誤って呼ばれた場合は `Error("subscription token must not be retrieved from keychain")` を throw する設計違反検出
   - `auth_hash` カラムを NULL 許容に変更（subscription は登録時点では auth_hash 未確定）。schema migration 追加
   - 起動時 migration: `UPDATE tokens SET credential_source = 'subscription', auth_hash = NULL WHERE credential_source = 'claude-credentials'`

2. `skills/cmux-team/manager/token-cli.ts`
   - `token add --subscription <handle>` を新設。引数: `--handle`、`--plan`、`--tags`、`--organization-id`（任意。指定なしなら proxy 初観測時に UPDATE で埋める）。keychain には触らない
   - `token add --from-claude-credentials` を削除
   - `token list` で `subscription` を区別表示（CRED 列に `oauth-native` 等）
   - `token migrate-subscription` を新設: `claude-credentials` 由来の row の keychain entry を `security delete-generic-password` で消す。冪等

3. `skills/cmux-team/manager/main.ts` (spawn-agent 経路、line 2660 周辺)
   - `selectToken` で subscription token が選ばれた場合、`retrieveTokenFromKeychain` を呼ばず `exportVars.push(CMUX_CLAUDE_TOKEN=...)` を skip する
   - `token_pool_subscription_no_inject` ログを残す
   - `AGENT_TOKEN_BOUND` post は subscription でも実施する（dashboard handle 表示のため）

4. `skills/cmux-team/manager/proxy.ts`
   - subscription row の `auth_hash IS NULL` 状態で proxy が初回 auth_hash を観測したら UPDATE する経路を追加（`recordRateLimit` の Phase 1〜4 と分けて整理）
   - 既存 T384 auto-rotate は subscription でもそのまま機能することを確認

## Test

5. 新規 unit test:
   - `token-cli.test.ts`: `token add --subscription` で keychain に書かれないこと、`token add --from-claude-credentials` が "removed" エラーで失敗すること、`token migrate-subscription` の冪等性
   - `token-store.test.ts`: migration `claude-credentials` → `subscription` の SQL 検証、subscription source で `retrieveTokenFromKeychain` 呼び出しが throw すること
   - `main.ts` の spawn-agent 経路（または抽出した内部関数）: subscription token 選択時に `exportVars` に `CMUX_CLAUDE_TOKEN` が含まれないこと、`AGENT_TOKEN_BOUND` は post されること

6. Existing test の更新:
   - `claude-credentials` 文字列を参照している既存 test を `subscription` に置換、または削除

7. **テスト実行は CLAUDE.md 記載の方法のみ:**
   ```
   cd skills/cmux-team/manager && for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test --timeout 30000 "$f"; done
   ```
   `bun test` 全体実行は禁忌（O(N²) 劣化、A021 参照）

## Docs

8. `docs/spec/09-token-pool.md`
   - `credential_source` セクション全面書き換え。3 種の表（上記）を本文に貼る
   - subscription の認証フロー（Claude Code 本体 → keychain → 自動 refresh、cmux-team は inject せず観測のみ）を明記
   - migration 注意事項（v4.20.0 で claude-credentials → subscription 自動変換、keychain entry は `token migrate-subscription` で削除）

9. `CLAUDE.md`（リポジトリルート）
   - 「token pool 運用方針」関連メモがあれば subscription は inject しない旨を追記。なければ追加不要

10. `README.md`
    - `token add --subscription` の例を追加
    - `token add --from-claude-credentials` の記述を削除
    - subscription と manual の使い分けセクションを 1 段落追加

11. `CHANGELOG.md`
    - v4.20.0 (BREAKING): claude-credentials credential_source 廃止、subscription source 新設、Dear T340 401 incident の対策

12. `docs/spec/glossary.md`
    - `credential_source` の項目に `subscription` を追加、`claude-credentials` を削除

## Release

13. `package.json` を v4.20.0 へ（minor。BREAKING 含むが pre-1.0 ではないので semver 厳密には major だが、cmux-team の慣例に従う。リリース PR で議論可）
14. CI (`.github/workflows/test.yml`) green を確認
15. `bun run release` 等のリリースフローに従って `npm publish`
16. tag push
17. リリースノートに「subscription source 導入。既存の `@tayo` 等は自動で subscription に migrate される。`cmux-team token migrate-subscription` で keychain entry を整理」と記載

# 受け入れ条件

- [ ] `cmux-team token add --subscription @newsub --plan max-x20` が成功し、keychain に entry が作られない（`security find-generic-password -s cmux-team -a @newsub` で 44 errSecItemNotFound）
- [ ] `cmux-team token add --from-claude-credentials @x` が "removed in v4.20.0. Use --subscription" エラーで非ゼロ exit
- [ ] daemon 起動時、既存 `claude-credentials` row が migration で `subscription` + `auth_hash=NULL` に変わる
- [ ] subscription token が pool 選択された agent で `CMUX_CLAUDE_TOKEN` が exportVars に含まれない（ログ `token_pool_subscription_no_inject` 出力）
- [ ] `cmux-team token migrate-subscription` 実行後、@tayo の keychain entry が削除されている
- [ ] proxy が subscription row の auth_hash NULL を初回観測時に UPDATE する
- [ ] T384 auto-rotate が subscription でも refresh 後の auth_hash を吸収する（手動検証 or mock test）
- [ ] `bun test` 上記方法で実行して全 PASS
- [ ] v4.20.0 が npm 公開済み（`npm view @hummer98/cmux-team version` が 4.20.0）

# 関連

- 起因 incident: Dear T340 (2026-04-30) — Dear リポジトリの `.team/logs/manager.log` の `[2026-04-30T15:37:19+09:00]` 周辺
- 関連実装: T384 (`feat(proxy): auth_hash mismatch 時の auto rotate を追加`、commit `da1dd0d`)
- 用語定義: `docs/spec/glossary.md` の `credential_source` 項目
- 関連 artifact: `.team/artifacts/A019-token-pool-design.md`
- 関連 feedback memory: 「token pool 運用方針（@kddi の使い分け）」

# 進め方ヒント

- まず `claude-credentials` の参照箇所を `grep -rn "claude-credentials" skills/ docs/ README.md CHANGELOG.md` で洗い出し、置換マップを作る
- token-store の schema migration は既存 DB の `auth_hash NOT NULL` 制約を緩めるため、SQLite では table re-create が必要（`token-store.ts` の既存 migration パターンに合わせる）
- `main.ts` の spawn-agent ロジックは長いので、subscription 分岐部分を関数として抽出してから test を書くと良い
- 受け入れ条件のうち「subscription token で 401 が再現しない」の手動検証は、@tayo を残した状態で実装後に Dear などで agent を spawn して確認できる


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-391-1777533767` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-391-1777533767
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-391-1777533767/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/391-refactor-token-pool-claude-credentials-subscription-source-dear-t340-401/runs/task-391-1777533767
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/391-refactor-token-pool-claude-credentials-subscription-source-dear-t340-401/runs/task-391-1777533767/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
