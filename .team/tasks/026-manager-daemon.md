---
id: 026
title: Manager daemon 起動時にタブタイトルを正しく設定する
priority: high
created_at: 2026-03-30T01:11:45.021Z
---

## タスク
## 問題
Manager daemon のタブタイトルが正しく表示されていない。

## 対応
Manager daemon の起動処理（main.ts の start コマンド付近）で、自身の surface のタブタイトルを `cmux rename-tab` で適切な名前（例: 'Manager' や 'cmux-team daemon'）に設定する。

## 参考
- cmux rename-tab の使い方: `cmux rename-tab --surface <id> <title>`
- cmux.ts に renameTab ラッパーがあるはず
- daemon の surface は team.json の manager.surface から取得可能
- 起動直後（startDashboard の前後）で実行するのが適切
