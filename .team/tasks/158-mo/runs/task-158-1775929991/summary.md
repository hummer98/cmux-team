# T158: mo ビューアで既存ブラウザを再利用する — 完了サマリー

## 結果: GO（成功）

## 変更内容

- **対象ファイル**: `skills/cmux-team/manager/dashboard.tsx`（+32行, -1行）
- **追加関数**: `findExistingBrowserSurface()` — `cmux tree --json` で既存ブラウザ surface を検出
- **修正関数**: `openArtifactInViewer()` の mo ブランチ — 既存ブラウザあれば `goto` で再利用

## フロー

- Phase 1（Plan）: 直接作成（単純明快な変更のため）
- Phase 3（Impl）: Implementer Agent（surface:297）で実装
- Phase 4（Inspection）: Conductor が直接検品 → GO

## マージ

- ローカルマージ: `task-158-1775929991/task` → `main`
- コミット: `c77bdb0` feat: mo ビューアで既存ブラウザを再利用する
