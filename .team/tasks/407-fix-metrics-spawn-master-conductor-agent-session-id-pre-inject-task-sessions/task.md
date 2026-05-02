---
id: 407
title: fix(metrics): 全 spawn (Master/Conductor/Agent) で session_id を pre-inject し task_sessions を正常化
priority: medium
created_at: 2026-05-01T02:22:57.107Z
---

## タスク
## 背景

issue #48 (denormalised tool_uses table in traceDB) の起票前事前調査で発見した、T379 由来の **既存バグ**。issue #48 本体（denorm 化）に取り掛かる前に、session→task 解決経路を信頼できる状態にしておくため先行で修正する。

## 事実

- task_sessions の event=agent_spawned 行は session_id="" で書かれ、後追い update も行われない (skills/cmux-team/manager/main.ts:3068 付近、agent_spawned 597 件すべて session_id 空を実測)
- ただし agent_spawned 行の task_id 列自体は埋まっている (main.ts:3066)
- Agent 自身は SessionStart hook で session_id を確定させているが、その値はどの task_sessions 行とも紐付かない
- trace-store.ts の WITH session_to_task AS (... WHERE event='assigned' AND task_id IS NOT NULL) CTE が Conductor の assigned 行しか拾えていないため、countToolCallsByTask / firstEditPerTask / failureRateByTask の 3 関数で **Agent 由来 tool_use が全件 task_id=NULL に倒れる**

## T203 の経緯と本タスクの方針

T203 (commit ec9d9360, 2026-04-15) は当時の crypto.randomUUID() 発行 + CONDUCTOR_SESSION 独自メッセージ経路を撤廃した。当時の根本問題は「--session-id を Claude に渡せず Manager 発行 UUID と Claude 内部 UUID が起動時から乖離していた + /clear で更にズレて凍結された」点。

調査の結果、現状の Claude CLI には --session-id <uuid> フラグが存在し、渡した UUID が実際にそのセッション ID として採用されることを実機確認済 (jsonl ファイル名が UUID と一致することを /tmp/session-id-test で確認)。

そこで本タスクは **「pre-inject + SessionStart hook update の両用」** で進める：

1. **spawn 時**: Manager が crypto.randomUUID() で UUID を発行し、claude --session-id <uuid> で渡す。task_sessions の起動行を確定 UUID で書く（空書き廃止）
2. **/clear / /compact 時**: Claude が新 UUID を発行 → 既存の SessionStart hook (matcher: "" / source=clear|compact) update 経路がそのまま追従する（T203 で実装済の経路を維持）
3. **整合性チェック**: source=startup の hook で届く UUID が事前発行 UUID と一致するか defensive ログ。不一致時は warn + hook 側を信頼してフォールバック

これにより T203 が解消した「凍結問題」を再発させずに、agent_spawned 行（および対称な Master / Conductor 起動行）の空書きを消せる。

## スコープ

### 1. 全 spawn 経路で UUID pre-inject

| spawn | 関数 (main.ts) | claude flags 追加 |
|---|---|---|
| Master | cmdSpawnMaster (2628 付近) | --session-id <UUID> |
| Conductor | cmdSpawnConductor (2684) | --session-id <UUID> |
| Agent | cmdSpawnAgent (2710) | --session-id <UUID> |

- crypto.randomUUID() で発行
- --resume 経路（assigned タスク再開）はそのまま、--session-id は追加で渡さない
- insertTaskSession(...) の session_id: "" ハードコードを撤去（main.ts:3068 と他 2 箇所: 3993, 4491 を確認）
- task_sessions の起動行 (Master/Conductor/Agent それぞれ) に確定 UUID を書き込む

### 2. SessionStart hook (source=startup) 整合性チェック

- 事前発行 UUID を team.json or in-memory state に保持
- source=startup の SESSION_STARTED hook 受信時、届いた session_id が事前発行 UUID と一致するか比較
- 不一致時: warn ログ (session_id_mismatch_at_startup) + hook 側を信頼して state を上書き
- 一致時: 通常通り state 維持

### 3. /clear /compact 追従経路は変更なし

- T203 で実装済の SessionStart hook (matcher: "" / source=clear|compact) update 経路をそのまま使う
- agent_spawned 行も SessionStart hook 受信時に最新 session_id で update（assigned 行と同じ update セマンティクス）
- ただし spawn 時に UUID を埋めているため、この update は /clear/compact 後の追従用途のみ

### 4. trace-store の CTE 拡張

- countToolCallsByTask / firstEditPerTask / failureRateByTask の WITH session_to_task CTE を event IN ('assigned','agent_spawned') に拡張
- agent_spawned 行に task_id / session_id が両方埋まっていれば、この拡張だけで Agent 由来 tool_use が解決される

### 5. テスト

- --session-id 渡し → SessionStart hook (source=startup) で同じ UUID が届くことの integration test
- /clear → SessionStart hook (source=clear) で起動行が新 UUID に update されることの test
- 全 spawn 経路 (Master/Conductor/Agent) で UUID pre-inject が機能する test
- countToolCallsByTask が Agent 由来 tool_use フィクスチャで task_id 解決する test
- 整合性チェックの不一致パスの test (warn ログ + hook 側信頼)

### 6. スコープ外

- T403 との共通 helper (resolveTaskIdBySurface) の切り出し → T403 / issue #48 タスクで扱う
- 既存 DB の backfill（fresh hook 到来時から正しく解決されるので不要、判断は実装者任せ）
- issue #48 の tool_uses 派生テーブル本体（後続タスク）

## 関連

- issue #48: denormalised tool_uses table in traceDB (本タスクの動機元、後続)
- T203 (commit ec9d9360): SessionStart hook 経由 sessionId 一元化（本タスクの方針が依拠する基盤）
- T403: api_usage.task_id 全件 NULL の調査・修正（症状は別だが session→task 解決経路で helper 共有しうる）
- T379: 当該 3 関数を追加した親タスク
- T406 (aborted): 本タスクの初回起票（Agent のみのスコープだったため abort）

## 受け入れ条件

- 新規 spawn 時、task_sessions の起動行 (Master/Conductor/Agent) に session_id が **空でなく** 埋まる
- /clear / /compact 後、SessionStart hook で起動行の session_id が新 UUID に update される
- countToolCallsByTask が Agent 由来 tool_use を task_id 解決する（テストで担保）
- T203 が解消した /clear 後 resume 不能問題が再発しない（既存 resume テストが pass）
- 整合性チェックの warn ログが不一致時のみ出力される
