---
id: 083
title: create-task CLI に --depends-on オプションを実装
priority: high
created_at: 2026-04-05T02:52:31.958Z
---

## タスク
## バグ

`cmux-team create-task --depends-on 081` で depends_on が無視される。
CLI に --depends-on の処理が未実装のため、タスクファイルの frontmatter に depends_on が書き出されない。

## 原因

`main.ts` の `cmdCreateTask()`（L1045-1098）に:
1. `getArg("depends-on")` がない
2. frontmatter 生成（L1089-1094）に `depends_on:` の出力がない
3. help テキスト（L1030-1034）にもオプション記載がない

## 修正内容

### main.ts の cmdCreateTask()

1. L1048 付近に追加:
   ```ts
   const dependsOn = getArg("depends-on") || "";
   ```

2. L1089-1094 の frontmatter 生成に追加:
   ```
   ${dependsOn ? `\ndepends_on: [${dependsOn}]` : ""}
   ```
   - カンマ区切りで複数指定可能: `--depends-on "081,082"`

3. help テキスト（L1030-1034）に追加:
   ```
   --depends-on <ids>      依存タスク ID（カンマ区切り、任意）
   ```

4. usage（L1677）にも追加:
   ```
   cmux-team create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--depends-on <ids>] [--run-after-all]
   ```

## 対象ファイル
- `skills/cmux-team/manager/main.ts` — cmdCreateTask() + help + usage
