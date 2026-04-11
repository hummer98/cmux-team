# タスク 157 完了サマリー

## タイトル
mo ビューアでファイル指定URLを使い直接フォーカスする

## ステータス
**完了（GO 判定）**

## 変更ファイル
- `skills/cmux-team/manager/dashboard.tsx` — `openArtifactInViewer` 関数の mo ビューア部分を修正

## 変更内容
- `mo file.md --json` でファイル固有URL（`?file=<id>`）を取得
- 取得した URL を `cmux browser open` に渡して対象ファイルに直接フォーカス
- JSON パース失敗時は `http://localhost:6275` にフォールバック
- `await Bun.sleep(500)` を削除し `await moProc.exited` でプロセス完了を待機

## テスト結果
- TypeScript 型エラー: 既存の3件のみ（変更箇所外、main ブランチと同一）
- 新規型エラーの導入: なし

## マージ
- コミット: `6a52390` — Fast-forward マージで main に統合

## 検品結果
- 全5項目パス（コード品質、フォールバック、型安全性、既存機能への影響、エッジケース）
- 詳細: inspection.md 参照
