---
id: 038
title: Agent の session_id を AgentState に記録する (#16)
priority: medium
created_at: 2026-04-02T05:45:00.472Z
---

## タスク
GitHub issue #16 の実装。

## 問題

API Proxy は全 Agent リクエストの `x-claude-code-session-id` ヘッダーから session_id を取得し traces DB に記録しているが、daemon のメモリ上の `AgentState` には反映されていない。

## 修正内容

1. **`schema.ts`**: `AgentState` に `sessionId?: string` を追加
2. **`proxy.ts`**: Agent の初回リクエスト受信時に `conductorId` + `surface` から該当 Agent を特定し、daemon の `AgentState.sessionId` に反映する仕組みを追加
3. **`daemon.ts`**: `updateTeamJson()` で Agent の `sessionId` も出力するように更新
4. **`main.ts`**: `agents` サブコマンドの出力に `sessionId` を含める

## 対象ファイル

- `skills/cmux-team/manager/schema.ts`
- `skills/cmux-team/manager/proxy.ts`
- `skills/cmux-team/manager/daemon.ts`
- `skills/cmux-team/manager/main.ts`

## 参考

- `proxy.ts:96` — `x-claude-code-session-id` を取得済み
- `proxy.ts:192` — traces DB に `session_id` として記録済み
- `schema.ts:97-102` — `AgentState` に `sessionId` フィールドがない
- `daemon.ts:308-313` — `AGENT_SPAWNED` 処理で session_id を保存していない

完了後、GitHub issue #16 をクローズすること。
