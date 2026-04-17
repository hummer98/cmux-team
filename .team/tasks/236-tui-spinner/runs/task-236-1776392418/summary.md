# T236 TUI: サブエージェント行に Spinner を実装する — サマリー

## フェーズ進行

| フェーズ | 結果 | 成果物 |
|---|---|---|
| Phase 1 Plan | ✅ | `plan.md` (24 KB) |
| Phase 2 Design Review | ✅ Approved (Minor 5 件) | `design-review.md` |
| Phase 3 Implementation | ✅ | `impl-report.md` |
| Phase 4 Inspection | ✅ GO (Critical 0 / Major 0 / Minor 1) | `inspection.md` |

## 完了したサブタスク

1. `schema.ts`: `AgentState.status: "starting" | "running" | "idle"` 必須化
2. `daemon.ts`: `AGENT_SPAWNED` で `status: "starting"` をセット
3. `daemon.ts`: `SESSION_STARTED` Agent 分岐で `status="running"` 遷移
4. `daemon.ts`: `SESSION_IDLE` Agent 分岐で `status="idle"` 遷移
5. `daemon.ts`: `SESSION_CLEAR` に Agent 分岐追加 (`status="running"` リセット、`session_clear_agent_reset` ログ)
6. `daemon.ts`: `restoredAgents` で `status` 復元 (fallback `"idle"`)
7. `daemon.ts`: `updateTeamJson` で `status` シリアライズ
8. `dashboard.tsx`: Agent 行に Spinner 描画分岐追加 (running/starting 時 CYAN spinner、idle 時 role アイコン + dim)
9. `dashboard.tsx`: `needsAnimation` に Agent 条件追加 (Conductor idle + Agent only running でも回る)
10. (E2E 手動検証) - 人間による確認に委託
11. 旧 `${icon} ${label}` 固定描画の残骸確認 (0 件)

## 変更ファイル一覧

| パス | 変更概要 |
|-----|---------|
| `skills/cmux-team/manager/schema.ts` | `AgentState.status` 必須フィールド追加 (+3) |
| `skills/cmux-team/manager/daemon.ts` | AGENT_SPAWNED/SESSION_STARTED/SESSION_IDLE/SESSION_CLEAR Agent 分岐、restoredAgents、updateTeamJson に status 追加 (+27) |
| `skills/cmux-team/manager/dashboard.tsx` | Agent 行の Spinner 描画分岐、needsAnimation 拡張 (+29/-5) |
| `skills/cmux-team/manager/daemon.test.ts` | 既存テストの `AgentState` インライン生成 10 箇所に `status` 追加 (+11) |

## テスト結果

- `bunx tsc --noEmit`: exit=0 (touched files clean)
- `bun test`: 445 pass / 0 fail / 989 expect() calls / 21 files / 13.7s

## 設計判断のハイライト

- Conductor の status 3 値と完全対称 (`starting` / `running` / `idle`) — コードリーディング負荷最小化
- Spinner は role アイコンの **置換** (追加ではない) でツリー幅を保持
- Spinner フレームは Conductor と共有 (`state.spinnerFrame`) — 同期表示
- `SESSION_CLEAR` の Agent 分岐は `conductor === undefined` のフォールスルー内に配置 — Master/Conductor 経路と干渉しない安全設計
- restoredAgents フォールバックは `"idle"` — PID alive ≠ running のため false running による空回りを防止

## 納品

- マージコミット: `6b0947a` (Merge branch 'task-236-1776392418/task')
- 実装コミット: `da2c334` (feat(tui): T236 サブエージェント行に Spinner を実装)
- 納品方法: ローカルマージ (main へ直接)
- artifact 化: 調査系ではないため **未実施**
