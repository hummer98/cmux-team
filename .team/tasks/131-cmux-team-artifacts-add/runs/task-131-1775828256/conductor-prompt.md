# タスク割り当て

## タスク内容

---
id: 131
title: cmux-team artifacts add コマンドを追加（ファイル名指定で登録）
priority: medium
created_at: 2026-04-10T13:37:36.196Z
---

## タスク
## 概要

`cmux-team artifacts add <file>` コマンドを追加し、既存のマークダウンファイルをアーティファクトとして登録できるようにする。

## 現状

- アーティファクト作成は `/artifact` スキル経由のみ（Claude の会話コンテキストから生成）
- CLI には一覧・表示・検索・検証はあるが、登録コマンドがない

## 要件

- `cmux-team artifacts add <file-path>` でファイルを `.team/artifacts/` にコピー登録
- ID（Axxx）は自動採番
- ファイルにフロントマターがあればそれを活かす（id は自動採番で上書き）
- フロントマターがなければ最低限のフロントマターを付与（ファイル名からタイトル推定、type はオプションで指定可能）
- オプション: `--type <type>`, `--title <title>`, `--task <id>`, `--tags <tag1,tag2>`

## 実装箇所

- `main.ts` の `cmdArtifacts()` 関数内にサブコマンド `add` を追加
- ヘルプテキスト（i18n.ts）の更新

## 使用例

```bash
cmux-team artifacts add ./research-notes.md
cmux-team artifacts add ./design.md --type decision --title "認証方式の選定"
cmux-team artifacts add ./analysis.md --task T042 --tags "auth,security"
```


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-131-1775828256` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-131-1775828256
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-131-1775828256/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/131-cmux-team-artifacts-add/runs/task-131-1775828256
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/131-cmux-team-artifacts-add/runs/task-131-1775828256/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
