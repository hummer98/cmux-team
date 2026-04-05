# 実装計画: create-task CLI に --depends-on オプションを実装

## 概要

`cmux-team create-task --depends-on 081` で depends_on が無視されるバグを修正する。
CLI に --depends-on の処理が未実装のため、タスクファイルの frontmatter に depends_on が書き出されない。

## 対象ファイル

- `skills/cmux-team/manager/main.ts` — cmdCreateTask() + help + usage

## 修正箇所（4箇所）

### 1. 引数取得の追加（L1048 付近）

```ts
const dependsOn = getArg("depends-on") || "";
```

### 2. frontmatter 生成に depends_on を追加（L1089-1094）

```
${dependsOn ? `\ndepends_on: [${dependsOn}]` : ""}
```

- カンマ区切りで複数指定可能: `--depends-on "081,082"`

### 3. help テキストにオプション追加（L1030-1034）

```
--depends-on <ids>      依存タスク ID（カンマ区切り、任意）
```

### 4. usage にオプション追加（L1677）

```
cmux-team create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--depends-on <ids>] [--run-after-all]
```

## 検証方法

修正後、以下を確認:
1. `--depends-on 081` で単一依存が frontmatter に出力される
2. `--depends-on "081,082"` で複数依存が出力される
3. `--depends-on` 省略時は depends_on 行が出力されない
4. `--help` で新オプションが表示される
