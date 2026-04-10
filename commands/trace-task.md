---
allowed-tools: Bash, Read, Glob, Grep
description: "タスクのセッション履歴を取得・分析する"
---

# /trace-task

タスクに関連した全セッション（Conductor + Agent）の履歴を取得し分析する。

## 引数

`$ARGUMENTS` にタスク ID を指定する（例: `T141`, `141`）。

## 手順

1. タスク ID を `$ARGUMENTS` から抽出（T プレフィックスがあれば除去）
2. CLI でセッション一覧を取得:
   ```bash
   cmux-team trace-task <task-id>
   ```
3. 出力された JSONL パスを `Read` ツールで開き、内容を分析
4. タイムライン・エラー・判断・成果物を要約して報告

## 注意

- JSONL ファイルは大きい場合があるため、`offset` + `limit` で必要な範囲だけ読む
- 全行を一度に読もうとしないこと
