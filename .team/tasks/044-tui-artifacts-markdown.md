---
id: 044
title: TUI Artifacts: 選択可能にしてMarkdownリーダーを起動
priority: high
created_at: 2026-04-02T16:58:15.266Z
---

## タスク
## 概要
TUI の Artifacts タブで、アーティファクトをカーソルで選択して Enter するとGFM準拠の Markdown Reader が起動する機能を追加する。

## 要件
1. Artifacts 一覧でカーソル移動＋Enter で選択可能にする
2. 選択時に環境変数 `CMUX_MD_VIEWER` で指定された Markdown ビューアを起動する
3. デフォルトは `glow`（未インストールなら `cat` にフォールバック）
4. `glow` は GFM 準拠のターミナル Markdown リーダー（Charm製）

## 仕様
- 環境変数: `CMUX_MD_VIEWER` — Markdown ビューアコマンド名（例: `glow`, `mdcat`, `bat`）
- フォールバック順: `CMUX_MD_VIEWER` → `glow` → `cat`
- 起動方法: `$VIEWER <artifact-file-path>` でサブプロセス実行
- TUI は一時停止し、ビューア終了後に復帰する（Ink の useInput を一時停止するか、alternateScreen を使う）

## 参考
- glow: https://github.com/charmbracelet/glow
- TUI 実装: skills/cmux-team/manager/src/tui/ 配下
