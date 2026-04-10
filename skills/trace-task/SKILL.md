---
name: trace-task
description: >
  タスクのセッション履歴を分析するスキル。
  Triggers: 「T141 を分析」「タスクの履歴を見せて」「セッション履歴」
  「trace task」「タスクのログ」「何が起きたか確認」等の発言。
---

# trace-task: タスクセッション履歴分析

タスクに関連した全セッション（Conductor + Agent）の情報を追跡・分析する。

## 手順

### 1. セッション一覧の取得

```bash
cmux-team trace-task <task-id>
```

出力例:
```
Task T141: SESSION_CLEAR で running Conductor のステータスをリセットする
Run: task-141-1775852524
Worktree: .worktrees/task-141-1775852524

Sessions:
  conductor    a87d71b5  surface:125   54 lines   ~/.claude/projects/.../a87d71b5.jsonl
  impl         1ad0d40a  surface:136   77 lines   ~/.claude/projects/.../1ad0d40a.jsonl
  inspector    xxxxxxxx  surface:137   45 lines   ~/.claude/projects/.../xxxxxxxx.jsonl
```

### 2. JSONL の分析

セッション一覧から JSONL パスを取得し、`Read` ツールで内容を確認する。

JSONL の各行は JSON オブジェクトで、主要フィールド:
- `type`: メッセージタイプ（`human`, `assistant`, `tool_use`, `tool_result` 等）
- `message.content`: メッセージ内容
- `timestamp`: タイムスタンプ

**大きな JSONL は `offset` + `limit` で範囲指定して読むこと。**

### 3. 分析観点

- **タイムライン**: 各セッションの開始・終了時刻、所要時間
- **エラー**: エラーメッセージ、リトライ、失敗パターン
- **判断**: Agent がどのような判断を下したか
- **成果物**: 生成されたファイル、コミット
