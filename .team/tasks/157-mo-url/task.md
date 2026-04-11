---
id: 157
title: mo ビューアでファイル指定URLを使い直接フォーカスする
priority: medium
created_at: 2026-04-11T17:33:54.413Z
---

## タスク
## 背景

TUI の Tasks パネルで Enter を押して mo で Markdown を開くと、ファイルリストの一番上が表示されてしまい、対象ファイルにフォーカスが当たらない。

## 原因

dashboard.tsx:756-758 で mo 起動後に `http://localhost:6275` を固定で開いているため。

## 修正方法

`mo file.md --json` の出力に `?file=<id>` 付きの URL が含まれる:

```json
{
  "files": [{"url": "http://localhost:6275/?file=fc461902", ...}]
}
```

この URL を `cmux browser open` に渡せば対象ファイルが直接表示される。

## 修正箇所

`skills/cmux-team/manager/dashboard.tsx` の `openArtifactInViewer` 関数（754-759行付近）:

- `Bun.spawn(["mo", filePath])` → `Bun.spawn(["mo", filePath, "--json"], { stdout: "pipe" })`
- stdout から JSON をパースし `files[0].url` を取得
- `cmux browser open` にそのファイル固有 URL を渡す
- JSON パース失敗時は既存のフォールバック（`http://localhost:6275`）を使う
