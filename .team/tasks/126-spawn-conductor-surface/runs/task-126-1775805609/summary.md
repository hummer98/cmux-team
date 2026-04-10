# T126 Summary: spawn-conductor から --surface 引数を削除

## 結果: 完了 (GO)

## 変更ファイル

1. `skills/cmux-team/manager/main.ts` — ヘッダーコメントと `cmdSpawnConductor()` から `--surface` 引数を削除
2. `skills/cmux-team/manager/i18n.ts` — 英語/日本語ヘルプテキスト（spawn-conductor + 全体ヘルプ）から `--surface` 記述を削除
3. `docs/spec/01-skill-cmux-team.md` — CLI コマンド表から `--surface`/`--direction` 記述を削除
4. `docs/spec/05-install-and-infrastructure.md` — サブコマンド表から `--surface`/`--direction` 記述を削除

## マージ

- ブランチ `task-126-1775805609/task` を main に fast-forward マージ
- コミット: `7dfc8c3`

## フロー

- Phase 1: Plan → Phase 3: Impl → Phase 4: Inspection (NOGO, 残存参照4箇所) → 修正 → 完了
