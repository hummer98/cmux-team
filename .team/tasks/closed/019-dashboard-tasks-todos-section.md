---
id: 019
title: ダッシュボード TUI に Tasks/Todos セクションを追加
priority: medium
status: ready
created_at: 2026-03-27T12:00:00+09:00
---

## タスク

TUI ダッシュボード (`skills/cmux-team/manager/dashboard.tsx`) に Tasks/Todos セクションを追加する。
現状はヘッダーに `tasks N open` の数字のみで中身が見えない。タスク一覧をセクションとして展開し、TODO 由来のタスクも区別して表示する。

### 表示仕様

- Conductors セクションと Log セクションの間に配置
- `.team/tasks/open/` を読み取り、新しい順に最大5件表示
- 各タスクの表示: `● {id} [{status}] {title} {elapsed}`
- TODO 区別: ファイル名が `*-todo.md` のものは title に `TODO:` プレフィックスを付与
- ステータス色分け:
  - `ready` = 黄色
  - `draft` = dim
  - Conductor 割り当て済み = 緑
- タスクがない場合は `no open tasks` の1行表示

### データ変更

- `DaemonState` に `taskList: TaskSummary[]` フィールドを追加（id, title, status, isTodo, createdAt）
- `daemon.ts` の `scanTasks()` またはメインループでタスク詳細を state に反映

## 対象ファイル

- `skills/cmux-team/manager/dashboard.tsx` — TasksSection コンポーネント追加、レイアウト変更
- `skills/cmux-team/manager/daemon.ts` — DaemonState にタスクリスト追加

## 完了条件

- ダッシュボードに Tasks/Todos セクションが表示される
- open タスクが一覧で見える（id, status, title, 経過時間）
- TODO 由来のタスクが区別して表示される
- タスクがない場合は `no open tasks` と表示される
- 既存のレイアウト（Header, Master, Conductors, Log）が崩れない
