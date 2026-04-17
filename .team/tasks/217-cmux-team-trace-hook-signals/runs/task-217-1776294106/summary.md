# T217 完了サマリー — cmux-team trace-hooks サブコマンド追加

## 完了したサブタスク

1. **Phase 1 Plan**: Planner Agent が `plan.md`（7 章、421 行）を作成
2. **Phase 3 Implement**: Implementer Agent が TDD で実装
3. **Phase 4 Inspect**: Inspector Agent が GO 判定（全検品項目 pass）

## 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/trace-store.ts` | `HookSignalRecord` 型と `getHookSignals(db, opts)` 関数を追加 |
| `skills/cmux-team/manager/trace-store.test.ts` | `getHookSignals` の unit test 5 ケース追加 |
| `skills/cmux-team/manager/main.ts` | `cmdTraceHooks` + 3 ヘルパ関数追加、switch case 追加、JSDoc Usage 更新 |
| `skills/cmux-team/manager/i18n.ts` | `help_trace_hooks` を en/ja に追加、`help_main` 2 ヶ所に 1 行追記 |

合計: 4 files changed, 271 insertions(+), 2 deletions(-)

## テスト結果

- `bun test skills/cmux-team/manager/`: **368 pass / 0 fail / 774 expect() calls**
- `bun test skills/cmux-team/manager/trace-store.test.ts`: **8 pass / 0 fail**（既存 3 + 新規 5）
- `cd skills/cmux-team/manager && bunx tsc --noEmit`: **エラー 0 件**

## CLI 動作確認（実プロジェクトの DB で検証済み）

```
$ cmux-team trace-hooks --limit 5
TIMESTAMP                      TYPE              SURFACE          PID       DETAIL
2026-04-15T23:16:35.220Z       SESSION_STARTED   S[305]           35496     source=startup
2026-04-15T23:16:34.210Z       AGENT_SPAWNED     S[305]           -         -
...

$ cmux-team trace-hooks --json --limit 1
[{ "id": 15, "timestamp": "...", "type": "SESSION_STARTED", ... }]

$ cmux-team trace-hooks --limit abc
Error: --limit must be a positive number (got: abc)
(exit 1)
```

- surface 正規化: `305` / `surface:305` / `C[305]` いずれも同一結果
- 0 件時: `No hook signals found.`（tabular）/ `[]`（JSON）
- 既存 `trace-task` サブコマンドに regression なし

## plan.md からの意図的逸脱（全て Implementer 判断、Inspector 承認済み）

1. **テスト fixture の hook type 名**: plan.md の `AGENT_DONE` は schema に存在しないため `CONDUCTOR_DONE` に差し替え、`source="conductor"` は `SessionStartedMessage.source` の union 型（`startup|resume|clear|compact`）に無いため `source="resume"` に差し替え
2. **surface 正規表現**: plan.md の `^[CAMUS]?\[?(\d+)\]?$` は `C[665`（閉じ括弧なし）を通してしまうため、`^[CAMUS]?\[(\d+)\]$` と `^(\d+)$` の 2 本立てに変更
3. **hook type 列挙の実在値への修正**: en/ja `help_trace_hooks` のオプション説明文で `AGENT_STARTED/AGENT_DONE/ASK_USER` → `AGENT_SPAWNED/SESSION_ASK` など実際の schema に合わせた名前に調整

## 懸念・残課題（Minor suggestions）

- surface の role 推定は現状 `S[NNN]` 統一（plan.md の明示通り）。Conductor/Agent 区別が必要になったら別タスク
- `hook_signals` の GC は未実装（CLAUDE.md 記載済みの既知事項）
- hook type 列挙の同期は将来 `QueueMessage["type"]` から自動生成する選択肢あり（範囲外）

## マージ

ローカルマージで `main` に統合する（3 層アーキ + プラグイン配布なので PR 不要）。
