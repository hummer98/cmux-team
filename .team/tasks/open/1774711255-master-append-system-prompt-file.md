---
id: 1774711255
title: Master起動時に--append-system-prompt-fileでロール定義を永続化
priority: medium
status: draft
created_at: 2026-03-28T16:30:38.858Z
---

## タスク
## 問題

Master は起動時に 'master.md を読んで指示に従ってください。' とユーザーメッセージでプロンプトファイルを読ませている。コンテキスト圧縮が進むとロール定義が薄れる可能性がある。

## 修正内容

Conductor と同様に、Master の Claude 起動時に --append-system-prompt-file でロール定義を永続化する。

### 起動コマンド変更

Before:
```bash
claude --dangerously-skip-permissions '.team/prompts/master.md を読んで指示に従ってください。'
```

After:
```bash
claude --dangerously-skip-permissions --append-system-prompt-file .team/prompts/master.md 'ユーザーからのタスクを待ってください。'
```

## 対象ファイル
- skills/cmux-team/manager/master.ts — spawnMaster()
