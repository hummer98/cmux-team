# タスク割り当て

## タスク内容

---
id: 148
title: statusline: ロール別カスタムステータスバーの実装
priority: medium
created_at: 2026-04-10T22:53:53.048Z
---

## タスク
## 概要
ClaudeCode のフッターstatuslineをロール（Master/Conductor/Agent）別にカスタマイズする。
デフォルトのPR表示ポーリングを排除し、各ロールに必要な情報のみを表示する。

## 背景
- ClaudeCode フッターのPR表示（60秒ごとGitHub APIポーリング）が不要
- TUI側で表示済みの情報（レートリミット、タスク一覧、Conductor状態）は重複して表示しない
- ロールごとに見るべき情報が異なる

## 表示内容の設計

### Master
- モデル名
- コンテキスト使用率
- セッションコスト
- gitブランチ名

### Conductor
- タスクID + タイトル（短縮）
- worktreeブランチ名
- コンテキスト使用率
- モデル名

### Agent
- ロール名（researcher/implementer等）
- 親タスクID
- コンテキスト使用率（最重要）

## 実装方針
- `~/.claude/statusline.sh` にスクリプトを生成
- 環境変数（CONDUCTOR_ID、CMUX_ROLE等）でロールを判別して分岐
- ANSIカラー対応
- `CMUX_NERD_FONT` 環境変数でNerd fontアイコン/フォールバックを切り替え（TUIと同じ体系）
- `generateConductorSettings()` で生成する conductor-settings.json に `statusLine` キーを追加

## 変更対象ファイル
- `skills/cmux-team/manager/main.ts` — generateConductorSettings() に statusLine 設定を追加、Masterの設定にも同様に追加
- `skills/cmux-team/manager/statusline.sh`（新規）— ロール判別・表示スクリプト
- install スクリプト — statusline.sh を ~/.claude/ にコピー


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-148-1775909504` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-148-1775909504
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-148-1775909504/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/148-statusline/runs/task-148-1775909504
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/148-statusline/runs/task-148-1775909504/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
