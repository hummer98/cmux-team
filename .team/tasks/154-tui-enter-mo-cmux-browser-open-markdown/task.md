---
id: 154
title: TUI の Enter キーで mo + cmux browser open による Markdown 表示
priority: medium
created_at: 2026-04-11T13:23:56.613Z
---

## タスク
## 背景

dashboard.tsx の `openArtifactInViewer` は TUI を停止して同じ TTY 上で `mo` をフォアグラウンド実行している。`mo` はブラウザベースのビューアでサーバー起動後すぐプロセスが返るため、TUI が一瞬ちらついて即復帰するだけで実用にならない。

## やること

`openArtifactInViewer`（dashboard.tsx L746-783）を以下に書き換え:

1. **TUI を停止しない**（`app.stop()` / `app.start()` を削除）
2. `mo <filePath>` をバックグラウンドで実行（`Bun.spawn(["mo", filePath])`、await しない）
3. 少し待ってから `cmux browser open http://localhost:6275` で別 surface にブラウザペインを作成
4. `mo` が見つからない場合のフォールバックは `cmux browser open` を使わず、従来の `cat` フォールバックでよい

## 注意

- `mo` は既にサーバーが起動済みの場合、後続の `mo` 呼び出しはファイルを追加するだけ（同一ポート 6275）
- ブラウザ surface が既に存在する場合は `cmux browser navigate` で URL を更新するだけにする等の考慮があるとなおよい（ただし初期実装では毎回 open でも許容）
- `cmux markdown open` は mermaid 非対応なので使わないこと
