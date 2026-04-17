# T220 リリース v3.48.0 → v3.49.0 完了サマリー

## バージョン判定

- 旧: v3.48.0
- 新: v3.49.0（minor bump）
- 判定根拠: v3.48.0..HEAD に `feat:` コミットが複数含まれるため minor

## 対象コミット（v3.48.0..HEAD）

- a65e183 feat: T219 CONDUCTOR_DONE / SESSION_CLEAR / SESSION_STARTED taskRunId 一致検証
- d1cb55b feat: T213 .team/config.json mainBranch 追加
- a4914c7 fix(conductor-role): T214 CONDUCTOR_DONE 二重送信解消
- 2590271 feat(statusline): T211 statusline proxy HTTP API 化 + Master hook 責務分離
- 5054a5d refactor(manager): T212 worktree .envrc / direnv allow 経路削除
- c61d808 / 471f0aa refactor(manager): T210 CONDUCTOR_ID / conductorId schema 撤去
- 6ca6906 docs(dockeeper): cmux-team-guide/SKILL.md 同期対象追加

## 変更ファイル

- CHANGELOG.md（[3.49.0] セクションに Added / Changed / Fixed を追記）
- package.json（version 3.48.0 → 3.49.0）
- .claude-plugin/plugin.json（version 3.48.0 → 3.49.0）
- .claude-plugin/marketplace.json（plugins[0].version 3.48.0 → 3.49.0）

## 実行したアクション

1. CHANGELOG.md 更新（既存 3.49.0 エントリに T210/T212/T213/T214/T219 追記）
2. バージョン 3 ファイル更新（Edit tool でバージョン行のみ書き換え）
3. main に commit → tag v3.49.0 → push
4. plugin marketplace キャッシュを git pull で同期
5. 旧 plugin cache 削除 → plugin uninstall/install で再インストール
6. GHA release.yml 確認（run 24481170230、conclusion=success）
7. npm install -g @hummer98/cmux-team で最新版を取得（3.49.0 確認）
8. cmux-team close-task でタスク完了記録

## 成果

- タグ: v3.49.0
- npm: @hummer98/cmux-team@3.49.0
- GHA: https://github.com/hummer98/cmux-team/actions/runs/24481170230
- plugin cache: /Users/yamamoto/.claude/plugins/cache/hummer98-cmux-team/cmux-team/3.49.0/

## 注意点

- 初回の json.dump によるバージョン更新は日本語文字列を `\uXXXX` エスケープし keywords を再フォーマットしてしまったため一度 revert し、Edit tool でバージョン行のみ書き換える方針に変更した
