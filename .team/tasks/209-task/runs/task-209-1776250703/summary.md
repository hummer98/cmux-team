# T209 リリース v3.48.0 — summary

## 概要

cmux-team v3.47.1 → v3.48.0 のリリース。`feat:` を含むため minor bump。

## 実施内容

1. CHANGELOG.md に T201/T203/T204/T205/T207/T208 のエントリを追記（既存の T206 ブロックに追加）
2. version を 3 ファイルで 3.48.0 に更新
   - `package.json`
   - `.claude-plugin/plugin.json`
   - `.claude-plugin/marketplace.json`
3. `chore: release v3.48.0` でコミット → タグ → push
4. plugin marketplace キャッシュ更新（git pull）
5. 旧キャッシュ削除（3.47.0 → 削除、3.47.1 のみ残す）
6. plugin 再インストール（uninstall → install）
7. GitHub Actions release.yml 監視（success）
8. npm install -g @hummer98/cmux-team@3.48.0 → cmux-team 3.48.0 確認
9. close-task で完了記録

## CHANGELOG エントリ要約

- **Added**: T204 restart-task aborted 対応
- **Changed (Breaking — soft)**: T206 conductor-settings 共通化
- **Changed**: T206 CMUX_SURFACE 必須撤廃 / --surface UUID 両対応, T207 paneId 永続化廃止, T203 SessionStart hook matcher 拡張
- **Fixed**: T201 startMaster PID フォールバック, T203 /clear 後 resume 失敗修正, T205 team.json sync flush, T208 classify-stop stop_reason ベース置換
- **Removed**: 旧 surface-settings ファイル, --pane-id 引数

## 成果物

- リリースコミット: `e7836b1 chore: release v3.48.0`
- タグ: `v3.48.0`
- npm: `@hummer98/cmux-team@3.48.0`
- plugin: 再インストール済み
- GitHub Actions: success（run 24450842695）

## 留意点

- worktree `task-209-1776250703` 内では作業せず、`PROJECT_ROOT` (main 側) で直接 commit/tag/push を実行
- worktree 内に差分は残っていない（後段で worktree 削除可能）
