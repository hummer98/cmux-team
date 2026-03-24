---
id: 3
title: status.json から loop_count を削除し last_checked_at に置換
priority: low
created_at: 2026-03-24T00:00:00+09:00
---

## タスク

Manager の status.json から `loop_count` フィールドを削除する。

### 現状の問題

- `loop_count` は「Manager が何周回ったか」を示すだけで、Master にとって有用な情報ではない
- ループごとに status.json を書き換えるのはトークンの無駄
- Manager の生存確認は `cmux read-screen` で直接可能

### 改善案

- `loop_count` を削除
- 必要であれば `last_checked_at`（ISO 8601 タイムスタンプ）に置換し、Manager が最後に動いた時刻だけ記録する

## 対象ファイル

- `skills/cmux-team/templates/manager.md` — §5 ステータス更新の JSON スキーマ

## 完了条件

- status.json に `loop_count` が含まれないこと
- Manager の生存確認に支障がないこと
