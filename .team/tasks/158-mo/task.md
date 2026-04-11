---
id: 158
title: mo ビューアで既存ブラウザを再利用する
priority: medium
depends_on: [157]
created_at: 2026-04-11T17:53:11.423Z
---

## タスク
## 背景

TUI から mo でファイルを開くたびに `cmux browser open` で新しいブラウザ split が作られてしまう。同一ワークスペース内に既にブラウザが開いていれば、そこに navigate するだけでよい。

## やること

`dashboard.tsx` の `openArtifactInViewer` 関数で:

1. ワークスペース内にブラウザ surface が存在するか確認（`cmux tree` や `cmux browser identify` 等で検出）
2. 既存ブラウザあり → `cmux browser <surface> goto <url>` で URL を変更（split 不要）
3. 既存ブラウザなし → 従来通り `cmux browser open <url>` で新規作成

## 参考

- `cmux browser open` — 新規ブラウザを開く
- `cmux browser <surface> goto <url>` — 既存ブラウザの URL を変更
- T157 で `?file=<id>` 付き URL の取得が実装される前提（depends-on 157）
