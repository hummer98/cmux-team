# T314 実装ログ

## 作業概要

`cmux-team status` の Tasks セクションで open/closed のカウントが誤る問題を修正。
aborted を明示的に別セグメントとして表示し、deleted は常に非表示とする。

plan.md に従い TDD（RED → GREEN → INTEGRATE → VERIFY）で実装。

## 変更ファイル一覧

| ファイル | 変更 | 行数 |
|---|---|---|
| `skills/cmux-team/manager/tasks-status.ts` | 新規作成（純粋関数 `buildTasksSectionLines`） | +28 |
| `skills/cmux-team/manager/tasks-status.test.ts` | 新規作成（6 ケース） | +75 |
| `skills/cmux-team/manager/main.ts` | import 1 行追加 + L1359-1364 置換 | ±5 |

## 実行コマンドと結果

### RED: テスト先行（関数未実装を確認）
```
$ bun test skills/cmux-team/manager/tasks-status.test.ts
error: Cannot find module './tasks-status'
 0 pass / 1 fail / 1 error
```
→ 期待通り fail。

### GREEN: 実装投入
```
$ bun test skills/cmux-team/manager/tasks-status.test.ts
 6 pass / 0 fail / 6 expect() calls
```
→ 全ケース pass。

### INTEGRATE: main.ts 置換
- `import { buildTasksSectionLines } from "./tasks-status";` を `buildRateLimitStatusLines` import 直後に追加
- L1359-1364 の 5 行を 4 行に置換（冗長な closedCount/openCount ローカル計算を撤去）

### VERIFY
```
$ bun test skills/cmux-team/manager
 1232 pass / 0 fail / 2997 expect() calls  (42 files, 52s)

$ bun test  # リポジトリ全体
 1232 pass / 0 fail / 2997 expect() calls  (42 files, 52s)
```

### typecheck
```
$ cd skills/cmux-team/manager && bun tsc --noEmit
```
→ 3 件のエラーが出るが、いずれも pre-existing で本変更とは無関係:
- `conductor.ts(201,3)` — 必須引数がオプショナルの後
- `daemon.test.ts(3870,9)` / `daemon.ts(1558,22)` — SESSION_STARTED の source 型
stash による切り分けで、私の変更前から存在することを確認済み。
新ファイル `tasks-status.ts` / `tasks-status.test.ts` および `main.ts` の差分にはエラー無し。

## 表示仕様（plan §1 の採用版）

| aborted 件数 | 表示 |
|---|---|
| 0 | `  open: N  closed: M` |
| ≥ 1 | `  open: N  closed: M  aborted: K` |

- `deleted` は常に非表示
- 想定外ステータスも silent drop（コメントで明記）

## 受け入れ条件チェック

- [x] 新規ファイル 2 個作成
- [x] `main.ts` の `cmdStatus()` が `buildTasksSectionLines` を利用
- [x] `bun test` リポジトリ全体 pass
- [x] 本変更由来の typecheck エラー無し
- [x] 作業ログ記録
