---
id: 267
title: fix(cli): --depends-on をゼロパディング正規化する (issue #25)
priority: high
created_by: surface:199
created_at: 2026-04-19T06:17:03.922Z
---

## タスク
## 背景

GitHub issue #25: https://github.com/hummer98/cmux-team/issues/25

\`cmux-team create-task --depends-on 28\` のようにゼロパディングされていないタスク ID を渡すと、コマンドは成功するが依存が永遠に解決されず後続タスクが ready のまま起動しない（サイレント失敗）。

\`task-state.json\` のキーは 3 桁ゼロパディング文字列（\"028\"）で固定のため、比較時に \"28\" != \"028\" で一致せず、Manager は永遠に待機する。

## 現状の実装

\`skills/cmux-team/manager/main.ts:2545-2700\` 付近で \`--depends-on\` を処理している:

- create-task (\`cmdCreateTask\` 相当): \`dependsOnRaw.split(\",\").map(s => s.trim()).filter(Boolean)\` のみ。正規化なし
- update-task: 同上。\`depsArray\` を \`depends_on: [...]\` 形式で frontmatter に書き込むだけ

既存の手書きタスクは全て \`depends_on: [001]\` 形式（3桁ゼロパディング）で統一されているため、CLI 側の正規化漏れが原因。

## 修正方針

**CLI 入口で正規化する（案 A・推奨）。**

- 各 ID を \`String(Number(id)).padStart(3, \"0\")\` で 3 桁ゼロパディング化
- \`Number(id)\` が \`NaN\` または負数・非整数の場合は明示的にエラー終了（exit 1 + stderr にガイダンス）
- create-task と update-task の両経路で同じ正規化を通す（共通ヘルパー化を推奨）

### 期待エラーメッセージ例

\`\`\`
Error: --depends-on must be positive integer task IDs. Got: \"abc\"
\`\`\`

## 対象ファイル

- \`skills/cmux-team/manager/main.ts\` — create-task / update-task の \`--depends-on\` 処理
- （共通化する場合）ヘルパーの新規追加先は任意判断

## 確認事項

- 単体テストを追加: \`28\` → \`028\`、\`028\` → \`028\`、\`001,28\` → \`[\"001\",\"028\"]\`、不正入力（\`abc\`, 負数, 空文字混在）で exit 1
- 手動確認: \`cmux-team create-task --depends-on 28\` で frontmatter に \`depends_on: [028]\` と書かれること
- 既存テストが壊れないこと（\`bun test\` で main.test.ts を含む全テスト）

## 完了条件

- \`--depends-on\` の正規化が入り、非ゼロパディング入力でも依存が解決されるようになる
- 不正入力は早期 fail する
- テストで挙動が保証される
- PR description に issue #25 への参照を含める

## 参考

- issue 本文: 回避策として \`cmux-team update-task --task-id NNN --depends-on \"028\"\` で即座に正常化する実測あり
- 既存 frontmatter 形式: \`depends_on: [001]\` / \`depends_on: [001, 003]\`
