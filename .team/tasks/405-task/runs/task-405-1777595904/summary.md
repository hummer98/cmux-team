# T405 リリース v4.23.1 完了サマリー

## 概要

タスクタイトル「リリース（バージョン自動判定）」に従い、`v4.23.0..HEAD` のコミット履歴を Conventional Commits で評価し **patch bump（v4.23.0 → v4.23.1）** を採用。main ブランチに直接リリースコミット・タグを打ち、plugin / npm 配布を更新した。

## バージョン判定

| キーワード | 件数 | レベル |
|---|---|---|
| `feat:` / `BREAKING` | 0 | — |
| `fix:` | 2 | patch |
| `docs:` | 1 | patch |

→ patch bump 確定（v4.23.1）

## 取り込んだコミット

| SHA | 種別 | サマリー |
|---|---|---|
| `8d9689e` | fix | dashboard Metrics の `util_5h=null` 表示を CLI と揃える (T402) |
| `68413ce` | fix | proxy `api_usage.task_id` 全件 NULL を修正 (T403) |
| `aabff11` | docs | events stream + watch mode を CLAUDE.md / docs / README に反映 (T361) |

## 変更ファイル（リリースコミット db6c361）

- `CHANGELOG.md` — `## [4.23.1] - 2026-05-01` セクションを Unreleased 直下に挿入
- `package.json` — `4.23.0 → 4.23.1`
- `.claude-plugin/plugin.json` — `4.23.0 → 4.23.1`
- `.claude-plugin/marketplace.json` — `plugins[0].version` を `4.23.0 → 4.23.1`

## 実行ステップ結果

| # | ステップ | 結果 |
|---|---|---|
| 1 | バージョン取得 | OK (CURRENT=4.23.0, LAST_TAG=v4.23.0) |
| 2 | バージョン判定 | OK (patch → 4.23.1) |
| 3 | CHANGELOG / version 3 ファイル更新 | OK |
| 4 | commit / push / tag | `db6c361` push + `v4.23.1` tag push |
| 5 | marketplace pull / 旧キャッシュ削除 | `4.22.0/` キャッシュ削除、`4.23.0/` は再インストール経由で更新 |
| 6 | plugin 再インストール | OK |
| 7 | GitHub Actions 監視 | run `25196549320` success (22s) |
| 8 | npm install -g | `cmux-team 4.23.1` 確認 |
| 9 | close-task | 本ファイル後に実行 |

## 納品物

- マージコミット: `db6c361` (`chore: release v4.23.1`)
- タグ: `v4.23.1`
- npm: `@hummer98/cmux-team@4.23.1`
- plugin: `cmux-team@hummer98-cmux-team` 再インストール済
- GHA Release run: `25196549320`

## 備考

- このタスクは operational task としてサブエージェントを spawn せず Conductor 自身が直接 main ブランチに対して commit / push / tag を実行した
- worktree branch `task-405-1777595904/task` には新規コミットを残していないため、`--deliverable-kind merged --merge-sha db6c361 --merged-into main` で close する
- worktree 内に `M package-lock.json` の dirty が残っていたため `git checkout -- package-lock.json` で破棄してから worktree を削除した
