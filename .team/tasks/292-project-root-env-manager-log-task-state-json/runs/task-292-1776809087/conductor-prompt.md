# タスク割り当て

## タスク内容

---
id: 292
title: テスト隔離: ダミープロジェクト + PROJECT_ROOT env で manager.log / task-state.json 汚染を防ぐ
priority: medium
created_by: surface:533
created_at: 2026-04-21T21:59:42.335Z
---

## タスク
## 背景

`bun test` 実行中に発生するファイル I/O が、repo 本体の `.team/logs/manager.log` および `.team/task-state.json` に混入する汚染バグが発覚した。T290 の対応中に `manager.log` から 4454 行（`+00:00]` / `Z]` タイムスタンプ）を手動除去した（バックアップ: `.team/logs/manager.log.bak-1776808684`）。task-state.json 側も過去に `task_id=1` 等のテストタスクが漏れていたことを確認済み（現状はクリーン）。

根本原因は **`skills/cmux-team/manager/logger.ts:67` の `const projectRoot = process.env.PROJECT_ROOT || process.cwd();`** が `PROJECT_ROOT` 未設定時に `cwd()` — つまり repo 自身 — にフォールバックすること。`process.env.PROJECT_ROOT` を設定していないテストが実プロジェクトの `.team/logs/` に append してしまう。

部分的対処として既に 8 つのテストファイルは `PROJECT_ROOT` を override しているが、**全 33 テストファイル中、env override / tmpdir setup の規約が統一されていない**。logger 以外でも `daemon.ts` / `task.ts` / `main.ts` 等が同様のパターン（env || cwd）を使っている可能性があり、横串で見直す必要がある。

## 目的

**テストが実プロジェクト配下のファイルを一切読み書きしない**構造に倒す。

## 方針（Agent 側で検証・調整してよい）

1. **ダミープロジェクト helper を新設** — `skills/cmux-team/manager/test-project.ts`（仮）等に、以下のような shape のヘルパーを集約:
   - `createDummyProject()` / `withDummyProject(fn)` で `fs.mkdtemp()` ベースの tmp dir を作り、`.team/` のサブ構造（logs/, tasks/, conductors/, output/, queue/ 等）を必要分だけ事前生成
   - `afterEach` / teardown で dir を再帰削除
   - `PROJECT_ROOT` env を override する方式を採用（`process.chdir` は **bun の parallel worker 下で非安全** なので不可）
2. **全 33 テストファイル** を順次このヘルパーに移行。直書きの `process.env.PROJECT_ROOT = ...` パターンは helper 経由に置き換え
3. **logger.ts を含む実装側** — `process.env.PROJECT_ROOT || process.cwd()` パターンが他にないか洗い出し、必要なら production 経路で「env 未設定時は明示エラーにする」方向も検討（ただし既存挙動の後方互換性を壊すと daemon が動かなくなるので、判断は Agent + Planner に委ねる）
4. **汚染検出の CI ガード** — テスト実行後に `.team/logs/manager.log` / `.team/task-state.json` が diff で汚染されていないことを検証するスクリプトを追加（任意、実装が軽ければ）

## 受け入れ条件

- `bun test` 実行後、repo の `.team/logs/manager.log` / `.team/task-state.json` / `.team/tasks/` / `.team/conductors/` / `.team/output/` / `.team/queue/` 等に **1 bit も変更が入らない**
- `git status` 上も `.team/` 配下に新規 untracked が増えない
- 既存の全テスト（`cd skills/cmux-team/manager && bun test`）がパス
- `tsc --noEmit` で **新規エラー 0**（pre-existing の 3 件は許容）

## 調査してほしい範囲

- `skills/cmux-team/manager/` 配下の `*.ts` で `process.env.PROJECT_ROOT` / `process.cwd()` / ハードコードされた `.team/` 参照がある箇所
- `bun test` の parallel worker 仕様と tmpdir 衝突リスク
- 既存 helper（あれば）との重複回避

## 関連

- T290: journal reason 構造化 — markTaskAborted 実装でテスト追加した際に汚染が顕在化
- 手動クリーンアップ実績: 2026-04-22 06:58 JST


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-292-1776809087` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-292-1776809087
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-292-1776809087/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/292-project-root-env-manager-log-task-state-json/runs/task-292-1776809087
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/292-project-root-env-manager-log-task-state-json/runs/task-292-1776809087/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
