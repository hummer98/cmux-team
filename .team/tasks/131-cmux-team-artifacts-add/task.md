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
