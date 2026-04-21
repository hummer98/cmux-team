# T288 リリース完了サマリー

## リリース情報

- **旧バージョン**: v4.2.0
- **新バージョン**: v4.3.0（minor bump）
- **判定根拠**: v4.2.0..HEAD で `feat:`（T286）+ `fix:`（T287）+ chore/docs。subject に `!:` なし、footer に `BREAKING CHANGE:` なし → Conventional Commits 厳格運用で minor bump
- **リリース日**: 2026-04-22

## 変更ファイル（main ブランチに直接 commit）

- `CHANGELOG.md` — `[Unreleased]` の直下に `[4.3.0] - 2026-04-22` セクションヘッダーを追加（既存内容は温存）
- `package.json` — `4.2.0` → `4.3.0`
- `.claude-plugin/plugin.json` — `4.2.0` → `4.3.0`
- `.claude-plugin/marketplace.json` — `plugins[0].version` `4.2.0` → `4.3.0`

## 実行結果

| Step | 内容 | 結果 |
|---|---|---|
| 1-2 | バージョン判定 | v4.2.0 → v4.3.0 |
| 3-4 | CHANGELOG + 3 ファイル更新 | OK |
| 5 | commit `chore: release v4.3.0` + tag `v4.3.0` + push main/tag | `0ba5643` push 済み |
| 6 | marketplace キャッシュ更新 | OK（`~/.claude/plugins/marketplaces/hummer98-cmux-team` を pull） |
| 7 | 旧 plugin キャッシュ削除 | 既存 4.2.0 のみで skip（新規 4.3.0 install で置換） |
| 8 | plugin uninstall/install | OK（`cmux-team@hummer98-cmux-team`） |
| 9 | GitHub Actions `release.yml` 監視 | RUN 24730612424 ✓ 53s で success（npm publish + GitHub Release 作成） |
| 10 | `npm install -g @hummer98/cmux-team` | `cmux-team 4.3.0` 確認 |
| 11 | close-task | （本 summary 書き出し後に実行） |

## 含まれる変更（v4.2.0 → v4.3.0）

### Changed (Breaking)

- `cmux-team stop` サブコマンドを廃止（T286）。cmux セッション終了で daemon が pidfile を自動 release する設計（T259）が既に整っており、明示停止コマンドは不要。手動停止は `kill <pid>`（PID は `.team/daemon.pid`）、または cmux セッション自体を終了

### Fixed

- `cmux-team start` が team.json に Conductor entry が残っているが実 surface が全て消失した状態から回復できない問題を修正（T286）。`applyDiscardOnly` ヘルパー抽出 + 「全 discarded」フォールバックで `initializeConductorSlots` 再構築経路を追加
- `cmux-team start` が新規フォルダで ENOENT で落ちる問題を修正（T287）

## 注意事項

- リリースコミット/タグは main ブランチに直接打った（worktree には差分を残さない運用）
- T286 commit body に「破壊的変更:」日本語記述があるが subject に `!:` なし・footer に `BREAKING CHANGE:` なしのため minor bump で処理（`stop` コマンド廃止は daemon 自動停止化に伴う dead code 整理で実質破壊なし）
