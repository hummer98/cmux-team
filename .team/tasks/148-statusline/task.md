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
