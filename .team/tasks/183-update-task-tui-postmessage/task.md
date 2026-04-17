---
id: 183
title: update-task の全更新を TUI 即時反映（postMessage 統一）
priority: medium
created_at: 2026-04-14T01:18:55.228Z
---

## タスク
# 背景

`cmux-team update-task` は status が `ready` に変更された場合のみ `postMessage TASK_CREATED` を送って daemon に通知しているが、それ以外（`--title` / `--body` / `--depends-on` のみ、あるいは status が ready 以外への変更）では通知を送らない。

結果として TUI ダッシュボードへの反映は daemon の次の `tick()`（`CMUX_TEAM_POLL_INTERVAL`、デフォルト 10 秒）まで待たされる。ユーザーが update-task 直後に TUI を見ても変更が見えない UX 的に不自然な挙動になっている。

## 該当コード

`skills/cmux-team/manager/main.ts:1768-1781` (`cmdUpdateTask`):

```ts
// --status: task-state.json を更新
if (newStatus !== undefined) {
  taskState[taskId] = { ...taskState[taskId], status: newStatus };
  await saveTaskState(PROJECT_ROOT, taskState);

  // ready に変更された場合は TASK_CREATED を送信
  if (newStatus === "ready") {
    await postMessage({
      type: "TASK_CREATED",
      taskId,
      taskFile,
      timestamp: new Date().toISOString(),
    });
  }
}
```

# タスクのゴール

update-task で**あらゆる変更**があった場合に daemon へ通知し、TUI ダッシュボードが即時反映するようにする。

# 調査してほしいこと（Agent 向け）

- 現在の queue メッセージ種別を確認（`postMessage` の `type` として何が使われているか）
- `TASK_UPDATED` 等の新しい通知種別を追加するか、既存の `TASK_CREATED` を再利用するかを設計判断
  - `TASK_CREATED` を再利用すると「新規タスクと同じ扱い」になって副作用があるか要確認（例: scanTasks がどう処理するか）
  - 新種別 `TASK_UPDATED` を作るなら daemon 側で受信して scheduleRefresh を呼ぶだけのシンプルなハンドラで良い
- daemon の state に task.md 本文の内容が載っているか、ファイルを都度読んでいるかを確認
  - ファイルを都度読んでいる場合、通知→scheduleRefresh で自動的に反映される
  - state に載っている場合は、state 側も更新する必要がある（scanTasks の再実行か、該当タスクだけ reload）
- `postMessage` の場所を整理: 現状は status=ready のときだけ呼んでいるが、title/body/depends_on/status=それ以外 の全更新で呼ぶように変更する
- `close-task` / `abort-task` / `delete-task` / `restart-task` でも同様の抜けがないか併せて調査する

# 受け入れ基準

- `cmux-team update-task --task-id N --title "新タイトル"` 実行後、最大 1 秒以内に TUI のタスク表示が更新される
- `cmux-team update-task --task-id N --body "..."` 実行後、最大 1 秒以内に TUI のタスク詳細表示が更新される（TUI でタスク本文を表示しているなら）
- `--status ready` の既存挙動は維持（TASK_CREATED 経路での割り当てトリガー）
- `close-task` / `abort-task` / `delete-task` / `restart-task` も同様の即時反映が担保されている（抜けがあれば修正）
- 既存テスト・e2e を破壊していない

# 参考ファイル

- `skills/cmux-team/manager/main.ts:1702-1789` (`cmdUpdateTask`)
- `skills/cmux-team/manager/main.ts:573-590` (daemon main loop / scheduleRefresh)
- `skills/cmux-team/manager/dashboard.tsx` (refresh ロジック)
- `skills/cmux-team/manager/queue.ts` (postMessage 実装)
- `skills/cmux-team/manager/daemon.ts` (queue consumer)
