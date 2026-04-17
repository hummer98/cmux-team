# T238 完了サマリ: Agent AskQuestion 時の通知と TUI 強調

## 結果

GO（Inspector 検品 pass、bun test 89/89、tsc clean）

## フェーズ実行

| フェーズ | Agent | 出力 |
|---|---|---|
| Plan | surface:494 (planner) | `plan.md` (18KB) |
| Impl | surface:498 (impl) | 5 ファイル変更 + テスト追加 |
| Inspect | surface:500 (inspector) | `inspection.md` GO 判定 |

Design Review はタスク本文が既に詳細な設計を提示していたため skip。

## 変更ファイル

| ファイル | 変更概要 |
|---|---|
| `skills/cmux-team/manager/schema.ts` | `AgentState.status` に `"asking"` 追加 |
| `skills/cmux-team/manager/daemon.ts` | SESSION_ASK の Agent 分岐に `agent.status="asking"` + `notifyStateChanged(...)` + `void cmux.notify(...)` を追加 |
| `skills/cmux-team/manager/dashboard.tsx` | Agent 行レンダリングに `isAgentAsking` 分岐（YELLOW + `?` + asking ラベル）を追加 |
| `skills/cmux-team/manager/cmux.ts` | `notify()` ラッパー新規追加（best-effort、catch + log("error", ...)） |
| `skills/cmux-team/manager/daemon.test.ts` | 既存 SESSION_ASK Agent テストに `agent.status === "asking"` assertion 追加 |
| `package-lock.json` | version 3.51.0 → 3.52.0 同期（npm install bootstrap の副作用、無害） |

## 解除経路（追加コード不要）

- SESSION_STARTED Agent 分岐（daemon.ts:1145）で `status = "running"` に自然上書き
- SESSION_IDLE Agent 分岐（daemon.ts:1543）で `status = "idle"` に自然上書き

## 検証

- `cd skills/cmux-team/manager && bun test daemon.test.ts` → 89 pass / 0 fail
- `bunx tsc --noEmit` → exit 0
- E2E 手動検証（実際の OS 通知 + TUI YELLOW 表示）は未実施。Inspector の推奨に従い、merge 後に余裕があれば手動確認を行うこと。

## マージ

ローカルマージ（main）。
