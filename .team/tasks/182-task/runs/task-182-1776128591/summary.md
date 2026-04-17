# リリース完了: v3.44.0 → v3.44.1

## バージョン判定

Conventional Commits 判定により **patch** リリース。

- `fix(manager): cmux tree タイムアウトを crash 判定から除外`
- `docs(spec): v3.39〜v3.43 の実装状況を反映`
- `docs(release): /release を --run-after-all タスク起票方式に変更`
- `chore: .claude/scheduled_tasks.lock を gitignore に追加`

## 実施手順

1. ✅ CHANGELOG.md に v3.44.1 エントリ追加（Changed 3件 / Fixed 1件）
2. ✅ 3ファイルでバージョン更新（package.json, plugin.json, marketplace.json）
3. ✅ コミット `chore: release v3.44.1` (968c6d3) / タグ v3.44.1 / main と tag を push
4. ✅ plugin marketplace キャッシュを git pull で更新
5. ✅ 旧 plugin キャッシュ（3.43.0）を削除
6. ✅ Claude plugin 再インストール（cmux-team@hummer98-cmux-team）
7. ✅ GitHub Actions release.yml 成功（Run ID 24375261549、24秒で完了、npm OIDC Publishing + GitHub Release 作成）
8. ✅ npm cache clean --force 後に `npm install -g @hummer98/cmux-team@latest` で 3.44.1 へ更新
9. ✅ `npm list -g` で 3.44.1 確認

## 成果物

- **コミット**: 968c6d3 chore: release v3.44.1
- **タグ**: v3.44.1
- **npm**: @hummer98/cmux-team@3.44.1
- **GitHub Release**: v3.44.1（Actions により自動作成）

## 試行錯誤

- 初回の Python `json.dump` によるバージョン更新で JSON フォーマット（keywords 配列のインライン表現、Unicode エスケープ）が崩れたため `git checkout` で revert し、`Edit` ツールで差分最小化した行単位置換に切り替え
- `npm install -g` 直後は npm キャッシュが古く 3.44.0 のままだったため `npm cache clean --force` 後に `@latest` 指定で再インストールした

## 懸念

なし。GHA ワークフローで Node.js 20 actions の deprecation 警告のみ（2026-06-02 以降影響）。
