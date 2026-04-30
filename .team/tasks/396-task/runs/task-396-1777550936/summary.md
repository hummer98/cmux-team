# T396 リリース完了サマリー

## バージョン
- 旧: v4.20.0
- 新: **v4.21.0**

## 判定根拠
v4.20.0 以降のコミット 3 件のうち `feat:` を含むため minor バージョンアップ。

| コミット | 種別 | 分類 |
|---|---|---|
| 6c534d0 fix(dashboard): shift+R/G/Q を ctrl+R/G/Q に変更 (T394) | fix | Changed (回帰修正) |
| 24bb7af feat(stopfailure-hook): Agent の API エラーを TUI に可視化 (T392) | feat | Added |
| 153a885 fix(token-store): T391 migration の FK 違反を SQLite 12-step procedure 準拠で解消 (T393) | fix | Fixed |

## 実施内容

1. CHANGELOG.md に v4.21.0 セクションを追加（Added / Changed / Fixed の 3 カテゴリ）
2. バージョンを 3 ファイルで更新
   - `package.json`
   - `.claude-plugin/plugin.json`
   - `.claude-plugin/marketplace.json`
3. リリースコミット作成: `a6548d1 chore: release v4.21.0`
4. タグ `v4.21.0` 作成
5. main / タグを origin に push
6. plugin marketplace cache を `git pull` で更新
7. 旧 plugin cache の cleanup（4.20.0 のみ存在、新バージョンインストール後に整理予定）
8. `claude plugin uninstall` → `claude plugin install` で plugin 再インストール
9. GitHub Actions Release workflow（run id 25164595656）が `success` で完了
10. `npm install -g @hummer98/cmux-team` 実行 → `cmux-team --version` で 4.21.0 を確認

## 成果物
- マージコミット: `a6548d1` on main
- タグ: `v4.21.0`
- npm: `@hummer98/cmux-team@4.21.0`
- plugin: 更新済み（user scope）

## 備考
- worktree 内では作業せず、`$PROJECT_ROOT`（main ブランチ側）で全ての編集・commit・push を実施した（タスク指示通り）
- worktree には差分を残さないため `git status` でも worktree 側は untracked のみ
