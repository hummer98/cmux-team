# T263 Summary: CONDUCTOR_DONE --success=false 時の worktree/branch 保持

## 完了したサブタスク

- **ST1**: `resetConductor` に `preserveWorktree?: boolean` オプション追加（conductor.ts）
- **ST2**: conductor.test.ts に 4 ケース追加（Case A/B/C/D — preserveWorktree true/false/未指定/broken）
- **ST3**: `handleConductorDone(state, conductor, opts?)` で task-state を読み、success=false && task-state ∈ {assigned, missing} なら worktree 温存、`conductor_done_unresolved` ログ発行
- **ST4**: daemon.test.ts に挙動テーブル 4 ケース追加（#1 success=true && closed, #6 success=false && closed, #9 success=false && assigned ★本命, #10 success=false && missing）

## 変更ファイル

| ファイル | 変更 |
|---|---|
| `skills/cmux-team/manager/conductor.ts` | +45/-21（preserveWorktree 分岐、worktree_preserved suffix） |
| `skills/cmux-team/manager/daemon.ts` | +49（handleConductorDone 拡張、loadTaskState、conductor_done_unresolved ログ） |
| `skills/cmux-team/manager/conductor.test.ts` | +190（T263 describe ブロック 4 ケース） |
| `skills/cmux-team/manager/daemon.test.ts` | +217（T263 describe ブロック 4 ケース） |

## テスト結果

```
bun test v1.3.12
 605 pass
 0 fail
 1453 expect() calls
Ran 605 tests across 25 files. [32.60s]
```

- 新規 T263 テスト 8 ケース全通過
- 既存テスト 597 件も全通過（破壊ゼロ）

## 型チェック

- touched files 起因の新規型エラーはゼロ
- 既存の 2 件（conductor.ts:197, daemon.test.ts:3650）は main ブランチでも発生する既存エラーで本タスクと無関係

## 仕様整合性

conductor-role.md Step 9.5 の「rebase 衝突時は worktree 削除せず、タスク状態 `assigned` のまま、success=false で通知」仕様と実装が一致。`grep conductor_done_unresolved manager.log` で人間判断待ちタスクを列挙可能。

## フェーズ実行

| フェーズ | Agent | 判定 |
|---|---|---|
| Plan | Planner | plan.md 24611 bytes, 10 ケース挙動表 + 5 サブタスク + 12 Decision Log |
| Design Review | Design Reviewer | Approved（6 minor findings） |
| Implementation | Implementer | 全 TDD サイクル完了、605 pass |
| Inspection | Inspector | **GO**（Critical 0, Major 0） |

## マージコミット

- `ee698d6` — fast-forward merge into main
- 納品方法: ローカルマージ（daemon 内部のバグ修正でレビュー済みのため）
- rebase 時: `origin/main` では up-to-date だったが、ローカル `main` が T265 で先行していたため `git rebase main` で解消してから ff merge
