# T271 リリース完了サマリー (v3.54.1 → v4.0.0)

## バージョン判定

| 項目 | 値 |
|---|---|
| 前バージョン | v3.54.1 |
| 新バージョン | **v4.0.0** |
| 判定根拠 | `feat(manager)!: mainBranch の暗黙フォールバックを撤廃し fail-stop (T253)` が `v3.54.1..HEAD` に含まれるため major bump |

## 反映したコミット範囲

v3.54.1..HEAD の 24 コミット。うち CHANGELOG の Unreleased 欄に既に載っていたのは T259 / T253 のみで、残り（T270 / T269 / T266 / T264 / T263 / T265 / T261 / T260 関連の feat 群 / T254 / T255 / T244 後続 fix / Full Quit 整理 / resetConductor surface 実在確認）を追記した。

## CHANGELOG 分類

### Added
- T259: daemon 多重起動を pidfile ロックで防止
- T266: Notification hook を daemon に集約し trace DB に記録
- T261: user_clear 判定の decision スナップショット + assigning window ログ
- T260: Conductor disconnect / broken ログ強化（pid/alive/lastHookAt、caller 情報、formatConductorSnapshot、broken_conductor_still_alive、task_aborted reason 機械可読化）
- T254: Task 二重起動防止の unique 制約不変条件検査
- T255: initializeLayout 復帰ロジックをマトリクス方式に刷新
- T264: 起動時 resume 不可検出で ready に戻さず aborted に倒す

### Changed (Breaking)
- T253: `mainBranch` 解決失敗時を fail-stop に変更

### Fixed
- T270: persistMainBranch で `.team/` 未作成時の ENOENT 修正
- T269: CONDUCTOR_DONE --success=false で assigned タスクを aborted に倒す
- T263: CONDUCTOR_DONE --success=false で worktree/branch を preserve
- T265: formatUserClearDecision の assigning_set_at を assigningSetAt 由来に修正
- その他: Master タブ名の再 rename、Full Quit 時の state クリア、resetConductor の surface 実在確認

## 実行ステップ（全 11 step）

| # | ステップ | 結果 |
|---|---|---|
| 1 | CURRENT / LAST_TAG / COMMITS 取得 | CURRENT=3.54.1, LAST_TAG=v3.54.1, 24 commits |
| 2 | バージョン判定 | v4.0.0（major bump） |
| 3 | CHANGELOG.md 更新 | Unreleased → [4.0.0] - 2026-04-19 + 追加エントリ |
| 4 | version 3 ファイル更新 | package.json / .claude-plugin/plugin.json / marketplace.json |
| 5 | commit + tag + push | commit b4c3930, tag v4.0.0, push origin main + tag |
| 6 | marketplace キャッシュ pull | ~/.claude/plugins/marketplaces/hummer98-cmux-team fast-forward 済み |
| 7 | 古い plugin キャッシュ削除 | 3.54.0 を削除、3.54.1 のみ残存（install 前） |
| 8 | plugin 再インストール | uninstall → install、cache に 4.0.0 追加 |
| 9 | GitHub Actions 監視 | release.yml run=24624236363 success |
| 10 | npm グローバルインストール | `@hummer98/cmux-team@4.0.0` インストール完了 |
| 11 | close-task + 完了通知 | 本サマリー記録後に実行 |

## 成果物

- マージコミット: [b4c3930](https://github.com/hummer98/cmux-team/commit/b4c3930) `chore: release v4.0.0`
- タグ: [v4.0.0](https://github.com/hummer98/cmux-team/releases/tag/v4.0.0)
- GitHub Actions run: https://github.com/hummer98/cmux-team/actions/runs/24624236363
- npm: `@hummer98/cmux-team@4.0.0`
- plugin: `cmux-team@hummer98-cmux-team` 4.0.0

## 懸念・注意

- **major bump (3 → 4)** は T253 の `feat!:` に従った自動判定。過去の v3.54.x は T253 breaking を Unreleased に持ったまま patch release されていたが、今回のルール適用時点で正式に major を上げる形になった
- T269 / T263 により `--success=false` の Conductor 終了時は **worktree/branch を preserve** するため、aborted タスクを放置すると worktree ディレクトリが徐々に増える。定期的に `git worktree prune` + 明示的な restart-task / abort-task を推奨
- npm install が `changed 1 package in 2s` と高速に完了したため、registry 反映のレイテンシは問題なし
