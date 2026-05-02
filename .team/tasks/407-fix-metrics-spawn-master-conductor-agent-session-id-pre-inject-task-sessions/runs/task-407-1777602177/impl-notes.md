# T407 実装メモ

## 実装サマリ

plan.md の 10 Step を TDD で順次実装。受け入れ条件 5 項目に対応するテストはすべて pass。

## 実装ファイル一覧

### 実装本体

- `skills/cmux-team/manager/schema.ts`
  - `ConductorRegisteredMessage` / `AgentSpawnedMessage` に `sessionId: z.string().optional()` 追加
  - `MasterRegisteredMessage` は **scope 外** で触らない

- `skills/cmux-team/manager/trace-store.ts`
  - `countToolCallsByTask` / `firstEditPerTask` / `failureRateByTask` の CTE を `event IN ('assigned','agent_spawned')` に拡張
  - `session_id IS NOT NULL AND session_id != ''` 防御を `session_to_task` CTE と JOIN 双方に追加（C2 採用）

- `skills/cmux-team/manager/main.ts`
  - `generateSessionId()` を export（`crypto.randomUUID()` 薄ラッパ）
  - `buildConductorClaudeArgs()` / `buildAgentClaudeFlags()` を export（builder 関数）
  - `registerSelf(role, surface, sessionId?)` の第 3 引数に optional sessionId 追加（POST body 同梱）
  - `cmdConductor`: UUID 発行 → `--session-id <UUID>` を claudeArgs に → `registerSelf` に渡す
  - `cmdSpawnAgent`: UUID 発行 → claudeFlags に `--session-id <UUID>` を inject → AGENT_SPAWNED の sessionId に同梱 → `insertTaskSession` の `session_id` を pre-inject UUID に
  - `cmdResume` / `cmdLaunchMaster` は **触らない**（plan の制約通り）

- `skills/cmux-team/manager/daemon.ts`
  - `CONDUCTOR_REGISTERED` ハンドラ: 既存 state ありなら sessionId 比較 → 不一致は `session_id_mismatch_at_register_late` warn + 既存維持。新規登録は `sessionId: message.sessionId` で初期化
  - `AGENT_SPAWNED` ハンドラ: 既存 agent ありなら同様（後着 mismatch 救済路）。新規 push は `sessionId: message.sessionId`
  - `SESSION_STARTED` ハンドラ（Conductor / Agent）: `source=startup` で `prevSessionId !== message.sessionId` なら `session_id_mismatch_at_startup` warn + hook 信頼で上書き。`source=clear/compact/resume/undefined` は warn 無し上書き

### テスト

- `schema.test.ts` (+85 lines, 7 tests): sessionId optional の正常 / 異常系
- `trace-store-metrics.test.ts` (+260 lines, 6 tests): T-5 / R1（重複・異常状態）/ C2（空 session_id 防御）
- `daemon.test.ts` (+340 lines, 13 tests): CONDUCTOR_REGISTERED / AGENT_SPAWNED の sessionId 受信、後着 mismatch（T-12）、SESSION_STARTED 整合性チェック（T-8 / T-9 / R2）、task_sessions append-only 維持
- `main.test.ts` (+130 lines, 11 tests): generateSessionId（T-11 UUID v4）、buildConductorClaudeArgs / buildAgentClaudeFlags（R5 token-pool prefix 並列性）
- `metrics-cli.test.ts` (+135 lines, 2 tests): R6 e2e fixture（4 軸集計 + unattached regression）

### ドキュメント追従

- `docs/spec/11-metrics.md` §3.5 / §3.5.1: CTE 拡張 + `session_id != ''` 防御 + spawn 時 pre-inject 経路を明文化
- `docs/spec/04-templates.md`: SessionStart hook 行に T407 の整合性チェック挙動を 1 行追記
- `docs/spec/07-state-machine.md` §1.6 を新設: pre-inject + hook update の両用挙動 / append-only / scope 外を整理
- `CLAUDE.md`: 直接的な session_id 言及が無いため触らない（過剰書き換え禁止）

## 守った制約

- `cmdResume` には `--session-id` を渡さない（既存 resume 経路を保護）
- `task_sessions` テーブルへの UPDATE 経路は導入せず、append-only 維持
- Master スコープ外（`cmdLaunchMaster` / `MasterRegisteredMessage` の sessionId 同梱は実装しない）
- `state.sessionId` の後着上書きは `if (message.sessionId && !state.sessionId)` でガード（hook 信頼方針）
- POST 順序逆転で hook が先着した場合は hook を信頼、後着 `*_REGISTERED` の sessionId は破棄 + warn

## 受け入れ条件の検証

| 条件 | 対応テスト | 結果 |
|---|---|---|
| 1. spawn 時 task_sessions の assigned / agent_spawned 行に session_id が空でなく埋まる（Conductor/Agent） | T-1（main.test.ts buildAgentClaudeFlags + cmdSpawnAgent insertTaskSession 経路）/ T-2（buildConductorClaudeArgs --session-id）/ daemon の sessionId 格納テスト | ✅ |
| 2. /clear / /compact 後、SESSION_STARTED で task-state.sessionId が新 UUID に update（task_sessions は append-only 維持） | task_sessions append-only 維持 (T407 Step 8) のテスト | ✅ |
| 3. countToolCallsByTask が Agent 由来 tool_use を task_id 解決する | T-5 / T-6（trace-store-metrics.test.ts）+ R6 e2e（metrics-cli.test.ts） | ✅ |
| 4. T203 の /clear 後 resume 不能問題が再発しない | 既存 SESSION_STARTED で sessionId 更新 (T203) テスト群が pass | ✅ |
| 5. 整合性チェックの warn ログが不一致時のみ出力される | T-8（一致 warn 無し）/ T-9（startup 不一致）/ T-12（後着 mismatch）/ R2（source=undefined）/ source=clear で warn 無し上書き | ✅ |

## 全体テスト結果

- main.test.ts: 226 / 226 pass
- daemon.test.ts: 199 / 199 pass
- trace-store.test.ts: 38 / 38 pass
- trace-store-metrics.test.ts: 22 / 22 pass
- schema.test.ts: 59 / 59 pass
- metrics-cli.test.ts: 18 / 18 pass
- metrics-aggregate.test.ts: 18 / 18 pass
- conductor.test.ts: 47 / 47 pass
- master.test.ts: 19 / 19 pass
- state-machine/*.test.ts: 全 pass
- dashboard-*.test.tsx: 全 pass

`bunx tsc --noEmit` エラーなし。

## 残課題（スコープ外、別タスク候補）

- Master の pre-inject（task_sessions に Master 起動行を追加するか別 issue）
- `task_sessions` テーブルへの UPDATE 経路（/clear 後の新 UUID 行追加可否、別 issue）
- T403 との共通 helper（`resolveTaskIdBySurface`）切り出し（issue #48）
- 既存 DB の backfill（fresh hook で線形減衰観測）
- `--resume` 経路で claude が新 UUID を払い出す挙動の確認（観測されたら別タスク）
