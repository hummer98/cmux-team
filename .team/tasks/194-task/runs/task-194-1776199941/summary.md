# T194 リリース v3.46.0 サマリー

## バージョン判定
- 旧: 3.45.0
- 新: **3.46.0**（minor — 複数の `feat:` あり、breaking なし）
- タグ: `v3.46.0`
- コミット: `d0015a7 chore: release v3.46.0`

## 採用したコミット（v3.45.0..HEAD）
| タスク | 種別 | 概要 |
|---|---|---|
| T181 | feat | await-agent 方式への移行 + Ask 状態検出 |
| T189 | feat | detect-ask 分類ロジックを Manager 側に移行 |
| T190 | fix | 既知の tsc エラー 6 件を解消 |
| T191 | docs | docs/spec と README を現状実装に同期 |
| T192 | feat | logger surface 表記簡略化 + バージョン記録 |
| T193 | feat | conductor init prompt 廃止 + タブ名ロール固定 |

## 更新ファイル
- `CHANGELOG.md` — 3.46.0 節を追加（Added / Changed / Fixed）
- `package.json` — 3.45.0 → 3.46.0
- `.claude-plugin/plugin.json` — 3.45.0 → 3.46.0
- `.claude-plugin/marketplace.json` — plugins[0].version 3.45.0 → 3.46.0

## デプロイ結果
- ✅ main に commit + push（d0015a7）
- ✅ tag v3.46.0 を push
- ✅ GitHub Actions `release.yml` run 24422447283 → success
- ✅ plugin marketplace キャッシュ pull 完了（~/.claude/plugins/marketplaces/hummer98-cmux-team）
- ✅ 旧 plugin cache 削除（3.44.1 を削除、3.45.0 を保持）
- ✅ claude plugin uninstall → install 完了
- ✅ `npm install -g @hummer98/cmux-team` 完了 → `cmux-team --version` が `3.46.0` を返すことを確認

## 注意点
- main には T191 の dockeeper 関連テンプレート修正等の未コミット変更（`.team/*` ランタイムファイル以外に `commands/docs-sync.md` / `skills/cmux-team/templates/{en,ja}/{dockeeper,master}.md` / `skills/dockeeper/SKILL.md`）が残っているが、今回のリリースコミットは対象 4 ファイルのみを明示的に stage したので影響なし。必要に応じて別タスクで対応のこと。
