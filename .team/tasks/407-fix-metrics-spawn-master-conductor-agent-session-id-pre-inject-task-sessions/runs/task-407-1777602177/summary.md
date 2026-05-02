# T407 Summary: 全 spawn (Conductor/Agent) で session_id を pre-inject

## 完了したサブタスク

- Phase 1 Plan: planner Agent (surface:598) → plan.md 初版
- Phase 2 Design Review (Round 1): reviewer Agent (surface:599) → Changes Requested (Critical 4 点 + Recommendations 6 点)
- Phase 1 Plan rev2: planner Agent (surface:600) → plan.md 改訂版（Critical / Recommendations 反映）
- Phase 2 Design Review (Round 2): reviewer Agent (surface:601) → **Approved**
- Phase 3 Implementation: implementer Agent (surface:602) → TDD で 10 Step 実装完了
- Phase 4 Inspection: inspector Agent (surface:603) → **GO**

## 設計判断（Design Review で確定）

| 項目 | 決定 | 理由 |
|---|---|---|
| Master の pre-inject | スコープ外 | `task_sessions` に Master 起動行が無く、metric 集計の経路として効果が無い |
| `task_sessions` UPDATE 経路 | 導入しない（append-only 維持） | 履歴復元・trace 再生用途を保護。`/clear` 後の追従は task-state.json のみで十分 |
| trace-store CTE の防御 | `session_id != ''` を CTE と JOIN 双方に追加 | backfill しない方針の空 session_id 行が誤マッチして集計を膨らませる regression を防ぐ |
| POST 順序逆転 race | `state.sessionId 未設定の場合のみ message.sessionId を採用` + 後着 mismatch warn | hook 側 sessionId を pre-inject 値に巻き戻すリスクを構造的に排除 |
| 事前発行 UUID の保持先 | in-memory state（既存 `MasterState/ConductorState/AgentState.sessionId`） | team.json への直書きは daemon の所有物との責務分割を破壊するため避けた |

## 変更ファイル一覧

```
docs/spec/04-templates.md                     |   2 +-
docs/spec/07-state-machine.md                 |  33 ++
docs/spec/11-metrics.md                       |  36 +-
package-lock.json                             |   4 +-
skills/cmux-team/manager/daemon.test.ts       | 417 +++++ (T-12 後着 mismatch / T-8/T-9 整合性チェック / append-only 維持)
skills/cmux-team/manager/daemon.ts            |  78 +
skills/cmux-team/manager/main.test.ts         | 140 +++ (R5 token-pool prefix 並列性 / T-11 UUID v4)
skills/cmux-team/manager/main.ts              | 129 +++ (generateSessionId / build*ClaudeArgs export)
skills/cmux-team/manager/metrics-cli.test.ts  | 155 +++ (R6 e2e 4 軸 + unattached regression)
skills/cmux-team/manager/schema.test.ts       |  89 +++ (sessionId optional + Master scope 外型担保)
skills/cmux-team/manager/schema.ts            |   9 +  (Conductor/Agent のみ sessionId optional 追加)
skills/cmux-team/manager/trace-store-metrics.test.ts | 327 +++ (T-5/T-6/R1/C2)
skills/cmux-team/manager/trace-store.ts       |  34 +  (CTE event IN ('assigned','agent_spawned') + session_id != '' 防御)
```

合計: 13 files / +1408 / -45

## テスト結果

| テストファイル | 結果 |
|---|---|
| main.test.ts | 226 pass / 0 fail |
| daemon.test.ts | 199 pass / 0 fail |
| trace-store.test.ts | 38 pass / 0 fail |
| trace-store-metrics.test.ts | 22 pass / 0 fail |
| schema.test.ts | 59 pass / 0 fail |
| metrics-cli.test.ts | 18 pass / 0 fail |

`bunx tsc --noEmit` (skills/cmux-team/manager) — exit 0、新規エラーなし。

## 受け入れ条件の検証

| 条件 | 結果 | 担保箇所 |
|---|---|---|
| 1. spawn 時 task_sessions の `assigned`/`agent_spawned` 行に session_id が空でなく埋まる（Conductor/Agent） | ✅ | `main.test.ts` (T-1/T-2 buildClaudeArgs) + `daemon.test.ts` sessionId 格納 |
| 2. /clear/compact 後 task-state.sessionId が新 UUID に update（task_sessions は append-only） | ✅ | `daemon.test.ts` append-only 維持テスト |
| 3. countToolCallsByTask が Agent 由来 tool_use を task_id 解決 | ✅ | `trace-store-metrics.test.ts` (T-5/T-6) + `metrics-cli.test.ts` (R6 e2e) |
| 4. T203 の /clear 後 resume 不能問題が再発しない | ✅ | `cmdResume` 経路は touch 無し、既存テスト全 pass |
| 5. 整合性チェックの warn ログが不一致時のみ（後着 mismatch 含む） | ✅ | `daemon.test.ts` (T-8/T-9/T-12/R2) |

## 残課題（スコープ外、別タスク候補）

- Master の pre-inject（必要なら issue 起票）
- `task_sessions` UPDATE 経路（/clear 後の新 UUID 行追加可否）
- T403 との共通 helper (`resolveTaskIdBySurface`) 切り出し（issue #48）
- 既存 DB の空 session_id 行 backfill（fresh hook で線形減衰観測）
- `--resume` 経路で claude が新 UUID を払い出す挙動の確認（観測されたら別タスク）

## マージ情報

- ブランチ名: `task-407-1777602177/task`
- マージ先: `main`
- 納品方式: ローカルマージ（ff-only）
- コミット SHA / マージ SHA: 後段の Step で記録
