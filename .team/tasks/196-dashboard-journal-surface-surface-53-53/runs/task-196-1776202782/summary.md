# T196: dashboard Journal の surface 表記修正

## 変更内容

`skills/cmux-team/manager/dashboard.tsx:668` で Journal エントリの surface 表記から `surface:` prefix を剥がすように変更。

```diff
- entry.surface ? ui.text(`[${entry.surface}]`, { dim: true }) : null,
+ entry.surface ? ui.text(`[${entry.surface.replace("surface:", "")}]`, { dim: true }) : null,
```

他のパネル（Master / Conductors / Agents 行）と同じフォーマットに統一した。

## 変更ファイル

- `skills/cmux-team/manager/dashboard.tsx` (+1 / -1)

## テスト結果

- `npx tsc --noEmit`: EXIT=0（型エラーなし）
- 新規テスト追加なし（タスク指示通り。1行の trivial fix で ROI が低いため）

## 納品

- コミット: `0706c6e fix(dashboard): strip surface: prefix in Journal panel (T196)`
- マージ方法: ローカルマージ（fast-forward）
- マージ先: `main`

## 受け入れ基準チェック

- [x] Journal パネルに表示される surface が `[53]` 形式になる（`extractSurface()` は `surface:NNN` を維持しているが、描画時に剥がされる）
- [x] Master / Conductors / Agents 行の surface 表記は従来通り（L668 以外は変更していない）
- [x] tsc 通過
