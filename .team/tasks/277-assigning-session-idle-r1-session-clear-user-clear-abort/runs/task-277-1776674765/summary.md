# T277 Summary

## タスク

assigning 中の SESSION_IDLE 保険 (R1) を撤去 — SESSION_CLEAR 遅着で誤 user_clear abort する事故 (T276 run #1) を防ぐ。

## 実行フェーズ

1. Phase 1: Plan（Planner）→ plan.md
2. Phase 2: Design Review（round 1: Changes Requested → round 2: Approved）
3. Phase 3: Implementation（Implementer、TDD）→ impl-report.md
4. Phase 4: Inspection → GO 判定
5. Phase 5: 納品

## 変更ファイル

| ファイル | +/- | 内容 |
|---------|-----|------|
| `skills/cmux-team/manager/daemon.ts` | +5 / -21 | SESSION_IDLE R1 分岐削除、`session_idle_at=` snapshot 列削除 |
| `skills/cmux-team/manager/schema.ts` | -2 | `sessionIdleAtInAssigning` フィールド削除 |
| `skills/cmux-team/manager/conductor.ts` | +3 / -3 | `sessionIdleAtInAssigning` reset 削除、コメント修正 |
| `skills/cmux-team/manager/daemon.test.ts` | +81 / -45 | 旧 R1 test を新仕様 test 2 本に置換、T276 race regression test 追加 |
| `.team/artifacts/A014-conductor-state-machine.md` | +4 / -4 | row 7 取消線 + 注記、Mermaid L266 から `IDLE` 除去 |

合計: 5 files changed, 93 insertions(+), 75 deletions(-)

## テスト結果

```
bun test (skills/cmux-team/manager/)
→ 666 pass / 0 fail / 1705 expect() calls across 26 files
```

typecheck 2 件の pre-existing error は T277 以前から存在（base HEAD に stash しても同じ error を再現）。本タスクスコープ外。

## 変更の要点

- **R1 分岐完全削除**: `daemon.ts:1937-1955` の「assigning + SESSION_IDLE → running」保険を撤去。T276 race（SESSION_IDLE 先着で R1 発火 → running → SESSION_CLEAR 後着で user_clear 誤 abort）を根絶
- **assigning window close を 3 経路に一本化**:
  1. `SESSION_STARTED source=clear`（正規経路）
  2. `SESSION_CLEAR`（daemon_assign_clear 早期 break）
  3. timeout (`ASSIGNING_TIMEOUT_SEC=60s` → disconnected → `DISCONNECT_TIMEOUT_SEC=300s` → forced close)
- **`sessionIdleAtInAssigning` フィールド削除**: R1 撤去で書き込み元が消えるため dead field を schema / conductor.ts / daemon.ts すべてから撤去
- **SESSION_ACTIVE R1 は現状維持**: `generateConductorSettings` で SESSION_ACTIVE hook が生成されないため実害なし。同種の撤去は後続タスク判断とした

## 新規テスト

- `SESSION_IDLE(assigning+taskRunId) で R1 は発火しない (T277)`: status=assigning 維持 + session_idle ログ有 + assigning_window_close/conductor_running 不在を検証
- `daemon /clear 由来 SESSION_IDLE が SESSION_CLEAR より先着しても task が abort されない (T277 regression)`: T276 race を忠実再現（`promptSentAt` 設定で `source_guess=clear_transient` も assert）

## 納品

main ブランチへローカルマージ。
