# T246 Implementer Report

タスク: exclusive 属性の追加（排他タスク）

## 変更ファイル一覧（15 ファイル）

`git diff --stat`:

```
 .claude/commands/release.md             |  9 ++++---
 CLAUDE.md                               | 27 +++++++++++++++++++
 README.ja.md                            |  2 +-
 README.md                               |  2 +-
 docs/spec/03-commands.md                | 10 +++++++
 docs/spec/06-implementation-tasks.md    |  3 ++-
 package-lock.json                       |  4 +--
 skills/cmux-team/SKILL.md               | 24 ++++++++++++++-
 skills/cmux-team/manager/daemon.ts      | 16 ++++++++++++
 skills/cmux-team/manager/i18n.ts        | 20 ++++++++++++--
 skills/cmux-team/manager/main.ts        | 14 +++++++++-
 skills/cmux-team/manager/task.test.ts   | 46 +++++++++++++++++++++++++++++++--
 skills/cmux-team/manager/task.ts        | 45 +++++++++++++++++++++++++-------
 skills/cmux-team/templates/en/master.md | 26 +++++++++++++++++++
 skills/cmux-team/templates/ja/master.md | 24 +++++++++++++++++
 15 files changed, 247 insertions(+), 25 deletions(-)
```

注: `package-lock.json` は worktree 作成時点で既に変更済み（今回の実装とは無関係）。

### コード変更

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/task.ts` | `TaskMeta.exclusive: boolean` 追加。`parseTaskMeta` で `runAfterAll = runAfterAllRaw \|\| exclusive`（case A）。`sortByPriority` に ID 昇順タイブレーカー追加。`createTaskProgrammatic` に `exclusive?` 引数、生成時 `run_after_all` 強制、4-case conflict フィルタ `!(exclusive && t.exclusive)`、frontmatter 出力で `exclusive: true` を追加 |
| `skills/cmux-team/manager/main.ts` | `--exclusive` フラグ解析、`run-after-all` との同時指定で `create_task_redundant_flags` ログ、`createTaskProgrammatic` に `exclusive` を伝達 |
| `skills/cmux-team/manager/i18n.ts` | `help_create_task` に `--exclusive` オプション・Notes 2 行・Examples（EN/JA）を追加。`help_main` の create-task 行に `[--exclusive]` を追加 |
| `skills/cmux-team/manager/daemon.ts` | `scanTasks` でアサイン中の排他タスクを検出しログ `exclusive_lock_active` 出力 → early return（throttle guard の直後、assign ループ前） |
| `skills/cmux-team/manager/task.test.ts` | `makeMeta` に `exclusive: false` を追加。`sortByPriority` の「同じ優先度」テストを ID 昇順検証に書き換え。`parseTaskMeta — exclusive` describe 追加（3 テスト） |

### ドキュメント変更

| ファイル | 変更内容 |
|---------|---------|
| `CLAUDE.md` | `## タスク属性` 新規追加（3 フェーズモデル・衝突ルール・ユースケース） |
| `docs/spec/06-implementation-tasks.md` | 6.6 属性リスト更新、リリース運用に T246 行追加 |
| `docs/spec/03-commands.md` | create-task オプション一覧を `/team-task` 節に追加 |
| `README.md` / `README.ja.md` | create-task 行に `[--exclusive]` を追加 |
| `skills/cmux-team/SKILL.md` | `## 5. タスク属性` 新規追加、create-task CLI 行を更新 |
| `skills/cmux-team/templates/ja/master.md` | `## 排他タスクの提案` 追加（6 パターン + 提案フォーマット例） |
| `skills/cmux-team/templates/en/master.md` | `## Proposing Exclusive Tasks` 追加（英語版） |
| `.claude/commands/release.md` | 4 箇所の書き換え（description, body, `--run-after-all` → `--exclusive`, 共存注意書き） |

## 主要な実装ポイントと plan からの逸脱

### 実装ポイント

1. **case A 採用**: `parseTaskMeta` の段階で `exclusive=true` を見たら `runAfterAll=true` を強制する。`filterExecutableTasks` / run-after-all 待機ロジックは既存のまま変更なし
2. **衝突ルール（plan §5 の 4-case 表）を `createTaskProgrammatic` にそのまま実装**:
   - case 1 (excl × excl): 許容
   - case 2 (excl × 非 excl RAA): NG
   - case 3 (非 excl RAA × excl): NG
   - case 4 (RAA × RAA): 既存通り NG
3. **ID 昇順タイブレーカー**: `sortByPriority` の同一優先度時に `a.id.localeCompare(b.id)` を返す。排他タスクはスキャン時に先頭に並びやすくなる（ID ゼロパディング前提）
4. **exclusive lock guard**: `scanTasks` で `assigned` な exclusive があり、かつ `allExecutable.length > 0` の場合にログ出力して early return（drain 中の補助）
5. **redundant flag 警告**: `--run-after-all --exclusive` 同時指定時は警告ログのみ、作成自体は継続

### plan からの逸脱

なし。plan §9 の順序・各判断を忠実に実装した。

## 手動検証

`.team/` 隔離のためワークツリー外の tmpdir（`$TMP`）で `git init` して検証した（ワークツリー `.team/` は実行中のプロジェクトと共有のため）。ワークツリー内のタスク状態にはテストデータを残していない。

### 衝突ケース

| ケース | 期待 | 実行コマンド | 結果 |
|-------|------|-------------|------|
| case 1: excl × excl | 許容 | `create-task --exclusive` を 2 連続 | OK: 002-exclusive-b.md が作成 |
| case 2: excl × 非 excl RAA（tmpdir） | NG | `--run-after-all` 済タスクあり状態で `--exclusive` | `Error: run_after_all task already exists: 121` |
| case 3: 非 excl RAA × excl（tmpdir） | NG | `--exclusive` 済の後に `--run-after-all` | `Error: run_after_all task already exists: 001` |
| case 4: RAA × RAA | NG（既存） | 検証不要（既存挙動） | — |

### その他の検証

| 項目 | 結果 |
|------|------|
| `--exclusive --run-after-all` 同時指定 | `create_task_redundant_flags` がログ出力、タスクは正常作成 |
| `cmux-team create-task --help` 出力 | `--exclusive` オプション行・Notes・Examples が表示される |
| frontmatter 生成 | `run_after_all: true` + `exclusive: true` が両方出力される（round-trip 正常） |
| `bunx tsc --noEmit` | exit 0（型エラーなし） |
| `bun test skills/cmux-team/manager/task.test.ts` | 21 件全て pass |
| `git status --short` | 意図した修正のみ。テストタスクの残骸なし |

## 残課題

- `skills/cmux-team/manager/daemon.test.ts` で T121 / T195 / T232 の timeout 系テスト 3 件が fail しているが、`git stash` で本変更を退避した状態でも同じ 3 件が fail することを確認済み。タイミング依存の既存 flaky テストで、本実装とは無関係。
- `exclusive_lock_active` ログの継続出力抑制（rate-limit）は入れていない。scanTasks は throttle されるため実害は小さいが、長時間 drain 中は冗長になる可能性がある。必要なら別タスクで対応。
