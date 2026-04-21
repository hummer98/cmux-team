# T291 完了サマリー

## タスク

close-task / update-task / abort-task / delete-task / restart-task の `--task-id` 引数を frontmatter `id:` 値（canonical id）に正規化するバグ修正。

## 完了したフェーズ

| Phase | Agent | 結果 |
|---|---|---|
| 1. Plan | planner (surface:600) | plan.md 作成 |
| 3. Implementation | impl (surface:603) | 994 pass / 0 fail, T291 起因 tsc エラー 0 件 |
| 4. Inspection | inspector (surface:607) | **GO** |

Design Review は中規模タスクのためスキップ。

## 変更ファイル

```
 skills/cmux-team/manager/main.test.ts | 182 ++++++++++++++++++++++++++++++++++
 skills/cmux-team/manager/main.ts      |  77 +++++++++++++-
 2 files changed, 254 insertions(+), 5 deletions(-)
```

## 主な変更

### main.ts

- `resolveCanonicalTaskId(inputId): Promise<string | undefined>` を `findTaskFile` 直後に追加（main.ts:288）
- `cmdUpdateTask` (2893-2901) / `cmdCloseTask` (3013-3021) / `cmdAbortTask` (3502-3508) / `cmdRestartTask` (3675-3681) / `cmdDeleteTask` (3790-3796) に共通パターンを挿入:
  ```typescript
  const taskIdInput = requireArg("task-id");
  const canonical = await resolveCanonicalTaskId(taskIdInput);
  if (!canonical) { console.error(`Error: task ${taskIdInput} not found in .team/tasks/`); process.exit(1); }
  const taskId = canonical;
  ```
- 下流コード（`taskState[taskId]` / `conductor.taskId === taskId` / `postMessage({ taskId })` 等）は一切変更なし

### main.test.ts

- T183 describe を拡張（slug 渡し統合テスト 4 件 + CONDUCTOR_DONE + エラー文言 2 件）
- 新 describe `resolveCanonicalTaskId (T291)`（5 ケース: 数値 id / 部分 slug / フル dir / 不在 / id 欠落）

## 受け入れ基準（4 項目すべて満たす）

- [x] 5 コマンドが frontmatter `id:` を canonical key として使う
- [x] slug 渡し・数字 id 渡しどちらでも `task-state.json` の既存エントリが正しく更新される
- [x] close-task 後 `team.json.conductors[].taskId` マッチに成功し CONDUCTOR_DONE が送られる
- [x] 存在しない task-id 渡し時のエラーメッセージは元入力値で表示

## 設計判断

1. **変数名: `taskIdInput` + 再宣言 `const taskId = canonical`** — 下流コード（`taskState[taskId]` 等）を一切変更せずに済む
2. **`cmdAbortTask` / `cmdRestartTask` の挙動変更** — 従来は `findTaskFile` 不在でも続行していたが、canonical 不明で exit 1 に倒した（孤児 entry 防止という本タスクの目的と整合）
3. **`resolveCanonicalTaskId` は `findTaskFile` の正規表現を再利用** — frontmatter 解析ユーティリティを新設せず YAGNI を徹底
4. **ユニットテストは bun subprocess 方式** — `PROJECT_ROOT` が main.ts モジュール読み込み時に固定されるため、env 差し替えのため subprocess 経由で呼び出す

## 懸念・残課題

- tsc 既知エラー 3 件（`conductor.ts:201` / `daemon.ts:1597` / `daemon.test.ts:3956`）は T291 スコープ外で pre-existing（git stash で確認済み）。別タスクで解消推奨。

## マージコミット or PR

（完了処理 Step 9 で記載）
