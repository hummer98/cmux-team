# リリース v3.47.1 完了

## バージョン判定
- v3.47.0 → v3.47.1 (patch bump)
- 対象コミット: `39611c6 fix(manager): skip dead conductors on restart to avoid stuck disconnected state`
- 判定根拠: `fix:` 1 件のみのため patch

## 変更ファイル
- CHANGELOG.md
- package.json
- .claude-plugin/plugin.json
- .claude-plugin/marketplace.json

## コミット / タグ
- commit: `4e85bda chore: release v3.47.1`
- tag: `v3.47.1`
- push: main + tag 共に成功

## plugin marketplace / キャッシュ
- marketplace pull: b200c37..4e85bda fast-forward
- 旧 plugin キャッシュ削除: 3.46.0/ を削除、3.47.0/ を保持
- plugin 再インストール: uninstall → install 成功

## GitHub Actions
- release.yml RUN_ID=24432707445 → success

## npm レジストリ
- npm view @hummer98/cmux-team version → 3.47.1
- `npm install -g @hummer98/cmux-team@3.47.1` でバージョン固定インストール完了
- `cmux-team --version` → `cmux-team 3.47.1`

## 備考
- `npm install -g @hummer98/cmux-team`（バージョン無指定）では 3.47.0 のままだったため、`@3.47.1` を明示指定して再インストールした
