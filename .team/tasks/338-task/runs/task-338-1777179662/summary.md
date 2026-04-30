# Release v4.10.0

## バージョン判定

- 現在: v4.9.1
- 新バージョン: **v4.10.0** (minor bump)
- 根拠: v4.9.1..HEAD に `feat(token-pool): ... (T335)` が含まれるため Conventional Commits で minor

## 含まれる変更（v4.9.1 → v4.10.0）

| SHA | 種別 | 内容 |
|---|---|---|
| 8f60fb2 | feat | token-pool: project default + include/exclude 設定モデルを導入 (T335, A019 改訂) |
| e7fbff5 | chore | perf-probe: bun test O(N²) 劣化を最小再現で切り分け (T337, A022) |

リリースコミット: `f4e412f chore: release v4.10.0`

## 実行ステップ

| # | ステップ | 結果 |
|---|---|---|
| 1 | バージョン判定 | v4.9.1 → v4.10.0 (minor) |
| 2 | CHANGELOG.md 更新 | `[Unreleased]` 配下に `[4.10.0] - 2026-04-26` セクション追加（Added: T335 / Changed: T337） |
| 3 | バージョン更新 (3 ファイル) | package.json / .claude-plugin/plugin.json / .claude-plugin/marketplace.json |
| 4 | commit + tag + push | `f4e412f` を main に push、tag `v4.10.0` も push |
| 5 | marketplace cache 更新 | `~/.claude/plugins/marketplaces/hummer98-cmux-team` を fast-forward pull |
| 6 | 旧 plugin cache 削除 | LATEST=4.9.1 のみ存在 → 削除対象なし |
| 7 | plugin 再インストール | `claude plugin uninstall` → `claude plugin install` 成功 |
| 8 | GitHub Actions 監視 | release.yml run 24948763050 = `completed/success`（タグ push と同時に完走済み） |
| 9 | npm install -g | `npm view @hummer98/cmux-team version` → `4.10.0`、`cmux-team --version` → `cmux-team 4.10.0` |

## 成果物

- npm: `@hummer98/cmux-team@4.10.0` 公開済み
- GitHub tag: `v4.10.0` (sha=f4e412f9d5de074b509408d3bb4dffec478f2976)
- plugin marketplace: `hummer98-cmux-team` の cmux-team 4.10.0 が install 可能
- ローカル CLI: `/Users/yamamoto/.anyenv/envs/nodenv/versions/22.15.0/bin/cmux-team` が 4.10.0 に更新

## 完了通知

リリース完了: v4.9.1 → v4.10.0
- タグ: v4.10.0
- plugin: 更新済み
- npm: @hummer98/cmux-team@4.10.0
