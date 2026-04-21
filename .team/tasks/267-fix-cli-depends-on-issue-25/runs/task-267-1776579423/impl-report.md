# T267 実装レポート: `--depends-on` ゼロパディング正規化

## 概要

GitHub issue #25 の修正。`cmux-team create-task --depends-on 28` で指定した ID が frontmatter に生値（`28`）で書かれ、`closedIds.has("028")` と一致せず子タスクが永遠に ready のままになるサイレント失敗を解消。

`task.ts` に `normalizeTaskId` / `normalizeTaskIdList` ヘルパーを追加し、`main.ts` の create-task / update-task CLI 経路で入力を正規化して frontmatter へ書き出すように変更。不正入力（英字・小数・負数・ゼロ等）は `Error: --depends-on must be positive integer task IDs. Got: "<raw>"` を stderr に出力して exit 1。

## 変更ファイル

| ファイル | 変更 |
|---|---|
| `skills/cmux-team/manager/task.ts` | `normalizeTaskId` / `normalizeTaskIdList` を追加・export |
| `skills/cmux-team/manager/task.test.ts` | §4.1 / §4.2 の全観点をカバーするテスト 27 件を追加 |
| `skills/cmux-team/manager/main.ts` | `normalizeTaskIdList` を import し、`cmdCreateTask` / `cmdUpdateTask` の depends_on 処理を差し替え |

## 設計判断（plan.md §2 に準拠）

- **ヘルパー配置**: `task.ts`（3 桁ゼロパディング規約の定義点と同一モジュール）
- **4 桁以上はそのまま**: `padStart(3, "0")` の minLength 仕様に揃える
- **`"0"` / `"000"` は reject**: 新規 ID は `maxId + 1 >= 1` のため ID 000 は存在しえず実害なし
- **空文字は `[]`**: update-task の「依存クリア」経路（`--depends-on ""`）を維持
- **重複は保持（dedup しない）**: `every(dep => closedIds.has(dep))` は重複でも論理正しく、ユーザの入力順・重複を壊さない
- **エラーメッセージは固定**: `--depends-on must be positive integer task IDs. Got: "${raw}"`。最初の invalid を `Got:` に報告

## テスト結果

### 追加テスト（`task.test.ts`）

- `describe("normalizeTaskId (T267)")`: 正常 6 件 + 異常 11 件 = 17 件
- `describe("normalizeTaskIdList (T267)")`: 正常 8 件 + 異常 3 件 = 11 件
- 計 28 件すべて green

### 回帰テスト

```
bun test skills/cmux-team/manager/
→ 625 pass / 0 fail / 1423 expect() calls (25 files, 30.65s)
```

既存の `parseTaskMeta depends_on`、`filterExecutableTasks`、`cascadeAbortToChildren` 等すべて非後退。

## 手動検証結果

`PROJECT_ROOT=/tmp/t267-verify bun skills/cmux-team/manager/main.ts` で実検証（検証後ディレクトリは削除済み）。

| ケース | コマンド | 結果 | 期待 |
|---|---|---|---|
| 1 | `create-task --title "dep-test-28" --depends-on 28` | `depends_on: [028]` | ✅ |
| 2 | `create-task --title "dep-test-028" --depends-on 028` | `depends_on: [028]` | ✅ |
| 3 | `create-task --title "dep-test-mix" --depends-on 1,28,100` | `depends_on: [001, 028, 100]` | ✅ |
| 4 | `create-task --depends-on abc` | stderr `Error: ... Got: "abc"`, exit 1 | ✅ |
| 5 | `create-task --depends-on "-1"` | stderr `Error: ... Got: "-1"`, exit 1 | ✅ |
| 6 | `update-task --task-id 003 --depends-on ""` | `depends_on: []`, exit 0 | ✅ |
| 追加 | `update-task --depends-on abc` | stderr `Error: ... Got: "abc"`, exit 1 | ✅ |

### 注意事項（getArg の仕様）

`getArg` は `--name <value>` 形式のみサポートし `--name=value` は未対応。`--depends-on=-1` は空値扱いとなるため、負数チェックは `--depends-on "-1"` のようにスペース + クォートで渡す必要がある（既存 CLI の全フラグ共通の仕様で本タスクの範囲外）。

## 受け入れ条件チェック（plan.md §5）

- [x] `task.ts` に `normalizeTaskId` / `normalizeTaskIdList` が export されている
- [x] `task.test.ts` に §4.1 / §4.2 の全観点をカバーするテストが追加され green
- [x] `main.ts` (create-task) が `normalizeTaskIdList` を通すように変更済み
- [x] `main.ts` (update-task) が `normalizeTaskIdList` を通すように変更済み
- [x] 不正入力時に `Error: --depends-on must be positive integer task IDs. Got: "<raw>"` が stderr 出力 + exit 1
- [x] `bun test skills/cmux-team/manager/` 全 625 テストが green
- [x] 手動検証 6 ケース + update invalid 追加 1 ケースすべて期待通り
- [x] README / docs/spec への追記は不要（CLI エラー文が自己説明的）
- [ ] **CHANGELOG.md への bugfix エントリ追加は未実施**（plan.md §6「CHANGELOG.md は close-task 時に Conductor が更新」の作業境界に従い、Implementer では触らない）

## 作業境界遵守

- 変更対象は `skills/cmux-team/manager/` 配下の 3 ファイルのみ
- README / CLAUDE.md / テンプレート / CHANGELOG.md は未変更
- `git commit` は行っていない（Conductor の責務）
- `.team/artifacts/` への書き込みなし
