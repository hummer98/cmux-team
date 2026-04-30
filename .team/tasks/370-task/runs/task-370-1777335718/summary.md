# T370 リリース完了

## 概要

cmux-team を **v4.14.1 → v4.15.0** にリリース（minor バンプ）。
タスクタイトルが「リリース（バージョン自動判定）」のため、コミット履歴の Conventional Commits から自動判定した。

## バージョン判定の根拠

`v4.14.1..HEAD` のコミット 7 件:

| SHA | type | 概要 |
|---|---|---|
| e20c535 | docs | README に token pool・close-agent・trace-hooks 追記 |
| 5ed0856 | docs | README にデモ動画追加 |
| f3b25e3 | feat | pool 有効時の THROTTLE 判定を pool-aware に変更 (T367) |
| d7e662b | fix | selectToken stale snapshot のリセット済み軸を util=0 (T369) |
| 1036efb | feat | pool capacity を 5h / 7d 別表示 (T366) |
| ae1b5f3 | feat | Metrics タブを Rate Limit Projection に作り直し (T354) |
| b69db2b | fix | pool-header-display.test.ts の TS2532 解消 (T368) |

`feat:` を含むため **minor バンプ**（BREAKING CHANGE は無し）。

## 実行結果

| Step | 結果 |
|---|---|
| 1. CHANGELOG.md 更新 | OK（`[4.15.0] - 2026-04-28` セクション追加、Changed × 4 / Fixed × 2） |
| 2. バージョン更新（3 ファイル） | OK（package.json / .claude-plugin/plugin.json / .claude-plugin/marketplace.json） |
| 3. commit + tag + push | OK（commit `a957a9f`、tag `v4.15.0` を origin に push） |
| 4. plugin marketplace cache pull | OK（`23ae108..a957a9f` fast-forward） |
| 5. plugin uninstall + install | OK |
| 6. GitHub Actions 監視 | OK（run `25026883716` success 完了） |
| 7. npm install -g | OK（`cmux-team 4.15.0` で動作確認） |

## 成果物

- リリースコミット: `a957a9f` (`chore: release v4.15.0`)
- タグ: `v4.15.0`
- npm: `@hummer98/cmux-team@4.15.0`
- GitHub Actions: run `25026883716`（success）
- plugin: hummer98-cmux-team 経由で再インストール済み
