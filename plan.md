# plan.md — `cmux-team create-task --depends-on` 実装計画

## 1. 概要

`cmux-team create-task --depends-on "081,082"` で、タスクファイルの frontmatter に `depends_on: [081, 082]` を書き出せるようにする。現在、CLI に `--depends-on` の処理が未実装のため、引数が無視される。

対象ファイルは `skills/cmux-team/manager/main.ts` のみ。

## 2. 現状分析

### `cmdCreateTask()` 関数（L1023-L1118）

引数取得部分（L1045-L1049）:

```typescript
const title = requireArg("title");          // L1045
const priority = getArg("priority") || "medium";  // L1046
const status = getArg("status") || "draft";       // L1047
const body = getArg("body") || "";                // L1048
const runAfterAll = process.argv.includes("--run-after-all");  // L1049
```

- **`getArg("depends-on")` が存在しない** — 引数が取得されていない

### frontmatter 生成部分（L1089-L1098）

```typescript
const content = `---
id: ${newId}
title: ${title}
priority: ${priority}${runAfterAll ? "\nrun_after_all: true" : ""}
created_at: ${new Date().toISOString()}
---

## タスク
${body}
`;
```

- **`depends_on:` 行がない** — frontmatter に出力されていない

### help テキスト（L1030-L1034）

```
Options:
  --title <title>         タスクタイトル（必須）
  --body <text>           タスク本文（任意）
  --priority <priority>   優先度: high / medium / low（任意、デフォルト medium）
  --status <status>       初期ステータス: draft / ready（任意、デフォルト draft）
```

- **`--depends-on` がない**

### usage テキスト（3箇所）

| 箇所 | 行番号 | 内容 |
|------|--------|------|
| ファイル先頭コメント | L16 | `./main.ts create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--run-after-all]` |
| help 内 Usage | L1028 | `cmux-team create-task --title <title> [options]` — 変更不要 |
| グローバル usage | L1677 | `cmux-team create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--run-after-all]` |

### 既存の depends_on の使われ方

- **`task.ts` L46-62**: frontmatter から `depends_on` をパース済み。`[033, 034]` 配列形式と `033` 単一値形式に対応
- **`task.ts` L139（filterExecutableTasks）**: `depends_on` の全タスクが closed であることを依存解決の条件としている
- **`daemon.test.ts` L54**: テストで `depends_on: [${dependsOn.join(", ")}]` 形式で生成
- **`e2e.ts` L170**: E2E テストで `depends_on: [${dependsOn.join(", ")}]\n` 形式で生成

**結論: パース・実行判定は完成しているが、CLI からの書き出しだけが欠けている。**

## 3. サブタスク

### サブタスク 1: `getArg("depends-on")` の追加

**対象**: `main.ts` L1049 付近（`runAfterAll` 行の後）

**追加コード**:
```typescript
const dependsOn = getArg("depends-on") || "";
```

### サブタスク 2: depends_on のパースと frontmatter 出力

**対象**: `main.ts` L1089-L1098（frontmatter 生成部分）

`runAfterAll` と同様の条件付き改行挿入パターンで、カンマ区切り文字列を YAML 配列に変換して出力する。

**追加コード**（L1089 の前、depsArray のパース）:
```typescript
const depsArray = dependsOn
  ? dependsOn.split(",").map(s => s.trim()).filter(Boolean)
  : [];
```

**変更コード**（frontmatter テンプレート内）:
```typescript
priority: ${priority}${runAfterAll ? "\nrun_after_all: true" : ""}${depsArray.length > 0 ? `\ndepends_on: [${depsArray.join(", ")}]` : ""}
```

**出力例**: `--depends-on "081,082"` → `depends_on: [081, 082]`

### サブタスク 3: help テキストへの `--depends-on` 追加

**対象**: `main.ts` L1030-L1034（Options セクション）

**追加行**（`--status` の後に追加）:
```
  --depends-on <ids>      依存タスク ID（カンマ区切り、例: "081,082"）（任意）
```

### サブタスク 4: help の Examples に依存タスク例を追加

**対象**: `main.ts` L1036-L1038（Examples セクション）

**追加行**:
```
  cmux-team create-task --title "リファクタ" --depends-on "081,082" --status ready
```

### サブタスク 5: usage テキストへの `--depends-on` 追加

**対象 1**: `main.ts` L16（ファイル先頭コメント）
```
./main.ts create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--depends-on <ids>] [--run-after-all]
```

**対象 2**: `main.ts` L1677（グローバル usage）
```
cmux-team create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--depends-on <ids>] [--run-after-all]
```

## 4. 検証方法

```bash
# 1. depends_on 付きタスク作成（複数依存）
cmux-team create-task --title "テスト依存" --depends-on "081,082" --status draft --body "テスト"
cat .team/tasks/xxx-*.md
# → depends_on: [081, 082] が frontmatter に含まれていること

# 2. depends_on 付きタスク作成（単一依存）
cmux-team create-task --title "テスト単一" --depends-on "081" --status draft
cat .team/tasks/xxx-*.md
# → depends_on: [081] が frontmatter に含まれていること

# 3. depends_on なしの既存動作確認
cmux-team create-task --title "テスト通常" --status draft
cat .team/tasks/xxx-*.md
# → depends_on 行がないこと

# 4. help 表示確認
cmux-team create-task --help
# → --depends-on が Options と Examples に表示されること
```

## 5. リスク

- **既存機能への影響: なし** — `--depends-on` を指定しなければ `depsArray` は空配列となり、frontmatter に `depends_on` 行は出力されない
- **パース互換性: 問題なし** — 出力形式 `depends_on: [081, 082]` は `task.ts` L46-62 の既存パーサーが対応済み
- **変更範囲: 1ファイルのみ** — `main.ts` の `cmdCreateTask()` 関数内と usage テキスト2箇所のみ
