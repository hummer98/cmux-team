# Summary: T152 Conductor 完了時にセッション上へ要約レポートを表示

## 完了サブタスク
- Phase 1: Planner Agent で実装計画書作成 — 完了
- Phase 3: Implementer Agent でテンプレート2ファイル修正 — 完了
- Phase 4: Inspector Agent で検品 — GO 判定

## 変更ファイル
- `skills/cmux-team/templates/conductor-role.md` — 完了時の処理にステップ8「完了レポートをセッション上に表示する」を挿入、既存ステップ番号を振り直し
- `skills/cmux-team/templates/conductor-task.md` — 完了通知セクションにレポート表示リマインダーを追加

## テスト結果
- 自動テストなし（テンプレートのプロンプト追記のみ）
- Inspector による全7チェック項目パス

## マージ
- Fast-forward マージ: 04c6a50..320f3c4
