# T240 リリース完了サマリー

## リリース情報

- **旧バージョン**: v3.52.0
- **新バージョン**: v3.53.0
- **バージョン判定**: `feat(manager): T238` が含まれるため **minor** アップ
- **リリース日**: 2026-04-17

## 実施内容

1. CHANGELOG.md に v3.53.0 エントリ追加（Added: T238 / Fixed: T239）
2. 3 ファイルのバージョン更新（package.json / plugin.json / marketplace.json）
3. main に `chore: release v3.53.0` コミット → `v3.53.0` タグ作成
4. `git push origin main` + `git push origin v3.53.0`
5. plugin marketplace キャッシュを `git pull`
6. 旧 plugin キャッシュ（3.51.0）削除、3.52.0 を LATEST として残した
7. `claude plugin uninstall/install` で plugin 再インストール
8. GitHub Actions release workflow 成功（run id: 24555570743, 25s）
9. `npm install -g @hummer98/cmux-team@3.53.0` → `cmux-team 3.53.0` 確認

## 含まれる変更

- **Added**: T238 Agent AskUserQuestion 時に通知 + TUI YELLOW 表示
- **Fixed**: T239 `cmux-team resume` の cwd を PROJECT_ROOT に揃え Conductor resume 失敗を修正

## 成果物

- タグ: v3.53.0
- GitHub Release: https://github.com/hummer98/cmux-team/releases/tag/v3.53.0
- npm: @hummer98/cmux-team@3.53.0
