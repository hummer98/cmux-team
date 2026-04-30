# Release v4.18.0

## バージョン判定

- 前バージョン: v4.17.0
- 新バージョン: **v4.18.0**（minor bump）
- 判定根拠: `feat(dashboard):` コミットが含まれるため Conventional Commits ルールで minor

## 含まれるコミット

- `06de877 feat(dashboard): Pool Tokens セクションの reset 残り時間を列内で padStart 整列 (T377)`

## 実施した作業

1. CHANGELOG.md に v4.18.0 セクションを追記（Added）
2. 3 ファイルのバージョンを 4.17.0 → 4.18.0 に更新
   - `package.json`
   - `.claude-plugin/plugin.json`
   - `.claude-plugin/marketplace.json`
3. `chore: release v4.18.0` で commit（SHA: a75d1c2）
4. `v4.18.0` タグを打ち、main と tag を origin に push
5. plugin marketplace を `git pull` で同期
6. 古い plugin cache（4.17.0）を削除し、`claude plugin uninstall/install` で 4.18.0 を再インストール
7. GitHub Actions release.yml の成功を確認（RUN_ID=25064169023）
8. `npm install -g @hummer98/cmux-team` でグローバルインストール完了

## 納品

- merge commit: a75d1c2 (`chore: release v4.18.0` on main)
- tag: v4.18.0
- npm: @hummer98/cmux-team@4.18.0
- plugin: cmux-team@hummer98-cmux-team 4.18.0

## 検証

- `cmux-team --version` → `cmux-team 4.18.0` を確認
