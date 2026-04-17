# タスク割り当て

## タスク内容

---
id: 208
title: classify-stop を stop_reason ベースに置き換え（agent_monologue SKIP 削除）
priority: high
created_at: 2026-04-15T09:20:53.884Z
---

## タスク
## 背景

`skills/cmux-team/manager/classify-stop.ts` の現在のロジックは、transcript 末尾の最後の assistant 行の `content[]` を走査して tool_use/tool_result 件数をカウントし、「toolCount === 0 && !isConductor」なら `SKIP(agent_monologue)` を返している。

これにより、planner のような 1-shot エージェントが「Write で plan.md を書く → 最終ターンで text-only の完了報告」というパターンで終わると、最後の assistant 行が text-only なために SKIP 判定され、Manager が `session_ended` を emit せず、Conductor の `await-agent` が永久に待機するバグが発生する。

## 実際に発生した事例

2026-04-15 18:05 に C[187] が T204 planner として A[191] を spawn。

- A[191] transcript: 141 行、41 件の assistant message、うち 40 件が `stop_reason: tool_use`、最後の 1 件が `stop_reason: end_turn`（text「plan.md を出力しました。」）
- ログ: `[18:09:27] session_stop_classified C[191] case=SKIP is_conductor=0 reason=agent_monologue`
- 結果: `session_ended` が発火せず、pid 42613 は生存したまま、C[187] の await-agent は永久ブロック

## 根本原因

Stop hook は Anthropic API の `stop_reason === "end_turn"` の時にのみ発火する（tool_use 中は発火しない）。つまり **classifier に到達する時点で「最後の assistant 行は必ず end_turn」**であり、「tool_use が無い = まだモノローグ中」という現行の推測自体が成立していない。

現行の toolCount カウントは「end_turn で text-only なら未完了」と誤って判定している。

## 実装方針

`classify-stop.ts` を `stop_reason` ベースに置き換える:

\`\`\`ts
const msg = assistant.message;
const content = msg?.content ?? [];
let askCount = 0;
let lastText = "";
for (const c of content) {
  if (c?.type === "tool_use" && c.name === "AskUserQuestion") askCount++;
  if (c?.type === "text" && typeof c.text === "string") lastText = c.text;
}

if (askCount > 0) {
  return { kind: "ASK", question: lastText.slice(0, QUESTION_CHAR_LIMIT) };
}
return { kind: "IDLE" };
\`\`\`

- `SKIP(agent_monologue)` ケースと `StopClassification` の `SKIP` バリアントは完全削除
- `isConductor` 引数も不要になる（Conductor/Agent を分岐する必要がない）。呼び出し側もあわせて整理
- transcript の末尾 16KB を読んで最後の assistant 行を取る処理は流用
- transcript 不在・パース失敗時は IDLE にフォールバック（現状維持）

## 確認観点

1. **テスト更新**: `classify-stop.test.ts` の既存ケースを `stop_reason` 入りフィクスチャに書き換え + 「tool_use 40 件 → 最後 end_turn で text-only」のケース（今回の A[191] 再現）を追加。既存の agent_monologue ケースは削除
2. **呼び出し側**: `daemon.ts` で `session_stop_classified` を log する箇所の `is_conductor=` / `reason=` キーの扱いを更新。`case=SKIP` 分岐の削除
3. **Conductor 分岐**: Conductor も同じロジックで判定されるようになる。過去の Conductor の Stop ログと整合するか確認（Conductor は tool 使わず text で答えるケースが多いが、それも `end_turn` なので IDLE 判定になる = 期待通り）
4. **手動動作確認**: 今のセッションで A[191] を kill して再 spawn し、planner の最終 text-only メッセージが正しく IDLE → session_ended → agent_done まで流れることを確認

## スコープ外

- 今動いている A[191] pid 42613 の救済は別（Master が手動 kill-agent する）
- `agent_monologue` SKIP を使っていた他の箇所（あれば整理）の大規模リファクタは本タスクで触るが、テンプレート・プロンプトの変更は行わない

## 関連ファイル

- `skills/cmux-team/manager/classify-stop.ts`
- `skills/cmux-team/manager/classify-stop.test.ts`
- `skills/cmux-team/manager/daemon.ts`（Stop hook 受信処理・ログ出力箇所）

## 完了条件

- 上記実装 + テストが tsc / 全テストパス
- Inspector GO
- ジャーナルに今回の A[191] 事例と stop_reason ベースへの切替理由を記載


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-208-1776244853` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-208-1776244853
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-208-1776244853/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/208-classify-stop-stop-reason-agent-monologue-skip/runs/task-208-1776244853
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/208-classify-stop-stop-reason-agent-monologue-skip/runs/task-208-1776244853/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
