---
id: A025
title: API エラー時の Claude Code hook 発火パターン実機検証
type: research
author: surface:141
date: 2026-04-30
related_issues: []
related_tasks: [391]
tags: [hook, api-error, stopfailure, dashboard]
---

# A025: API エラー時の Claude Code hook 発火パターン実機検証

## 動機

cmux-team の TUI で Agent の API エラー（rate_limit / auth / billing / server）が可視化されていない問題（issue #45 とは別）を発端に、検出経路を調査。当初「proxy 経由でレスポンス status code を観測する」しか手段が無いと推定したが、ユーザー指摘で hook 経路の網羅性を再検証することに。

## 検証環境

`/tmp/api-error-probe/` に隔離した実験ディレクトリを作成。

- **dummy-proxy.ts**: Bun HTTP サーバ (port 18801)。`error-mode.txt` の値で `/v1/messages` の応答 status を切替。`/v1/models` は 200 で通す
- **settings.json**: `SessionStart` / `SessionEnd` / `Stop` / `StopFailure` / `Notification` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` の全 hook を `/tmp/api-error-probe/hooks.log` に append
- 起動: `cmux new-split right` で新 surface を作成 → 同じワークスペース内に隔離
- claude 起動: `CLAUDE_CODE_OAUTH_TOKEN=<fake>  ANTHROPIC_BASE_URL=http://localhost:18801 claude --settings ... --setting-sources user --debug api,hooks --debug-file ...`
- ANTHROPIC_API_KEY 経路ではなく **CLAUDE_CODE_OAUTH_TOKEN 経路**で起動（cmux-team の本番運用に揃えるため。API_KEY 経路と挙動が異なる）

## 結果

### `StopFailure` hook が API エラー時に発火する（核心）

| プロキシ status | Anthropic error type | **StopFailure.error** | claude のリトライ回数 | UserPromptSubmit → StopFailure |
|---|---|---|---|---|
| 429 | rate_limit_error | `rate_limit` | 1 回 | **即発火 (~0s)** |
| 401 | authentication_error | `authentication_failed` | 3 回 | ~4 秒 |
| 403 | permission_error | `authentication_failed` | 2 回 | ~1 秒 |
| 400 (credit msg) | invalid_request_error | `billing_error` | 1 回 | **即発火** |
| 529 | overloaded_error | `server_error` | **10 回** | **3 分 10 秒** |
| 500 | api_error | `server_error`（推定） | 10 回（推定） | 3 分（推定） |

### `last_assistant_message` の実例

```
rate_limit:
  "API Error: Server is temporarily limiting requests (not your usage limit) ·
   Number of request tokens has exceeded your rate limit. Please try again later."

authentication_failed (401):
  "Not logged in · Please run /login"

authentication_failed (403):
  "Please run /login · API Error: 403 ..."

billing_error:
  "Credit balance is too low"

server_error (529):
  "API Error: 529 Overloaded. This is a server-side issue, usually temporary —
   try again in a moment. If it persists, check status.claude.com."
```

### `StopFailure` の payload 構造

```json
{
  "session_id": "<uuid>",
  "transcript_path": "/Users/.../<uuid>.jsonl",
  "cwd": "/private/tmp/api-error-probe",
  "hook_event_name": "StopFailure",
  "error": "rate_limit | authentication_failed | billing_error | server_error",
  "last_assistant_message": "<人間可読のエラー文言>"
}
```

### リトライ中は他 hook も来ない

`UserPromptSubmit` から `StopFailure` までの 3 分間、`Notification` / `Stop` / その他 hook は **一切発火しない**。proxy.log には POST /v1/messages が 10 回記録される（exponential backoff っぽい間隔: 0s, 5s, 5s, 5s, 5s, 8s, 19s, 37s, 35s, 34s）。

`StopFailure` 発火後、約 1 分後に `Notification(idle_prompt)` が二次通知として来る:
```json
{"hook_event_name":"Notification","message":"Claude is waiting for your input","notification_type":"idle_prompt"}
```

### ANTHROPIC_API_KEY 経路との差

検証初期に `ANTHROPIC_API_KEY=<fake>` で起動したケースでは「Retrying in 52s · attempt 1/10」と表示され、リトライ完走前に介入が必要だった（`StopFailure` を待たずペインで気付く）。OAuth 経路は **即発火する種別が多い**（rate_limit / billing 等）。cmux-team の本番運用は OAuth なので、即発火想定で設計してよい。

## 結論

1. **hook 経路で API エラー検出は可能**。proxy 改造は不要。
2. **`StopFailure` 1 個を Master/Conductor/Agent の全 settings.json に追加するだけ**で 4 種別 (`rate_limit` / `authentication_failed` / `billing_error` / `server_error`) を識別できる。
3. **5xx 系は 3 分間 hook 沈黙する** が、claude が自動リトライで復帰する場合は実害なし。復帰しなければ 3 分後に `StopFailure` で確定する。**沈黙タイマーは不要**（過剰設計）。
4. Master / Conductor が即対処すべきエラー (`rate_limit` / `authentication_failed` / `billing_error`) は全て即発火するので、対処タイミングを逃さない。

## 設計への反映（T391）

`AgentState` に `lastApiError: { kind, message, at }` 追加 + `status: "error"` バリアント追加。
`generateMasterSettings` / `generateConductorSettings` / `generateAgentSettings` に `StopFailure` hook 登録を追加。
daemon の `handleMessage` に `STOP_FAILURE` ハンドラを追加し、payload を `state.lastApiError` に反映。
dashboard.tsx で `error` 状態の表示（kind 別アイコン + last_assistant_message の tail）。
Conductor の `await-agent` の出力 STATUS を `completed | crashed | ask` から `completed | crashed | ask | api_error <kind>` に拡張。

## 関連ファイル

- 検証スクリプト: `/tmp/api-error-probe/dummy-proxy.ts` / `settings.json` (検証完了後は削除可)
- hooks.log の生ログ: `/tmp/api-error-probe/hooks.log` (検証完了後は削除可)
- 検証セッション: workspace:1 surface:479 (rename "API-Error-Probe")

## 参考リンク

- Claude Code 公式 hooks docs: https://code.claude.com/docs/en/hooks.md
- 公式 hook event 一覧（2026-04 時点）:
  - SessionStart / SessionEnd
  - UserPromptSubmit / Stop / **StopFailure**
  - PreToolUse / PostToolUse / PermissionRequest / PermissionDenied
  - FileChanged / ConfigChange / CwdChanged / Setup
  - Notification (ntype: permission_prompt / idle_prompt / push_notification 等)
