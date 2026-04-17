# T207 完了サマリー — paneId 永続化を廃止し surface → pane を on-demand 解決に統一

- Run: task-207-1776243788
- Branch: task-207-1776243788/task
- Verdict: GO（Critical 0 / Major 0 / minor 3）
- Phases: Plan → Design Review (Approved) → Impl → Inspection (GO)

## 完了したサブタスク

plan.md S1〜S20 すべて完了。S21（手動 E2E）は本セッションでは実行不可のため、impl-report の代替検証（型 + 全テスト + grep + 新規 unit test）でカバー。

## 設計判断

- **方針 A（フィールド完全削除）採用** — キャッシュ層自体を消すことで dummy 値混入経路を構造的に根絶（Decision Log D1）
- **新ヘルパー `cmux.listSiblingSurfaces(surface, workspace?)` を導入** — `cmux tree` 1 回呼びで「対象 surface の所属 pane → 同 pane 全 surface」を 1-pass で集約。`getPaneForSurface` と同一の line-by-line スキャン方式（D2）
- **`getPaneIdForSurface` (conductor.ts) と `getPaneForSurface` (cmux.ts) の重複を統一** — cmux 関連ヘルパーは cmux.ts に集約する既存パターンに準拠（D7）
- **後方互換削除** — `cmdSendMessage --pane-id` 引数 + i18n.ts ヘルプ + schema.ts フィールドを同時削除（D4）

## 変更ファイル

| ファイル | 変更概要 |
|---------|---------|
| `cmux.ts` | `listSiblingSurfaces` 追加 / `listPaneSurfaces` 削除 / `newSurface` のローカル param 名を `pane` に改名 |
| `cmux.test.ts` | `listSiblingSurfaces` 単体テスト 2 ケース追加 |
| `conductor.ts` | `getPaneIdForSurface` 削除 / `launchConductor` paneId 引数削除 / `createConductorPanes` 戻り値 `string[]` 化 / `resetConductor` に workspace 引数追加 + `listSiblingSurfaces` 経由 |
| `conductor.test.ts` | T176 createConductorPanes テストを `panes[0]!` 参照に追従 |
| `daemon.ts` | handleMessage / initializeLayout / updateTeamJson から paneId 削除 / `resetConductor` 呼び出し 3 箇所に `state.workspace` 追加 |
| `main.ts` | `onFullQuit` を `listSiblingSurfaces` 経由に / `cmdSpawnAgent` の team.json 経由 paneId 解決を `getPaneForSurface` 単発呼び出しに統一 / `cmdSendMessage --pane-id` 削除 |
| `i18n.ts` | en/ja の `--pane-id` ヘルプ削除 |
| `schema.ts` | `ConductorRegisteredMessage.paneId` / `ConductorState.paneId?` 削除 |

`git diff --stat`: 8 files / +133 -103

## テスト結果

- `bunx tsc --noEmit` → exit 0
- `bun test` → 274 pass / 0 fail / 558 expect calls
- `rg paneId skills/cmux-team/manager/` → 0 件
- `rg "pane-id" skills/cmux-team/manager/` → 0 件
- `rg listPaneSurfaces skills/cmux-team/manager/` → 0 件

## Design Reviewer findings 対応

- F1（S5 grep 順序）: ✅ S6 完了後に grep 検証
- F2（パース戦略）: ✅ `getPaneForSurface` と同一の line-by-line スキャン方式採用
- F3（helper unit test）: ✅ `cmux.test.ts` に 2 ケース追加
- F4（cmdSpawnConductor 追従）: ✅ 元々 2 引数呼び出しのため影響なし、tsc で確認

## 残課題

- **S21 手動 E2E**: 次セッションで `cmux-team start` 起動経路 + 任意タスク実行で確認
  - team.json に paneId フィールドが含まれないこと
  - daemon 再起動後に conductors_restored ログから pane 関連警告が出ないこと
  - spawn-agent 経由で Agent タブが Conductor と同じ pane に作成されること
  - abort-task → resetConductor で sibling close が正常動作すること

## マージコミット

- merge: `7b58f58c338e425c6573a7faf2e50be490d1d942`
- branch: `task-207-1776243788/task` → main
