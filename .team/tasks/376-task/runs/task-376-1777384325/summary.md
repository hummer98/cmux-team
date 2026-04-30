# T376 リリース完了サマリー

## バージョン
- 4.16.0 → **4.17.0**（minor バンプ、`feat:` × 2 を含むため）

## 含まれるコミット
- `8afe4c1` feat(statusline): agent ペインに tokenHandle (@xxx) を表示 (T375)
- `2168a2a` feat(pool-capacity): 7d forecast ゲージ + next 候補 5h に再設計 (T374, A024)

## 実施手順
1. CHANGELOG.md に [4.17.0] - 2026-04-28 を追加（Unreleased の T374 セクションを 4.17.0 に確定し、T375 を Added セクションに新規追記）
2. version を 3 ファイルで 4.16.0 → 4.17.0 に更新（package.json / .claude-plugin/plugin.json / .claude-plugin/marketplace.json）
3. release commit + tag + push（commit `ac7b4e1`、tag `v4.17.0`）
4. plugin marketplace cache を `git pull origin main` で更新
5. claude plugin uninstall → install で plugin を 4.17.0 に更新
6. install 後に古い 4.16.0 キャッシュを削除（4.17.0 のみ残る状態）
7. release.yml workflow（run 25057047030）が success で完了済みを確認
8. `npm install -g @hummer98/cmux-team` でグローバル CLI を 4.17.0 に更新
9. `cmux-team --version` で `cmux-team 4.17.0` を確認

## 納品
- merge コミット: `ac7b4e1` (main 直接コミット)
- tag: `v4.17.0` (push 済み)
- plugin: 更新済み（hummer98-cmux-team marketplace 経由 4.17.0）
- npm: `@hummer98/cmux-team@4.17.0` グローバルインストール済み
- GitHub Actions release.yml: run 25057047030 success
