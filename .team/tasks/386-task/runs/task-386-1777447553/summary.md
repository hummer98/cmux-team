# T386 リリース作業サマリー

## 結論

cmux-team v4.18.0 → **v4.19.0** リリース完了（minor bump）。

## バージョン判定

- 現在: 4.18.0
- 最新タグ: v4.18.0
- 対象コミット: v4.18.0..HEAD（6 commit）
- 最大変更レベル: `feat:` 多数 / BREAKING CHANGE なし → **minor bump**
- 新バージョン: **4.19.0**

## 対象コミット

| SHA | 種別 | 内容 |
|---|---|---|
| da1dd0d | feat | proxy: auth_hash mismatch 時の auto rotate (T384) |
| 92d93ea | feat | token-store: admitCandidates に 7d ブロッカー追加 (T382) |
| 815d53d | feat | manager: events.jsonl writer + 17 event 経路結線 (T358) |
| 0ace52e | feat | デフォルトレイアウトを wide → 16x9 に変更 |
| 383498c | chore | token-pool: default を @tayo に変更し @kddi を exclude |
| 4070df3 | fix | dashboard: R/G/Q を shift+letter に変更してキー重複登録を解消 |

## 実施手順と成果

| step | 内容 | 結果 |
|---|---|---|
| 1 | バージョン判定 | 4.18.0 → 4.19.0 (minor) |
| 2 | CHANGELOG.md 更新（main 側） | [4.19.0] - 2026-04-29 セクション追加（Added 3 件 / Changed 2 件 / Fixed 1 件） |
| 3 | 3 ファイルバージョン更新 | package.json / .claude-plugin/plugin.json / .claude-plugin/marketplace.json |
| 4 | commit + tag | `36fcb3c chore: release v4.19.0` / `v4.19.0` |
| 5 | push origin main + tag | OK |
| 6 | marketplace cache pull | a75d1c2..36fcb3c fast-forward |
| 7 | 旧 plugin cache 削除 | 4.18.0 → 削除済み |
| 8 | plugin re-install | uninstall + install 成功（4.19.0 cache 作成） |
| 9 | GitHub Actions release.yml | run 25096317064 success |
| 10 | npm install -g | @hummer98/cmux-team@4.19.0 反映確認（`cmux-team --version` で 4.19.0） |

## 変更ファイル（リリースコミット）

```
.claude-plugin/marketplace.json |  2 +-
.claude-plugin/plugin.json      |  2 +-
CHANGELOG.md                    | 17 +++++++++++++++++
package.json                    |  2 +-
4 files changed, 20 insertions(+), 3 deletions(-)
```

## 納品

- 納品方式: ローカル直接コミット → push（worktree は使わず main で作業）
- merge SHA: `36fcb3c`
- merged-into: `main`
- npm: `@hummer98/cmux-team@4.19.0` (registry / local install 両方反映済み)
- tag: `v4.19.0` (origin にも push 済み)

## 備考

- worktree (`task-386-1777447553`) は使用せず削除済み（branch も削除）
- operational task のためサブエージェントは spawn せず Conductor が直接実行
