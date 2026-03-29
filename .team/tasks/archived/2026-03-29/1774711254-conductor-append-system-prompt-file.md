---
id: 1774711254
title: Conductor起動時に--append-system-prompt-fileでロール定義を永続化
priority: medium
status: draft
created_at: 2026-03-28T16:28:52.240Z
---

## タスク
## 問題

Conductor は /clear でコンテキストリセット後、ユーザーメッセージとしてプロンプトファイルを読ませている。ロール定義（Conductor としての責務・プロトコル）もタスク固有情報も同じプロンプトファイルに混在しており、毎回全量を送信している。

## 修正内容

Conductor の Claude 起動時に --append-system-prompt-file でロール定義を永続化する。

### 起動コマンド変更

Before:
```bash
claude --dangerously-skip-permissions 'Conductor として待機中。'
```

After:
```bash
claude --dangerously-skip-permissions --append-system-prompt-file .team/prompts/conductor-role.md 'Conductor として待機中。'
```

### プロンプト分離

- **conductor-role.md**（不変）: Conductor の責務・プロトコル・完了手順など。--append-system-prompt-file で起動時にセット。/clear しても消えない。
- **conductor-{id}.md**（タスク固有）: タスク内容・worktree パス・出力先など。/clear 後にユーザーメッセージとして送信。

### テンプレート変更

templates/conductor.md を2つに分割:
1. templates/conductor-role.md — ロール定義（変数なし or 起動時に確定する変数のみ）
2. templates/conductor-task.md — タスク固有情報（{{WORKTREE_PATH}} 等の変数を含む）

## 対象ファイル
- skills/cmux-team/manager/conductor.ts — initializeConductorSlots(), assignTask()
- skills/cmux-team/manager/template.ts — generateConductorPrompt() の分割
- skills/cmux-team/templates/conductor.md — 2ファイルに分割

## Journal

- summary: Conductor起動時に--append-system-prompt-fileでロール定義を永続化。conductor.mdをrole/taskに分割し、/clear後もロール定義が維持される設計に改善
- closed_at: 2026-03-28T18:55:48.784Z
