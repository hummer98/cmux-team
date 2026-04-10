# 実装計画: update-task に --depends-on オプション追加

## 概要

`cmux-team update-task` コマンドに `--depends-on <ids>` オプションを追加する。
既存の `create-task` と同じパターン（カンマ区切り ID リスト）で受け付ける。

## 変更対象ファイル

**`skills/cmux-team/manager/main.ts`** のみ（1ファイル変更）

## 変更箇所

### 1. コマンドヘッダーコメント（17行目）

```
// Before:
 *   ./main.ts update-task --task-id <id> [--status <status>] [--body <text>] [--title <title>]

// After:
 *   ./main.ts update-task --task-id <id> [--status <status>] [--body <text>] [--title <title>] [--depends-on <ids>]
```

### 2. cmdUpdateTask 関数（1285行目〜）

#### 2a. 引数取得の追加（1290行付近）

```typescript
const dependsOn = getArg("depends-on");
```

#### 2b. 必須チェックの修正（1292行）

`--depends-on` 単体でも使えるよう条件に追加:

```typescript
if (newStatus === undefined && body === undefined && title === undefined && dependsOn === undefined) {
    console.error("Error: at least one of --status, --body, --title, or --depends-on is required");
    process.exit(1);
}
```

#### 2c. depends_on 更新ロジック（--title 処理の後あたりに追加）

```typescript
// --depends-on: frontmatter 内の depends_on 行を更新（なければ追加）
if (dependsOn !== undefined) {
    const depsArray = dependsOn
      ? dependsOn.split(",").map(s => s.trim()).filter(Boolean)
      : [];
    const depsValue = depsArray.length > 0 ? `[${depsArray.join(", ")}]` : "[]";
    let content = await readFile(taskFile, "utf-8");
    if (content.match(/^depends_on:\s*.+$/m)) {
      // 既存の depends_on 行を更新
      content = content.replace(/^depends_on:\s*.+$/m, `depends_on: ${depsValue}`);
    } else {
      // depends_on 行がなければ、frontmatter の最後の --- 前に追加
      const fmEnd = content.indexOf("---", content.indexOf("---") + 3);
      content = content.slice(0, fmEnd) + `depends_on: ${depsValue}\n` + content.slice(fmEnd);
    }
    await writeFile(taskFile, content);
}
```

#### 2d. 完了メッセージ更新（1347行付近）

```typescript
if (dependsOn !== undefined) parts.push("depends_on updated");
```

### 3. ヘルプテキスト（i18n.ts）

#### 英語版 help_update_task（260行付近）

Options に追加:
```
  --depends-on <ids>      dependency task IDs (comma-separated, e.g. "081,082") (optional)
```

必須チェック説明更新:
```
  * At least one of --status, --title, --body, or --depends-on is required
```

Examples に追加:
```
  cmux-team update-task --task-id 035 --depends-on "081,082"
```

#### 日本語版 help_update_task（716行付近）

Options に追加:
```
  --depends-on <ids>      依存タスク ID（カンマ区切り、例: "081,082"）（任意）
```

必須チェック説明更新:
```
  ※ --status, --title, --body, --depends-on のうち少なくとも1つが必要
```

Examples に追加:
```
  cmux-team update-task --task-id 035 --depends-on "081,082"
```

## テスト方法

```bash
# 1. depends_on がないタスクに追加
cmux-team update-task --task-id <id> --depends-on "081,082"
# → frontmatter に depends_on: [081, 082] が追加されること

# 2. 既存の depends_on を更新
cmux-team update-task --task-id <id> --depends-on "090"
# → depends_on: [090] に更新されること

# 3. --depends-on 単体で動作
cmux-team update-task --task-id <id> --depends-on "081"
# → --status なしでもエラーにならないこと

# 4. 空文字で依存をクリア
cmux-team update-task --task-id <id> --depends-on ""
# → depends_on: [] になること

# 5. ヘルプ表示
cmux-team update-task --help
# → --depends-on オプションが表示されること
```

## 完了条件

- `cmux-team update-task --task-id <id> --depends-on "081,082"` が正常動作する
- frontmatter の depends_on が正しく追加/更新される
- --depends-on 単体で使える（他オプション不要）
- ヘルプテキスト（英語・日本語）が更新されている
- コマンドヘッダーコメントが更新されている
