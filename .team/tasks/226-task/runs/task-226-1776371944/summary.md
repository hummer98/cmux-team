# Release v3.51.0

## 前バージョン
v3.50.0

## 新バージョン
v3.51.0（minor bump — feat: を含み BREAKING CHANGE なし）

## 含まれるコミット
- feat: T225 direnv allow 未実行時に cmdStart / spawn-agent で fail-fast (ce492a4)
- docs: T217/T213/T204 の実装変更を docs/spec と cmux-team-guide に反映 T224 (cd4a639)
- fix: T223 envrc-prompt の env 変数ベース判定に修正 (dec2fb1)
- feat: T175 Master 稼働中ステータスを TUI スピナーに反映 (4ebe400)

## 実行ステップ
1. 現在のバージョン・コミット履歴取得
2. 新バージョン判定 (minor)
3. CHANGELOG.md に v3.51.0 エントリ追加
4. package.json / .claude-plugin/plugin.json / .claude-plugin/marketplace.json を 3.51.0 に更新
5. リリースコミット + タグ作成 + main/v3.51.0 push
6. marketplace キャッシュ更新 (~/.claude/plugins/marketplaces/hummer98-cmux-team)
7. 旧 plugin キャッシュ削除 (3.49.0 → 削除、3.50.0 → 残存)
8. claude plugin uninstall/install
9. GitHub Actions release.yml 監視 (RUN_ID=24532892483、success)
10. npm install -g @hummer98/cmux-team (3.51.0 確認)

## 成果物
- release commit: 08d42b7
- tag: v3.51.0
- npm: @hummer98/cmux-team@3.51.0
- plugin: 再インストール完了
