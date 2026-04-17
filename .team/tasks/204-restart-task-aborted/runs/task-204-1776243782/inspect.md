# T204 検品レポート

## 判定: GO

## 検証結果

### 1. コード差分

`git diff --stat` 結果:
```
 skills/cmux-team/manager/i18n.ts | 22 +++++-----
 skills/cmux-team/manager/main.ts | 90 ++++++++++++++++++++++++++++++++++++++--
 2 files changed, 99 insertions(+), 13 deletions(-)
```

main.ts の変更点（plan.md §3 と照合）:
- L26-31: `import { execFile } from "child_process"` / `import { promisify } from "util"`、`type TaskState` を `./task` から追加 import → impl.md「乖離点 1」記載通り、plan §3.1.2 擬似コードの `require()` 直書きを `import` に置換
- L88: `const execFileAsync = promisify(execFile)` モジュールスコープ定数を新設
- L2662-2727: `restartFromAborted()` 関数を新規追加 → plan §3.1.2 と完全一致
- L2746-2754: `cmdRestartTask` 状態チェック緩和 + aborted 早期 return → plan §3.1.1 + §3.1.2 と一致
- L2774-2777, L2800-2803: conductor 不在分岐と assigned 通常分岐に 4 フィールド delete を追加 → plan §3.1.3（推奨 3）と一致

i18n.ts の変更点（plan.md §3.2 表と照合）:
- en help_restart_task: title・notes・examples の文言更新（行追加なし、インライン注釈化）
- en help_main の restart-task サマリー行更新
- ja help_restart_task: 同等の更新
- ja help_main の restart-task サマリー行更新

→ plan.md §3.2 表との照合 OK。「Performs cleanup ...」の 1 行案を「For assigned: ... / For aborted: ...」の 2 行に分割した点は impl.md「乖離点 4」で説明済み、可読性向上のため妥当。

### 2. 状態チェック緩和

`main.ts:2746-2749`:
```typescript
if (currentStatus !== "assigned" && currentStatus !== "aborted") {
  console.error(`Error: task ${taskId} is not assigned or aborted (current status: ${currentStatus ?? "unknown"}). Only assigned or aborted tasks can be restarted.`);
  process.exit(1);
}
```

✅ `assigned` と `aborted` 両方を許可。エラーメッセージは plan §3.1.1 通り。

### 3. aborted 分岐の実装

`restartFromAborted` (`main.ts:2667-2728`) の検証:

| 観点 | 結果 |
|------|------|
| worktree 削除（冪等） | ✅ L2674-2687: `existsSync(stale.worktreePath)` 後に `git worktree remove --force`、try/catch で `cleanup_failed` ログのみ |
| branch 削除（冪等、`-D`） | ✅ L2688-2698: `stale.taskRunId` 存在時に `git branch -D ${taskRunId}/task`、try/catch で `cleanup_failed` ログのみ |
| task-state resume フィールド剥がし | ✅ L2710-2715: `worktreePath` / `taskRunId` / `conductorSlot` / `sessionId` / `abortedAt` / `assignedAt` の 6 フィールドを delete |
| `journal: [restart] ...` 形式 | ✅ L2705: `journal: \`[restart] ${journal}\`` |
| `task_restarted` ログに `from=aborted` | ✅ L2718-2721: `task_restarted task_id=... from=aborted journal_summary=...` |
| `TASK_CREATED` 通知送信 | ✅ L2723-2726 |
| `CONDUCTOR_DONE` を**送らない** | ✅ 関数内に CONDUCTOR_DONE 送信なし、関数頭の docstring にも理由明記 |

### 4. 推奨 3 の適用（assigned 分岐 + conductor 不在分岐）

- conductor 不在分岐 (`main.ts:2774-2777`): `worktreePath` / `taskRunId` / `conductorSlot` / `sessionId` の 4 フィールド delete 追加 ✅
- assigned 通常分岐 (`main.ts:2800-2803`): 同 4 フィールド delete 追加 ✅
- aborted 分岐との対称性: `abortedAt` を assigned/conductor 不在分岐で delete しないのは、それらの分岐では abortedAt が元々存在しないため妥当（不変条件として正しい）

### 5. i18n.ts の help 文字列

- `--help` 出力（en, `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 CMUX_TEAM_LANG=en`）:
  - `restart an assigned or aborted task (re-queues as ready)` ✅
  - `Only tasks in assigned or aborted state can be restarted` ✅
  - `For assigned: performs the same cleanup as abort-task ...` / `For aborted: removes residual worktree/branch ...` ✅
  - examples に `# works for both assigned and aborted` 注釈 ✅
- `--help` 出力（ja, デフォルト）:
  - `assigned または aborted のタスクを再実行（ready に戻す）` ✅
  - `assigned（実行中）または aborted のタスクを再実行できます` ✅
  - `assigned からは abort-task と同じクリーンアップを実行` / `aborted からは abort 時に残った worktree / ブランチの残骸のみ削除します` ✅
  - examples に `# assigned / aborted どちらでも実行可` 注釈 ✅
- `cmux-team --help` のメイン行サマリー: en `restart an assigned or aborted task` / ja `assigned または aborted のタスクを再実行` ✅

### 6. 型エラー

```
$ cd skills/cmux-team/manager && npx tsc --noEmit
TSC_EXIT=0
```

✅ 型エラーなし。`type TaskState` の追加 import が `restartFromAborted` の引数型に正しく対応。`taskState[taskId]!` の non-null assertion は直前の status チェックで担保されており安全。

### 7. テスト

```
$ bun test
 272 pass
 0 fail
 554 expect() calls
Ran 272 tests across 14 files. [8.70s]
```

✅ 既存テスト 272 件すべて pass。回帰なし。restart-task 経路の専用ユニットテストは元々存在せず、impl.md §「関連ユニットテスト」記載通り。

### 8. --help 出力の確認

`bun run main.ts restart-task --help` を en/ja 両方で実行し、上記 §5 の通り反映を確認済み。`bun run main.ts --help` のサマリー行も両言語で更新済み。

### 9. コーディング規約

- `restartFromAborted` 本体にはステップ番号コメント（`// 1.` `// 2.` `// 3.`）が省かれている → CLAUDE.md「Default to writing no comments」に準拠 ✅
- 関数頭の docstring（4 行）は **WHY**（Conductor 不在のため team.json 引かず CONDUCTOR_DONE も送らない）を説明しており、CLAUDE.md「Only add a comment when the WHY is non-obvious」を満たす ✅
- 後方互換のためのコメント・removed comments・rename 痕跡なし ✅
- ロギング: `formatExecError(e)` を使用し stderr/stdout が含まれることを確認（`exec-error.ts` 実装確認済み）、CLAUDE.md「ロギングポリシー」に準拠 ✅

### 10. 後方互換性

- assigned からの restart は既存パス（`main.ts:2756-2830`）が保持されており、`cleanupAssignedTask` → status=ready → CONDUCTOR_DONE → `cmux send` → TASK_CREATED の順序は変更なし
- 新規追加された 4 フィールド delete（推奨 3）は `assignTask` で上書きされる前のタイミングで状態を整える操作で、既存の挙動は壊さない（restart 直後〜再 assign の窓で「ready なのに resume 情報を持つ」不変条件違反を解消する方向）
- CLI インターフェース（`--task-id` / `--journal`）は互換、エラーメッセージのみ拡張
- task-state.json スキーマ変更なし、ログイベント名変更なし（`task_restarted` に `from=aborted` detail を追加するだけ）

→ ✅ 既存の assigned 動作は壊れていない。

## 批判的レビュー

### impl.md の「plan.md からの乖離点」評価

1. **`require()` → `import` への置換**: 妥当。CLAUDE.md / TS スタイル的にも自然。`execFileAsync` をモジュールスコープに格上げしたことで関数内の重複定義も解消されており、`restartFromAborted` のコード密度が上がっている。
2. **既存 `cleanupAssignedTask` の inline `require()` を放置**: スコープ最小化方針として妥当。CLAUDE.md「Don't add features, refactor, or introduce abstractions beyond what the task requires」に準拠。将来の統一リファクタ余地としてだけ残せばよい。
3. **examples のインライン注釈化**: 行追加せず末尾コメントに統合した判断は、help 全体の縦長化を避ける観点で妥当。
4. **notes 文の 2 行構成への分割**: 「assigned/aborted で挙動が違うことを 1 行で書く」より明らかに読みやすい。en/ja 両方で対称になっており妥当。
5. **`restartFromAborted` 内のステップ番号コメント省略**: 関数本体 60 行で十分把握可能、docstring が WHY を語っており冗長コメント不要。CLAUDE.md「Default to writing no comments」準拠。
6. **`docs/spec/03-commands.md` の追従未対応**: scope 外として保留扱い。実機影響なし、Doc 同期タスクで処理。

### 「ケース D の `cleanup_failed` ログ」問題の評価

`stale.taskRunId` が aborted 状態でも残っており、対応するブランチが既に削除済みの場合、`branch -D` が「branch not found」で失敗 → `cleanup_failed` ログ 1 件が出る。

評価:
- plan.md §6.2 ケース D の「`cleanup_failed` ログが出ないこと」期待は plan.md §3.1.2 擬似コード（taskRunId があれば必ず branch -D を呼ぶ）と矛盾しており、plan.md 内部の不整合
- 実装は plan.md §3.1.2 擬似コードに忠実
- plan.md §7.2「冪等性: 残骸が無くても問題なし」「全操作 try/catch で握り潰し」の方針とは整合的
- 実害なし: 処理は成功扱いで TASK_CREATED まで到達、ログが 1 件増えるだけ
- 修正するなら `git rev-parse --verify` での事前チェックや `git branch -D 2>/dev/null` のような無視が考えられるが、scope 外の最適化

→ **GO 判定で問題なし**。impl.md「ケース D の補足」で言及済み、Doc 同期 / 後続タスクで `git rev-parse --verify` 化を検討する余地あり。

### 「`loadTaskState` 2 回呼び出し」評価

- 1 回目: `cmdRestartTask` 冒頭 (L2744)、status チェック用
- 2 回目: `restartFromAborted` 内 (L2702)、書き戻し前の最新値取得用

race window:
- worktreePath / taskRunId は `stale`（1 回目スナップショット）から読む
- status 更新 + delete は `ts`（2 回目）にマージしてから書く

評価:
- restart-task はユーザー手動起動で並行実行はほぼ起こらない
- daemon は aborted タスクを assign 対象としないため、daemon 側からの書き換えも起きない
- もし 1 回目と 2 回目の間で他プロセスが worktreePath を消した → `existsSync` で skip されるので無害
- もし他プロセスが status を非 aborted に変更した → 1 回目に基づく分岐が古くなるが、書き込みは ts（最新）ベースなので致命傷なし
- 完全な correctness より「読みやすさ + 防御的再読み込み」のトレードオフとして許容範囲

→ **race は実用上回避できている**。気になるなら 1 回目のロードを省いて関数内 1 回読み込みに統一する余地はあるが、現状でも妥当。

### 「推奨 3 の delete 漏れ」評価

assigned 分岐と conductor 不在分岐で `abortedAt` を delete していないのは:
- assigned タスクは abort された時点で aborted 状態に遷移するため、assigned 状態のタスクに `abortedAt` は通常存在しない
- 過去の不整合データで `assigned` + `abortedAt` 同居がありえた場合のみ意味があるが、それを救済する責務は restart-task にない
- aborted 分岐では `abortedAt` を delete する必要があり、対称性は崩れているが「現在の status に対応する付帯フィールドのみ消す」という観点で妥当

→ ✅ 漏れではなく意図的。

### 「worktree 誤削除」評価

- `stale.worktreePath` は assignTask 時に記録された自タスクの worktree 絶対パスのみ
- TIMESTAMP 衝突は秒精度でも事実上ない
- 万一同一パスを別タスクが使っていても、削除対象は `stale.worktreePath` プロパティ（自タスクのもの）に限定される
- `git worktree remove --force` は登録された worktree のみ削除し、無関係なディレクトリには影響しない
- plan.md §7.4 の議論と整合

→ ✅ 危険性なし。

## まとめ

T204 の実装は plan.md §3 の意図を忠実に反映しており、状態チェック緩和・`restartFromAborted` 関数追加・推奨 3 の resume フィールド剥がし・i18n 文言更新がすべて plan.md の指示通りに行われている。型チェック (`tsc --noEmit`) はエラー 0 件、`bun test` は 272 件すべて pass、`--help` の en/ja 出力にも文言が反映されている。impl.md「乖離点」は require → import 置換・コメント省略・notes 2 行構成への分割といずれも妥当な判断で、後方互換性も維持されている。`cleanup_failed` ログがケース D で 1 件出る点は plan.md 内部の文言不整合に起因するもので、冪等性方針とは整合的かつ実害なし。**GO** 判定。残課題（`docs/spec/03-commands.md` および README の追従、`cleanupAssignedTask` の `require()` 統一）は本タスクのスコープ外として後続タスクで処理可能。
