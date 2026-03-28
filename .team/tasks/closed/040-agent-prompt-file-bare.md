---
id: 040
title: Agent 起動時のコンテキスト最適化（--bare + プロンプトファイル化）
priority: high
status: draft
created: 2026-03-29
---

## 概要

Conductor → spawn-agent 経由での Agent 起動時にコンテキスト溢れが頻発している。CLI 引数にプロンプト全文を渡す現状を改め、ファイル経由 + --bare で最適化する。

## 現状の問題

1. Conductor が `--prompt "大量テキスト"` で spawn-agent CLI を呼び出す
2. spawn-agent が `claude --dangerously-skip-permissions '${prompt}'` としてシェルコマンドに埋め込む
3. プロンプト全文が CLI 引数として渡されるため、サイズ制限やエスケープ問題が発生
4. Agent が CLAUDE.md / hooks / plugins 等を自動読み込みし、コンテキストを圧迫

## 修正方針

### 1. プロンプトをファイル経由で渡す

spawn-agent CLI に `--prompt-file` オプションを追加:

```bash
bun run main.ts spawn-agent \
  --conductor-id xxx \
  --role impl \
  --prompt-file .team/prompts/agent-xxx.md
```

Conductor はプロンプトをファイルに書き出してからパスだけを渡す。

### 2. --bare モードで不要なコンテキスト読み込みをスキップ

```bash
claude -w <conductor-id> \
  --dangerously-skip-permissions \
  --bare \
  --system-prompt-file <role-definition> \
  --add-dir .team \
  "<prompt-file> を読んで指示に従って"
```

- `--bare`: CLAUDE.md / hooks / plugins / auto-memory 等をスキップ
- `--system-prompt-file`: ロール定義（researcher, implementer 等）を分離
- `--add-dir .team`: .team ディレクトリへのアクセスを許可
- ユーザーメッセージはファイル読み込み指示のみ（最小限）

## 影響範囲
- skills/cmux-team/manager/main.ts（cmdSpawnAgent）
- skills/cmux-team/templates/conductor.md（Agent spawn 手順の更新）

## Journal

- summary: spawn-agent に --prompt-file オプションと --bare モードを追加。Conductor テンプレートもプロンプトファイル方式に更新。
- files_changed: 2
