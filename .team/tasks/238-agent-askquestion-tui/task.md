---
id: 238
title: Agent AskQuestion 時の通知と TUI 強調
priority: high
created_by: surface:488
created_at: 2026-04-17T03:01:24.995Z
---

## タスク
## 背景

Agent が AskUserQuestion を出したとき、現状は完全に無通知:

1. daemon は `.team/output/<conductor>/<agent>/done` に `status: "ask"` を書くのみ（daemon.ts:1584-1604）
2. `AgentState.status` は更新されず、TUI では running 状態に見え続ける
3. OS 通知も飛ばない → ユーザーは Conductor ペインを覗かない限り気付けない

Conductor 側は既に `conductor.status = "asking"` + YELLOW 表示が実装済み（daemon.ts:1572-1581, dashboard.tsx:444）。**同じパターンを Agent にも展開する** のが最小構成。

## ゴール

- Agent が AskQuestion を出したら `cmux notify` で OS 通知が飛ぶ
- TUI の Agent 行が YELLOW + "asking" ラベルで表示される
- Agent が応答を受けて再開したら元の色/ラベルに戻る

## 修正内容

### 1. `skills/cmux-team/manager/schema.ts`

`AgentState.status` に `"asking"` を追加:

```ts
status: "starting" | "running" | "idle" | "asking";
```

### 2. `skills/cmux-team/manager/daemon.ts`

`SESSION_ASK` の Agent 分岐（1584-1604 行付近）で以下を追加:

- `agent.status = "asking"` をセット
- `notifyStateChanged("daemon.ts:handleMessage:session-ask-agent")` を呼ぶ
- `cmux notify --surface <agent.surface> --title "Agent asking" --subtitle <role or task title> --body <question>` を spawn
  - **通知先 surface は Agent surface**（ユーザー確認済み）
  - `cmux.ts` の既存ラッパー経路で実装。失敗は best-effort（log("error", ...) のみ、エラーは握りつぶして他処理を続行）
- 既存の `writeAgentDone` + `agent_ask` log は残す

解除経路（新規コード不要）:

- SESSION_STARTED Agent 分岐（daemon.ts:1139-1145）で `agent.status = "running"` に自然上書き
- SESSION_IDLE Agent 分岐（daemon.ts:1532-1543）で `agent.status = "idle"` に自然上書き

### 3. `skills/cmux-team/manager/dashboard.tsx`

Agent 行レンダリング（506 行付近）で `status === "asking"` 分岐を追加:

- spinner の代わりに asking を示すマーク（例: `?` または `!`）を YELLOW で表示
- ラベルと role icon も YELLOW
- Conductor 行 444 行の `ui.text("asking", { style: { fg: YELLOW } })` と同スタイル

## 検証

1. KDG-lab 等の別セッションで Agent に AskUserQuestion を踏ませるか、テストで `SESSION_ASK` メッセージを直接流す
2. OS 通知が飛ぶことを確認
3. TUI の Agent 行が YELLOW + "asking" で表示されることを確認
4. Conductor が応答を返した後、Agent の次の SESSION_STARTED / SESSION_IDLE で自然に running / idle に戻ることを確認
5. `daemon.test.ts` の既存 SESSION_ASK テストに Agent 分岐の assertion を追加

## 非ゴール

- Conductor 側の挙動は変更しない（既に動作しているため）
- 通知のクリック時フォーカス挙動は cmux の既存仕様に委ねる
- asking 解除の明示 API 追加はしない（SESSION_STARTED/IDLE で自然解除される設計）
- schema.ts 既存 AgentState 永続ファイル互換: 旧 status 値で永続化された場合の復元処理（daemon.ts:818 周辺）は `"asking"` を受けても問題ない設計（復元後は idle/running で上書きされる）

## 参考

- 調査記録: KDG-lab workspace の surface:432 Master セッションでの初期調査 + cmux-team 本体での検証
- Conductor 実装参考: daemon.ts:1572-1581（status set）、dashboard.tsx:444（YELLOW 表示）
- `cmux notify` CLI spec: `--title --subtitle --body --workspace --surface` を受け付ける
