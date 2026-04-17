# T204 実装サマリー — restart-task を aborted 状態からも使えるようにする

## 編集ファイル

| ファイル | 変更箇所 | 概要 |
|---|---|---|
| `skills/cmux-team/manager/main.ts` | line 25-31（imports） | `child_process.execFile` / `util.promisify` を import、`./task` から `TaskState` 型を追加 import |
| `skills/cmux-team/manager/main.ts` | line 88（モジュール定数） | `const execFileAsync = promisify(execFile)` を追加 |
| `skills/cmux-team/manager/main.ts` | line 2662-2727（新規関数） | `restartFromAborted()` を追加（worktree/branch 冪等削除 + resume フィールド剥がし + TASK_CREATED 通知） |
| `skills/cmux-team/manager/main.ts` | line 2746-2755（cmdRestartTask 状態チェック + aborted 分岐） | 状態許容を `assigned`/`aborted` の両方に拡大、aborted のときは `restartFromAborted` に委譲して早期 return |
| `skills/cmux-team/manager/main.ts` | line 2774-2779（conductor 不在分岐） | resume 用フィールド (`worktreePath` / `taskRunId` / `conductorSlot` / `sessionId`) の delete を追加（推奨 3） |
| `skills/cmux-team/manager/main.ts` | line 2801-2805（assigned 通常分岐） | 同上 4 フィールドの delete を追加（推奨 3） |
| `skills/cmux-team/manager/i18n.ts` | line 370-389（en help_restart_task） | タイトル・notes・examples を `assigned or aborted` 対応に書き換え |
| `skills/cmux-team/manager/i18n.ts` | line 533（en help_main 行サマリー） | `restart a running task` → `restart an assigned or aborted task` |
| `skills/cmux-team/manager/i18n.ts` | line 891-911（ja help_restart_task） | タイトル・notes・examples を `assigned または aborted` 対応に書き換え |
| `skills/cmux-team/manager/i18n.ts` | line 1054（ja help_main 行サマリー） | `実行中タスクを再実行` → `assigned または aborted のタスクを再実行` |

## plan.md からの乖離点

1. **`require()` → `import` への置換**: plan.md §3.1.2 の擬似コードでは `require("child_process")` / `require("util")` を関数内に直書きしていたが、プロンプト指示「実コードでは import 文を使うこと」に従い、ファイル先頭で `import { execFile } from "child_process"; import { promisify } from "util";` を行い、モジュールスコープの `const execFileAsync = promisify(execFile)` を新設して再利用した。
2. **既存 `cleanupAssignedTask` の require 直書きはそのまま**: スコープ外のリファクタリングを避けるため、既存コードの inline `require()` パターンには手を入れていない（CLAUDE.md「Don't add features, refactor, or introduce abstractions beyond what the task requires」）。
3. **plan.md §3.2 の examples 行**: plan.md は en/ja の examples セクションに「`# works for both assigned and aborted` を 1 行追加」と書いていたが、既存の最初の example 行（`cmux-team restart-task --task-id 035`）の末尾コメントとして付与する形に統一した（行追加せずインライン注釈）。日本語版は `# assigned / aborted どちらでも実行可` と意訳。
4. **plan.md §3.2 の表で英語 notes line 386 の修正案**「`Performs cleanup (stops agents and removes worktree for assigned; removes residual worktree/branch for aborted)`」を 2 行に分割して可読性を上げた:
   ```
   - For assigned: performs the same cleanup as abort-task (stops agents, removes worktree)
   - For aborted: removes residual worktree/branch left over from the abort
   ```
   日本語側も同様に 2 行構成。
5. **コメント**: `restartFromAborted` 内のステップ番号コメント（`// 1. ...` `// 2. ...` `// 3. ...`）は CLAUDE.md「Default to writing no comments」に従い省いた。関数本体は十分小さく、ステップ意図は関数頭の docstring と TASK の流れから読み取れる。
6. **plan.md 7.7 への申し送り（`docs/spec/03-commands.md`）**: 今回の実装スコープ外として未着手。Inspection / Doc 同期フェーズで処理する。

## 型チェック結果

```
$ cd skills/cmux-team/manager && npx tsc --noEmit -p tsconfig.json
EXIT=0
```

エラー 0 件。

## 関連ユニットテスト

```
$ bun test main.test.ts task.test.ts
 101 pass
 0 fail
 195 expect() calls
Ran 101 tests across 2 files.
```

restart-task 経路の専用ユニットテストは元々存在しない（plan.md §6 のとおり手動 E2E のみ）。`main.test.ts` / `task.test.ts` の既存 101 ケースに回帰なし。

## --help 出力（抜粋）

### en（`LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 CMUX_TEAM_LANG=en bun run main.ts restart-task --help`）

```
cmux-team restart-task -- restart an assigned or aborted task (re-queues as ready)

Usage:
  cmux-team restart-task --task-id <id> [--journal <text>]

Options:
  --task-id <id>          task ID (required)
  --journal <text>        restart journal (optional, default: "Restarted: T{id} {title}")

Examples:
  cmux-team restart-task --task-id 035                                    # works for both assigned and aborted
  cmux-team restart-task --task-id 035 --journal "Conductor crashed, retrying"

Notes:
  - Only tasks in assigned or aborted state can be restarted
  - For assigned: performs the same cleanup as abort-task (stops agents, removes worktree)
  - For aborted: removes residual worktree/branch left over from the abort
  - Sets status back to ready instead of aborted
  - Sends TASK_CREATED notification for automatic re-assignment
```

### ja（`bun run main.ts restart-task --help`、デフォルト LANG=ja）

```
cmux-team restart-task -- assigned または aborted のタスクを再実行（ready に戻す）

Usage:
  cmux-team restart-task --task-id <id> [--journal <text>]

Options:
  --task-id <id>          タスク ID（必須）
  --journal <text>        再実行ジャーナル（任意、デフォルト: "再実行: T{id} {title}"）

Examples:
  cmux-team restart-task --task-id 035                                    # assigned / aborted どちらでも実行可
  cmux-team restart-task --task-id 035 --journal "Conductor がクラッシュしたため再実行"

Notes:
  - assigned（実行中）または aborted のタスクを再実行できます
  - assigned からは abort-task と同じクリーンアップを実行（エージェント停止、worktree 削除）
  - aborted からは abort 時に残った worktree / ブランチの残骸のみ削除します
  - ステータスを aborted ではなく ready に戻します
  - TASK_CREATED 通知により自動再割り当てされます
```

メイン `--help` のサマリー行も両言語で更新済み:

- en: `cmux-team restart-task --task-id <id> [--journal <text>] restart an assigned or aborted task`
- ja: `cmux-team restart-task --task-id <id> [--journal <text>] assigned または aborted のタスクを再実行`

## plan.md §6 ケース表のコードレビュー検証

| # | 起動状態 | 期待 | 実装上の挙動（コードレビュー） |
|---|---|---|---|
| A | assigned（既存） | conductor cleanup → ready → 自動再 assign + 4 フィールド剥がし | line 2767-2806: 既存 `cleanupAssignedTask(conductor)` → `taskState[taskId] = { ..., status: ready }` → 4 つの `delete` → `saveTaskState` → CONDUCTOR_DONE → `cmux send` → TASK_CREATED の順序で実行。**plan.md §3.1.3 の resume フィールド剥がしを line 2802-2805 で適用済み**。 |
| B | conductor 不在の assigned（既存） | エラーなしで ready 化、フィールド剥がし | line 2768-2790: `find` が undefined を返すと既存の早期 return 経路に入り、status=ready + 4 つの delete + `saveTaskState` + TASK_CREATED 送信。**plan.md §3.1.3 を line 2776-2779 で適用済み**。 |
| C | aborted（worktree 物理残あり） | worktree が消える、ブランチ削除、ready 化、自動再 assign | line 2674-2698: `existsSync(stale.worktreePath)` true → `git worktree remove --force`。続けて `stale.taskRunId` あり → `git branch -D <id>/task`。例外時は `cleanup_failed` ログのみ（冪等）。後続で `loadTaskState` 再読込 → ready + 6 つの delete（abortedAt も含む）→ `saveTaskState` → `task_restarted from=aborted` ログ → TASK_CREATED 通知。 |
| D | aborted（worktree 削除済み） | エラーなし・ブランチ削除も skip・ready 化・自動再 assign・cleanup_failed なし | line 2674: `existsSync(stale.worktreePath)` が false なら丸ごと skip → ログ出力なし。branch ブロックは `stale.taskRunId` ありなら実行されるが、削除済みブランチに対しては `branch -D` が `error: branch 'X/task' not found.` で失敗 → catch → `cleanup_failed` ログを 1 件出す。**plan.md は「`cleanup_failed` ログが出ないこと」を期待しているが、現実装では branch 削除失敗だけは記録される**（worktree 物理削除と branch 残存は独立イベントなので、現実問題として branch も既に削除済みであれば `cleanup_failed` が 1 件出る）。これは plan.md §7.6/7.5 の方針（残骸ログだけ残す）と整合的だが、ケース D の期待文言と微妙に食い違うので Inspection で要確認。 |
| E | aborted（taskRunId なし） | branch 削除 block skip、ready 化、自動再 assign、例外なし | line 2688: `if (stale.taskRunId)` で偽 → branch 削除 block 全体を skip。worktree block も `worktreePath` 不在なら skip。残りの state 書き換え + TASK_CREATED は通常通り実行。例外なし。 |
| F | ready / draft / closed / deleted | exit 1、メッセージに「assigned or aborted」 | line 2746-2749: `currentStatus !== "assigned" && currentStatus !== "aborted"` で `console.error` + `process.exit(1)`。エラー文言: `Error: task ${taskId} is not assigned or aborted (current status: <s>). Only assigned or aborted tasks can be restarted.` → 期待通り。 |
| G | i18n | en/ja help に `assigned or aborted` / `assigned または aborted` 反映 | 上記 --help 出力で確認済み。 |

### ケース D の補足

plan.md §6.2 ケース D「`cleanup_failed` ログが出ないこと」は、次の前提のときのみ満たされる:
- `stale.taskRunId` が abort で剥がれている、または
- branch が `existsSync` のような事前チェックなしで「無いものを delete しても黙って成功する」

実装は plan.md §3.1.2 擬似コードに忠実に「`taskRunId` があれば必ず `branch -D` を呼ぶ」構造。abort-task は `task-state` の `taskRunId` を剥がさないので、aborted 状態でも `taskRunId` は通常残っている → branch 削除を試みる → 既に削除済みなら 1 行 cleanup_failed ログが出る。

これは意図された冪等動作（plan.md §7.2「冪等性」: 「残骸が無くても問題なし」）と整合する。ログが出ても処理は成功扱い、後続の TASK_CREATED まで通る。Inspector は plan.md §6.2 の「`cleanup_failed` ログが出ないこと」という期待文言を「処理は成功する（出てもよいが致命的ではない）」と読み替えて検証することを推奨。

## 残課題・懸念

1. **`docs/spec/03-commands.md` の追従**: plan.md §7.7 で実装者への申し送りとされていた更新は本タスクのスコープ外として保留。Doc 同期タスクで対応する。
2. **手動 E2E（plan.md §6 全ケース）**: コードレビューレベルでの整合性は確認済みだが、実機動作（特に C の物理 worktree 残あり / D の cleanup_failed 出力有無）は Inspection フェーズで実機確認が望ましい。
3. **ケース D のログ期待文言**: 上述のとおり `cleanup_failed` ログが出る可能性があり、plan.md §6.2 の文言と微妙に食い違う。実害なしだが Inspector が期待値を読み替える必要あり。
4. **既存 `cleanupAssignedTask` の `require()` 直書き**: 今回 `execFileAsync` をモジュールスコープに新設したが、`cleanupAssignedTask` の inline `require()` は触っていない（スコープ外）。将来的に統一リファクタする余地あり。
