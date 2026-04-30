# T297 リリースサマリー

## バージョン

- v4.4.0 → v4.5.0（minor bump）
- 判定理由: コミット履歴に `feat(close-task):` / `feat(auto-update):` を含むため、Conventional Commits ルールに従い minor。CLAUDE.md 内でも T294 / T295 を v4.5.0 相当と記載済み

## 含まれる変更

- **T295（Breaking）**: `close-task` に `--deliverable-kind <kind>` を必須化、`deliverable` フィールドで納品物を機械可読に記録
- **T294（Breaking）**: auto-update の `task` モードを廃止、`notify` のみに縮約。`self-update` サブコマンドも削除
- **T296（Docs）**: T295 で漏れた README / manager.md の close-task 旧署名を sweep
- **T267（Fix）**: `create-task` / `update-task` の `--depends-on` をゼロパディング 3 桁に正規化（#25）
- **Docs**: Master テンプレから `cmux-team status` 誘導を削除

## 実行結果

- commit: `488a950` (`chore: release v4.5.0`)
- tag: `v4.5.0`（origin に push 済み）
- CHANGELOG.md: `[Unreleased]` → `[4.5.0] - 2026-04-22` に確定、T267 / T296 / docs を追記
- 3 ファイルのバージョン更新: `package.json` / `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json`
- plugin marketplace キャッシュ (`~/.claude/plugins/marketplaces/hummer98-cmux-team`) を pull → 最新
- 旧 plugin キャッシュ `4.3.0` を削除、`claude plugin uninstall` → `install` で `4.5.0` を取得
- GitHub Actions `release.yml` run #24763247627: **success**
- npm インストール: `npm list -g @hummer98/cmux-team` → `4.5.0`、`cmux-team --version` → `cmux-team 4.5.0`

## 納品方式

リリースコミット / タグは `main` に直接 push 済み（ローカル feature branch ではない）。
Conductor 側 worktree (`.worktrees/task-297-1776838240`) は変更ゼロ。close-task の
`--deliverable-kind` はリリースタスクの性質上 `merged`（`main` に直接コミット）とする。
