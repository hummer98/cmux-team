# タスク割り当て

## タスク内容

---
id: 272
title: GitHub issue/PR キャッシュ (daemon管理, SQLite, CLI, TUI Issuesタブ, 誘導スキル)
priority: medium
created_at: 2026-04-19T14:07:05.787Z
---

## タスク
GitHub rate limit 枯渇対策として cmux-team daemon 管理の issue/PR キャッシュを整備する。詳細仕様は #26 を正とする。

## 納品方法

**main にマージせず PR として提出する。** レビューのしやすさ・段階導入の観点から、Phase 単位での分割 PR が望ましいが、一括 PR でも可（Conductor が判断）。

- 作業ブランチから `gh pr create` で PR を作成
- 本文に対応 issue (#26) と Phase 範囲を明記
- レビュー後のマージはユーザーが手動で行う — Conductor は **マージしない**

## 対象

- 起動ディレクトリの git repo のみ（非 git では機能非表示）
- issue / PR 本体 + 付属データ全部（comments, reviews, review_comments, labels, assignees, reactions, milestones 等）
- 初回 500 件 / 差分は手動同期

## 成果物

### Phase 1: DB + 差分同期の土台

- `.team/gh-cache.db` 新設（trace DB とは分離）
- スキーマ: `issues`, `comments`, `reviews`, `review_comments`, `labels`, `assignees`, `reactions`, `sync_meta`
- 認証解決: `GH_TOKEN` / `GITHUB_TOKEN` / `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` / `gh auth token` の順
- `cmux-team gh sync` で初回 500 件 + 差分同期（ETag 304 + `since` パラメータ）
- `cmux-team gh status` で最終 sync / rate limit 残を表示
- トークンローテ検知 → `token_hash` 不一致で自動パージ

### Phase 2: CLI

- `cmux-team issue list/show/search`
- `cmux-team pr list/show`
- `--json FIELDS` は gh のキー名互換（`state`, `title`, `assignees[].login`, ...）
- 書き込み系は対象外（`gh` に委ねる）
- 非 git ディレクトリでは exit with guidance

### Phase 3: TUI Issues タブ

- 現状のタブ列に `Issues` 追加（非 git リポジトリでは非表示）
- issue / PR 統合表示、アイコン or 色で種別識別
- ↑↓ で移動、updated_at 降順
- `Enter`: `$PAGER`（未設定時 `less -R`）で body + comments をプレビュー
- `Shift+Enter`: `open <url>`（macOS 前提）
- `R`: 手動 sync トリガー

### Phase 4: 誘導スキル

- cmux-team plugin に同梱
- `gh issue/pr` や `ghe` を使おうとする場面で `cmux-team issue/pr` へ誘導
- 使い方リファレンス + トリガー条件を含む SKILL.md

### Phase 5（任意・後送り可）

- GraphQL Projects V2 の `updatedAt` diff 方式

## 設計判断の根拠

- **DB 分離**: trace DB は rotation 対象・短寿命、gh キャッシュは長期保持 → GC ポリシー衝突を回避
- **手動 sync のみ**: daemon 定期 poll は rate 消費を読みにくくする。手動なら負荷予測しやすい
- **独自 CLI 形**: 既存 `cmux-team create-task` / `trace-task` と動詞+名詞で一貫。キャッシュ前提フラグ（`--sync`, `--stale-ok`）を自然に追加できる。JSON キー名のみ gh 互換で従来の使用感を維持
- **macOS 前提**: `open` で十分。Linux 対応は必要になったら追加

## 注意

- 初回 500 件は rate 消費が大きい。`--full` 実行時のみ全量取得、通常は差分で
- ETag はトークン単位で発行される。トークン変更時の無効化は必須
- 非 git / 未認証ケースでは crash させず、案内メッセージで機能停止


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-272-1776622205` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-272-1776622205
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-272-1776622205/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/272-github-issue-pr-daemon-sqlite-cli-tui-issues/runs/task-272-1776622205
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/272-github-issue-pr-daemon-sqlite-cli-tui-issues/runs/task-272-1776622205/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」Step 12 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
