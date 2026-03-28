---
id: 1774711256
title: TODOメッセージを廃止しcreate-task --status readyに一本化
priority: medium
status: draft
created_at: 2026-03-28T16:39:24.274Z
---

## タスク
## 問題

TODO と TASK の二系統が存在するが、実装上 TODO も結局タスクファイルを作成しており、違いは「ユーザー承認を省略する」だけ。create-task --status ready で同じことができるため、不要な複雑さになっている。

## 修正内容

### 1. TODO 関連コードの削除
- daemon.ts: handleTodo() を削除
- main.ts: cmdSend() の TODO case を削除
- queue.ts / schema.ts: TODO メッセージ型を削除

### 2. テンプレート修正
- templates/master.md: TODO セクションを削除し、軽微な作業も create-task --status ready を使うよう統一
- templates/manager.md: TODO 関連の記載を削除

### 3. TUI 修正
- dashboard.tsx: isTodo 判定の削除（全て通常タスクとして表示）

## 対象ファイル
- skills/cmux-team/manager/daemon.ts
- skills/cmux-team/manager/main.ts
- skills/cmux-team/manager/schema.ts
- skills/cmux-team/manager/dashboard.tsx
- skills/cmux-team/templates/master.md
- skills/cmux-team/templates/manager.md
