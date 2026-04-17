# T187 実行サマリ

## 結果
- **Verdict**: GO（検品済み、Minor 指摘 1 件のみ）
- **マージコミット**: `c4ad127 Merge branch 'task-187-1776137581/task' (T187 update-notifier)`
- **実装コミット**: `a900c9a feat(manager): auto-update を update-notifier + タスク自動起票に再設計 (T187)`

## フェーズ実行状況

| Phase | 担当 Agent | 結果 |
|-------|-----------|------|
| Phase 1 Plan | planner (surface:650) | plan.md 生成（15KB） |
| Phase 2 Review v1 | design-reviewer (surface:651) | Changes Requested（High x2, Medium x4, Low x4） |
| Phase 2 Replan | planner (surface:653) | plan.md 更新（27KB）で全指摘反映 |
| Phase 2 Review v2 | design-reviewer (surface:654) | **Approved** |
| Phase 3 Impl | impl (surface:656) | 208/208 テスト pass、17m27s |
| Phase 4 Inspection | inspector (surface:663) | **GO** (Minor 指摘 1 件) |

## 主な変更（16 ファイル / +941 / -196）

### 実装
- `skills/cmux-team/manager/package.json` — `update-notifier ^7.0.0` 追加
- `skills/cmux-team/manager/schema.ts` — `AutoUpdateMode` + `normalizeAutoUpdate()`
- `skills/cmux-team/manager/daemon.ts` — 旧 `checkNpmUpdate` 削除、`checkUpdateAndNotify` / `createUpdateTask` 追加
- `skills/cmux-team/manager/main.ts` — `resolveAutoUpdateMode`、`cmdSelfUpdate`、12h 周期呼び出し
- `skills/cmux-team/manager/task.ts` — `createTaskProgrammatic` を共通 API として切り出し
- `skills/cmux-team/manager/dashboard.tsx` — update バナー
- `skills/cmux-team/manager/i18n.ts` — help に `self-update` 追加

### テスト
- `skills/cmux-team/manager/main.test.ts` — `resolveAutoUpdateMode` / `normalizeAutoUpdate` マトリックス
- `skills/cmux-team/manager/daemon.test.ts` — `checkUpdateAndNotify` / `createUpdateTask` テスト追加

### ドキュメント
- `CLAUDE.md` — auto-update セクションを 3 モードに更新
- `README.md` / `README.ja.md` — 同上
- `docs/spec/05-install-and-infrastructure.md` — `autoUpdate: "off"` の例を追加
- `docs/spec/06-implementation-tasks.md` — T187 エントリ
- `CHANGELOG.md` — 破壊的変更とAdded 項目

## テスト結果

```
208 pass / 0 fail / 415 expect() calls / 13 files / 10.16s
```

## Minor 未対応項目（merge 後フォロー推奨）

- `update-notifier` の型定義欠如（`daemon.ts:20` で TS7016）— 実行・テストに影響なし
- 既存の型エラー 5 件は main ブランチ由来（cmux.ts / dashboard.tsx / main.test.ts / main.ts）で T187 では悪化なし
- 実 registry に対する E2E（TUI バナーの実表示、古い版 open タスクの supersede）は daemon を実稼働させないと確認不可

## 参照ファイル

- `plan.md` — 実装計画書（Design Review Approved 版）
- `design-review.md` — v1 レビュー（Changes Requested）
- `design-review-v2.md` — v2 レビュー（Approved）
- `impl-report.md` — 実装レポート
- `inspection.md` — 検品レポート
