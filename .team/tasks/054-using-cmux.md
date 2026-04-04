---
id: 054
title: using-cmux競合警告を削除
priority: high
created_at: 2026-04-03T04:27:11.304Z
---

## タスク
main.ts L121-127 の using-cmux プラグイン競合チェック・警告ログを削除する。

CMUX_NO_RENAME_TAB 環境変数による抑止で共存可能になったため、排他的な警告は不要。

対象箇所（skills/cmux-team/manager/main.ts）:
- L121-127 の using-cmux 競合チェックブロックを削除
  - plugins.json の読み取り
  - using-cmux 文字列チェック
  - console.log 警告
  - log() 呼び出し
