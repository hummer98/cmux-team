# T309 Summary: Metrics タブから重複する「統合（5h/7d）」セクションを削除

## 結果

**Inspector 判定: GO**（一発 GO、修正ラウンドなし）

## 完了したサブタスク

1. Phase 1 (Planner): `plan.md` 作成 — 変更対象 4 ファイルの正確な行範囲、削除漏れ防止 grep、禁止事項を整理
2. Phase 3 (Implementer): TDD で削除実装 — 4 ファイル -28 行 / +0 行
3. Phase 4 (Inspector): 別セッションで検品 → GO

## 変更ファイル一覧

| ファイル | 変更 |
|---|---|
| `skills/cmux-team/manager/dashboard-metrics.ts` | -20 行（`MetricsData.unifiedFive`/`unifiedSeven` + JSDoc、描画ブロック全体） |
| `skills/cmux-team/manager/dashboard.tsx` | -4 行（2 箇所の `MetricsData` リテラルから代入行削除） |
| `skills/cmux-team/manager/i18n.ts` | -2 行（en/ja 両方の `metrics_section_unified` キー） |
| `skills/cmux-team/manager/dashboard-metrics.test.tsx` | -2 行（テストフィクスチャ） |

合計: **4 files changed, 28 deletions(-)**

## テスト結果

- `bun test skills/cmux-team/manager/dashboard-metrics.test.tsx`: 26 pass / 0 fail
- `bun test`（フル）: **1215 pass / 0 fail** (2957 expect, 40 files)
- `bunx tsc --noEmit`: 変更ファイルに新規型エラー 0 件

## 禁止事項の確認

`daemon.rateLimit.unified5hUtilization` / `unified7dUtilization` はヘッダー描画と
throttle 判定で使用中のため触らない、との plan の指示通り:

- `rg 'unified5hUtilization|unified7dUtilization' skills/cmux-team/manager/ | wc -l` → **49 件**（不変）
- `git diff --name-only | grep -v -E 'dashboard-metrics|dashboard\.tsx|i18n\.ts'` → **空**

## 消し漏れチェック

- `rg 'unifiedFive|unifiedSeven' skills/cmux-team/` → 0 件
- `rg 'metrics_section_unified' skills/cmux-team/ docs/ README*.md` → 0 件
- `rg 'unifiedFive|unifiedSeven|metrics_section_unified'`（全体） → 0 件

## 補足

- `package-lock.json` は worktree 開始時点で 4.5.1 → 4.6.0 の version 同期差分が出ていたが、
  本タスクの範囲外（release commit `30f6181` で package.json 側のみ bump された遺留物と推測）
  なので `git restore` で除外し、本コミットには含めない
- 本タスクは純粋な削除のため、ヘッダー側の `rate-limit-display.ts` 表示や throttle ロジックには
  一切影響しない（確認済み）

## 納品方法

ローカルマージ（ff-only）: `main` に直接マージ
