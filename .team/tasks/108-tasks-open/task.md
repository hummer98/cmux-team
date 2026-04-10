---
id: 108
title: ダッシュボード Tasks の並び順を修正: open上位 + 新しい順
priority: high
created_at: 2026-04-08T14:14:36.219Z
---

## タスク
## バグ概要

Tasks の並び順が期待と異なる。ready タスクが上に来ない。

## 現状

open タスク（draft/ready/assigned）を priority 順でソートしているのみ。同一 priority 内の順序は不定。

## 期待する並び順

1. **open タスク**（status が closed/aborted でないもの）が上
   - open 内は **created_at の降順**（新しいものが上）
2. **closed タスク**が下
   - closed 内は **closedAt の降順**（最近閉じたものが上）← 現状通り

priority によるソートは廃止し、作成日時の新しい順にする。

## 修正箇所

- skills/cmux-team/manager/daemon.ts（L598-605 付近）

```typescript
// 修正後
const openTasks = [...openTasksList]
  .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
```

## テスト

daemon.test.ts に taskList の並び順テストを追加すること。
