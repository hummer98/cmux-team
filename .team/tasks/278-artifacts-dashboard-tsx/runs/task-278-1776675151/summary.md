# T278 Summary

## 完了したサブタスク

1. Phase 1 — Planner Agent が plan.md を作成（ARTIFACT_VISIBLE_LINES=12、Tasks タブ同形の startIdx 計算を採用）
2. Phase 3 — Implementer Agent が `skills/cmux-team/manager/dashboard.tsx` を修正
3. Phase 4 — Inspector Agent が GO 判定（checklist 全通過、境界 6 ケース検証、Tasks タブ式と一致を確認）

## 変更ファイル

- `skills/cmux-team/manager/dashboard.tsx`（+19 / -3 行）

## 変更内容

- L33 に `ARTIFACT_VISIBLE_LINES = 12` を追加
- `buildArtifactRows` 内（L817〜832）にカーソル追従スクロールを導入:
  - Tasks タブ L1112-1117 と同形の `artifactStartIdx` 計算
  - `filtered.length > ARTIFACT_VISIBLE_LINES` のガードで小リスト時は全件表示
  - `visibleArtifacts = filtered.slice(startIdx, startIdx + ARTIFACT_VISIBLE_LINES)`
  - for ループを `visibleArtifacts.length` で回し、`isSelected = (artifactStartIdx + i) === state.artifactCursor`
- プレビュー描画・Up/Down キーハンドラは未変更

## テスト結果

- 型チェック: `dashboard.tsx` にエラーなし（既存の `conductor.ts:197`, `daemon.test.ts:3650` は本タスク範囲外）
- 境界ケース: 空リスト / 小リスト / 先頭 / 末尾 / カーソル戻し / 境界ちょうど の 6 ケースをコードレビューで確認済み

## 成果物

- plan.md
- impl-report.md
- inspect-report.md
- マージコミット: 086a29c（main に fast-forward）
- 納品方法: ローカルマージ（local main が origin より ahead の ahead-side 運用）
