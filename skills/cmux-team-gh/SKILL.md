---
name: cmux-team-gh
description: >
  Use when reading GitHub issues / PRs (github.com or GitHub Enterprise) from
  the current project. Triggers: mention of an issue/PR number (e.g. "#272",
  "issue 272", "PR #42"), user asks to run `gh issue`, `gh pr`, `ghe issue`,
  `ghe pr`, wants to see review / comment status, or asks "show me open issues
  / review requests / recent closed PRs". Use `cmux-team issue` /
  `cmux-team pr` / `cmux-team gh` instead of invoking `gh` directly for READ
  operations — the local SQLite cache avoids rate limit exhaustion. Writing
  (create / comment / close / merge / review) still goes through `gh`.
---

# cmux-team-gh: GitHub issue/PR キャッシュ経由の読み取り

このスキルは `cmux-team` plugin に同梱される GitHub issue/PR キャッシュの
使い方リファレンスです。`gh issue` / `gh pr` の **読み取り系** は
`cmux-team issue` / `cmux-team pr` に置き換えてください。

## なぜ `gh` を直接使わないか

- `gh` を叩くたびに GitHub API を呼ぶため、複数 issue を走査する用途
  （レビュー待ち一覧、最近 close された PR の確認等）で rate limit を
  消費しやすい。
- `cmux-team gh sync` は ETag (`If-None-Match`) + `since=` による差分同期で、
  変更がなければ **304 Not Modified**（rate limit 消費 0）で返る。
- 同一プロジェクト内で複数エージェントが同じ issue を参照する場合、
  キャッシュから読むため何度でも同じコストで読める。

## トリガー判定（Claude 向け）

以下のいずれかの場合にこのスキルを適用してください:

- ユーザーが issue/PR 番号に言及（`#272`, `issue 272`, `PR #42`, `T042` 等）
- ユーザーが `gh issue list` / `gh pr view` 等を実行したがっている
- ユーザーが `ghe ...`（企業 GitHub）を実行したがっている — 同じキャッシュで読める
- 「レビュー待ち」「open な PR」「直近 closed」「自分にアサインされた issue」等、
  issue/PR の問い合わせ全般
- `@me` に割り当てられた issue を探している
- 特定ラベル（`bug`, `help wanted` 等）の絞り込みをしたい

## 置換表

| 代わりに | 使うもの |
|---|---|
| `gh issue list --state open --limit 20` | `cmux-team issue list --state open --limit 20` |
| `gh issue list --assignee @me` | `cmux-team issue list --assignee @me` |
| `gh issue list --label bug` | `cmux-team issue list --label bug` |
| `gh issue view 272` | `cmux-team issue show 272` |
| `gh issue view 272 --json title,body,labels` | `cmux-team issue show 272 --json title,body,labels` |
| `gh pr list --state open` | `cmux-team pr list --state open` |
| `gh pr view 42` | `cmux-team pr show 42` |
| `gh pr view 42 --json state,title,reviews` | `cmux-team pr show 42 --json state,title,reviews` |
| `gh search issues keyword` | `cmux-team issue search keyword` |

JSON 出力のキー名は `gh --json` 互換です（`author.login`,
`assignees[].login`, `labels[].name`, `createdAt`, `mergedAt` など）。
既存の jq パイプラインをそのまま使えます。

```bash
# 例: open PR の author 一覧を取得
cmux-team pr list --state open --json number,title,author.login
```

## キャッシュが古いと感じたら

- **差分同期（ほぼ無料）**: `cmux-team gh sync`
  - 前回同期以降に更新された issue/PR のみ取得
  - 変更がなければ 304 Not Modified
- **フル同期**: `cmux-team gh sync --full`
  - 直近 500 件の issue/PR を最初から取得
  - 初回実行 / トークン変更 / **月 1 回の運用推奨**
  - 削除・transfer された issue を cleanup する唯一の手段
- **状態確認**: `cmux-team gh status`
  - 最終 sync 時刻、rate limit 残量、viewer login、issue/PR 件数
  - 「最終 full sync から N 日経過」表示に注意
  - 30 日を超えたら `--full` 推奨

### 省略コマンドとしての `--sync`

一発で同期 + 読み取りを行いたい場合は list/show に `--sync` を付けられます:

```bash
cmux-team issue list --state open --sync    # 事前 incremental sync してから表示
cmux-team issue show 272 --sync              # 対象 issue を同期してから表示
```

## TUI Issues タブ

`cmux-team start` で起動する Manager ダッシュボードには「Issues」タブが
あります（キーバインド `5` または `I`）。

- `R` — incremental sync を走らせる
- `Enter` / `O` — 選択中 issue を markdown ビューアで開く
- `B` — 選択中 issue の GitHub URL をブラウザで開く
- `↑` / `↓` — カーソル移動

## 書き込み系は `gh` を使う

以下の操作は本 skill の対象外です。引き続き `gh` を使ってください:

- `gh issue create` — issue 作成
- `gh issue comment` / `gh pr comment` — コメント追加
- `gh issue close` / `gh pr close` — クローズ
- `gh pr merge` — マージ
- `gh pr review` — レビュー送信

書き込みを行った後は `cmux-team gh sync` でキャッシュを更新してください。

## 無効化される状況

以下の場合、このスキルは使えません。従来通り `gh` を直接使ってください:

- 起動ディレクトリが git repo でない（exit 2）
- `origin` が GitHub / GHE でない（exit 2）
- 認証トークンが無い（exit 3）
  - `gh auth login` を実行するか、`GITHUB_TOKEN` / `GH_TOKEN` を設定

### rate limit 到達時（exit 4）

`cmux-team gh sync` が exit 4 を返した場合、しばらく待って（`reset_at`
表示を参照）再度実行してください。`cmux-team issue list --stale-ok` で
警告を抑止して古いキャッシュから読み続けることも可能です。

## Exit codes

| code | 意味 |
|---|---|
| 0 | 成功 |
| 1 | 汎用エラー |
| 2 | 非 git / 非 GitHub origin |
| 3 | 認証欠如 |
| 4 | rate limit 到達 |

## キャッシュの場所

- DB: `.team/gh-cache.db`（SQLite WAL）
- 本文 / raw JSON は同 DB 内に格納（別ファイルなし）
- トークンハッシュ不一致 / 異なる repo を検出したら自動 purge

プロジェクト毎に独立したキャッシュを持つため、複数リポジトリを横断して
参照する用途には使えません（各リポジトリで個別に `cmux-team start` /
`cmux-team gh sync` を走らせてください）。
