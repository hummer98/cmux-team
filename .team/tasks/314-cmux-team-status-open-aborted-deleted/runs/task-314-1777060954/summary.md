# T314 完了サマリー

## タスク

`cmux-team status` の Tasks セクションで open カウントに aborted/deleted が混入していた問題を修正。

## 変更内容

### 新規ファイル

- `skills/cmux-team/manager/tasks-status.ts` — 純粋関数 `buildTasksSectionLines` を定義。`TaskMeta[]` を受け取り Tasks セクションの表示行 (`string[]`) を返す。
- `skills/cmux-team/manager/tasks-status.test.ts` — 6 ケース網羅（通常 / aborted>0 / 空配列 / deleted 無視 / aborted のみ / 想定外ステータス silent drop）。

### 修正ファイル

- `skills/cmux-team/manager/main.ts`
  - L75: `import { buildTasksSectionLines } from "./tasks-status";` 追加
  - L1361-1364: `closedCount`/`openCount` の filter 計算を削除し、`buildTasksSectionLines(tasks)` の結果を `console.log` に流す形に置換

## 表示仕様（採用: 案A 一行統合型）

| aborted 件数 | 表示 |
|--------------|------|
| 0 | `  open: N  closed: M` |
| ≥ 1 | `  open: N  closed: M  aborted: K` |

- `deleted` は常に非表示
- 想定外ステータスも silent drop（JSDoc で明記）

## テスト結果

- `bun test skills/cmux-team/manager/tasks-status.test.ts`: 6 pass / 0 fail
- `bun test`（リポジトリ全体）: 1232 pass / 0 fail / 2997 expect
- typecheck: 新規エラー 0 件（pre-existing エラー 5 行は本変更とは無関係）
- 実機 `cmux-team status`: `open: 2  closed: 298  aborted: 7` と期待通り表示

## 受け入れ条件チェック

| # | 条件 | 結果 |
|---|------|------|
| 1 | aborted / deleted が open にカウントされない | Pass |
| 2 | 実稼働タスク 0 件時に `open: 0` と表示 | Pass |
| 3 | aborted=0 時に余計な行が出ない | Pass |
| 4 | 既存 closed カウントは従来通り | Pass |
| 5 | `bun test` / typecheck 通過 | Pass |

## Inspector 判定

**GO**（Critical findings なし）。Minor findings は 2 点いずれも必須ではない改善提案。

## 納品方式

ローカル ff-only マージ（`main` へマージ）。

## 関連ファイル

- plan.md — 実装計画書（Planner 作成）
- impl-log.md — TDD 実装ログ（Implementer 作成）
- inspection.md — 検品レポート（Inspector 作成）

## マージコミット

- `118b759` fix(status): exclude aborted/deleted from open count (T314)
- main へ fast-forward マージ済み（`c9f5139..118b759`）
- rebase target: `origin/main` (= local main, SHA `c9f5139`)
- rebase conflict: なし
