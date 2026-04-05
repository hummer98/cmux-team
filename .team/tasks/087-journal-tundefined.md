---
id: 087
title: Journal の Tundefined 防御 + 不正ログ行削除
priority: high
created_at: 2026-04-05T15:49:53.438Z
---

## タスク
## 問題

manager.log に `task_id=undefined` のログ行が存在し、Dashboard の Journal に `Tundefined` と表示される。

### 修正内容

#### 1. 防御的コード追加

- `dashboard.tsx:472` — `buildJournalRows` で taskId が undefined/空/"undefined" の場合はエントリをスキップまたは "---" 表示
- `main.ts:614` — `cmux-team status` CLI で idle Conductor の表示を修正（taskId がない場合は表示しない）

#### 2. 不正ログ行の削除

manager.log から `task_id=undefined` を含むログ行を削除する:

```
[2026-04-05T12:18:46+09:00] task_completed task_id=undefined surface=surface:490 title=...
[2026-04-05T12:20:56+09:00] task_completed task_id=undefined surface=surface:490
[2026-04-05T12:27:51+09:00] task_completed task_id=undefined surface=surface:491
[2026-04-05T12:47:12+09:00] task_completed task_id=undefined surface=surface:490
```

#### 3. ログ記録時のバリデーション

task_completed を記録する箇所で taskId が undefined の場合はログを出さない（または error レベルで記録）ようにする
