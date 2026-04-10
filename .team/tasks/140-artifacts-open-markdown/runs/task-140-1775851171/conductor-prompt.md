# タスク割り当て

## タスク内容

---
id: 140
title: artifacts open サブコマンドで Markdown ビューアを起動
priority: medium
created_at: 2026-04-10T19:59:31.700Z
---

## タスク
## 概要

`cmux-team artifacts open <id>` で Artifact を Markdown ビューアで開けるようにする。

## 仕様

- **サブコマンド**: `cmux-team artifacts open <id>`
- **ビューア優先順位**:
  1. 環境変数 `CMUX_TEAM_MD_VIEWER` が設定されていればそのコマンドを使用
  2. デフォルト: `mo`（https://zenn.dev/tanatake/articles/4268692b417a10 参照）
  3. `mo` が見つからなければ `cat` にフォールバック（既存の show と同じ動作）
- **起動方法**: `<viewer> <artifact-file-path>` で実行
- **既存の `show` は変更しない**（標準出力は引き続き使える）

## 実装場所

- `skills/cmux-team/manager/main.ts` の `cmdArtifacts()` 関数（L1842 付近）に `open` サブコマンドを追加
- ヘルプテキスト（`i18n.ts`）にも追加

## 参考

- mo: ターミナル Markdown ビューア（`brew install mo`）
- 参考記事: https://zenn.dev/tanatake/articles/4268692b417a10


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-140-1775851171` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-140-1775851171
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-140-1775851171/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/140-artifacts-open-markdown/runs/task-140-1775851171
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/140-artifacts-open-markdown/runs/task-140-1775851171/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
