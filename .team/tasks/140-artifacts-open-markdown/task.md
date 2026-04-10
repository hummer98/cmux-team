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
