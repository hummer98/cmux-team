# T236 TUI Agent Spinner 検品レポート

## Verdict: GO

## Summary

計画書 plan.md の全 11 サブタスク（#10 E2E 手動検証を除く）が実装されており、`bunx tsc --noEmit` は exit=0、`bun test` は 445 pass / 0 fail。EventBus・ロギング・formatPair/formatSurface のプロジェクトポリシーはすべて遵守され、AgentState の必須化に伴う既存 `daemon.test.ts` の 10 箇所もテスト意図を維持した値（`"starting" | "running"`）で追補されている。Critical 0 / Major 0 / Minor 1 (E2E 手動検証未実施、impl-report にて人間委託明示済)。

## Findings

### 1. 計画充足（サブタスク #1〜#9, #11）: critical blocker なし ✅

| # | 検証コマンド | 結果 |
|---|------------|------|
| #1 | `rg 'status' schema.ts \| rg 'starting\|running\|idle'` | `schema.ts:158: status: "starting" \| "running" \| "idle";` |
| #2 | `rg 'AGENT_SPAWNED' daemon.ts -A 10 \| rg 'status.*"starting"'` | `daemon.ts:1030:  status: "starting",`（AGENT_SPAWNED push 内） |
| #3 | `rg 'agent\.status\s*=\s*"running"' daemon.ts` | `daemon.ts:1145` (SESSION_STARTED), `daemon.ts:1690` (SESSION_CLEAR) |
| #4 | `rg 'agent\.status\s*=\s*"idle"' daemon.ts` | `daemon.ts:1543` (SESSION_IDLE Agent 分岐) |
| #5 | `rg 'session_clear_agent_reset' daemon.ts` | `daemon.ts:1693`（新規ログイベント追加、計画書 D11 通り 1 箇所のみ） |
| #6 | `rg 'restoredAgents' daemon.ts -A 12 \| rg 'status'` | `daemon.ts:827: status: (a.status as AgentState["status"]) ?? "idle"` |
| #7 | `rg 'status: a\.status' daemon.ts` | `daemon.ts:2231: status: a.status`（updateTeamJson 内） |
| #8 | `rg 'isAgentRunning\|SPINNER_FRAMES\[spinnerFrame' dashboard.tsx` | `dashboard.tsx:506/508` で spinner / role アイコン切り替え |
| #9 | `rg 'needsAnimation' dashboard.tsx -A 10 \| rg 'agents'` | `dashboard.tsx:1341` に Agent running/starting OR 条件追加 |
| #11 | `rg '\$\{icon\}\s+\$\{label\}' dashboard.tsx` | 0 件（旧固定描画残骸なし） |

### 2. Dead/Zombie Code: なし ✅ (severity: major, 該当無し)

- `dashboard.tsx` の旧 `${icon} ${label}` 描画は分岐置換により完全消滅（grep 0 件）。
- `roleIcon` へのリネームも `icon` との衝突回避として合理的（impl-report D-impl-2 通り）。
- 未使用 import / 変数の検出なし。

### 3. テスト（既存テスト全 pass）: critical 破壊なし ✅

```
cd skills/cmux-team/manager && bun test
 445 pass / 0 fail / 989 expect() calls / 21 files / 13.36s
```

- `daemon.test.ts` の 10 箇所で `AgentState` インラインオブジェクトに `status: "running" as const` / `status: "starting" as const` を追加。
- テスト意図（SESSION_STARTED 前は starting、PID watcher 検証では running）と整合。ロジック変更なし。
- 新規テスト追加は計画書方針（「自動テストフレームワークはない」）通り行わず、動作検証は E2E 手動に委任。

### 4. 設計原則 (EventBus / ロギング / formatPair): major 違反なし ✅

- `notifyStateChanged` の source 指定: 新規 3 箇所（`"daemon.ts:handleMessage:session-started-agent"`, `"...:session-idle-agent"`, `"...:session-clear-agent"`）すべてファイル:関数:理由の形式を遵守。
- `bus.emit` / `bus.on` の外部呼び出しなし（`rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts` → 0 件）。
- `formatPair(c.surface, agent.surface, "C", "A")` 使用。生の `surface:NNN` 表記なし。
- 新規ログイベント追加は `session_clear_agent_reset` の 1 件のみ（計画書 D11 の「1 箇所のみ」制約に合致）。
- SESSION_IDLE の空 catch 既存箇所（1539）は `await log("error", ...)` でリカバリ済み。新規 catch 追加なし。
- SESSION_CLEAR Agent 分岐が `!conductor` ガード付き（master/assigning/disconnected/running いずれでもないときのみ）で、destructive な task-state 書き換えや resetConductor と干渉しない構造。

### 5. 統合 (schema→daemon→dashboard→team.json): critical 未接続なし ✅

- schema.ts の必須フィールド化 → daemon.ts の AGENT_SPAWNED (1030) / restoredAgents (827) 両生成経路で埋め込み済み（tsc が他の生成箇所を検出せず exit=0）。
- SESSION_STARTED / SESSION_IDLE / SESSION_CLEAR の各 Agent 分岐で status 遷移 → dashboard.tsx の `isAgentRunning` 判定・`needsAnimation` OR 条件に直結。
- `updateTeamJson` の agents.map に `status: a.status` 含む → 次回 restore 時に保持される閉ループ成立。

### 6. 型エラー（touched files）: critical なし ✅

```
cd skills/cmux-team/manager && bunx tsc --noEmit 2>&1; echo "exit=$?"
exit=0
```

touched files（schema.ts / daemon.ts / dashboard.tsx / daemon.test.ts）すべてクリーン。新規エラーゼロ。

### 7. E2E 手動検証（サブタスク #10）: severity: minor

- impl-report.md §Issues I2 で明示的に Inspector / 人間に委託されている（daemon 稼働中の別プロセスへの干渉が必要で Implementer から実行不能）。
- 参考セクションにも「blocker にしない (minor)」と明記あり。
- **Verdict 判定上は GO ブロックしない**が、リリース前に人間が以下を必ず確認すべき:
  1. `cmux-team start` 後に Agent を spawn し CYAN spinner が描画されること
  2. SESSION_IDLE 到達後に spinner が止まり dim role アイコンに戻ること
  3. Conductor idle + Agent のみ running の状況で spinner フレームが前進すること
  4. `cmux-team stop` 後に `jq '.conductors[].agents[] | .status' .team/team.json` で status が永続化されていること

## Fix Required

なし（GO 判定のため）。

## 参考情報

- 変更行数: schema.ts +3 / daemon.ts +27 / dashboard.tsx +29 / daemon.test.ts +11（`git diff HEAD --stat`）
- 新規イベント: `session_clear_agent_reset`（1 件、計画書 D11 通り）
- notifyStateChanged 新規 source: 3 件（session-started-agent / session-idle-agent / session-clear-agent）
- 破壊的変更: `AgentState.status` は必須フィールド。team.json 旧形式は restoredAgents の `?? "idle"` fallback で吸収済み（計画書 D9）。
