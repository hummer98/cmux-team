# T289 Summary — Issues タブのカーソル追従スクロール修正

## 完了サブタスク

1. Planner Agent で plan.md 作成
2. Implementer Agent で TDD 実装（dashboard.tsx + dashboard-issues.test.tsx）
3. Inspector Agent で検品（GO）

## 変更ファイル

| path | 変更内容 |
|------|---------|
| `skills/cmux-team/manager/dashboard.tsx` | `ISSUE_VISIBLE_LINES = 20` 定数追加、`buildIssueRows` の else ブロックに `buildArtifactRows` と同一のカーソル追従窓計算を移植 |
| `skills/cmux-team/manager/dashboard-issues.test.tsx` | 回帰テスト 3 件追加（カーソル末尾 / 上端 / 件数 < VISIBLE） |
| `package-lock.json` | npm install の副作用で 4.2.0 → 4.3.0（main 側 package.json との既存不整合の補正） |

## テスト結果

- `bun test dashboard-issues.test.tsx`: 11 pass / 0 fail（既存 8 + 追加 3）
- `bun test`（全体）: 970 pass / 0 fail
- `bunx tsc --noEmit`: 新規エラー 0 件（既存 3 件は baseline、T289 対象外ファイル）

## Inspector 判定

**GO** — スコープ遵守、実装正確、テスト妥当、退行 0 件。

## マージ方法

タスク本文の指示通り main へローカル直接コミット（PR 不要）。
