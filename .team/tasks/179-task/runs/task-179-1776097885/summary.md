# Release v3.44.0 Summary

## バージョン
- v3.43.0 → v3.44.0（feat: → minor bump）

## 反映されたコミット
- feat(layout): add 16x9 two-conductor layout mode (--layout=16x9)
- fix(logger): evaluate PROJECT_ROOT per call to prevent test log leakage
- test(logger): add regression tests for PROJECT_ROOT lazy evaluation
- feat(daemon): macOSスリープ抑止（caffeinate）をアクティブ時のみ有効化

## 変更ファイル
- CHANGELOG.md（v3.44.0 セクション追加）
- package.json
- .claude-plugin/plugin.json
- .claude-plugin/marketplace.json

## 実行結果
- リリースコミット: 7e06c1a `chore: release v3.44.0`
- タグ: v3.44.0（push 済み）
- GitHub Actions: run 24354790198 success（25s）
- marketplace キャッシュ: pull 済み
- 旧 plugin キャッシュ: 3.42.0 削除（3.43.0 は uninstall 時に削除される）
- plugin 再インストール: 成功
- npm: @hummer98/cmux-team@3.44.0 グローバルインストール確認済み

## 特筆事項
- 初回 `npm install -g` では 3.43.0 のまま解決されたため、`@3.44.0` 明示指定で再インストール。npm レジストリの反映タイムラグ対策。
