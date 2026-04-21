---
id: 291
title: close-task / update-task / abort-task の task-id 正規化バグ修正
priority: high
created_at: 2026-04-21T21:54:28.703Z
---

## タスク
## 目的

`cmux-team close-task` / `update-task` / `abort-task` / `delete-task` / `restart-task` が CLI 引数の `--task-id` 値をそのまま `task-state.json` のキーとして使うため、frontmatter `id:` 以外の値（ディレクトリ slug 名など）を渡すと **既存エントリを更新せず、別キーの孤児エントリを新規作成してしまう**バグを修正する。

## 背景 / 再現事例

AIview プロジェクト T015 で発生:

1. daemon は frontmatter `id: 015` を key として `taskState[\"015\"] = {status: assigned}` を書き込む
2. Conductor が Step 11 で以下を実行:
   \`\`\`
   cmux-team close-task --task-id 015-mainwindowview-swift-3-mainactor-ci-xcode-15-4 --journal \"...\"
   \`\`\`
3. `cmdCloseTask` は `findTaskFile(taskId)` で task.md は見つけるが、canonical id に正規化せず **引数文字列そのまま** `taskState[\"015-mainwindowview-...\"] = {status: closed}` を書く
4. 結果: `\"015\"` は `assigned` のまま、`\"015-mainwindowview-...\"` に `closed` の孤児エントリが残る
5. さらに `conductor.taskId === taskId` の検索も失敗するため **CONDUCTOR_DONE が送られず**、daemon は ConductorState を `running` のまま保持。Conductor ペインは `end_turn` 後 idle 化するがリセットされない

### 確認コマンド

\`\`\`bash
cat ~/git/AIview/.team/task-state.json | python3 -c \"import json,sys; d=json.load(sys.stdin); [print(k,v['status']) for k,v in d.items() if '015' in k]\"
\`\`\`

出力:
\`\`\`
015 assigned
015-mainwindowview-swift-3-mainactor-ci-xcode-15-4 closed
\`\`\`

## 影響範囲

`skills/cmux-team/manager/main.ts` 内で CLI 引数 `taskId` をそのまま `taskState[taskId]` に使っている関数:

| 関数 | 行 | 症状 |
|---|---|---|
| `cmdCloseTask` | 2963〜 | slug 渡しで孤児 closed 作成 + CONDUCTOR_DONE 送信失敗 |
| `cmdUpdateTask` | 2852〜 | status 更新が既存エントリに反映されず孤児エントリ作成 |
| `cmdAbortTask` | 3455〜 | currentStatus チェックが常に undefined で assigned でないと誤判定する可能性 |
| `cmdRestartTask` | 3621〜 | 既存 aborted エントリを見落とす |
| `cmdDeleteTask` | 3729〜 | 同上 |

（`cmdCreateTask` は `createTaskProgrammatic` の戻り値 `result.id` を使うため正常）

## やってほしいこと

1. **task-id 正規化ヘルパを追加**
   - 例: `async function resolveCanonicalTaskId(inputId: string): Promise<string | undefined>`
   - `findTaskFile(inputId)` でファイルを見つけ、そこから frontmatter `id:` を読んで返す
   - ファイルが見つからない / frontmatter に id が無い場合は undefined（呼び出し側で従来通り exit 1）

2. **影響する全コマンドで適用**
   - `cmdCloseTask`, `cmdUpdateTask`, `cmdAbortTask`, `cmdDeleteTask`, `cmdRestartTask` で `requireArg(\"task-id\")` 直後に `taskId = await resolveCanonicalTaskId(taskId)` に置き換える
   - 以降の `taskState[taskId]` / `conductor.taskId === taskId` / `postMessage({ taskId })` は変更不要（canonical id で統一されるため）

3. **エラーメッセージで元の入力値を残す**
   - 正規化後も `Error: task ${origInput} not found` のように、ユーザーが打った文字列で表示する（正規化結果だと検索に使えない）

4. **動作確認**
   - 数字 id 渡し（`--task-id 015`）でも slug 渡し（`--task-id 015-mainwindowview-...`）でも同じ既存エントリが更新されることを確認
   - Conductor が close-task 経由で CONDUCTOR_DONE が daemon に届き、ConductorState が idle にリセットされることを確認

## 受け入れ基準

- [ ] `cmdCloseTask` / `cmdUpdateTask` / `cmdAbortTask` / `cmdDeleteTask` / `cmdRestartTask` が frontmatter `id:` を canonical key として使う
- [ ] slug 渡し・数字 id 渡しのどちらでも `task-state.json` の既存エントリが正しく更新される
- [ ] close-task 実行後、`team.json.conductors[].taskId` とのマッチに成功し CONDUCTOR_DONE が送られる（TASK_UPDATED で終わらない）
- [ ] 存在しない task-id 渡し時のエラーメッセージは従来通り（元の入力値で表示）
- [ ] PR を作って master にマージ

## 補足

- バグ発見経路: AIview T015 で Conductor 終了処理が完遂せず。詳細は `cmux-team` 側の当該会話セッション参照
- 孤児エントリ除去ツールは本タスクの対象外（必要なら別タスク）
