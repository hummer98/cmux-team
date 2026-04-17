# T241 完了サマリ

`depends_on` 親タスクが `aborted` / `deleted` に遷移した瞬間、`depends_on` に親を含む
**ready** 子タスクを自動的に `draft` に戻す cascade を実装した。

## 完了したサブタスク

| ID | 内容 | 状態 |
|----|------|------|
| Phase 1 | Planner で plan.md 作成 | ✅ |
| Phase 2 | Design Reviewer レビュー（Approved, minor 4件） | ✅ |
| Phase 3 | Implementer 実装（Recommendation 1-4 適用） | ✅ |
| Phase 4 | Inspector 検品（GO, findings 0件） | ✅ |

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/task.ts` | `CascadeAbortResult` 型 + `cascadeAbortToChildren` 関数を追加 |
| `skills/cmux-team/manager/daemon.ts` | 3 経路（user_clear / forceClose / assign_failed）に cascade 呼び出し追加 |
| `skills/cmux-team/manager/main.ts` | 2 経路 3 箇所（cmdAbortTask×2 / cmdDeleteTask）に cascade 呼び出し追加 |
| `skills/cmux-team/manager/task.test.ts` | pure function テスト 6 ケース追加 |
| `skills/cmux-team/manager/daemon.test.ts` | 統合テスト 7 ケース追加（5 直接 + 回帰 1 + E2E 1） |
| `CLAUDE.md` | 「エラーリカバリ」セクション直下に `### 依存タスクの cascade（T241）` を追記 |

## cascade 呼び出し箇所（5 経路 6 箇所）

```
daemon.ts:1677  user_clear 経路
daemon.ts:1839  assign_failed 経路（scanTasks 内 AssignTaskError kind="task" 分岐）
daemon.ts:2182  forceCloseDisconnectedConductor（disconnect timeout）
main.ts:2998    cmdAbortTask（Conductor 不在分岐）
main.ts:3030    cmdAbortTask（Conductor 有り分岐）
main.ts:3283    cmdDeleteTask
```

## テスト結果

- `bun test task.test.ts`: **24 pass / 0 fail**（うち T241 新規 6 ケース）
- `bun test daemon.test.ts`: **96 pass / 0 fail**（うち T241 新規 7 ケース）
- `bun test`（全体）: **458 pass / 0 fail**
- `bunx tsc --noEmit`: クリーン（既存型エラーの新規導入なし）

## 仕様適合性

- ✅ 親 abort/deleted → ready 子が draft に戻る（5 経路 6 箇所すべてカバー）
- ✅ 子 journal に `parent_aborted: <parentTaskId>` 追記（既存 journal は `; ` で連結）
- ✅ ログ `child_reverted_to_draft parent=<X> child=<Y> reason=parent_aborted`（delete 経路含め統一）
- ✅ ready のみ draft 化（draft/assigned/closed/aborted/deleted は変更なし）
- ✅ 循環 depends_on で O(N) 終了（1 パス走査、再帰なし）
- ✅ 既存正常系（親 closed → 子 assigned）に回帰なし

## 設計判断（主要なもの）

- **D1**: cascade 関数は `task.ts` に配置（daemon / CLI 両方から呼ぶ純粋関数）
- **D3**: `closed` Set（daemon.ts:1728-1732）は**変更しない** — cascade で子が draft になれば `filterExecutableTasks` の `status !== "ready"` 判定で自然に弾かれる二重防御
- **D7**: ログ reason は全経路 `parent_aborted` で統一（delete 経路でも）

## 受け入れ条件（task.md）

- ✅ 親が abort/deleted になった瞬間に、ready 子が自動で draft に戻る
- ✅ 子の journal から理由が追跡できる（`parent_aborted: <parentId>`）
- ✅ 既存の正常系（親 closed → 子 assigned）に回帰なし

## 納品

- マージコミット: `7368964` (main)
- 子コミット: `ab1d370` feat(manager): T241 depends_on 親 abort/deleted 時に ready 子を draft に戻す cascade
- 成果物は main にローカルマージ済み
- worktree 削除済み、branch 削除済み
