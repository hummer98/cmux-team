# T285 リリース完了サマリー

## バージョン

- 旧: v4.1.0
- 新: v4.2.0
- 判定根拠: v4.1.0..HEAD のコミット 5 件中、`feat:` が 2 件あり最大変更レベルが minor、`BREAKING CHANGE` / `!:` 表記は無し

## 含まれる変更

### Changed (Breaking)
- T284: Conductor Step 8 が rebase conflict を semantic に自動解決
- T283: `CMUX_TEAM_FETCH_BEFORE_WORKTREE` のデフォルトを OFF → ON に反転
- T283: Ready 昇格時に sync state ガードを追加

### Added
- T283: Master に git 読み取り / ローカル同期を許可
- Master が意思的に `await-task` を使うパターンを許可（docs:master）

### Fixed
- T281: rate-limit `isStale` を 5h/7d 軸別に分離し throttle 凍結を解消
- T282: TUI ダッシュボードの Update 通知バナーが null のとき空行を残さない

## 実行結果

| ステップ | 結果 |
|---|---|
| 1. CHANGELOG.md 更新 | ✓ Unreleased を [4.2.0] に変換、未記載の T281/T282/await-task を追記 |
| 2. version 更新 (3 ファイル) | ✓ package.json, plugin.json, marketplace.json |
| 3. commit + tag + push | ✓ commit cb4108a, tag v4.2.0, origin main + tag push |
| 4. marketplace cache 更新 | ✓ git pull origin main (033c748..cb4108a) |
| 5. plugin cache cleanup + 再インストール | ✓ 4.2.0 のみ残存 |
| 6. GitHub Actions release.yml | ✓ Run 24699496219 success |
| 7. npm install -g | ✓ cmux-team 4.2.0 確認 |

## 成果物

- タグ: `v4.2.0`
- npm: `@hummer98/cmux-team@4.2.0`
- GitHub Release Run: 24699496219
