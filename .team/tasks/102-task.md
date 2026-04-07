---
id: 102
title: タスク中心フォルダ集約: プロンプト・出力をタスクフォルダに統合
priority: high
created_at: 2026-04-07T01:03:43.315Z
---

## タスク
## 背景

Conductorが生成したプロンプト・出力がバラバラに配置されており、後から特定タスクの作業内容を追跡しにくい。タスク中心のフォルダ構造に集約する。

## 新構造

```
.team/tasks/T100-fix-journal-log-sort-order/
├── task.md                           # タスク定義
└── runs/
    └── task-100-1774283589/          # taskRunId（リトライ時に複数）
        ├── conductor-prompt.md       # Conductor への指示
        ├── agent-*.md               # Agent への指示（あれば）
        ├── summary.md               # 出力
        └── sessions.json            # Conductor/Agent の session-id 一覧（want）
```

## 採用方針

| 懸念点 | 解決策 |
|--------|--------|
| task-state.json 整合 | **案A: ハイブリッド** — loadTasks() を拡張し .md ファイルとディレクトリ両対応。stat で判定して分岐 |
| worktree からの参照 | **案D: 現状維持** — 絶対パスで渡しているので変更不要 |
| マイグレーション | **案G: 新規のみ** — 既存タスク（T001〜）はフラットのまま。新規からフォルダ構造適用 |

## 実装箇所

### 1. task.ts — loadTasks() のハイブリッド化
- `readdir` の結果で `.md` ファイル → 従来通り
- ディレクトリ → 内部の `task.md` を読む
- `parseTaskMeta` は変更不要（content と fileName を受け取るだけ）

### 2. main.ts — cmdCreateTask() のフォルダ作成
- 新規タスク作成時: `.team/tasks/T{NNN}-{slug}/task.md` に書き出し
- slug はタイトルから生成（既存のファイル名生成ロジックを流用）

### 3. template.ts — generateConductorTaskPrompt() のパス変更
- プロンプト出力先: `.team/tasks/T{NNN}-{slug}/runs/{taskRunId}/conductor-prompt.md`
- `.team/prompts/` への書き出しは廃止（新規タスクのみ）

### 4. conductor.ts — outputDir の変更
- 出力先: `.team/tasks/T{NNN}-{slug}/runs/{taskRunId}/`
- `.team/output/{taskRunId}/` への書き出しは廃止（新規タスクのみ）

### 5. conductor.ts — sessions.json の記録（want）
- タスク割り当て時に Conductor の sessionId を記録
- Agent spawn 時にも追記
- `claude --resume <session-id>` でログ追跡可能

### 6. schema.ts — TaskMeta にフォルダパス追加
- `taskDir: string` フィールドを追加（フォルダ構造の場合はディレクトリパス、フラットの場合はファイルパス）

## 後方互換

- 既存フラットファイル: そのまま読める（ハイブリッド）
- task-state.json: 変更なし（IDベースの管理は同じ）
- 旧 .team/prompts/ .team/output/: 残存ファイルはそのまま（削除しない）

## 対象ファイル

- skills/cmux-team/manager/task.ts
- skills/cmux-team/manager/main.ts
- skills/cmux-team/manager/template.ts
- skills/cmux-team/manager/conductor.ts
- skills/cmux-team/manager/schema.ts
