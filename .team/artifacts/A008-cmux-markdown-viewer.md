---
id: A008
type: research
title: "cmux markdown viewer の対応状況調査"
created: 2026-04-11T03:30:00+09:00
author: master
tags: [cmux, markdown, viewer]
---

## 調査対象

`cmux markdown open <file>` コマンドのマークダウンレンダリング対応状況。
cmux v0.63.2 で検証。

## GFM 対応状況

| 機能 | 対応 | 備考 |
|------|------|------|
| テーブル | OK | |
| タスクリスト（チェックボックス） | OK | |
| 取り消し線 | OK | |
| オートリンク | OK | |
| コードブロック | OK | シンタックスハイライトなし |
| mermaid | NG | コードブロックとして表示される |
| 画像 | NG | テキストとして表示される |

## 関連 issue

- [manaflow-ai/cmux#2069](https://github.com/manaflow-ai/cmux/issues/2069) — "Markdown viewer: render images and mermaid code blocks" (OPEN)
  - mermaid と画像の対応が feature request として起票済み
  - +1 リアクション済み

## 備考

- markdown パネルは terminal surface ではないため `cmux read-screen` で内容を読み取れない
- ライブファイル監視対応（ファイル更新時に自動リロード）
- `--direction` オプションで分割方向を指定可能
- TUI ダッシュボードの artifact ビューアとして `cmux markdown open` を使う場合、TUI 停止/再開が不要になるメリットがある（現在の glow 方式はページャーの TTY 問題で即終了する）
