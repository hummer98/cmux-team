# T143 完了サマリー

## タスク
TUI の Tasks パネルで Enter キーを押すと task.md を Markdown ビューアで開く

## 実施内容
- `resolveMarkdownViewer()` を `dashboard.tsx` で export し共通化
- 環境変数を `CMUX_TEAM_MD_VIEWER` に統一、デフォルトビューアを `mo` に変更
- `main.ts` のインラインビューア解決ロジック（10行）を共通関数呼び出し（1行）に置換

## 変更ファイル
1. `skills/cmux-team/manager/dashboard.tsx` — resolveMarkdownViewer() の修正・export
2. `skills/cmux-team/manager/main.ts` — 共通関数の import・使用
3. `package-lock.json` — 軽微な依存関係更新

## 検品結果
GO（全チェック項目に問題なし）

## マージ
ローカルマージ完了（Fast-forward: 39e4f25..0222844）
