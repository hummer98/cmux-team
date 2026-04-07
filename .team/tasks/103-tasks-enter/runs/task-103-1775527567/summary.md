# T103 Summary: Tasks タブ Enter キーでタスクドキュメント表示

## 判定: GO

## 完了サブタスク
1. Plan 作成 — plan.md
2. Implementation — Implementer Agent (surface:24)
3. Inspection — Inspector Agent (surface:25), 全5項目 PASS

## 変更ファイル
- `skills/cmux-team/manager/daemon.ts` — TaskSummary に filePath 追加、scanTasks で転記
- `skills/cmux-team/manager/dashboard.tsx` — Enter キーハンドラに tasks 分岐追加、ヘルプ表示更新

## 変更内容
- Tasks タブでカーソル選択中のタスクに Enter を押すと、glow（フルスクリーンページャー）でタスクドキュメントを表示
- ESC/q で離脱し TUI に復帰
- 既存の Artifacts タブの Enter 実装パターンを完全に流用

## マージ
- Fast-forward マージ: main (a22230a → 35f0cc5 → dac9a39)
- plan.md はマージ後に削除済み
