# タスク割り当て

## タスク内容

---
id: 178
title: logger.ts のログ出力先切替に関するリグレッションテスト追加
priority: medium
created_at: 2026-04-13T16:04:16.131Z
---

## タスク
## 背景

T177 で `skills/cmux-team/manager/logger.ts` の `PROJECT_ROOT` を module-level 定数から `log()` 内の都度評価に修正したが、直接的なリグレッションテストは追加していない（既存 `daemon.test.ts` が green になることで間接確認したのみ）。

module-level 定数に戻す変更が入ってもテストが通ってしまうため、再発防止が弱い。

## やること

`skills/cmux-team/manager/logger.test.ts` を新規作成し以下 3 ケースを追加する。

### 1. PROJECT_ROOT 遅延評価

- `import { log } from "./logger"` 済みの状態で `process.env.PROJECT_ROOT = tmpdir` を設定
- `await log("test_event", "detail=1")` を呼ぶ
- `<tmpdir>/.team/logs/manager.log` に該当行が書かれていることを assert
- 実プロジェクトの `.team/logs/manager.log` には書かれないことを assert（sentinel 文字列で確認）

### 2. 動的切替

- 同一プロセスで `process.env.PROJECT_ROOT = tmpdirA` → `log()` → `process.env.PROJECT_ROOT = tmpdirB` → `log()` を実行
- tmpdirA / tmpdirB 両方に期待される行がそれぞれ書かれていることを assert
- 定数キャッシュが復活していれば tmpdirB への書き込みが tmpdirA に流れる → その regression を検出できること

### 3. プロジェクト未汚染（sentinel ベース）

- テスト前に実プロジェクト `manager.log` 内の sentinel 文字列（ユニークなテスト専用 event 名、例: `regression_sentinel_<nonce>`）の出現数を記録
- テスト実行（上記 1 / 2 含む）後に再度数え、増加していないことを assert
- 並行実行耐性を考え、行数ではなく sentinel 文字列の件数で確認

## 実装上の注意

- `beforeEach` / `afterEach` で `process.env.PROJECT_ROOT` を退避・復元する（他テストへの影響防止）
- tmpdir は `os.tmpdir()` 配下に `mkdtemp` で確保し、`afterEach` で `rm -rf`
- テストは `bun test skills/cmux-team/manager/logger.test.ts` で実行できること
- 既存 142 テストが引き続き green であることを確認

## 完了条件

- `logger.test.ts` が追加され 3 ケース全て pass
- `bun test`（manager 全体）で 145 pass / 0 fail（既存 142 + 追加 3）
- 結果サマリーを `runs/<taskRunId>/summary.md` に記録


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-178-1776096256` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-178-1776096256
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-178-1776096256/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/178-logger-ts/runs/task-178-1776096256
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/178-logger-ts/runs/task-178-1776096256/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
