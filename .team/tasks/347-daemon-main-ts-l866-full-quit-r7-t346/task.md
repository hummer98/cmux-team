---
id: 347
title: daemon main.ts L866 Full Quit コメントの R7 言及を T346 後の挙動に整合
priority: medium
created_by: surface:54
created_at: 2026-04-26T12:26:20.537Z
---

## タスク
T346 (R7 廃止 + 事後条件保証) の Inspector 検品で発見された minor finding M-2。

## 背景

T346 で R7 (復帰時は pane 新規作成しない方針) を廃止し、initializeLayout の事後条件として
state.conductors.size === maxConductors を保証するようになった。これに伴い、Full Quit 後の
次回起動でも fallback ルート経由で maxConductors 個の pane が作成されるため、
`skills/cmux-team/manager/main.ts:866` の Full Quit 処理コメント
「R7 方針で pane を新規作成しないため Conductor ゼロ台で着地する」が
古い記述になった。

## 修正内容

main.ts L866 周辺の Full Quit コメントを T346 後の挙動 (次回起動で initializeLayout の
fallback 経路 → topup → maxConductors 個の pane が作成される) に整合する形に更新する。
実装挙動は変えない (コメントのみ)。

## 対象ファイル

- skills/cmux-team/manager/main.ts (L866 周辺)

## 完了条件

- コメントが T346 後の挙動と整合
- tsc エラーなし
- 既存テスト全 pass
