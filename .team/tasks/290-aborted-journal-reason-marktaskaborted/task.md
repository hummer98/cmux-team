---
id: 290
title: Aborted 経路の journal と reason 表示を構造化（markTaskAborted 集約）
priority: medium
created_by: surface:533
created_at: 2026-04-21T20:16:58.330Z
---

## タスク
# 背景

タスクが aborted に倒れたときの reason 表現が経路ごとにバラついており、\`await-task\` / \`show-task\` の出力（\`Task N was aborted: <journal>\`）から reason を機械的にも視覚的にも読みにくい。

## 現状の経路（6 種）と journal フォーマット

| 経路 | 場所 | journal フォーマット | log reason |
|---|---|---|---|
| user_clear | daemon.ts:2259 | \`user_clear: C[XXX] taskRunId=...\` | \`user_clear\` |
| judgment_pending | daemon.ts:3164 | \`conductor_done_unresolved: <reason> (worktree=...) taskRunId=...\` | \`judgment_pending\` ← **journal prefix と log reason が不一致** |
| assign_failed | daemon.ts:2626 | \`assign_failed: <e.reason>\` | \`assign_failed\` |
| disconnect_timeout | daemon.ts:3054 | \`disconnect_timeout: C[XXX] ...\` | \`disconnect_timeout\` |
| abort-task CLI | main.ts:3484 / 3525 | ユーザー入力そのまま | \`abort_task\` |
| resume_marked_aborted | main.ts:840 周辺 | \`resume_no_session_id\` 等、個別 reason | 同 |

## 問題

1. **journal prefix と log reason の乖離** — 特に judgment_pending では log は \`judgment_pending\` だが journal は \`conductor_done_unresolved:\` で始まる。grep で対応づけしにくい
2. **abort-task CLI 経由ではユーザー入力がそのまま journal に入る** — reason 列が無いためフィルタできない
3. **\`await-task\` / \`show-task\` の出力で reason が先頭に来ない** — \`Task N was aborted: <journal>\` の \<journal\> が冒頭にキーを持つ経路と持たない経路が混在

## ゴール

\`await-task\` / \`show-task\` / TUI の aborted 表示で、canonical な reason が先頭に明示されること。6 経路すべてが同じ構造で journal を書くこと。

## 実装方針（案・Planner が精緻化）

daemon.ts:3159 に既に **\"markTaskAborted ヘルパーに抽出予定（Decision D1）\"** という TODO がある。この回収と合わせて実施する。

### 想定インターフェース（Planner が確定）

\`\`\`ts
// task.ts
type AbortReason =
  | \"user_clear\"
  | \"judgment_pending\"
  | \"assign_failed\"
  | \"disconnect_timeout\"
  | \"abort_task\"
  | \"resume_no_session_id\"
  | \"resume_no_task_run_id\"
  | \"resume_no_worktree\";

async function markTaskAborted(
  projectRoot: string,
  taskId: string,
  reason: AbortReason,
  detail: string,  // 従来の journal 本文（surface 情報・worktree パス等）
): Promise<{ revertedChildren: string[] }>;
\`\`\`

journal の on-disk 表現はシリアライズ形式を決める（現行 string 型との互換）:
- 案 A: \`reason=<reason>; <detail>\` という prefix string
- 案 B: JSON stringified \`{reason, detail, abortedAt, ...}\`
- 案 C: TaskState.journal の型を \`string | { reason; detail }\` union に拡張

Planner は既存 task-state.json の migration コストを含めて案を選ぶ。

### 表示側の改修

- \`await-task\` exit 1 時の stderr: \`Task N was aborted: [<reason>] <detail>\` 形式
- \`show-task <id>\` の出力も同様
- TUI Tasks タブで aborted タスクの reason 列 / 色分け（現状あれば）

### 対象経路（全 6 箇所を markTaskAborted に置換）

- daemon.ts:2259 (user_clear)
- daemon.ts:3164 (judgment_pending)
- daemon.ts:2626 (assign_failed)
- daemon.ts:3054 (disconnect_timeout)
- main.ts:3484 / 3525 (abort-task CLI)
- main.ts:840 周辺 (resume_marked_aborted の 3 種 reason)

cascadeAbortToChildren + \`child_reverted_to_draft\` ログの emit も markTaskAborted 内に集約すると良い（現状は呼び出し側に散らばっている）。

## 後方互換

既存の \`.team/task-state.json\` には旧 format の journal が残っている。

- 読み取り時: 旧 format（prefix なし / 独自 prefix）は \`reason=unknown\` として扱う or 既存 prefix から best-effort で reason を推定する
- 新規書き込み: 必ず新 format
- migration 専用スクリプトは不要（上書きで自然に更新される）

## Inspection 項目

- 6 経路すべてが markTaskAborted 経由になっている（grep で \`status: \"aborted\"\` の直接代入が 0 件）
- \`await-task\` / \`show-task\` で reason が冒頭に出る
- 既存テスト（daemon.test.ts の \`task_aborted reason=...\` 正規表現）がパスする
- 旧 format の journal を持つ task-state.json でも crash しない

## 非目標

- abort_task CLI の \`--reason\` フラグ追加は別タスク（今回は \`reason=abort_task\` 固定で OK）
- TUI の色分けは nice-to-have、最低限 reason 文字列が見えれば足りる
