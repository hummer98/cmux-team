# T347 サマリー: Full Quit コメントを T346 後の挙動に整合

## 変更概要

`skills/cmux-team/manager/main.ts` L865-L868 (Full Quit step 4) のコメントを T346 後の挙動と整合する形に書き換えた。**実装ロジックは無変更**。

## 修正前 / 修正後

修正前（古い記述）:

```
//    team.json から読んで全件 discard し、R7 方針で pane を新規作成しない
//    ため Conductor ゼロ台で着地する（Full Quit のセマンティクスは
```

修正後（T346 後の実態と一致）:

```
//    team.json から読んで全件 discard し、fallback 経路 → topup により
//    maxConductors 個の pane が新規作成される（T346: R7 廃止 + 事後条件
//    保証後）。pane 台数は最終的に揃うが、Full Quit のセマンティクスは
```

## 整合の根拠 (T346 = a6873be)

T346 は R7 (復帰時に pane を新規作成しない方針) を廃止し、`initializeLayout` の事後条件として `state.conductors.size === maxConductors` を保証するよう変更した。具体的には `daemon.ts` の `applyRestorePlan` 後に deficit > 0 で `initializeConductorSlots` を呼んで補充する (新ログキー `layout_conductors_topup`)。

Full Quit 後の次回起動の流れ:

1. `state.conductors.clear()` 済みなので team.json から読む既存 conductor は無い
2. （仮に clear() を忘れると死んだ surface が残り）`initializeLayout` で全件 discard
3. fallback 経路 → topup により `maxConductors` 個の pane が新規作成される

つまり修正前の「Conductor ゼロ台で着地する」は完全に逆になっており、修正後は「maxConductors 個」が正しい。

## 完了条件チェック

- ✅ コメントが T346 後の挙動と整合
- ✅ `bunx tsc --noEmit` pass (新規エラー 0、コメント変更のみなので当然)
- ✅ 既存テスト: コメント変更でロジック挙動は不変。ロジック側の事後条件保証は T346 で `daemon.test.ts` に M18a/M18b/M18c を追加済み

## 変更ファイル

- `skills/cmux-team/manager/main.ts` (コメント 4 行のみ)

## マージ・PR

- 納品方式: ローカルマージ (ff-only)
- マージコミット: `a8ee524` (main にfast-forward マージ)
