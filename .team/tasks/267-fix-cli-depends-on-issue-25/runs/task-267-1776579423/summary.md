# T267 結果サマリー: fix(cli): --depends-on をゼロパディング正規化する (issue #25)

## 完了サブタスク

1. Plan — Planner Agent が plan.md を作成
2. Implementation — Implementer Agent が TDD で実装、impl-report.md を提出
3. Inspection — Inspector Agent が検品し **GO** 判定

## 変更ファイル

| ファイル | 変更 |
|---|---|
| `skills/cmux-team/manager/task.ts` | `normalizeTaskId` / `normalizeTaskIdList` ヘルパーを追加・export |
| `skills/cmux-team/manager/task.test.ts` | 28 テストケース追加（正常 14 / 異常 14） |
| `skills/cmux-team/manager/main.ts` | create-task / update-task の `--depends-on` 処理を正規化経由に差し替え |

## テスト結果

```
bun test skills/cmux-team/manager/
→ 625 pass / 0 fail / 1423 expect() calls (25 files, 30.65s)
```

追加テスト 28 件すべて green、既存テストは非後退。

## 手動検証

- `cmux-team create-task --depends-on 28` → frontmatter `depends_on: [028]` に正規化される
- `cmux-team create-task --depends-on abc` → stderr に `Error: --depends-on must be positive integer task IDs. Got: "abc"` を出力し exit 1
- `cmux-team update-task --depends-on ""` → `depends_on: []`（依存クリア経路を維持）

## 設計判断

- **ヘルパー配置**: `task.ts`（3 桁ゼロパディング規約の定義点と同一モジュール）に置いた。`main.ts` にインライン展開せず共通化
- **入力仕様**: `/^\d+$/` + 正の整数のみ受理。`0` / `000` も reject、空文字全体は `[]`（依存クリア）として許容
- **重複は保持**（dedup しない）: ユーザ入力順と重複を壊さない
- **エラーメッセージ**: `--depends-on must be positive integer task IDs. Got: "<raw>"` で統一、最初の invalid を報告

## 納品

- コミット: 後段で記載
- マージ先: main（ローカルマージ）

## 参考

- GitHub issue #25: https://github.com/hummer98/cmux-team/issues/25
- 回避策（update-task で正常化）は引き続き動作するが、本修正により create-task 側でも正規化されるため不要に
