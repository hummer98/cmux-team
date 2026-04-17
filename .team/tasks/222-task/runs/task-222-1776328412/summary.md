# T222 リリース v3.50.0

## バージョン

v3.49.0 → **v3.50.0**（minor bump）

判定根拠: 前回タグ v3.49.0 以降に `feat:` 2 件（T217 / T216）を含むため minor。BREAKING / `!:` は無し。

## 取り込まれた変更

- **Added:** `cmux-team trace-hooks` サブコマンド追加（T217）
- **Changed:** hook 全送信ポリシーへの統合（T216） / cmux-team-investigate スキル更新（T218）
- **Fixed:** plugin.json から不要な SessionStart hook 定義を削除（T221）

## 実行ステップ結果

| ステップ | 状態 |
|---|---|
| 1. コミット履歴取得 | OK（v3.49.0..HEAD で 4 merge + 4 commit） |
| 2. バージョン判定 | minor → 3.50.0 |
| 3. CHANGELOG.md 追記 | OK |
| 4. 3 ファイル version 更新 | OK（package.json / plugin.json / marketplace.json） |
| 5. commit / tag / push | OK（main に 26a8c29 / tag v3.50.0） |
| 6. marketplace cache git pull | OK（0116eb6..26a8c29 fast-forward） |
| 7. 旧 plugin キャッシュ削除 | OK（3.48.0 を削除、3.49.0 を残置） |
| 8. plugin 再インストール | OK（user scope） |
| 9. GitHub Actions 監視 | OK（run 24500469992, success） |
| 10. npm -g install | OK（cmux-team 3.50.0） |

## 納品

- main コミット: `26a8c29 chore: release v3.50.0`
- タグ: `v3.50.0`
- npm: `@hummer98/cmux-team@3.50.0`
- plugin: 再インストール完了
