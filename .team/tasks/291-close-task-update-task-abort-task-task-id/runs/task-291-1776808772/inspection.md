# T291 検品結果

## Verdict

**GO**

## 検品サマリ

| 項目 | 結果 |
|---|---|
| `bun test`（manager 全体） | 994 pass / 0 fail |
| `bunx tsc --noEmit`（T291 起因） | 0 件（既知 3 件は main への git stash で pre-existing を確認） |
| 受け入れ基準 4 項目 | すべて満たす |
| plan 追加セルフチェック 5 項目 | すべて満たす |
| 下流コードへの破壊的変更 | なし（追加のみ） |
| 過剰実装 / スコープ違反 | なし |
| CLAUDE.md コーディング規約 | 遵守 |

## 受け入れ基準チェック

### タスク本文の受け入れ基準（4 項目）

- [x] `cmdCloseTask` / `cmdUpdateTask` / `cmdAbortTask` / `cmdDeleteTask` / `cmdRestartTask` が frontmatter `id:` を canonical key として使う
  - 5 コマンドすべてで `requireArg("task-id")` 直後に `resolveCanonicalTaskId` を呼び、`const taskId = canonical` で変数名を維持している（main.ts:2896, 3016, 3503, 3676, 3792）。plan 3.2 の共通パターンと一致。
- [x] slug 渡し・数字 id 渡しのどちらでも `task-state.json` の既存エントリが正しく更新される
  - 統合テスト 4 件（`update-task (T291)` / `close-task (T291)` / `delete-task (T291)` / `abort-task (T291)` in main.test.ts:609-681）で、slug 渡し後に canonical key（例: `"550"`）が更新され、slug キー（例: `"550-example"`）が作られないことを assert。
- [x] close-task 後 `team.json.conductors[].taskId` マッチに成功し CONDUCTOR_DONE が送られる
  - `close-task (T291): slug 渡しで team.json.conductors[].taskId マッチが成功し CONDUCTOR_DONE が送られる`（main.test.ts:636）で、mock HTTP 経由で `CONDUCTOR_DONE` 送信・surface/taskRunId/success の内容を assert。
- [x] 存在しない task-id 渡し時のエラーメッセージは従来通り（元の入力値で表示）
  - `close-task / update-task (T291): 存在しない task-id で元の入力値がエラーメッセージに表示される`（main.test.ts:684, 696）で、`"task 999-bogus not found"` が stderr に出ることを assert。`console.error` に `taskIdInput` を渡す実装も 5 箇所で一貫。

### plan 追加セルフチェック（5 項目）

- [x] `resolveCanonicalTaskId` のユニットテスト 5 ケース（数値 / 部分 slug / フル dir / 不在 / id 欠落）通る
  - `describe("resolveCanonicalTaskId (T291)")`（main.test.ts:713-769）の 5 test が全 pass。PROJECT_ROOT を env で差し替えるため bun subprocess 方式を採用しており、plan の testability 課題の妥当な落とし所。
- [x] 既存の T183 TASK_UPDATED テストが全て通る（回帰なし）
  - describe 内既存 7 test 全 pass、main.test.ts 単体 124 pass / 0 fail。
- [x] 追加した slug 渡し統合テスト 3 件通る（実際には 4 + 2 件追加で規模が合致）
- [x] CONDUCTOR_DONE 送信テスト（slug 経由）通る
- [x] `bun test` 全体グリーン / `bunx tsc --noEmit` 0 エラー（T291 起因）
  - 994 pass / 0 fail、tsc 既知 3 件は `git stash` で pre-existing 確認済み（後述）。

## コード品質評価

### plan との整合性

| plan 要件 | 実装 | 判定 |
|---|---|---|
| 3.1 `resolveCanonicalTaskId` 仕様 | main.ts:288-301。`findTaskFile` 経由 → readFile → `/^id:\s*(.+)$/m` → trim → falsy は undefined | ✅ plan と完全一致 |
| 3.2 共通パターン（`taskIdInput` + `canonical` + 再宣言 `const taskId = canonical`） | 5 箇所すべてで同一パターン | ✅ 一貫 |
| 3.2.1 cmdUpdateTask: findTaskFile 再呼び出し / not-found 防御線の保持 | 両方残されている | ✅ |
| 3.2.3 cmdAbortTask: canonical 不明で exit 1（旧「続行」からの挙動変更） | 実装済み（3500-3508）、plan 5.3 のリスク表にも記載通り | ✅ |
| 3.2.4 cmdRestartTask: canonical 不明で exit 1 | 実装済み（3673-3681） | ✅ |
| 3.2.5 cmdDeleteTask: cascadeAbortToChildren は canonical id で走る | 下流コードは無変更 → canonical id でそのまま渡る | ✅ |
| 3.3 エラー文言は元入力値 | `console.error` 5 箇所で `taskIdInput` を使用 | ✅ |

### 下流コードの保全

`git diff main` を精査し、`taskState[taskId]` / `conductor.taskId === taskId` / `postMessage({ taskId })` / `markTaskAborted(..., taskId, ...)` / `findTaskFile(taskId)`（後段再呼び出し）/ db insert 等は **一切変更されていない**（純粋な追加のみ）。plan 3.2 の「既存下流コード一切変更しない」方針を守っている。

### tsc 3 エラーの T291 起因検証

`git stash --include-untracked` で差分を退避し `bunx tsc --noEmit` を再実行した結果、同じ 3 件が再現:

```
conductor.ts(201,3)   TS1016
daemon.test.ts(3956,9) TS2322
daemon.ts(1597,22)    TS2352
```

いずれも `main.ts` / `main.test.ts` 以外のファイルであり、T291 の変更範囲外。impl-notes.md の主張（pre-existing）は正しい。別タスクでの解消推奨。

### 過剰実装 / スコープ違反

なし。

- 新規関数は `resolveCanonicalTaskId` 1 つのみで、findTaskFile の正規表現をあえて再利用して frontmatter 解析ユーティリティ化を避けている（plan の YAGNI 方針）。
- ログ方針（logger.ts 経由）の新規呼び出しは追加していない。findTaskFile も同様にログしないため一貫性あり。
- EventBus 変更なし。

### CLAUDE.md コーディング規約遵守

- **コメント最小**: 5 箇所の patch コメント（3-4 行）はいずれも T291 の意図（canonical 化）と下流影響の記述で、plan 3.2 の設計判断理由に直結。"WHY" のみで "WHAT" の冗長な重複はない。CLAUDE.md「Default to writing no comments. Only add one when the WHY is non-obvious」に合致。
- **エラーハンドリング**: `resolveCanonicalTaskId` 内の `readFile` 失敗を `try/catch` で undefined に倒す分岐は、findTaskFile の既存パターンと同型。過剰ではない。
- **日本語コメント / 英語コード識別子**: 守られている。
- **ロギングポリシー**: CLI コマンドの「not found」系は従来 `console.error` でエラーを出し即 exit 1 する設計。logger.ts の log() 呼び出しは該当 code path で元から使われておらず、T291 も追従している。一貫性あり。

## Findings

なし（critical / major / minor いずれも該当なし）。

## 推奨改善（非ブロッキング、T291 対象外）

1. **tsc 既知 3 エラーの解消**: 本 PR のスコープではないが、別タスクで `conductor.ts:201` / `daemon.ts:1597` / `daemon.test.ts:3956` を修正する価値あり。
2. **`resolveCanonicalTaskId` が `taskFile` path も返す拡張**: plan 5.3 で明記されている通り、タスク数が 1000 を超えるプロジェクトで findTaskFile の 2 重呼び出しが顕在化したら検討（現状は YAGNI でよい）。
3. **ユニットテストの subprocess 方式コスト**: 5 ケース × ~500ms = 2.5s。将来 PROJECT_ROOT を env 毎回参照する設計に倒したら軽量化可能だが、T291 の責務を超える。

## 結論

plan.md に書かれた設計・実装ステップが**過不足なく**反映されており、受け入れ基準 4 項目と追加セルフチェック 5 項目をすべて満たす。既存の 994 test に回帰は無く、T291 起因の型エラーも 0 件。下流コードを一切変更していないため、canonical 化の影響範囲が明確でリスクが最小化されている。cmdAbortTask / cmdRestartTask の挙動変更（canonical 不明で exit 1）も plan 3.2.3 / 3.2.4 通りで、孤児 taskState 防止という本タスクの目的に沿った安全側設計。

**GO。merge 推奨。**
