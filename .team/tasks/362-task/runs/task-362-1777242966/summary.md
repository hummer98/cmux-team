# T362 リリース v4.13.0 サマリー

## 結果

- **リリース**: v4.12.1 → **v4.13.0**（minor バンプ）
- **リリースコミット**: `34948bf chore: release v4.13.0` (main)
- **タグ**: `v4.13.0`（origin に push 済み）
- **GitHub Actions**: release workflow run `24968838990` → `success`
- **npm**: `@hummer98/cmux-team@4.13.0` を globally install 済み（`cmux-team --version` で確認）
- **plugin**: `cmux-team@hummer98-cmux-team` を uninstall → install で再インストール

## バージョン判定

タスクタイトル末尾が「（バージョン自動判定）」だったためコミット履歴から判定。
v4.12.1..HEAD のコミット群:

```
e1ce0ba feat(dashboard): Agent 行のスピナー直後に @handle を配置 (T352)
08e84a4 feat(dashboard): pool capacity ヘッダー + per-surface handle/util 表示 (T351 Step 4-6)
58fb4c1 feat(daemon): tokenDb / pool snapshot を DaemonState に追加 (T351 Step 3)
605ba95 refactor(cli): cmdStatus を loadPoolSummary 経由に切替 (T351 Step 2)
fb55ae0 feat(token): pool-summary 共有モジュール切り出し (T351 Step 1)
10190be docs(spec): glossary.md を新設して用語集を一元化 (T350)
e17e586 feat(token): plan prompt for unknown rateLimitTier (T349)
```

`feat:` を含む（`BREAKING CHANGE` / `!:` なし）→ **minor バンプ**。

## 変更ファイル（リリースコミットの内訳）

```
.claude-plugin/marketplace.json |  2 +-
.claude-plugin/plugin.json      |  2 +-
CHANGELOG.md                    | 11 +++++++++++
package.json                    |  2 +-
4 files changed, 14 insertions(+), 3 deletions(-)
```

CHANGELOG.md は `## [4.13.0] - 2026-04-27` セクションを追加し、Added / Changed のサブセクションに T349 / T350 / T351 / T352 の意味的サマリーを記載。

## CHANGELOG ハイライト

### Added

- dashboard に token pool capacity ヘッダーと per-surface @handle / 利用率表示を追加（T351 / T352）
- `cmux-team token add` / `promote` / `rotate` で未知の `rateLimitTier` をプロンプトで補完（T349）

### Changed

- `docs/spec/glossary.md` を新設し用語集を一元化（T350）

## 後続キャッシュ操作

- `~/.claude/plugins/marketplaces/hummer98-cmux-team` を fast-forward pull（aa7d652..34948bf）
- `~/.claude/plugins/cache/hummer98-cmux-team/cmux-team/4.12.0/` を削除（4.12.1 のみ残存 → 再インストールで 4.13.0 に置換）
