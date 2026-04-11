# Summary: T154 — TUI の Enter キーで mo + cmux browser open による Markdown 表示

## 判定: GO

## 変更内容

`skills/cmux-team/manager/dashboard.tsx` の `openArtifactInViewer` 関数を修正:

- **mo ビューア使用時**: TUI を停止せず、`Bun.spawn(["mo", filePath])` でバックグラウンド起動 → 500ms 待機 → `cmux browser open http://localhost:6275` で別 surface にブラウザ表示
- **cat フォールバック**: 従来通り TUI 停止 → cat 実行 → TUI 再開

## 変更ファイル

| ファイル | 変更量 |
|---------|--------|
| skills/cmux-team/manager/dashboard.tsx | +16 / -21 |

## テスト結果

- 型チェック: パス（既存の無関係エラー3件のみ）
- Inspector 判定: GO（全5項目パス）

## マージ

- マージ先: main (fast-forward)
- コミット: 045ba7a
