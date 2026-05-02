# Release v4.22.0

## 概要

`v4.21.0` → `v4.22.0` リリース完了。`feat:` コミットを含むため minor bump を採用した。

## 変更コミット (v4.21.0..v4.22.0)

- `9842759` feat(cli): update-task に --no-exclusive フラグを追加
- `b1e35b8` fix(daemon): run_after_all assigned 中の normal 抑止 guard 追加 (T398)
- `e198827` fix(task): run_after_all が draft 経由で間接デッドロックする問題を解消 (T397)
- `fe29cb5` chore(team): タスク・アーティファクト蓄積物のスナップショット

## 実行ステップ

1. CHANGELOG.md に [4.22.0] セクション追記
2. `package.json` / `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json` の version を 4.22.0 に更新
3. リリースコミット `3c34140 chore: release v4.22.0` を作成
4. `git push origin main` + `git push origin v4.22.0`
5. plugin marketplace キャッシュ更新 (`~/.claude/plugins/marketplaces/hummer98-cmux-team` を git pull)
6. 旧 plugin キャッシュ `4.20.0` を削除
7. `claude plugin uninstall` → `claude plugin install` で plugin 再インストール
8. GitHub Actions release.yml run 25168505695 が success で完了
9. `npm install -g @hummer98/cmux-team` 実行 → 4.22.0 がインストール済みを確認

## 成果

- タグ: `v4.22.0`
- リリースコミット: `3c34140`
- npm: `@hummer98/cmux-team@4.22.0`
- plugin: 更新済み (`cmux-team@hummer98-cmux-team`)
- GitHub Actions: success (run 25168505695)
