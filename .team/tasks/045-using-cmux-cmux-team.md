---
id: 045
title: using-cmux を排他化し必要な機能を cmux-team に取り込む
priority: medium
created_at: 2026-04-02T17:32:58.785Z
---

## タスク
## 概要
using-cmux プラグインと cmux-team の競合を解消する。using-cmux の機能のうち cmux-team に必要なものを取り込み、排他にする。

## やること

### 1. Manager 起動時に using-cmux インストール警告
- daemon 起動時に using-cmux プラグインの存在をチェック
- インストールされていたら警告を表示（競合する旨を通知）

### 2. SessionStart hook の移植
- using-cmux の SessionStart hook を cmux-team の plugin.json に移動
- CMUX_SURFACE 環境変数がある場合はタブ名上書きをスキップ（cmux-team 管理下の surface）
- CMUX_SURFACE がない場合は [N] Claude Code を設定（従来の using-cmux の挙動）

### 3. cmux 操作知識の取り込み
- send の改行ルール（単一行 \n vs 複数行 send-key return）を SKILL.md に追加
- 基本操作コマンドリファレンスを SKILL.md に追加
- 制御キーの送信方法を追加
- cmux 環境検出（CMUX_SOCKET_PATH）を起動時チェックに追加

## やらないこと
- cross-workspace 操作（cmux-team は同一 workspace 内で動作）
- PTY 遅延初期化問題のワークアラウンド（new-split のみ使用）
- ペイン再利用の原則（固定レイアウト）
- cmux-grid（うまく機能しない）
