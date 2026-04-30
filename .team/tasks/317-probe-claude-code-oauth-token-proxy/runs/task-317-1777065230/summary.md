# T317 完了サマリー

## タスク
T317 probe: CLAUDE_CODE_OAUTH_TOKEN 切り替えと proxy 識別の実機検証

## 実施フロー
- Phase 0（Research）: Researcher Agent（surface:1068）で実機 probe 実施
- Phase 4（Inspection）: Inspector Agent（surface:1070）で research.md を検品 → **GO**

## 主要な検証結果

- **subscription OAuth token は `Authorization: Bearer sk-ant-oat01-...` で送られる**。`anthropic-beta: oauth-2025-04-20` ヘッダーが無いと 401 `OAuth authentication is currently not supported`。
- **token 全体の sha256 12 文字 prefix で account 識別が可能**。実機で 2 トークンの hash 分岐（pod-d `c7fd09f013e3` vs kamiya `14e6f7a1b875`）を確認。
- **subscription 経由では TPM 系 rate-limit ヘッダーは返らない**。`anthropic-ratelimit-unified-5h|7d-utilization` のみが返り、既存 api_usage テーブルの `ratelimit_tokens_*` / `ratelimit_requests_*` 列は subscription 利用時は全て NULL（892 行中 0 行で埋まる）。
- **`anthropic-organization-id` レスポンスヘッダー（UUID）で account 単位の識別も可能**。hash と併用で refresh 後 token の同一 account 束ね直しに使える。
- **`cmdSpawnAgent` は CLAUDE_CODE_OAUTH_TOKEN を exportVars に含めない**（`main.ts:2434-2447`）。pane 継承 env で Master と Agent が同一 hash になる。env 注入は exportVars への追記で実装可能。
- **2 つ目の subscription 切り替えの完全検証は未完**。手元の kamiya OAuth token が `expiresAt=2026-04-05` で expired だったため、別 account の utilization が増える証拠までは取れていない。

## 成果物
- `research.md`（22KB、詳細な検証結果＋後続実装 4 方針の提言）
- `.team/artifacts/A019-token-pool-probe.md` として登録（commit 前に artifacts add）

## コード変更
- **無し**（proxy.ts に一時追加した capture ログは git diff ゼロで revert 完了を確認）

## 変更ファイル
- `.team/artifacts/A019-token-pool-probe.md`（新規）

## 納品方式
- ローカル ff-only マージ → main
