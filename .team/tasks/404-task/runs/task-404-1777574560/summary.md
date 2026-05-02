# T404 リリース v4.23.0 完了サマリー

## バージョン判定

- 旧バージョン: `v4.22.0`
- 新バージョン: `v4.23.0`（**minor** バンプ）
- 判定根拠: `v4.22.0..HEAD` のコミット 9 件中 `feat:` を最大変更レベルに採用

## 実施手順

| Step | 内容 | 結果 |
|---|---|---|
| 1 | 現バージョン / コミット履歴取得 | OK |
| 2 | バージョン判定 (auto: minor) | 4.23.0 |
| 3 | CHANGELOG.md 更新 (Added 5 / Changed 1 / Fixed 2) | OK |
| 4 | package.json / .claude-plugin/plugin.json / marketplace.json 更新 | OK (3 files) |
| 5 | commit + tag + push | `814b350`, `v4.23.0` |
| 6 | marketplace cache pull | OK (`3c34140..814b350`) |
| 7 | 旧 plugin cache 削除 | `4.21.0` 削除、`4.22.0` のみ残存 |
| 8 | plugin uninstall / install | OK |
| 9 | GitHub Actions release.yml | `success` (run 25183177290) |
| 10 | `npm install -g @hummer98/cmux-team` | `cmux-team 4.23.0` 確認 |

## CHANGELOG エントリ概要

### Added
- `cmux-team metrics` サブコマンド (T379 / T381)
- `/cmux-team:watch` slash command (T360)
- `cmux-team events` サブコマンド (T359)
- dashboard Journal に daemon lifecycle / resume イベント (T353)
- dashboard: Pool key モード時に Metrics 枯渇予測セクション非表示

### Changed
- docs/spec/11-metrics.md 新設、metrics taxonomy / CodeDNA 評価判定基準を SSOT 化 (T380)

### Fixed
- `loadPoolSummary` 失敗時の CLI warning 再表示 (T356)
- dashboard Metrics pool token を CLI と一致させる (T401)

## 成果物

- リリースコミット: `814b350` `chore: release v4.23.0`
- タグ: `v4.23.0`
- npm: `@hummer98/cmux-team@4.23.0`
- plugin: `cmux-team@hummer98-cmux-team` (再インストール済み)

## 備考

- worktree は read-only（main 側で直接 commit/tag するため、worktree には差分なし）
- task は operational なため Researcher / Planner / Implementer / Inspector は spawn せず、Conductor 自身が順次実行
