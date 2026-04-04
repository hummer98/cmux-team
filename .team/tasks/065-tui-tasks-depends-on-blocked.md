---
id: 065
title: TUIのTasksセクションにdepends_onのblocked表示を追加
priority: medium
created_at: 2026-04-04T01:00:38.776Z
---

## タスク
## 概要

タスク一覧で depends_on の依存先が未完了の場合、[ready] の代わりに [blocked Txxx] と表示する。

## 表示例

```
● T062 [ready]        docs/seeds/ を現在の実装に同期
● T064 [blocked T062] docs/seeds/ を docs/spec/ にリネーム
```

依存先が複数なら [blocked T061,T062] のように表示。依存が全て解消されたら通常の [ready] に戻る。

## 対象ファイル

- `manager/dashboard.tsx` — buildTaskRow で depends_on 情報を参照し表示を分岐
- `manager/daemon.ts` — TaskSummary に dependsOn 情報を含める（現状含まれていなければ追加）

## 実装方針

1. TaskSummary 型に dependsOn フィールドを追加（未解決の依存タスクIDリスト）
2. scanTasks / buildTaskList で dependsOn 情報を収集
3. dashboard.tsx の buildTaskRow で、dependsOn が空でなければ [blocked Txxx,Txxx] と表示
