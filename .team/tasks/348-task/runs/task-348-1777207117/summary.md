# リリース完了: v4.12.0 → v4.12.1

## バージョン判定

- 前回タグ: v4.12.0
- 含まれるコミット (3): T345 fix(token), T346 fix(daemon), T347 docs(daemon)
- `feat:` / `BREAKING CHANGE` / `!:` なし → **patch**
- 採用バージョン: **v4.12.1**

## 変更ファイル

- `CHANGELOG.md` ([4.12.1] セクション追記)
- `package.json` (4.12.0 → 4.12.1)
- `.claude-plugin/plugin.json` (4.12.0 → 4.12.1)
- `.claude-plugin/marketplace.json` (plugins[0].version: 4.12.0 → 4.12.1)

## リリース成果物

- マージコミット: `aa7d652` (`chore: release v4.12.1`)
- タグ: `v4.12.1`
- GitHub Actions release.yml: success (run 24956873354)
- npm: `@hummer98/cmux-team@4.12.1` 公開済み
- plugin: `claude plugin install` で v4.12.1 をキャッシュに追加
- ローカル npm: `/Users/yamamoto/.anyenv/envs/nodenv/versions/22.15.0/bin/cmux-team` が `4.12.1` を表示

## CHANGELOG エントリ要約

- Fixed (T345): `cmux-team token` の credential 読み取りを macOS Keychain 優先に変更
- Fixed (T346): `cmux-team resume` 後の Conductor ゼロ問題を修正 (R7 廃止 + topup 補充)
- Changed (T347): Full Quit 後挙動コメントを T346 後の実態に整合
