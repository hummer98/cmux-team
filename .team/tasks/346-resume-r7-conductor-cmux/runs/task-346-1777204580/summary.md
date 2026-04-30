# T346 Summary — resume R7 廃止 + Conductor 事後条件保証

## タスク

cmux クラッシュ後 `cmux-team resume` で Conductor が 0 個のまま throttled が永続するバグを修正。
R7（復帰時は pane 新規作成しない方針）を廃止し、`initializeLayout` の事後条件として
`state.conductors.size === maxConductors`（実質的には pane 数 = maxConductors）を保証。

## 実装フェーズ

| Phase | 結果 |
|---|---|
| Phase 1: Plan | plan.md 作成、変更箇所・テスト方針を精緻化 |
| Phase 2: Design Review | skip（中規模タスク・実装方針が明確） |
| Phase 3: Impl (TDD) | daemon.ts + daemon.test.ts を変更、全テスト pass |
| Phase 4: Inspection | GO 判定。Minor 2 件（M-1: daemon.ts L1019 docstring / M-2: main.ts L866 コメント） |
| Phase 4 後: M-1 修正 | docstring 更新で対応（self-touch ファイル） |
| Phase 4 後: M-2 起票 | T347 として別タスク起票（self-touch 外ファイル） |

## 変更ファイル

- `skills/cmux-team/manager/daemon.ts` (+46 / -10)
  - L1019 `applyRestorePlan` docstring: R7 言及を削除し T346 の topup 補充に整合
  - L1135-L1141 `applyRestorePlan` 内 D 経路コメント更新
  - L1273 `layout_restore_empty_fallback` 条件から `resumeNewSurface.length === 0` を削除（fallback 発動条件を緩和）
  - L1283-L1305 fallback 内で D 経路 resume を Map で taskId 一意化して `initializeConductorSlots` に透過
  - L1326-L1342 `applyRestorePlan` 後の事後条件チェック: `deficit > 0` で `initializeConductorSlots(deficit, undefined)` 補充。ログキー `layout_conductors_topup`
- `skills/cmux-team/manager/daemon.test.ts` (+254 / -13)
  - 既存 `layout_kept_partial` テスト修正（topup 検証追加 + 文言短縮）
  - 既存 partial restore 系 6 件に `state.mainBranch = "main"` 追加（topup 経路で T253 fail-stop 対応）
  - M16 に `newSplitSpy` 追加
  - `stubCmuxIO` ヘルパに `newSplit` のデフォルトモック追加（実 cmux 副作用遮断）
  - 新規 M18a/M18b/M18c 追加（事後条件保証の回帰テスト、特に M18c は本タスクが解いたバグの本質を捉えた回帰テスト）

## 検証結果

```
tsc --noEmit -p skills/cmux-team/manager/tsconfig.json: エラー 0 件
bun test layout-restore.test.ts: 10 pass / 0 fail
bun test daemon.test.ts: 173 pass / 0 fail (620 expect calls)
bun test conductor.test.ts: 38 pass / 0 fail
```

## 自己判断

| # | ポイント | 判断 |
|---|---|---|
| 1 | D 経路と外部 resumePlan の重複防止 | Map で taskId 一意化（plan.md の「単純結合」より構造的に強い実装） |
| 2 | M18 系の同期検証方法 | `initializeConductorSlots` が非 resume slot を pre-populate しない仕様に合わせ、M18a でのみ `CONDUCTOR_REGISTERED` simulate で最終 size 検証、他は `newSplit` 呼び出し回数 + 同期 size で代替 |
| 3 | テスト副作用の遮断 | `stubCmuxIO` ヘルパに `newSplit` モック追加（partial restore 系全般で topup 発動するため） |

## 残課題（後続タスク）

- **T347**: main.ts L866 Full Quit コメントの R7 言及を T346 後の挙動に整合（M-2 finding）

## 関連ファイル

- plan.md
- impl-report.md
- inspection.md
