# T257 リリース v3.53.0 → v3.54.0

## バージョン判定

- 現行: 3.53.0
- 新規: **3.54.0**（minor bump）
- 判定根拠: v3.53.0 以降のコミットに `feat:` が 4 件（T241/T242/T243/T246/T247/T249/T250）、`fix:` が 2 件（T244/T256）、`BREAKING CHANGE` なし → minor

## 変更サマリー（CHANGELOG [3.54.0]）

### Added
- T250: Conductor `broken` ステータス
- T249: マージ前 `origin/<mainBranch>` rebase 手順
- T247: Agent project-local instructions overlay
- T246: タスク `--exclusive` 属性
- T243: trace DB `base_branch` / `base_sha` / `base_source` 列
- T241: depends_on 親 abort/deleted 時の ready 子 cascade

### Changed
- T242: Conductor worktree base を `origin/<mainBranch>` 優先解決
- T256: macOS `caffeinate -i` → `-dis`

### Fixed
- T244: `AGENT_SPAWNED` を Claude 起動前に POST

## 実施手順

| # | 工程 | 結果 |
|---|------|------|
| 1 | コミット履歴取得 | v3.53.0..HEAD 20 commits |
| 2 | バージョン判定 | minor → 3.54.0 |
| 3 | CHANGELOG.md 更新 | [Unreleased] 3 件 + 新規 6 件 = 計 9 エントリ |
| 4 | version 3 ファイル更新 | package.json / plugin.json / marketplace.json |
| 5 | commit + tag | `0e1fb26 chore: release v3.54.0` / `v3.54.0` |
| 6 | push | origin/main + tag |
| 7 | marketplace キャッシュ更新 | `~/.claude/plugins/marketplaces/hummer98-cmux-team` を pull |
| 8 | 旧 plugin キャッシュ削除 | 3.52.0 を削除、3.53.0 を残存（その後 3.54.0 追加） |
| 9 | plugin 再インストール | uninstall → install で 3.54.0 取得 |
| 10 | GitHub Actions 監視 | Run 24588934440 success（34s）、npm publish + GitHub Release 成功 |
| 11 | npm グローバルインストール | `@hummer98/cmux-team@3.54.0` |

## リリース情報

- タグ: `v3.54.0`
- リリースコミット: `0e1fb26`
- GitHub Release: https://github.com/hummer98/cmux-team/releases/tag/v3.54.0
- npm: `@hummer98/cmux-team@3.54.0`
- plugin: `cmux-team@hummer98-cmux-team` v3.54.0（plugin marketplace 経由で配布）

## 自己判断

- CHANGELOG の `[Unreleased]` に T243/T256/T242 が積まれていたが、v3.53.0..HEAD の diff を見ると他にも T241/T246/T247/T249/T250/T244 の feat/fix があり未記載だった。release タスク内で全てを拾って 3.54.0 セクションに整理した
- `[Unreleased]` セクションは空のまま残した（次回以降の変更を溜めるための枠）
