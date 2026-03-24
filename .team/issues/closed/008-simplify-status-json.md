---
id: 8
title: status.json をスリム化し、履歴はログファイルに分離
priority: medium
status: ready
created_at: 2026-03-24T00:00:00+09:00
---

## タスク

status.json を「現在の状態」のみに絞り、履歴情報は `.team/logs/manager.log` に分離する。

### 1. status.json のスリム化

現在の状態だけを保持する:

```json
{
  "updated_at": "<ISO 8601>",
  "manager": {
    "surface": "surface:N",
    "status": "idle|monitoring"
  },
  "conductors": [
    {
      "id": "conductor-xxx",
      "task_id": "007",
      "surface": "surface:N",
      "status": "running"
    }
  ]
}
```

**削除するもの:**
- `completed_tasks` — ログへ移動
- `tasks` (`issues`) カウント — `ls` で直接確認可能
- `manager.last_checked_at` — ログで追える

### 2. ログファイルの導入

`.team/logs/manager.log` に追記形式で記録:

```
[2026-03-24T12:08:00Z] task_completed id=001 conductor=conductor-1774278927 merged=a855ed1
[2026-03-24T12:35:00Z] task_completed id=002 conductor=conductor-1774279789 merged=33f398d
[2026-03-24T12:40:00Z] conductor_started id=conductor-1774280063 task=003 surface=surface:90
[2026-03-24T12:45:00Z] idle_start
```

構造化テキスト（1行1イベント）で、grep しやすい形式。

## 対象ファイル

- `skills/cmux-team/templates/manager.md` — §5 ステータス更新の書き換え + ログ書き込み追加
- `.team/prompts/master.md` — status.json の読み方を更新

## 完了条件

- status.json が現在の状態のみ保持していること
- `.team/logs/manager.log` に履歴が追記されること
- Master が status.json とログから必要な情報を取得できること
