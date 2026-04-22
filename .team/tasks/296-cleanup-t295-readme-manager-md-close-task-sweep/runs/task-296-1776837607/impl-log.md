# T296 impl-log

## 変更ファイル（4 件）

### 1. README.md L110

旧:
```
| `cmux-team close-task --task-id <id> [--journal <text>]` | Close a task |
```

新:
```
| `cmux-team close-task --task-id <id> --deliverable-kind <files|merged|pr|none> [kind-specific flags] [--journal <text>]` | Close a task |
```

### 2. README.ja.md L110

旧:
```
| `cmux-team close-task --task-id <id> [--journal <text>]` | タスク close |
```

新:
```
| `cmux-team close-task --task-id <id> --deliverable-kind <files|merged|pr|none> [kind 別フラグ] [--journal <text>]` | タスク close |
```

### 3. skills/cmux-team/templates/en/manager.md L73

旧:
```
- **Primary completion detection**: Conductor executes `cmux-team close-task --task-id <TASK_ID> --journal "..."` → close-task internally sends CONDUCTOR_DONE to daemon's HTTP API `/api/messages`
```

新（引数を抽象化して陳腐化を防ぐ）:
```
- **Primary completion detection**: Conductor executes `cmux-team close-task ...` → close-task internally sends CONDUCTOR_DONE to daemon's HTTP API `/api/messages`
```

### 4. skills/cmux-team/templates/ja/manager.md L73

旧:
```
- **主要な完了検出**: Conductor が `cmux-team close-task --task-id <TASK_ID> --journal "..."` を実行 → close-task が内部で daemon の HTTP API `/api/messages` に CONDUCTOR_DONE を送信する
```

新:
```
- **主要な完了検出**: Conductor が `cmux-team close-task ...` を実行 → close-task が内部で daemon の HTTP API `/api/messages` に CONDUCTOR_DONE を送信する
```

## 検証

### Check 1: 旧署名（`--deliverable-kind` を含まない `close-task --task-id` 行）の残存

コマンド:
```bash
rg "close-task --task-id" docs/ CLAUDE.md README.md README.ja.md skills/cmux-team/templates/ | rg -v "deliverable-kind"
```

結果: **0 件（空出力）** — 期待通り。

### Check 2: 新仕様行（`--deliverable-kind` 付き）が conductor 系テンプレートに残存

コマンド:
```bash
rg "close-task --task-id.*deliverable-kind" skills/cmux-team/templates/
```

結果（抜粋）:
```
skills/cmux-team/templates/en/conductor-role.md: merged / pr / files / none 各 1 行（計 4 行）
skills/cmux-team/templates/en/conductor.md:      Step 11 の merged 例 1 行
skills/cmux-team/templates/en/conductor-task.md: Step 11 説明 1 行
skills/cmux-team/templates/ja/conductor-role.md: merged / pr / files / none 各 1 行（計 4 行）
skills/cmux-team/templates/ja/conductor.md:      Step 11 の merged 例 1 行
skills/cmux-team/templates/ja/conductor-task.md: Step 11 説明 1 行
```

期待通り — 新仕様の本丸である conductor-task.md（ja/en）および conductor-role.md / conductor.md の行は無傷。

## 気づいた点

- 今回 sweep した manager.md の 2 行は「Conductor が close-task を呼ぶことで daemon に CONDUCTOR_DONE が送られる」という **メカニズムの説明** であり、close-task の正確な引数を教える箇所ではない。そのため指示通り `cmux-team close-task ...` と引数部分を `...` に抽象化することで、今後の署名変更でも陳腐化しない形にした（引数詳細は conductor-role.md / conductor-task.md に集約）。
- README 2 ファイルは CLI 早見表（コマンド一覧テーブル）なので、引数を完全展開した新仕様を記述。kind 別フラグを `[kind-specific flags]` / `[kind 別フラグ]` と丸めることで表の幅が爆発しないよう配慮しつつ、`--deliverable-kind <files|merged|pr|none>` が必須であることは明示した。
