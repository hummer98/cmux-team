# T364 リリース完了

## バージョン

- v4.13.0 → **v4.14.0**（minor bump）
- 判定根拠: `feat(dashboard): TUI ヘッダー右の 5h/7d を pool capacity に置換 (T363)` 1 件のみ。Conventional Commits の `feat:` で minor 採用

## 変更ファイル（リリースコミット）

- `CHANGELOG.md` — `[4.14.0]` セクション追加（Changed 1 件）
- `package.json` — version
- `.claude-plugin/plugin.json` — version
- `.claude-plugin/marketplace.json` — `plugins[0].version`

リリースコミット: `06d58d6 chore: release v4.14.0`
タグ: `v4.14.0`（push 済み）

## 反映状況

- GitHub: `origin/main` へ push 済み、`v4.14.0` タグ push 済み
- GitHub Actions `release.yml`: run id 24974480427 → success（npm publish 済み）
- npm: `@hummer98/cmux-team@4.14.0` を global に install 済み（`cmux-team --version` で 4.14.0 を確認）
- plugin marketplace cache: `~/.claude/plugins/marketplaces/hummer98-cmux-team` を `git pull` で main 同期、4.14.0 がローカル plugin cache に追加され旧 4.12.1 を削除
- plugin: `claude plugin uninstall` → `install cmux-team@hummer98-cmux-team` で再インストール完了

## 設計判断

T363 のコミットは `feat:` だが内容が「既存表示の置換（5h/7d → pool capacity）」だったため CHANGELOG では Added ではなく Changed に分類した。新機能というより一等地の表示差し替え。

## 残課題

なし。
